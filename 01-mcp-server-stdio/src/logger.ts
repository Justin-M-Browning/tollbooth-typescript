export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

class StderrLogger {
  private currentLevel: LogLevel = LogLevel.INFO;

  public setLogLevel(level: LogLevel): void {
    this.currentLevel = level;
  }

  private formatMessage(level: string, message: string, meta?: unknown): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta !== undefined ? ` | ${typeof meta === 'object' ? JSON.stringify(meta) : String(meta)}` : '';
    return `[${timestamp}] [${level}] ${message}${metaStr}\n`;
  }

  public debug(message: string, meta?: unknown): void {
    if (this.currentLevel <= LogLevel.DEBUG) {
      process.stderr.write(this.formatMessage('DEBUG', message, meta));
    }
  }

  public info(message: string, meta?: unknown): void {
    if (this.currentLevel <= LogLevel.INFO) {
      process.stderr.write(this.formatMessage('INFO', message, meta));
    }
  }

  public warn(message: string, meta?: unknown): void {
    if (this.currentLevel <= LogLevel.WARN) {
      process.stderr.write(this.formatMessage('WARN', message, meta));
    }
  }

  public error(message: string, meta?: unknown): void {
    if (this.currentLevel <= LogLevel.ERROR) {
      process.stderr.write(this.formatMessage('ERROR', message, meta));
    }
  }
}

export const logger = new StderrLogger();

export function enforceStdioIsolation(): void {
  console.log = (...args: unknown[]) => {
    process.stderr.write(`[CONSOLE.LOG -> STDERR] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`);
  };

  console.info = (...args: unknown[]) => {
    process.stderr.write(`[CONSOLE.INFO -> STDERR] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`);
  };

  console.warn = (...args: unknown[]) => {
    process.stderr.write(`[CONSOLE.WARN -> STDERR] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`);
  };
}

