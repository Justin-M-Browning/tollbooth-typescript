import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Node.js MCP STDIO Isolation & Wire Compliance', () => {
  it('guarantees stdout contains strictly JSON-RPC and logs go to stderr', async () => {
    const serverPath = path.resolve(__dirname, '../dist/index.js');
    const child = spawn(process.execPath, [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const lines = text.split('\n').filter((l: string) => l.trim().length > 0);
      stdoutLines.push(...lines);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      const lines = text.split('\n').filter((l: string) => l.trim().length > 0);
      stderrLines.push(...lines);
    });

    const send = (msg: Record<string, unknown>) => {
      child.stdin.write(JSON.stringify(msg) + '\n');
    };

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-stdio-client', version: '1.0.0' },
      },
    });

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_customer_record', arguments: { customer_id: 'CUST-10001' } },
    });

    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_customer_record', arguments: { customer_id: 'BAD_ID' } },
    });

    await new Promise((r) => setTimeout(r, 1200));

    child.stdin.end();
    child.kill();

    expect(stdoutLines.length).toBeGreaterThanOrEqual(3);
    for (const line of stdoutLines) {
      let parsed: any;
      expect(() => {
        parsed = JSON.parse(line);
      }).not.toThrow();
      expect(parsed).toHaveProperty('jsonrpc', '2.0');
    }

    const initRes = stdoutLines.map((l) => JSON.parse(l)).find((m) => m.id === 1);
    expect(initRes).toBeDefined();
    expect(initRes.result.serverInfo.name).toBe('mcp-customer-service');

    const validRes = stdoutLines.map((l) => JSON.parse(l)).find((m) => m.id === 2);
    expect(validRes.result.content[0].text).toContain('Sarah Connor');

    const invalidRes = stdoutLines.map((l) => JSON.parse(l)).find((m) => m.id === 3);
    expect(invalidRes.error).toBeDefined();
    expect(invalidRes.error.code).toBe(-32602);

    expect(stderrLines.length).toBeGreaterThan(0);
    const hasLog = stderrLines.some((l) => l.includes('mcp-customer-service'));
    expect(hasLog).toBe(true);
  });
});

