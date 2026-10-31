import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { createCustomerServer } from '../src/server.js';
import { db } from '../src/db.js';

describe('Node.js MCP Customer Server Unit & Protocol Tests', () => {
  let server: ReturnType<typeof createCustomerServer>;
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeEach(async () => {
    db.reset();
    server = createCustomerServer();
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  it('lists registered tools with correct schemas', async () => {
    const res = await client.listTools();
    expect(res.tools.map(t => t.name)).toEqual(['get_customer_record', 'trigger_refund']);
  });

  it('retrieves customer for valid CUST-XXXXX', async () => {
    const res = await client.callTool({
      name: 'get_customer_record',
      arguments: { customer_id: 'CUST-10001' },
    });
    const data = JSON.parse((res.content[0] as any).text);
    expect(data.name).toBe('Sarah Connor');
  });

  it('returns not found message for unseeded CUST-XXXXX', async () => {
    const res = await client.callTool({
      name: 'get_customer_record',
      arguments: { customer_id: 'CUST-99999' },
    });
    const data = JSON.parse((res.content[0] as any).text);
    expect(data.found).toBe(false);
  });

  it('rejects malformed customer_id with InvalidParams (-32602)', async () => {
    for (const badId of ['INVALID', 'CUST-12', 'CUST-123456', 'cust-10001', '10001', '']) {
      try {
        await client.callTool({ name: 'get_customer_record', arguments: { customer_id: badId } });
        expect.fail(`Expected failure for ${badId}`);
      } catch (err: any) {
        expect(err.code).toBe(ErrorCode.InvalidParams);
      }
    }
  });

  it('processes refund successfully for valid inputs', async () => {
    const res = await client.callTool({
      name: 'trigger_refund',
      arguments: { customer_id: 'CUST-10001', amount: 150.0, reason: 'Damaged item on delivery' },
    });
    const data = JSON.parse((res.content[0] as any).text);
    expect(data.status).toBe('PROCESSED');
    expect(data.amount).toBe(150.0);
  });

  it('rejects refund with non-positive amount (-32602)', async () => {
    for (const amount of [-10, 0]) {
      try {
        await client.callTool({
          name: 'trigger_refund',
          arguments: { customer_id: 'CUST-10001', amount, reason: 'Valid reason string' },
        });
        expect.fail(`Expected failure for amount ${amount}`);
      } catch (err: any) {
        expect(err.code).toBe(ErrorCode.InvalidParams);
      }
    }
  });

  it('rejects refund with reason shorter than 10 characters (-32602)', async () => {
    for (const reason of ['Short', '123456789', '']) {
      try {
        await client.callTool({
          name: 'trigger_refund',
          arguments: { customer_id: 'CUST-10001', amount: 50.0, reason },
        });
        expect.fail(`Expected failure for reason ${reason}`);
      } catch (err: any) {
        expect(err.code).toBe(ErrorCode.InvalidParams);
      }
    }
  });

  it('rejects unknown tool with MethodNotFound (-32601)', async () => {
    try {
      await client.callTool({ name: 'unknown', arguments: {} });
      expect.fail('Expected error');
    } catch (err: any) {
      expect(err.code).toBe(ErrorCode.MethodNotFound);
    }
  });
});
