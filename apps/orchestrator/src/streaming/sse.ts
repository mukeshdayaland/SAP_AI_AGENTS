import type { ServerResponse } from 'node:http';
import { encodeSSE, type StreamEvent } from '@prowess/contracts';

/**
 * Server-Sent Events writer. Sends a comment heartbeat so proxies (approuter,
 * CF gorouter) keep the connection open during long tool calls, and exposes
 * an AbortSignal that fires when the client disconnects.
 */
export class SSEStream {
  readonly controller = new AbortController();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly res: ServerResponse,
    headers: Record<string, string> = {},
  ) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      ...headers,
    });
    res.flushHeaders();
    this.heartbeat = setInterval(() => this.raw(': keep-alive\n\n'), 15_000);
    res.on('close', () => {
      if (!this.closed) this.controller.abort(new Error('client disconnected'));
      this.dispose();
    });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  send(event: StreamEvent): void {
    this.raw(encodeSSE(event));
  }

  private raw(chunk: string) {
    if (this.closed || this.res.writableEnded) return;
    this.res.write(chunk);
  }

  end(): void {
    this.closed = true;
    this.dispose();
    if (!this.res.writableEnded) this.res.end();
  }

  private dispose() {
    clearInterval(this.heartbeat);
  }
}
