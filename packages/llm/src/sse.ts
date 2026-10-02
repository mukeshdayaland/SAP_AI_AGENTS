export interface SSEMessage {
  event?: string;
  data: string;
}

/** Incremental text/event-stream parser (WHATWG semantics, subset). */
export async function* parseSSE(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<SSEMessage> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];

  const flush = function* (): Generator<SSEMessage> {
    if (data.length) yield { ...(event !== undefined && { event }), data: data.join('\n') };
    event = undefined;
    data = [];
  };

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.search(/\r?\n/)) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 2 : 1));
      if (line === '') {
        yield* flush();
      } else if (line.startsWith(':')) {
        continue;
      } else {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') data.push(value);
        else if (field === 'event') event = value;
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
  yield* flush();
}
