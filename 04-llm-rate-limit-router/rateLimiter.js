const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const { RateLimitError } = require('./errors');

class SlidingWindowRateLimiter {
  constructor(options = {}) {
    const dbPath = options.dbPath || path.join(__dirname, 'rate_limiter.db');
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.defaultLimit = options.defaultLimit || 50000;
    this.defaultWindowMs = options.defaultWindowMs || 60000;
    this.init();
  }

  init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS token_reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tenant_timestamp 
      ON token_reservations(tenant_id, timestamp);
    `);

    this.stmtEvict = this.db.prepare(`
      DELETE FROM token_reservations 
      WHERE timestamp < ?
    `);

    this.stmtSum = this.db.prepare(`
      SELECT COALESCE(SUM(tokens), 0) AS total 
      FROM token_reservations 
      WHERE tenant_id = ? AND timestamp >= ? AND status != 'released'
    `);

    this.stmtOldest = this.db.prepare(`
      SELECT MIN(timestamp) AS oldest 
      FROM token_reservations 
      WHERE tenant_id = ? AND timestamp >= ? AND status != 'released'
    `);

    this.stmtInsert = this.db.prepare(`
      INSERT INTO token_reservations (tenant_id, tokens, timestamp, status) 
      VALUES (?, ?, ?, 'active')
    `);

    this.stmtSettle = this.db.prepare(`
      UPDATE token_reservations 
      SET tokens = ?, status = 'committed' 
      WHERE id = ?
    `);

    this.stmtRelease = this.db.prepare(`
      UPDATE token_reservations 
      SET tokens = 0, status = 'released' 
      WHERE id = ?
    `);
  }

  evictExpired(windowMs = this.defaultWindowMs, now = Date.now()) {
    const cutoff = now - windowMs;
    const result = this.stmtEvict.run(cutoff);
    return result.changes;
  }

  checkAndReserve(tenantId, tokens, limit = this.defaultLimit, windowMs = this.defaultWindowMs) {
    if (!tenantId || typeof tenantId !== 'string') {
      throw new Error('Valid tenant_id is required');
    }
    if (typeof tokens !== 'number' || tokens <= 0) {
      throw new Error('Valid positive tokens count is required');
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      const cutoff = now - windowMs;
      this.stmtEvict.run(cutoff);

      const sumRow = this.stmtSum.get(tenantId, cutoff);
      const currentUsage = sumRow ? Number(sumRow.total) : 0;

      if (currentUsage + tokens > limit) {
        const oldestRow = this.stmtOldest.get(tenantId, cutoff);
        const oldest = oldestRow && oldestRow.oldest ? Number(oldestRow.oldest) : now;
        const retryAfterMs = Math.max(0, (oldest + windowMs) - now);

        this.db.exec('ROLLBACK');
        throw new RateLimitError('Tenant token rate limit exceeded', {
          limit,
          window_ms: windowMs,
          current_usage: currentUsage,
          requested_tokens: tokens,
          retry_after_ms: retryAfterMs
        });
      }

      const insertResult = this.stmtInsert.run(tenantId, tokens, now);
      const reservationId = insertResult.lastInsertRowid;
      this.db.exec('COMMIT');

      return {
        reservationId,
        tenantId,
        allocatedTokens: tokens,
        currentUsage: currentUsage + tokens,
        limit,
        remainingTokens: Math.max(0, limit - (currentUsage + tokens))
      };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_) {}
      throw err;
    }
  }

  settle(reservationId, actualTokens) {
    if (!reservationId) return;
    this.stmtSettle.run(actualTokens, reservationId);
  }

  release(reservationId) {
    if (!reservationId) return;
    this.stmtRelease.run(reservationId);
  }

  getUsage(tenantId, windowMs = this.defaultWindowMs) {
    const now = Date.now();
    const cutoff = now - windowMs;
    const sumRow = this.stmtSum.get(tenantId, cutoff);
    const used = sumRow ? Number(sumRow.total) : 0;
    return {
      tenantId,
      used,
      windowMs,
      limit: this.defaultLimit,
      remaining: Math.max(0, this.defaultLimit - used)
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = {
  SlidingWindowRateLimiter
};
