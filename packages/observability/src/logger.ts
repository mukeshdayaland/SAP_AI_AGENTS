import { currentContext } from './context.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are always masked, at any depth. */
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|api[-_]?key|cookie|credential|private[-_]?key|assertion/i;
/** Keys that may contain prompt or business content; dropped unless explicitly allowed. */
const CONTENT_KEY = /^(prompt|messages|content|body|payload|arguments|args|input|output)$/i;

export interface LoggerOptions {
  service: string;
  level?: LogLevel;
  /** Write sink; defaults to stdout. Injected in tests. */
  sink?: (line: string) => void;
  /** Allow content-bearing fields to be logged (never enable in production). */
  logContent?: boolean;
}

export function redact(value: unknown, logContent = false, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, logContent, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) out[k] = '[redacted]';
      else if (!logContent && CONTENT_KEY.test(k)) out[k] = '[omitted]';
      else out[k] = redact(v, logContent, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2_000) return `${value.slice(0, 2_000)}…`;
  return value;
}

export class Logger {
  private readonly min: number;
  private readonly sink: (line: string) => void;

  constructor(
    private readonly opts: LoggerOptions,
    private readonly bindings: Record<string, unknown> = {},
  ) {
    this.min = LEVELS[opts.level ?? 'info'];
    this.sink = opts.sink ?? ((line) => process.stdout.write(`${line}\n`));
  }

  child(bindings: Record<string, unknown>): Logger {
    return new Logger(this.opts, { ...this.bindings, ...bindings });
  }

  debug(msg: string, fields?: Record<string, unknown>) {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>) {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>) {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>) {
    this.write('error', msg, fields);
  }

  private write(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (LEVELS[level] < this.min) return;
    const ctx = currentContext();
    const record = {
      ts: new Date().toISOString(),
      level,
      service: this.opts.service,
      msg,
      ...(ctx && {
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        traceId: ctx.traceId,
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        agent: ctx.agent,
        provider: ctx.provider,
      }),
      ...(redact({ ...this.bindings, ...fields }, this.opts.logContent) as Record<string, unknown>),
    };
    this.sink(JSON.stringify(record));
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  return new Logger(opts);
}
