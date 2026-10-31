import { Transform } from 'node:stream';

export class SSEParserTransform extends Transform {
  constructor(options = {}) {
    super({ ...options, readableObjectMode: false, writableObjectMode: false });
    this.buffer = '';
  }

  _transform(chunk, encoding, callback) {
    this.buffer += chunk.toString('utf8');
    const parts = this.buffer.split(/\r?\n\r?\n/);
    this.buffer = parts.pop() || '';

    for (const part of parts) {
      const lines = part.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') {
          continue;
        }
        try {
          const parsed = JSON.parse(dataStr);
          const deltaContent = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.text ?? '';
          if (deltaContent) {
            this.push(deltaContent);
          }
        } catch {
          if (dataStr) {
            this.push(dataStr);
          }
        }
      }
    }
    callback();
  }

  _flush(callback) {
    if (this.buffer.trim()) {
      const lines = this.buffer.trim().split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(dataStr);
          const deltaContent = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.text ?? '';
          if (deltaContent) {
            this.push(deltaContent);
          }
        } catch {
          if (dataStr) {
            this.push(dataStr);
          }
        }
      }
      this.buffer = '';
    }
    callback();
  }
}

export class SSESerializerTransform extends Transform {
  constructor(model = 'llm-guardrail', options = {}) {
    super({ ...options, decodeStrings: false });
    this.model = model;
    this.id = 'chatcmpl-' + Math.random().toString(36).substring(2, 11);
    this.created = Math.floor(Date.now() / 1000);
  }

  _transform(chunk, encoding, callback) {
    const text = chunk.toString('utf8');
    if (text.length > 0) {
      const payload = {
        id: this.id,
        object: 'chat.completion.chunk',
        created: this.created,
        model: this.model,
        choices: [
          {
            index: 0,
            delta: { content: text },
            finish_reason: null
          }
        ]
      };
      this.push(`data: ${JSON.stringify(payload)}\n\n`);
    }
    callback();
  }

  _flush(callback) {
    const finalPayload = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop'
        }
      ]
    };
    this.push(`data: ${JSON.stringify(finalPayload)}\n\n`);
    this.push('data: [DONE]\n\n');
    callback();
  }
}
