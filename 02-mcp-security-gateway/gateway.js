import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';

export function createJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const b64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
  const b64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${b64Header}.${b64Payload}`)
    .digest('base64url');
  return `${b64Header}.${b64Payload}.${signature}`;
}

export function verifyJwt(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [b64Header, b64Payload, signature] = parts;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${b64Header}.${b64Payload}`)
    .digest('base64url');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(b64Payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function extractRoleFromAuthHeader(headerValue, secret, tokenMap = {}) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  if (tokenMap[token]) return tokenMap[token];
  if (token === 'admin' || token === 'viewer') return token;
  const payload = verifyJwt(token, secret);
  if (payload) {
    if (payload.role) return payload.role;
    if (Array.isArray(payload.roles) && payload.roles.length > 0) return payload.roles[0];
  }
  return null;
}
export function createGatewayServer(options = {}) {
  const downstreamUrl = new URL(options.downstreamUrl || 'http://127.0.0.1:4001');
  const secret = options.jwtSecret || 'mcp-gateway-secret-key-12345';
  const tokenMap = options.tokenMap || {
    'admin-token': 'admin',
    'viewer-token': 'viewer'
  };

  const bodyParserMiddleware = async (ctx, next) => {
    const chunks = [];
    for await (const chunk of ctx.req) {
      chunks.push(chunk);
    }
    ctx.rawBody = Buffer.concat(chunks);
    if (ctx.rawBody.length > 0) {
      try {
        ctx.jsonRpc = JSON.parse(ctx.rawBody.toString('utf8'));
      } catch (err) {
        const errorResponse = {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: 'Parse error'
          }
        };
        const payload = Buffer.from(JSON.stringify(errorResponse), 'utf8');
        ctx.res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': payload.length
        });
        ctx.res.end(payload);
        ctx.intercepted = true;
        return;
      }
    } else {
      ctx.jsonRpc = null;
    }
    await next();
  };

  const bearerAuthMiddleware = async (ctx, next) => {
    const authHeader = ctx.req.headers['authorization'];
    ctx.role = extractRoleFromAuthHeader(authHeader, secret, tokenMap);
    await next();
  };

  const mcpSecurityGateMiddleware = async (ctx, next) => {
    if (ctx.jsonRpc && typeof ctx.jsonRpc === 'object') {
      const { method, params, id } = ctx.jsonRpc;
      if (method === 'tools/call') {
        const toolName = params && typeof params === 'object' ? params.name : null;
        if (typeof toolName === 'string' && toolName.startsWith('admin_')) {
          if (ctx.role !== 'admin') {
            const errorResponse = {
              jsonrpc: '2.0',
              id: id !== undefined ? id : null,
              error: {
                code: -32001,
                message: 'Unauthorized Tool Call'
              }
            };
            const payload = Buffer.from(JSON.stringify(errorResponse), 'utf8');
            ctx.res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Length': payload.length
            });
            ctx.res.end(payload);
            ctx.intercepted = true;
            return;
          }
        }
      }
    }
    await next();
  };

  const proxyForwardMiddleware = async (ctx) => {
    if (ctx.intercepted) return;

    return new Promise((resolve) => {
      const headers = { ...ctx.req.headers };
      const hopByHopHeaders = [
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
        'content-length'
      ];
      for (const h of hopByHopHeaders) {
        delete headers[h];
      }
      headers['host'] = downstreamUrl.host;
      if (ctx.rawBody && ctx.rawBody.length > 0) {
        headers['content-length'] = ctx.rawBody.length;
      }

      const proxyReq = http.request(
        {
          hostname: downstreamUrl.hostname,
          port: downstreamUrl.port || 80,
          path: ctx.req.url,
          method: ctx.req.method,
          headers: headers
        },
        (downstreamRes) => {
          const outHeaders = { ...downstreamRes.headers };
          for (const h of hopByHopHeaders) {
            delete outHeaders[h];
          }
          ctx.res.writeHead(downstreamRes.statusCode || 200, outHeaders);
          downstreamRes.pipe(ctx.res);
          downstreamRes.on('end', resolve);
        }
      );

      proxyReq.on('error', (err) => {
        if (!ctx.res.headersSent) {
          const errResp = {
            jsonrpc: '2.0',
            id: ctx.jsonRpc && ctx.jsonRpc.id !== undefined ? ctx.jsonRpc.id : null,
            error: {
              code: -32603,
              message: 'Internal error: downstream failure: ' + err.message
            }
          };
          const errBuf = Buffer.from(JSON.stringify(errResp), 'utf8');
          ctx.res.writeHead(502, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': errBuf.length
          });
          ctx.res.end(errBuf);
        }
        resolve();
      });

      if (ctx.rawBody && ctx.rawBody.length > 0) {
        proxyReq.write(ctx.rawBody);
      }
      proxyReq.end();
    });
  };

  const middlewares = [
    bodyParserMiddleware,
    bearerAuthMiddleware,
    mcpSecurityGateMiddleware,
    proxyForwardMiddleware
  ];

  const server = http.createServer((req, res) => {
    const ctx = {
      req,
      res,
      rawBody: null,
      jsonRpc: null,
      role: null,
      intercepted: false
    };

    let index = 0;
    const dispatch = async () => {
      if (index >= middlewares.length) return;
      const fn = middlewares[index++];
      await fn(ctx, dispatch);
    };

    dispatch().catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith('gateway.js')) {
  const port = parseInt(process.env.GATEWAY_PORT || '3000', 10);
  const downstreamUrl = process.env.DOWNSTREAM_URL || 'http://127.0.0.1:4001';
  const server = createGatewayServer({ downstreamUrl });
  server.listen(port, () => {
    console.log(`Node MCP Security Gateway listening on http://127.0.0.1:${port}`);
  });
}

