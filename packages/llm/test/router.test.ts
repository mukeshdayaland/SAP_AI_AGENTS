import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/errors.js';
import { MockProvider } from '../src/providers/mock.js';
import { ModelRouter, type ModelTier } from '../src/router.js';
import type { LLMChunk, LLMProvider, ProviderId } from '../src/types.js';
import { drain } from './helpers.js';

function fake(id: ProviderId, isPrivate: boolean, behaviour: 'ok' | 'fail-before' | 'fail-after'): LLMProvider {
  return {
    id,
    private: isPrivate,
    async *stream(): AsyncGenerator<LLMChunk> {
      if (behaviour === 'fail-before') throw new ProviderError(id, 'unavailable', 'down');
      yield { type: 'text', text: `from ${id}` };
      if (behaviour === 'fail-after') throw new ProviderError(id, 'unavailable', 'mid-stream');
      yield { type: 'finish', reason: 'stop' };
    },
    complete: () => Promise.reject(new Error('unused')),
    healthCheck: async () => behaviour === 'ok',
  };
}

const tier = (patch: Partial<ModelTier> = {}): ModelTier => ({
  id: 'standard',
  label: 'Standard',
  description: '',
  requiredRoles: [],
  fallback: true,
  maxOutputTokens: 100,
  maxContextTokens: 1000,
  targets: [
    { provider: 'sap-ai-core', model: 'a' },
    { provider: 'azure-ai-foundry', model: 'b' },
  ],
  ...patch,
});

describe('ModelRouter', () => {
  it('falls back when the first provider fails before emitting output', async () => {
    const router = new ModelRouter(
      new Map<ProviderId, LLMProvider>([
        ['sap-ai-core', fake('sap-ai-core', true, 'fail-before')],
        ['azure-ai-foundry', fake('azure-ai-foundry', false, 'ok')],
      ]),
      { tiers: [tier()] },
    );
    const selections: string[] = [];
    const chunks = await drain(router.stream('standard', { messages: [] }, (s) => selections.push(s.provider)));
    expect(selections).toEqual(['sap-ai-core', 'azure-ai-foundry']);
    expect(chunks[0]).toEqual({ type: 'text', text: 'from azure-ai-foundry' });
  });

  it('never replaces a partially streamed answer', async () => {
    const router = new ModelRouter(
      new Map<ProviderId, LLMProvider>([
        ['sap-ai-core', fake('sap-ai-core', true, 'fail-after')],
        ['azure-ai-foundry', fake('azure-ai-foundry', false, 'ok')],
      ]),
      { tiers: [tier()] },
    );
    await expect(drain(router.stream('standard', { messages: [] }))).rejects.toThrow(/mid-stream/);
  });

  it('does not fall back when the tier forbids it', async () => {
    const router = new ModelRouter(
      new Map<ProviderId, LLMProvider>([
        ['sap-ai-core', fake('sap-ai-core', true, 'fail-before')],
        ['azure-ai-foundry', fake('azure-ai-foundry', false, 'ok')],
      ]),
      { tiers: [tier({ fallback: false })] },
    );
    await expect(drain(router.stream('standard', { messages: [] }))).rejects.toThrow(/down/);
  });

  it('keeps private tiers inside private providers', () => {
    const router = new ModelRouter(
      new Map<ProviderId, LLMProvider>([
        ['sap-ai-core', fake('sap-ai-core', true, 'ok')],
        ['azure-ai-foundry', fake('azure-ai-foundry', false, 'ok')],
      ]),
      { tiers: [tier({ id: 'private', privateOnly: true })] },
    );
    expect(router.resolveTargets('private').map((t) => t.provider)).toEqual(['sap-ai-core']);
  });

  it('honours DEFAULT_LLM_PROVIDER ordering', () => {
    const router = new ModelRouter(
      new Map<ProviderId, LLMProvider>([
        ['sap-ai-core', fake('sap-ai-core', true, 'ok')],
        ['azure-ai-foundry', fake('azure-ai-foundry', false, 'ok')],
      ]),
      { tiers: [tier()] },
      { preferredProvider: 'azure-ai-foundry' },
    );
    expect(router.resolveTargets('standard')[0]!.provider).toBe('azure-ai-foundry');
  });
});

describe('MockProvider', () => {
  it('selects the invoice tool for an invoice question', async () => {
    const p = new MockProvider();
    const chunks = await drain(
      p.stream({
        model: 'mock',
        messages: [{ role: 'user', content: 'Why is invoice 5100012345 blocked?' }],
        tools: [{ name: 'fico_getInvoice', description: '', inputSchema: {} }],
      }),
    );
    expect(chunks.find((c) => c.type === 'tool_call')).toMatchObject({ call: { name: 'fico_getInvoice', arguments: { invoiceNumber: '5100012345' } } });
  });

  it('never calls a tool that is not offered', async () => {
    const p = new MockProvider();
    const chunks = await drain(p.stream({ model: 'mock', messages: [{ role: 'user', content: 'release invoice 5100012345' }], tools: [] }));
    expect(chunks.some((c) => c.type === 'tool_call')).toBe(false);
  });
});
