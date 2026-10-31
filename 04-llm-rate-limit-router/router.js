const { RateLimitError, TimeoutError, UpstreamError, GatewayError, formatErrorResponse } = require('./errors');

class LLMGatewayRouter {
  constructor(options = {}) {
    this.rateLimiter = options.rateLimiter;
    this.primaryProvider = options.primaryProvider;
    this.secondaryProvider = options.secondaryProvider;
    this.primaryTimeoutMs = options.primaryTimeoutMs ?? 3000;
    this.secondaryTimeoutMs = options.secondaryTimeoutMs ?? 5000;
    this.defaultLimit = options.defaultLimit ?? 50000;
    this.defaultWindowMs = options.defaultWindowMs ?? 60000;
  }

  estimateTokens(payload) {
    if (payload.tokens && typeof payload.tokens === 'number') {
      return payload.tokens;
    }
    let chars = 0;
    if (typeof payload.prompt === 'string') {
      chars += payload.prompt.length;
    }
    if (Array.isArray(payload.messages)) {
      for (const msg of payload.messages) {
        if (msg && typeof msg.content === 'string') {
          chars += msg.content.length;
        }
      }
    }
    const maxTokens = typeof payload.max_tokens === 'number' ? payload.max_tokens : 500;
    const promptEstimated = Math.ceil(chars / 4);
    return Math.max(1, promptEstimated + maxTokens);
  }

  async executeWithTimeout(provider, payload, timeoutMs) {
    const controller = new AbortController();
    let timerId = null;
    let didTimeout = false;

    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        didTimeout = true;
        controller.abort();
        reject(new TimeoutError(`Provider ${provider.name || 'endpoint'} timed out after ${timeoutMs}ms`, {
          timeout_ms: timeoutMs,
          provider: provider.name || 'unknown'
        }));
      }, timeoutMs);
    });

    try {
      const callPromise = Promise.resolve(provider.call(payload, controller.signal));
      const result = await Promise.race([callPromise, timeoutPromise]);
      if (timerId) clearTimeout(timerId);
      return result;
    } catch (err) {
      if (timerId) clearTimeout(timerId);
      if (didTimeout || controller.signal.aborted || err.name === 'AbortError') {
        throw new TimeoutError(`Provider ${provider.name || 'endpoint'} timed out after ${timeoutMs}ms`, {
          timeout_ms: timeoutMs,
          provider: provider.name || 'unknown'
        });
      }
      throw err;
    }
  }

  isFallbackTrigger(error) {
    if (error instanceof TimeoutError) {
      return { shouldFallback: true, reason: 'primary_timeout' };
    }
    const status = error.statusCode || error.status || (error.response && error.response.status);
    if (status === 429) {
      return { shouldFallback: true, reason: 'primary_429' };
    }
    if (error.code === 'RATE_LIMIT_EXCEEDED' || error.code === 'ETIMEDOUT' || error.code === 'UPSTREAM_TIMEOUT') {
      return { shouldFallback: true, reason: 'primary_rate_limit_or_timeout' };
    }
    return { shouldFallback: false, reason: null };
  }

  async routeCompletion(tenantId, payload) {
    const estimatedTokens = this.estimateTokens(payload);
    let reservation = null;

    if (this.rateLimiter) {
      reservation = this.rateLimiter.checkAndReserve(
        tenantId,
        estimatedTokens,
        this.defaultLimit,
        this.defaultWindowMs
      );
    }

    let response = null;
    let fallbackInfo = null;

    try {
      response = await this.executeWithTimeout(this.primaryProvider, payload, this.primaryTimeoutMs);
      fallbackInfo = { fallback: false, provider: this.primaryProvider.name || 'primary' };
    } catch (primaryErr) {
      const fallbackCheck = this.isFallbackTrigger(primaryErr);

      if (!fallbackCheck.shouldFallback || !this.secondaryProvider) {
        if (reservation) {
          this.rateLimiter.release(reservation.reservationId);
        }
        if (primaryErr instanceof GatewayError) {
          throw primaryErr;
        }
        throw new UpstreamError('Primary upstream model failed and no fallback was possible', 502, {
          provider: this.primaryProvider.name || 'primary',
          cause: primaryErr.code || 'UPSTREAM_FAILURE'
        });
      }

      try {
        response = await this.executeWithTimeout(this.secondaryProvider, payload, this.secondaryTimeoutMs);
        fallbackInfo = {
          fallback: true,
          provider: this.secondaryProvider.name || 'secondary',
          fallback_reason: fallbackCheck.reason
        };
      } catch (secondaryErr) {
        if (reservation) {
          this.rateLimiter.release(reservation.reservationId);
        }
        if (secondaryErr instanceof GatewayError) {
          throw secondaryErr;
        }
        throw new UpstreamError('Secondary backup model provider failed after failover', 502, {
          primary_reason: fallbackCheck.reason,
          secondary_cause: secondaryErr.code || 'BACKUP_FAILURE'
        });
      }
    }

    let actualTokens = estimatedTokens;
    if (response && response.usage && typeof response.usage.total_tokens === 'number') {
      actualTokens = response.usage.total_tokens;
    }

    if (reservation) {
      this.rateLimiter.settle(reservation.reservationId, actualTokens);
    }

    return {
      ...response,
      gateway: {
        ...fallbackInfo,
        tokens_billed: actualTokens,
        tokens_reserved: estimatedTokens
      }
    };
  }

  async handleRequest(tenantId, payload) {
    try {
      if (!tenantId) {
        throw new GatewayError('Tenant API key or ID is required', 401, 'UNAUTHORIZED', 'authentication_error');
      }
      const result = await this.routeCompletion(tenantId, payload);
      return {
        status: 200,
        body: result
      };
    } catch (err) {
      const formatted = formatErrorResponse(err);
      const status = err.statusCode || (err instanceof RateLimitError ? 429 : 500);
      return {
        status,
        body: formatted
      };
    }
  }
}

module.exports = {
  LLMGatewayRouter
};
