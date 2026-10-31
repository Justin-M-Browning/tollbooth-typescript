import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { StreamingPIIRedactor } from './redactor.js';
import { createGateway } from './gateway.js';
import { createMockUpstream } from './mock_upstream.js';

async function streamToString(readable) {
  let result = '';
  for await (const chunk of readable) {
    result += chunk.toString('utf8');
  }
  return result;
}

async function testUnitRedactorDirect() {
  const chunks = ['Contact ', 'john.doe', '@sub.domain.', 'co.uk for details.'];
  const redactor = new StreamingPIIRedactor();
  const readable = Readable.from(chunks);
  const transformed = readable.pipe(redactor);
  const output = await streamToString(transformed);

  assert.equal(output.includes('john.doe@sub.domain.co.uk'), false);
  assert.equal(output.includes('[REDACTED]'), true);
  assert.equal(output, 'Contact [REDACTED] for details.');
}

async function testUnitRedactorSSNSplit() {
  const chunks = ['SSN number: ', '987', '-', '65-', '4321', ' is secret.'];
  const redactor = new StreamingPIIRedactor();
  const readable = Readable.from(chunks);
  const transformed = readable.pipe(redactor);
  const output = await streamToString(transformed);

  assert.equal(output.includes('987-65-4321'), false);
  assert.equal(output.includes('[REDACTED]'), true);
  assert.equal(output, 'SSN number: [REDACTED] is secret.');
}

async function testUnitRedactorCreditCardSplit() {
  const chunks = ['Card: ', '4111', '-', '2222', '-', '3333-', '4444', ' expired'];
  const redactor = new StreamingPIIRedactor();
  const readable = Readable.from(chunks);
  const transformed = readable.pipe(redactor);
  const output = await streamToString(transformed);

  assert.equal(output.includes('4111-2222-3333-4444'), false);
  assert.equal(output.includes('[REDACTED]'), true);
  assert.equal(output, 'Card: [REDACTED] expired');
}

async function testUnitRedactorTTFTResponsiveness() {
  const redactor = new StreamingPIIRedactor();
  const emitted = [];
  redactor.on('data', (c) => emitted.push(c.toString('utf8')));

  redactor.write('The quick brown ');
  assert.ok(emitted.length > 0);
  assert.equal(emitted.join(''), 'The quick brown ');

  redactor.write('fox jumps over ');
  assert.equal(emitted.join(''), 'The quick brown fox jumps over ');

  redactor.write('the lazy dog.');
  redactor.end();
  assert.equal(emitted.join(''), 'The quick brown fox jumps over the lazy dog.');
}

async function testEndToEndChatSSE() {
  const mockPort = 8101;
  const gatewayPort = 8102;
  const mockServer = createMockUpstream();
  await new Promise((resolve) => mockServer.listen(mockPort, resolve));
  const gatewayServer = createGateway(`http://127.0.0.1:${mockPort}`);
  await new Promise((resolve) => gatewayServer.listen(gatewayPort, resolve));

  try {
    const postData = JSON.stringify({
      messages: [{ role: 'user', content: 'test' }],
      custom_chunks: [
        'User info: ',
        'email is test.user',
        '@example.com',
        ' and SSN is 456-',
        '78-1234.'
      ],
      delay_ms: 5
    });

    let fullResponse = '';
    await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: gatewayPort,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        },
        (res) => {
          assert.equal(res.statusCode, 200);
          assert.ok(res.headers['content-type'].includes('text/event-stream'));
          res.on('data', (chunk) => {
            fullResponse += chunk.toString('utf8');
          });
          res.on('end', resolve);
        }
      );
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    assert.equal(fullResponse.includes('test.user@example.com'), false);
    assert.equal(fullResponse.includes('456-78-1234'), false);
    assert.ok(fullResponse.includes('[REDACTED]'));
    assert.ok(fullResponse.includes('data: [DONE]'));
  } finally {
    await new Promise((resolve) => mockServer.close(resolve));
    await new Promise((resolve) => gatewayServer.close(resolve));
  }
}

async function testEndToEndRawStream() {
  const mockPort = 8103;
  const gatewayPort = 8104;
  const mockServer = createMockUpstream();
  await new Promise((resolve) => mockServer.listen(mockPort, resolve));
  const gatewayServer = createGateway(`http://127.0.0.1:${mockPort}`);
  await new Promise((resolve) => gatewayServer.listen(gatewayPort, resolve));

  try {
    const postData = JSON.stringify({
      custom_chunks: [
        'Transaction: card 5500-',
        '0000-1111-2222',
        ' processed for ',
        'clerk@store.com'
      ],
      delay_ms: 5
    });

    let fullResponse = '';
    await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: gatewayPort,
          path: '/stream',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        },
        (res) => {
          assert.equal(res.statusCode, 200);
          res.on('data', (chunk) => {
            fullResponse += chunk.toString('utf8');
          });
          res.on('end', resolve);
        }
      );
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    assert.equal(fullResponse.includes('5500-0000-1111-2222'), false);
    assert.equal(fullResponse.includes('clerk@store.com'), false);
    assert.ok(fullResponse.includes('[REDACTED]'));
  } finally {
    await new Promise((resolve) => mockServer.close(resolve));
    await new Promise((resolve) => gatewayServer.close(resolve));
  }
}

async function runAll() {
  await testUnitRedactorDirect();
  await testUnitRedactorSSNSplit();
  await testUnitRedactorCreditCardSplit();
  await testUnitRedactorTTFTResponsiveness();
  await testEndToEndChatSSE();
  await testEndToEndRawStream();
  console.log('All Node.js tests passed successfully!');
}

runAll().catch((err) => {
  process.stderr.write(`Test failure: ${err.stack || err}\n`);
  process.exit(1);
});

