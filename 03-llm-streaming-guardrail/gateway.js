import http from 'node:http';
import { pipeline } from 'node:stream';
import { StreamingPIIRedactor } from './redactor.js';
import { SSEParserTransform, SSESerializerTransform } from './sse.js';

export function createGateway(upstreamUrl = process.env.UPSTREAM_URL || 'http://127.0.0.1:8001') {
  const upstream = new URL(upstreamUrl);

  const server = http.createServer((clientReq, clientRes) => {
    if (clientReq.method === 'GET' && clientReq.url === '/health') {
      clientRes.writeHead(200, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ status: 'ok', runtime: 'nodejs' }));
      return;
    }

    if (clientReq.method !== 'POST') {
      clientRes.writeHead(405, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    const isChatEndpoint = clientReq.url.includes('/v1/chat/completions');
    const isStreamEndpoint = clientReq.url.includes('/stream');

    if (!isChatEndpoint && !isStreamEndpoint) {
      clientRes.writeHead(404, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    const proxyHeaders = { ...clientReq.headers };
    delete proxyHeaders['host'];
    proxyHeaders['host'] = upstream.host;

    const proxyReq = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: clientReq.url,
        method: clientReq.method,
        headers: proxyHeaders
      },
      (upstreamRes) => {
        const isSSE =
          isChatEndpoint ||
          (upstreamRes.headers['content-type'] &&
            upstreamRes.headers['content-type'].includes('text/event-stream'));

        if (isSSE) {
          clientRes.writeHead(upstreamRes.statusCode || 200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
          });

          const parser = new SSEParserTransform();
          const redactor = new StreamingPIIRedactor();
          const serializer = new SSESerializerTransform();

          pipeline(upstreamRes, parser, redactor, serializer, clientRes, (err) => {
            if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
              if (!clientRes.headersSent) {
                clientRes.writeHead(502, { 'Content-Type': 'application/json' });
                clientRes.end(JSON.stringify({ error: 'Upstream stream error' }));
              }
            }
          });
        } else {
          clientRes.writeHead(upstreamRes.statusCode || 200, {
            'Content-Type': upstreamRes.headers['content-type'] || 'text/plain',
            'Transfer-Encoding': 'chunked',
            'X-Accel-Buffering': 'no'
          });

          const redactor = new StreamingPIIRedactor();

          pipeline(upstreamRes, redactor, clientRes, (err) => {
            if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
              if (!clientRes.headersSent) {
                clientRes.writeHead(502, { 'Content-Type': 'application/json' });
                clientRes.end(JSON.stringify({ error: 'Upstream stream error' }));
              }
            }
          });
        }
      }
    );

    proxyReq.on('error', (err) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'Upstream gateway unavailable', details: err.message }));
      }
    });

    clientRes.on('close', () => {
      if (!clientRes.writableEnded) {
        proxyReq.destroy();
      }
    });

    clientReq.pipe(proxyReq);
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith('gateway.js')) {
  const port = parseInt(process.env.PORT || '3000', 10);
  const server = createGateway();
  server.listen(port, () => {
    process.stdout.write(`Node.js Gateway listening on port ${port}\n`);
  });
}
