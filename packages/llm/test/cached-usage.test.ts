import { describe, expect, it } from 'vitest';
import { GcpVertexProvider } from '../src/providers/gcp-vertex.js';
import { SapAiCoreProvider } from '../src/providers/sap-ai-core.js';
import { drain, fastPolicy, sseResponse, stubFetch } from './helpers.js';

const aiCore = (fetchImpl: typeof fetch) =>
  new SapAiCoreProvider({
    authUrl: 'https://tenant.authentication.eu10.hana.ondemand.com',
    clientId: 'cid',
    clientSecret: 'secret',
    apiUrl: 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com',
    resourceGroup: 'prowess',
    mode: 'orchestration',
    orchestrationDeploymentId: 'd123',
    policy: fastPolicy,
    fetchImpl,
  });

describe('prompt-cache hits in reported usage', () => {
  it('reads cached_tokens from the SAP AI Core orchestration final_result usage', async () => {
    const { impl } = stubFetch(() =>
      sseResponse(
        [
          { request_id: 'r', final_result: { choices: [{ index: 0, delta: { content: 'Blocked.' } }] } },
          {
            request_id: 'r',
            final_result: {
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 7_400, completion_tokens: 20, total_tokens: 7_420, prompt_tokens_details: { cached_tokens: 7_168, audio_tokens: 0 } },
            },
          },
        ],
        { done: true },
      ),
    );
    const chunks = await drain(aiCore(impl).stream({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'x' }] }));
    expect(chunks.filter((c) => c.type === 'usage')).toEqual([{ type: 'usage', usage: { inputTokens: 7_400, outputTokens: 20, cachedInputTokens: 7_168 } }]);
  });

  it('leaves cachedInputTokens out when nothing was served from cache', async () => {
    const { impl } = stubFetch(() =>
      sseResponse(
        [{ final_result: { choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } } } }],
        { done: true },
      ),
    );
    const chunks = await drain(aiCore(impl).stream({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'x' }] }));
    expect(chunks.filter((c) => c.type === 'usage')).toEqual([{ type: 'usage', usage: { inputTokens: 50, outputTokens: 2 } }]);
  });

  it('reads cachedContentTokenCount from Vertex AI Gemini usage metadata', async () => {
    const { impl } = stubFetch(() =>
      sseResponse([
        {
          candidates: [{ content: { role: 'model', parts: [{ text: 'Done' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 9_000, candidatesTokenCount: 15, cachedContentTokenCount: 8_192 },
        },
      ]),
    );
    const provider = new GcpVertexProvider({ projectId: 'prowess-ai-dev', location: 'europe-west3', auth: { type: 'access-token', token: 't' }, fetchImpl: impl, policy: fastPolicy });
    const chunks = await drain(provider.stream({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'x' }] }));
    expect(chunks.filter((c) => c.type === 'usage')).toEqual([{ type: 'usage', usage: { inputTokens: 9_000, outputTokens: 15, cachedInputTokens: 8_192 } }]);
  });
});
