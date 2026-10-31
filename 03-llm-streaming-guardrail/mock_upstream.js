import http from 'node:http';

export function createMockUpstream() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });

      req.on('end', () => {
        let parsed = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = {};
        }

        const isChat = req.url.includes('/v1/chat/completions');
        const chunks = parsed.custom_chunks || [
          'Hello, ',
          'my name is ',
          'Alice and my email ',
          'is alice.',
          'smith',
          '@company.org. ',
          'My SSN is 123-',
          '45-67',
          '89. ',
          'Card: 4532-',
          '1111-2222',
          '-3333 is verified.',
          ' End of message.'
        ];

        const delayMs = parsed.delay_ms !== undefined ? parsed.delay_ms : 20;

        if (isChat) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });

          let i = 0;
          const interval = setInterval(() => {
            if (i < chunks.length) {
              const payload = {
                id: 'chatcmpl-mock',
                object: 'chat.completion.chunk',
                created: Date.now(),
                choices: [
                  {
                    index: 0,
                    delta: { content: chunks[i] },
                    finish_reason: null
                  }
                ]
              };
              res.write(`data: ${JSON.stringify(payload)}\n\n`);
              i++;
            } else {
              clearInterval(interval);
              res.write('data: [DONE]\n\n');
              res.end();
            }
          }, delayMs);

          res.on('close', () => {
            if (!res.writableEnded) {
              clearInterval(interval);
            }
          });
        } else {
          res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Transfer-Encoding': 'chunked'
          });

          let i = 0;
          const interval = setInterval(() => {
            if (i < chunks.length) {
              res.write(chunks[i]);
              i++;
            } else {
              clearInterval(interval);
              res.end();
            }
          }, delayMs);

          res.on('close', () => {
            if (!res.writableEnded) {
              clearInterval(interval);
            }
          });
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}

if (process.argv[1] && process.argv[1].endsWith('mock_upstream.js')) {
  const port = parseInt(process.env.MOCK_PORT || '8001', 10);
  const server = createMockUpstream();
  server.listen(port, () => {
    process.stdout.write(`Mock Upstream listening on port ${port}\n`);
  });
}
