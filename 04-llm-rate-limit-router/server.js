const http = require('node:http');
const { formatErrorResponse, GatewayError } = require('./errors');

function createGatewayServer(router) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/v1/completions')) {
      const authHeader = req.headers['authorization'] || '';
      const apiKeyHeader = req.headers['x-api-key'] || '';
      let tenantId = apiKeyHeader;
      if (!tenantId && authHeader.startsWith('Bearer ')) {
        tenantId = authHeader.substring(7).trim();
      }

      if (!tenantId) {
        const err = new GatewayError('Missing API key in Authorization or x-api-key header', 401, 'UNAUTHORIZED', 'authentication_error');
        res.writeHead(401);
        res.end(JSON.stringify(formatErrorResponse(err)));
        return;
      }

      let bodyStr = '';
      req.on('data', chunk => {
        bodyStr += chunk;
      });

      req.on('end', async () => {
        try {
          const payload = bodyStr ? JSON.parse(bodyStr) : {};
          const result = await router.handleRequest(tenantId, payload);
          res.writeHead(result.status);
          res.end(JSON.stringify(result.body));
        } catch (jsonErr) {
          const err = new GatewayError('Malformed JSON payload in request body', 400, 'BAD_REQUEST', 'invalid_request_error');
          res.writeHead(400);
          res.end(JSON.stringify(formatErrorResponse(err)));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify(formatErrorResponse(new GatewayError('Endpoint not found', 404, 'NOT_FOUND', 'invalid_request_error'))));
  });

  return server;
}

module.exports = {
  createGatewayServer
};
