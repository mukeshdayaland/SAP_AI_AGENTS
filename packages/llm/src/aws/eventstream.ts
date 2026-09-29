import { crc32 } from 'node:zlib';

/**
 * Decoder for the `application/vnd.amazon.eventstream` binary framing used by
 * Bedrock `ConverseStream`.
 *
 * Frame: [total len u32][headers len u32][prelude CRC u32][headers][payload][message CRC u32]
 */

export type HeaderValue = string | number | boolean | Uint8Array | bigint;

export interface EventStreamMessage {
  headers: Record<string, HeaderValue>;
  payload: Uint8Array;
}

export class EventStreamError extends Error {}

function parseHeaders(view: DataView, bytes: Uint8Array, start: number, end: number): Record<string, HeaderValue> {
  const headers: Record<string, HeaderValue> = {};
  const decoder = new TextDecoder();
  let pos = start;
  while (pos < end) {
    const nameLen = view.getUint8(pos);
    pos += 1;
    const name = decoder.decode(bytes.subarray(pos, pos + nameLen));
    pos += nameLen;
    const type = view.getUint8(pos);
    pos += 1;
    switch (type) {
      case 0:
        headers[name] = true;
        break;
      case 1:
        headers[name] = false;
        break;
      case 2:
        headers[name] = view.getInt8(pos);
        pos += 1;
        break;
      case 3:
        headers[name] = view.getInt16(pos);
        pos += 2;
        break;
      case 4:
        headers[name] = view.getInt32(pos);
        pos += 4;
        break;
      case 5:
      case 8:
        headers[name] = view.getBigInt64(pos);
        pos += 8;
        break;
      case 6:
      case 7: {
        const len = view.getUint16(pos);
        pos += 2;
        const raw = bytes.subarray(pos, pos + len);
        headers[name] = type === 7 ? decoder.decode(raw) : raw;
        pos += len;
        break;
      }
      case 9:
        headers[name] = bytes.subarray(pos, pos + 16);
        pos += 16;
        break;
      default:
        throw new EventStreamError(`Unknown header type ${type}`);
    }
  }
  return headers;
}

export function decodeMessage(frame: Uint8Array): EventStreamMessage {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const total = view.getUint32(0);
  const headersLen = view.getUint32(4);
  if (total !== frame.byteLength) throw new EventStreamError('Frame length mismatch');
  if (crc32(frame.subarray(0, 8)) !== view.getUint32(8)) throw new EventStreamError('Prelude CRC mismatch');
  if (crc32(frame.subarray(0, total - 4)) !== view.getUint32(total - 4)) throw new EventStreamError('Message CRC mismatch');
  const headers = parseHeaders(view, frame, 12, 12 + headersLen);
  return { headers, payload: frame.subarray(12 + headersLen, total - 4) };
}

/** Splits an arbitrary byte stream into complete event-stream messages. */
export async function* decodeEventStream(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<EventStreamMessage> {
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  for await (const chunk of chunks) {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;
    while (buffer.length >= 12) {
      const total = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0);
      if (total < 16 || total > 16 * 1024 * 1024) throw new EventStreamError(`Invalid frame length ${total}`);
      if (buffer.length < total) break;
      yield decodeMessage(buffer.slice(0, total));
      buffer = buffer.subarray(total);
    }
  }
  if (buffer.length) throw new EventStreamError('Stream ended mid-frame');
}

/** Encoder (string headers only) — used by tests and local mocks. */
export function encodeMessage(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const headerParts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = enc.encode(name);
    const v = enc.encode(value);
    const part = new Uint8Array(1 + n.length + 1 + 2 + v.length);
    const dv = new DataView(part.buffer);
    part[0] = n.length;
    part.set(n, 1);
    part[1 + n.length] = 7;
    dv.setUint16(2 + n.length, v.length);
    part.set(v, 4 + n.length);
    headerParts.push(part);
  }
  const headersLen = headerParts.reduce((s, p) => s + p.length, 0);
  const total = 12 + headersLen + payload.length + 4;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, total);
  dv.setUint32(4, headersLen);
  dv.setUint32(8, crc32(out.subarray(0, 8)));
  let pos = 12;
  for (const p of headerParts) {
    out.set(p, pos);
    pos += p.length;
  }
  out.set(payload, pos);
  dv.setUint32(total - 4, crc32(out.subarray(0, total - 4)));
  return out;
}
