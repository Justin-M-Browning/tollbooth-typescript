import assert from 'node:assert';
import { createGatewayServer, createJwt } from './gateway.js';
import { createMockServer } from './mock-server.js';

const MOCK_PORT = 4101;
const GATEWAY_PORT = 3101;
const SECRET = 'test-secret-key-999';

const mockServer = createMockServer(MOCK_PORT);
const gatewayServer = createGatewayServer({
  downstreamUrl: `http://127.0.0.1:${MOCK_PORT}`,
  jwtSecret: SECRET,
  tokenMap: {
    'admin-token': 'admin',
    'viewer-token': 'viewer'
  }
});

async function postRpc(payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function run() {
  await new Promise((resolve) => mockServer.listen(MOCK_PORT, resolve));
  await new Promise((resolve) => gatewayServer.listen(GATEWAY_PORT, resolve));

  const adminJwt = createJwt({ sub: 'user1', role: 'admin' }, SECRET);
  const viewerJwt = createJwt({ sub: 'user2', role: 'viewer' }, SECRET);
  const invalidJwt = adminJwt + 'tampered';

  try {
    mockServer.clearRecords();
    const res1 = await postRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { Authorization: `Bearer ${viewerJwt}` }
    );
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.data.id, 1);
    assert.ok(Array.isArray(res1.data.result.tools));
    assert.strictEqual(mockServer.recordedRequests.length, 1);

    mockServer.clearRecords();
    const res2 = await postRpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { Authorization: 'Bearer admin-token' }
    );
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.data.id, 2);
    assert.strictEqual(mockServer.recordedRequests.length, 1);

    mockServer.clearRecords();
    const res3 = await postRpc({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    assert.strictEqual(res3.status, 200);
    assert.strictEqual(mockServer.recordedRequests.length, 1);
    mockServer.clearRecords();
    const res4 = await postRpc(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'read_status', arguments: {} }
      },
      { Authorization: `Bearer ${viewerJwt}` }
    );
    assert.strictEqual(res4.status, 200);
    assert.strictEqual(res4.data.id, 4);
    assert.ok(!res4.data.error);
    assert.strictEqual(mockServer.recordedRequests.length, 1);

    mockServer.clearRecords();
    const res5 = await postRpc(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'admin_reset_key', arguments: { keyId: 'abc' } }
      },
      { Authorization: `Bearer ${adminJwt}` }
    );
    assert.strictEqual(res5.status, 200);
    assert.strictEqual(res5.data.id, 5);
    assert.ok(!res5.data.error);
    assert.strictEqual(mockServer.recordedRequests.length, 1);

    mockServer.clearRecords();
    const res6 = await postRpc(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'admin_reset_key', arguments: { keyId: 'abc' } }
      },
      { Authorization: 'Bearer admin-token' }
    );
    assert.strictEqual(res6.status, 200);
    assert.strictEqual(res6.data.id, 6);
    assert.ok(!res6.data.error);
    assert.strictEqual(mockServer.recordedRequests.length, 1);

    mockServer.clearRecords();
    const res7 = await postRpc(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'admin_reset_key', arguments: { keyId: 'abc' } }
      },
      { Authorization: `Bearer ${viewerJwt}` }
    );
    assert.strictEqual(res7.status, 200);
    assert.strictEqual(res7.data.id, 7);
    assert.ok(res7.data.error);
    assert.strictEqual(res7.data.error.code, -32001);
    assert.strictEqual(res7.data.error.message, 'Unauthorized Tool Call');
    assert.strictEqual(mockServer.recordedRequests.length, 0);

    mockServer.clearRecords();
    const res8 = await postRpc(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'admin_delete_cache', arguments: {} }
      },
      { Authorization: 'Bearer viewer-token' }
    );
    assert.strictEqual(res8.status, 200);
    assert.strictEqual(res8.data.id, 8);
    assert.ok(res8.data.error);
    assert.strictEqual(res8.data.error.code, -32001);
    assert.strictEqual(res8.data.error.message, 'Unauthorized Tool Call');
    assert.strictEqual(mockServer.recordedRequests.length, 0);

    mockServer.clearRecords();
    const res9 = await postRpc(
      {
        jsonrpc: '2.0',
        id: 'string-id-9',
        method: 'tools/call',
        params: { name: 'admin_reset_key', arguments: {} }
      }
    );
    assert.strictEqual(res9.status, 200);
    assert.strictEqual(res9.data.id, 'string-id-9');
    assert.ok(res9.data.error);
    assert.strictEqual(res9.data.error.code, -32001);
    assert.strictEqual(res9.data.error.message, 'Unauthorized Tool Call');
    assert.strictEqual(mockServer.recordedRequests.length, 0);

    mockServer.clearRecords();
    const res10 = await postRpc(
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'admin_reset_key', arguments: {} }
      },
      { Authorization: `Bearer ${invalidJwt}` }
    );
    assert.strictEqual(res10.status, 200);
    assert.strictEqual(res10.data.id, 10);
    assert.strictEqual(res10.data.error.code, -32001);
    assert.strictEqual(mockServer.recordedRequests.length, 0);

    mockServer.clearRecords();
    const res11 = await postRpc('this is not json');
    assert.strictEqual(res11.data.error.code, -32700);
    assert.strictEqual(res11.data.error.message, 'Parse error');
    assert.strictEqual(mockServer.recordedRequests.length, 0);

    console.log('All Node.js MCP Gateway tests passed successfully!');
  } finally {
    mockServer.close();
    gatewayServer.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

