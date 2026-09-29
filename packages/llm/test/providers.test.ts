import { describe, expect, it } from 'vitest';
import { createProvidersFromEnv } from '../src/factory.js';
import { AzureAIFoundryProvider } from '../src/providers/azure-ai-foundry.js';
import { GcpVertexProvider, toVertexSchema } from '../src/providers/gcp-vertex.js';
import { SapAiCoreProvider } from '../src/providers/sap-ai-core.js';
import { drain, fastPolicy, sseResponse, stubFetch } from './helpers.js';

const tools = [
  {
    name: 'fico_getInvoice',
    description: 'Get invoice',
    inputSchema: { type: 'object', properties: { invoiceNumber: { type: 'string' } }, required: ['invoiceNumber'], additionalProperties: false },
  },
];

const openAIToolStream = (wrap: (c: unknown) => unknown = (c) => c) => [
  wrap({ choices: [{ delta: { content: 'Let me ' } }] }),
  wrap({ choices: [{ delta: { content: 'check.' } }] }),
  wrap({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'fico_getInvoice', arguments: '{"invoice' } }] } }] }),
  wrap({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Number":"5100012345"}' } }] }, finish_reason: 'tool_calls' }] }),
  wrap({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 12 } }),
];

const expected = [
  { type: 'text', text: 'Let me ' },
  { type: 'text', text: 'check.' },
  { type: 'usage', usage: { inputTokens: 40, outputTokens: 12 } },
  { type: 'tool_call', call: { id: 'call_1', name: 'fico_getInvoice', arguments: { invoiceNumber: '5100012345' } } },
  { type: 'finish', reason: 'tool_calls' },
];

describe('SAP AI Core', () => {
  const base = {
    authUrl: 'https://tenant.authentication.eu10.hana.ondemand.com',
    clientId: 'cid',
    clientSecret: 'secret',
    apiUrl: 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com',
    resourceGroup: 'prowess',
    policy: fastPolicy,
  };

  it('calls the Orchestration v2 completion endpoint and unwraps final_result chunks', async () => {
    const { impl, calls } = stubFetch(() => sseResponse(openAIToolStream((c) => ({ request_id: 'r', final_result: c })), { done: true }));
    const provider = new SapAiCoreProvider({ ...base, mode: 'orchestration', orchestrationDeploymentId: 'd123', fetchImpl: impl });
    const chunks = await drain(
      provider.stream({ model: 'anthropic--claude-4-sonnet', messages: [{ role: 'user', content: 'Why is {{?x}} blocked?' }], tools, maxOutputTokens: 500 }),
    );
    expect(chunks).toEqual(expected);

    expect(calls[0]!.url).toBe('https://tenant.authentication.eu10.hana.ondemand.com/oauth/token');
    const inference = calls[1]!;
    expect(inference.url).toBe('https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com/v2/inference/deployments/d123/v2/completion');
    const headers = inference.init.headers as Record<string, string>;
    expect(headers['ai-resource-group']).toBe('prowess');
    expect(headers.authorization).toBe('Bearer test-token');
    const body = inference.body as { config: { modules: { prompt_templating: { prompt: { template: { content: string }[]; tools: unknown[] }; model: unknown } }; stream: unknown } };
    expect(body.config.stream).toEqual({ enabled: true });
    expect(body.config.modules.prompt_templating.model).toEqual({ name: 'anthropic--claude-4-sonnet', params: { max_tokens: 500 } });
    expect(body.config.modules.prompt_templating.prompt.tools).toHaveLength(1);
    // Untrusted text must not be interpreted as an orchestration placeholder.
    expect(body.config.modules.prompt_templating.prompt.template[0]!.content).not.toContain('{{?');
  });

  it('calls a foundation-model deployment in foundation mode', async () => {
    const { impl, calls } = stubFetch(() => sseResponse(openAIToolStream(), { done: true }));
    const provider = new SapAiCoreProvider({ ...base, apiUrl: `${base.apiUrl}/v2`, mode: 'foundation', fetchImpl: impl });
    expect(await drain(provider.stream({ model: 'dep-gpt', messages: [{ role: 'user', content: 'x' }], tools }))).toEqual(expected);
    expect(calls[1]!.url).toMatch(/\/v2\/inference\/deployments\/dep-gpt\/chat\/completions\?api-version=/);
  });

  it('retries on 429 honouring Retry-After, then succeeds', async () => {
    let n = 0;
    const { impl } = stubFetch(() =>
      n++ === 0 ? new Response('busy', { status: 429, headers: { 'retry-after': '0' } }) : sseResponse(openAIToolStream(), { done: true }),
    );
    const provider = new SapAiCoreProvider({ ...base, mode: 'foundation', fetchImpl: impl });
    expect(await drain(provider.stream({ model: 'd', messages: [{ role: 'user', content: 'x' }] }))).toEqual(expected);
    expect(n).toBe(2);
  });

  it('does not retry non-retryable errors', async () => {
    let n = 0;
    const { impl } = stubFetch(() => {
      n++;
      return new Response('bad', { status: 400 });
    });
    const provider = new SapAiCoreProvider({ ...base, mode: 'foundation', fetchImpl: impl });
    await expect(drain(provider.stream({ model: 'd', messages: [{ role: 'user', content: 'x' }] }))).rejects.toMatchObject({ kind: 'bad_request' });
    expect(n).toBe(1);
  });
});

describe('Azure AI Foundry', () => {
  it('uses the v1 endpoint with api-key auth', async () => {
    const { impl, calls } = stubFetch(() => sseResponse(openAIToolStream(), { done: true }));
    const provider = new AzureAIFoundryProvider({
      endpoint: 'https://prowess.openai.azure.com/',
      apiStyle: 'openai-v1',
      auth: { type: 'api-key', apiKey: 'k' },
      fetchImpl: impl,
      policy: fastPolicy,
    });
    expect(await drain(provider.stream({ model: 'gpt-4.1', messages: [{ role: 'user', content: 'x' }], tools, correlationId: 'PRW-1' }))).toEqual(expected);
    expect(calls[0]!.url).toBe('https://prowess.openai.azure.com/openai/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>)['api-key']).toBe('k');
    expect((calls[0]!.body as { model: string }).model).toBe('gpt-4.1');
  });

  it('acquires an Entra ID token for client-secret auth', async () => {
    const { impl, calls } = stubFetch(() => sseResponse(openAIToolStream(), { done: true }));
    const provider = new AzureAIFoundryProvider({
      endpoint: 'https://prowess.services.ai.azure.com',
      apiStyle: 'openai-deployments',
      auth: { type: 'client-secret', tenantId: 't', clientId: 'c', clientSecret: 's' },
      fetchImpl: impl,
      policy: fastPolicy,
    });
    await drain(provider.stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }));
    expect(calls[0]!.url).toBe('https://login.microsoftonline.com/t/oauth2/v2.0/token');
    expect(String(calls[0]!.init.body)).toContain('scope=https%3A%2F%2Fcognitiveservices.azure.com%2F.default');
    expect(calls[1]!.url).toMatch(/\/openai\/deployments\/gpt-4o\/chat\/completions\?api-version=/);
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer test-token');
  });
});

describe('Google Vertex AI', () => {
  it('streams Gemini responses including function calls', async () => {
    const { impl, calls } = stubFetch(() =>
      sseResponse([
        { candidates: [{ content: { role: 'model', parts: [{ text: 'Checking' }] } }] },
        {
          candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'fico_getInvoice', args: { invoiceNumber: '5100012345' } } }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5 },
        },
      ]),
    );
    const provider = new GcpVertexProvider({
      projectId: 'prowess-ai-dev',
      location: 'europe-west3',
      auth: { type: 'access-token', token: 't' },
      fetchImpl: impl,
      policy: fastPolicy,
    });
    const chunks = await drain(provider.stream({ model: 'gemini-2.5-pro', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'x' }], tools }));
    expect(calls[0]!.url).toBe(
      'https://europe-west3-aiplatform.googleapis.com/v1/projects/prowess-ai-dev/locations/europe-west3/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    );
    const body = calls[0]!.body as { systemInstruction: unknown; tools: { functionDeclarations: { parameters: Record<string, unknown> }[] }[] };
    expect(body.systemInstruction).toEqual({ parts: [{ text: 's' }] });
    expect(body.tools[0]!.functionDeclarations[0]!.parameters).not.toHaveProperty('additionalProperties');
    expect(chunks).toEqual([
      { type: 'text', text: 'Checking' },
      { type: 'tool_call', call: { id: 'fico_getInvoice_0', name: 'fico_getInvoice', arguments: { invoiceNumber: '5100012345' } } },
      { type: 'usage', usage: { inputTokens: 30, outputTokens: 5 } },
      { type: 'finish', reason: 'tool_calls' },
    ]);
  });

  it('converts JSON-schema nullable unions to OpenAPI form', () => {
    expect(toVertexSchema({ type: ['string', 'null'], $schema: 'x', default: 'a' })).toEqual({ type: 'string', nullable: true });
  });
});

describe('provider factory', () => {
  it('enables only providers with configuration present', () => {
    const { providers } = createProvidersFromEnv(
      { AZURE_AI_ENDPOINT: 'https://x.openai.azure.com', AZURE_AI_API_KEY: 'k', GCP_PROJECT_ID: 'prowess-ai-dev', GCP_ACCESS_TOKEN: 't' },
      { allowMock: false },
    );
    expect([...providers.keys()].sort()).toEqual(['azure-ai-foundry', 'gcp-vertex']);
  });

  it('reads SAP AI Core credentials from a VCAP_SERVICES binding', () => {
    const vcap = JSON.stringify({
      aicore: [{ credentials: { clientid: 'c', clientsecret: 's', url: 'https://auth', serviceurls: { AI_API_URL: 'https://api' } } }],
    });
    const { providers } = createProvidersFromEnv({ VCAP_SERVICES: vcap, AICORE_ORCHESTRATION_DEPLOYMENT_ID: 'd' }, { allowMock: false });
    expect(providers.has('sap-ai-core')).toBe(true);
  });

  it('fails fast on partial configuration', () => {
    expect(() => createProvidersFromEnv({ AZURE_AI_ENDPOINT: 'https://x', AZURE_AI_AUTH: 'client-secret' }, { allowMock: false })).toThrow(/AZURE_TENANT_ID/);
  });
});
