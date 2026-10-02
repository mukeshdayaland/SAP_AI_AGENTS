import type { LLMChunk } from '../src/types.js';

export interface RecordedCall {
  url: string;
  init: RequestInit;
  body: unknown;
}

/** Builds a fetch stub that answers token endpoints with a fake token and inference with `respond`. */
export function stubFetch(respond: (url: string) => Response) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input.toString();
    let body: unknown = init.body;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, init, body });
    if (/oauth|token/.test(new URL(url).pathname) && !/converse/.test(url)) {
      return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200 });
    }
    return respond(url);
  }) as typeof fetch;
  return { impl, calls };
}

export function sseResponse(events: unknown[], opts: { done?: boolean } = {}): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + (opts.done ? 'data: [DONE]\n\n' : '');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export async function drain(stream: AsyncIterable<LLMChunk>): Promise<LLMChunk[]> {
  const out: LLMChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

export const fastPolicy = { connectTimeoutMs: 2_000, idleTimeoutMs: 2_000, maxRetries: 2, baseBackoffMs: 1, maxBackoffMs: 5 };
