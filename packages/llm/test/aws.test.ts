import { describe, expect, it } from 'vitest';
import { decodeEventStream, encodeMessage } from '../src/aws/eventstream.js';
import { signRequest } from '../src/aws/sigv4.js';
import { AwsBedrockProvider, toConverseMessages } from '../src/providers/aws-bedrock.js';
import { drain, fastPolicy, stubFetch } from './helpers.js';

describe('SigV4', () => {
  it('matches the AWS test-suite "get-vanilla" vector', () => {
    const headers = signRequest({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {},
      body: '',
      service: 'service',
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('adds the session token for temporary credentials', () => {
    const headers = signRequest({
      method: 'POST',
      url: new URL('https://bedrock-runtime.eu-central-1.amazonaws.com/model/x/converse-stream'),
      headers: { 'content-type': 'application/json' },
      body: '{}',
      service: 'bedrock',
      region: 'eu-central-1',
      credentials: { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' },
    });
    expect(headers['x-amz-security-token']).toBe('ST');
    expect(headers.authorization).toContain('x-amz-security-token');
  });
});

describe('event-stream decoding', () => {
  it('round-trips frames split across arbitrary chunk boundaries', async () => {
    const frames = [
      encodeMessage({ ':event-type': 'a', ':message-type': 'event' }, new TextEncoder().encode('{"x":1}')),
      encodeMessage({ ':event-type': 'b', ':message-type': 'event' }, new TextEncoder().encode('{"y":2}')),
    ];
    const all = new Uint8Array(frames[0]!.length + frames[1]!.length);
    all.set(frames[0]!);
    all.set(frames[1]!, frames[0]!.length);
    async function* chunks() {
      for (let i = 0; i < all.length; i += 7) yield all.subarray(i, i + 7);
    }
    const out = [];
    for await (const m of decodeEventStream(chunks())) out.push(m.headers[':event-type']);
    expect(out).toEqual(['a', 'b']);
  });

  it('rejects corrupted frames', async () => {
    const frame = encodeMessage({ ':event-type': 'a' }, new TextEncoder().encode('{}'));
    frame[frame.length - 6]! ^= 0xff;
    async function* one() {
      yield frame;
    }
    await expect(drain(decodeEventStream(one()) as never)).rejects.toThrow(/CRC/);
  });
});

describe('Bedrock Converse mapping', () => {
  it('merges consecutive same-role turns and maps tool results', () => {
    const { system, messages } = toConverseMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'fico_getInvoice', arguments: { invoiceNumber: '5100012345' } }] },
      { role: 'tool', toolCallId: 't1', name: 'fico_getInvoice', content: '{"ok":true}' },
      { role: 'user', content: 'thanks' },
    ]);
    expect(system).toEqual([{ text: 'sys' }]);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[2]!.content).toHaveLength(2);
  });

  it('streams text and assembles tool calls from ConverseStream events', async () => {
    const enc = (type: string, payload: unknown) =>
      encodeMessage({ ':event-type': type, ':message-type': 'event', ':content-type': 'application/json' }, new TextEncoder().encode(JSON.stringify(payload)));
    const frames = [
      enc('messageStart', { role: 'assistant' }),
      enc('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Checking ' } }),
      enc('contentBlockStart', { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'tu1', name: 'fico_getInvoice' } } }),
      enc('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '{"invoiceNumber":' } } }),
      enc('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '"5100012345"}' } } }),
      enc('messageStop', { stopReason: 'tool_use' }),
      enc('metadata', { usage: { inputTokens: 11, outputTokens: 7 } }),
    ];
    const body = new Blob(frames.map((f) => new Uint8Array(f))).stream();
    const { impl, calls } = stubFetch(() => new Response(body, { status: 200 }));
    const provider = new AwsBedrockProvider({
      region: 'eu-central-1',
      auth: { type: 'sigv4', credentials: async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK' }) },
      fetchImpl: impl,
      policy: fastPolicy,
    });
    const chunks = await drain(provider.stream({ model: 'eu.anthropic.claude-sonnet-4-20250514-v1:0', messages: [{ role: 'user', content: 'x' }] }));
    expect(calls[0]!.url).toBe('https://bedrock-runtime.eu-central-1.amazonaws.com/model/eu.anthropic.claude-sonnet-4-20250514-v1%3A0/converse-stream');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toMatch(/^AWS4-HMAC-SHA256/);
    expect(chunks).toEqual([
      { type: 'text', text: 'Checking ' },
      { type: 'usage', usage: { inputTokens: 11, outputTokens: 7 } },
      { type: 'tool_call', call: { id: 'tu1', name: 'fico_getInvoice', arguments: { invoiceNumber: '5100012345' } } },
      { type: 'finish', reason: 'tool_calls' },
    ]);
  });

  it('surfaces throttling exceptions as retryable rate-limit errors', async () => {
    const frame = encodeMessage(
      { ':message-type': 'exception', ':exception-type': 'throttlingException' },
      new TextEncoder().encode('{"message":"slow down"}'),
    );
    const { impl } = stubFetch(() => new Response(new Blob([new Uint8Array(frame)]).stream(), { status: 200 }));
    const provider = new AwsBedrockProvider({ region: 'us-east-1', auth: { type: 'api-key', apiKey: 'k' }, fetchImpl: impl, policy: fastPolicy });
    await expect(drain(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] }))).rejects.toMatchObject({
      kind: 'rate_limited',
      retryable: true,
    });
  });
});
