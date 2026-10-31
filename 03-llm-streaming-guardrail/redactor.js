import { Transform } from 'node:stream';

export class StreamingPIIRedactor extends Transform {
  constructor(options = {}) {
    super({ ...options, decodeStrings: false });
    this.buffer = '';
    this.maxLookahead = options.maxLookahead || 80;
    this.patterns = [
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g,
      /\b(?:\d{4}[- ]?){3}\d{4}\b/g,
      /\b\d{13,19}\b/g
    ];
  }

  _redact(text) {
    let result = text;
    for (const pattern of this.patterns) {
      result = result.replace(pattern, '[REDACTED]');
    }
    return result;
  }

  _findSafeBoundary(text) {
    if (!text) return 0;
    let hazardIndex = text.length;

    const trailingDigitsMatch = text.match(/[\d\- ]+$/);
    if (trailingDigitsMatch && /\d/.test(trailingDigitsMatch[0])) {
      const matchLen = Math.min(trailingDigitsMatch[0].length, 24);
      const digitStart = text.length - matchLen;
      hazardIndex = Math.min(hazardIndex, digitStart);
    }

    const lastAt = text.lastIndexOf('@');
    if (lastAt !== -1 && text.length - lastAt < 64) {
      let emailCandidateStart = lastAt;
      while (emailCandidateStart > 0 && /[a-zA-Z0-9._%+-]/.test(text[emailCandidateStart - 1])) {
        emailCandidateStart--;
      }
      hazardIndex = Math.min(hazardIndex, emailCandidateStart);
    } else {
      const trailingWordMatch = text.match(/[a-zA-Z0-9._%+-]+$/);
      if (trailingWordMatch) {
        const wordLen = Math.min(trailingWordMatch[0].length, 64);
        const wordStart = text.length - wordLen;
        hazardIndex = Math.min(hazardIndex, wordStart);
      }
    }

    const minSafeIndex = Math.max(0, text.length - this.maxLookahead);
    return Math.max(minSafeIndex, hazardIndex);
  }

  _transform(chunk, encoding, callback) {
    const chunkStr = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.buffer += chunkStr;

    const safeIndex = this._findSafeBoundary(this.buffer);
    if (safeIndex > 0) {
      const processPart = this.buffer.slice(0, safeIndex);
      this.buffer = this.buffer.slice(safeIndex);
      const redacted = this._redact(processPart);
      this.push(redacted);
    }
    callback();
  }

  _flush(callback) {
    if (this.buffer.length > 0) {
      const finalRedacted = this._redact(this.buffer);
      this.buffer = '';
      this.push(finalRedacted);
    }
    callback();
  }
}
