const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { SlidingWindowRateLimiter } = require('./rateLimiter');
const { LLMGatewayRouter } = require('./router');
const { formatErrorResponse, RateLimitError } = require('./errors');
const { createGatewayServer } = require('./server');

const testDbPath = path.join(__dirname, 'test_gateway.db');

function cleanup() {
  for (const f of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`]) {
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  }
}

async function runTests() {
  cleanup();

  const rateLimiter = new SlidingWindowRateLimiter({
    dbPath: testDbPath,
    defaultLimit: 50000,
    defaultWindowMs: 1500
  });

  assert.strictEqual(fs.existsSync(testDbPath), true);

  const res1 = rateLimiter.checkAndReserve('tenant_a', 20000, 50000, 1500);
  assert.strictEqual(res1.currentUsage, 20000);
  assert.strictEqual(res1.remainingTokens, 30000);

  const res2 = rateLimiter.checkAndReserve('tenant_a', 25000, 50000, 1500);
  assert.strictEqual(res2.currentUsage, 45000);

  let rateLimitCaught = false;
  try {
    rateLimiter.checkAndReserve('tenant_a', 10000, 50000, 1500);
  } catch (err) {
    rateLimitCaught = true;
    assert.strictEqual(err instanceof RateLimitError, true);
    assert.strictEqual(err.statusCode, 429);
    assert.strictEqual(err.code, 'RATE_LIMIT_EXCEEDED');
    assert.strictEqual(err.details.limit, 50000);
    assert.strictEqual(err.details.current_usage, 45000);
  }
  assert.strictEqual(rateLimitCaught, true);

  await new Promise(r => setTimeout(r, 1600));
  const evicted = rateLimiter.evictExpired(1500);
  assert.strictEqual(evicted >= 2, true);

  const res3 = rateLimiter.checkAndReserve('tenant_a', 40000, 50000, 1500);
  assert.strictEqual(res3.currentUsage, 40000);

  let primaryCalled = 0;
  let secondaryCalled = 0;

  const mockPrimary429 = {
    name: 'primary-model',
    call: async () => {
      primaryCalled++;
      const err = new Error('Primary rate limited');
      err.statusCode = 429;
      throw err;
    }
  };

  const mockSecondarySuccess = {
    name: 'secondary-backup-model',
    call: async () => {
      secondaryCalled++;
      return {
        id: 'sec-123',
        choices: [{ message: { role: 'assistant', content: 'Backup response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 }
      };
    }
  };

  const router1 = new LLMGatewayRouter({
    rateLimiter,
    primaryProvider: mockPrimary429,
    secondaryProvider: mockSecondarySuccess,
    primaryTimeoutMs: 3000,
    secondaryTimeoutMs: 3000,
    defaultLimit: 50000,
    defaultWindowMs: 5000
  });

  const response1 = await router1.routeCompletion('tenant_fallback_429', {
    prompt: 'Hello world',
    tokens: 100
  });

  assert.strictEqual(primaryCalled, 1);
  assert.strictEqual(secondaryCalled, 1);
  assert.strictEqual(response1.gateway.fallback, true);
  assert.strictEqual(response1.gateway.provider, 'secondary-backup-model');
  assert.strictEqual(response1.gateway.fallback_reason, 'primary_429');
  assert.strictEqual(response1.gateway.tokens_billed, 25);

  let latePrimaryResolved = false;
  const mockPrimaryTimeout = {
    name: 'primary-timeout-model',
    call: async (payload, signal) => {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          latePrimaryResolved = true;
          resolve({ choices: [{ message: { content: 'Late' } }] });
        }, 800);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('Aborted'));
        });
      });
    }
  };

  const mockSecondaryForTimeout = {
    name: 'secondary-backup-model',
    call: async () => ({
      choices: [{ message: { content: 'Fallback from timeout' } }],
      usage: { total_tokens: 50 }
    })
  };

  const router2 = new LLMGatewayRouter({
    rateLimiter,
    primaryProvider: mockPrimaryTimeout,
    secondaryProvider: mockSecondaryForTimeout,
    primaryTimeoutMs: 200,
    secondaryTimeoutMs: 1000,
    defaultLimit: 50000,
    defaultWindowMs: 5000
  });

  const response2 = await router2.routeCompletion('tenant_timeout_test', {
    tokens: 100
  });
  assert.strictEqual(response2.gateway.fallback, true);
  assert.strictEqual(response2.gateway.fallback_reason, 'primary_timeout');
  assert.strictEqual(response2.choices[0].message.content, 'Fallback from timeout');
  assert.strictEqual(latePrimaryResolved, false);

  const mockPrimaryFails = {
    name: 'primary-fails',
    call: async () => {
      const err = new Error('Internal DB conn string at secret.cluster.local:8080');
      err.statusCode = 429;
      err.stack = 'Sensitive stack\n    at internalFn (/app/secret.js:10:5)';
      throw err;
    }
  };
  const mockSecondaryFails = {
    name: 'secondary-fails',
    call: async () => {
      const err = new Error('Secret secondary key leaked');
      err.statusCode = 500;
      err.stack = 'Secondary stack\n    at secFn (/app/sec.js:20:5)';
      throw err;
    }
  };

  const routerSanitize = new LLMGatewayRouter({
    rateLimiter,
    primaryProvider: mockPrimaryFails,
    secondaryProvider: mockSecondaryFails,
    primaryTimeoutMs: 500,
    secondaryTimeoutMs: 500
  });

  const sanitizeResult = await routerSanitize.handleRequest('tenant_sanitize', { tokens: 50 });
  assert.strictEqual(sanitizeResult.status, 502);
  const errStr = JSON.stringify(sanitizeResult.body);
  assert.strictEqual(errStr.includes('secret.cluster.local'), false);
  assert.strictEqual(errStr.includes('Sensitive stack'), false);
  assert.strictEqual(errStr.includes('Secondary stack'), false);
  assert.strictEqual(sanitizeResult.body.error.code, 'UPSTREAM_ERROR');

  const rawErr = formatErrorResponse(new TypeError('Crash details'));
  assert.strictEqual(rawErr.error.code, 'INTERNAL_GATEWAY_ERROR');
  assert.strictEqual(JSON.stringify(rawErr).includes('Crash details'), false);

  const server = createGatewayServer(router1);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const httpReq = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer key_123' },
    body: JSON.stringify({ prompt: 'test' })
  });
  assert.strictEqual(httpReq.status, 200);

  const unauthReq = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.strictEqual(unauthReq.status, 401);

  const concurrentCalls = Array.from({ length: 10 }, (_, i) =>
    router1.handleRequest('concurrent_tenant', { tokens: 6000 })
  );
  const concurrentResults = await Promise.all(concurrentCalls);
  const successes = concurrentResults.filter(r => r.status === 200);
  const limited = concurrentResults.filter(r => r.status === 429);
  assert.strictEqual(successes.length, 8);
  assert.strictEqual(limited.length, 2);

  await new Promise(resolve => server.close(resolve));
  rateLimiter.close();
  cleanup();
  console.log('ALL NODEJS TESTS PASSED SUCCESSFULLY');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});

