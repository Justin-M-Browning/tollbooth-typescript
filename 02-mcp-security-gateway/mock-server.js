import http from 'node:http';

export function createMockServer(port = 4001) {
  const recordedRequests = [];

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = JSON.parse(rawBody);
      } catch (err) {
        body = rawBody;
      }

      recordedRequests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body
      });

      let responsePayload;
      if (body && body.method === 'tools/list') {
        responsePayload = {
          jsonrpc: '2.0',
          id: body.id !== undefined ? body.id : null,
          result: {
            tools: [
              {
                name: 'admin_reset_key',
                description: 'Reset an administrative key',
                inputSchema: { type: 'object', properties: { keyId: { type: 'string' } } }
              },
              {
                name: 'admin_delete_cache',
                description: 'Flush system caches',
                inputSchema: { type: 'object', properties: {} }
              },
              {
                name: 'read_status',
                description: 'Read system status',
                inputSchema: { type: 'object', properties: {} }
              }
            ]
          }
        };
      } else if (body && body.method === 'tools/call') {
        responsePayload = {
          jsonrpc: '2.0',
          id: body.id !== undefined ? body.id : null,
          result: {
            content: [
              {
                type: 'text',
                text: 'Successfully executed tool: ' + (body.params?.name || 'unknown')
              }
            ],
            isError: false
          }
        };
      } else {
        responsePayload = {
          jsonrpc: '2.0',
          id: body && body.id !== undefined ? body.id : null,
          result: { acknowledged: true }
        };
      }

      const responseBuffer = Buffer.from(JSON.stringify(responsePayload), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': responseBuffer.length
      });
      res.end(responseBuffer);
    });
  });

  server.recordedRequests = recordedRequests;
  server.clearRecords = () => {
    recordedRequests.length = 0;
  };

  return server;
}

if (process.argv[1] && process.argv[1].endsWith('mock-server.js')) {
  const port = parseInt(process.env.MOCK_PORT || '4001', 10);
  const server = createMockServer(port);
  server.listen(port, () => {
    console.log(`Mock MCP server listening on http://127.0.0.1:${port}`);
  });
}
