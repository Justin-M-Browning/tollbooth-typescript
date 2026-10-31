class GatewayError extends Error {
  constructor(message, statusCode = 500, code = 'GATEWAY_ERROR', type = 'gateway_error', details = null) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.type = type;
    this.details = details;
  }
}

class RateLimitError extends GatewayError {
  constructor(message, details = null) {
    super(message || 'Rate limit exceeded', 429, 'RATE_LIMIT_EXCEEDED', 'rate_limit_error', details);
  }
}

class TimeoutError extends GatewayError {
  constructor(message, details = null) {
    super(message || 'Upstream request timed out', 504, 'UPSTREAM_TIMEOUT', 'timeout_error', details);
  }
}

class UpstreamError extends GatewayError {
  constructor(message, statusCode = 502, details = null) {
    super(message || 'Upstream provider error', statusCode, 'UPSTREAM_ERROR', 'upstream_error', details);
  }
}

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') {
    return null;
  }
  const clean = {};
  for (const [key, val] of Object.entries(details)) {
    if (key === 'stack' || key === 'stackTrace' || key === 'url' || key === 'config') {
      continue;
    }
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean' || val === null) {
      clean[key] = val;
    }
  }
  return clean;
}

function formatErrorResponse(err) {
  if (err instanceof GatewayError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        type: err.type,
        details: sanitizeDetails(err.details)
      }
    };
  }
  return {
    error: {
      code: 'INTERNAL_GATEWAY_ERROR',
      message: 'A sanitized gateway error occurred during request processing.',
      type: 'gateway_error',
      details: null
    }
  };
}

module.exports = {
  GatewayError,
  RateLimitError,
  TimeoutError,
  UpstreamError,
  formatErrorResponse
};
