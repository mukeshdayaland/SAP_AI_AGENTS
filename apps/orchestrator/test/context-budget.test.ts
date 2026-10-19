import { MockProvider, type LLMMessage, type LLMProvider, type LLMRequest, type ProviderId } from '@prowess/llm';
import { fenceUntrusted } from '@prowess/security';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContext, estimateTokens, fitToolResults, toolSpecForModel, toolSpecTokens } from '../src/llm/context.js';
import type { ConversationRecord, MessageRecord } from '../src/persistence/types.js';
import { startStack, USERS } from './harness.js';

const conversation: ConversationRecord = { id: 'c', userId: 'u', tenantId: 't', title: 't', agent: 'fico', modelTier: 'standard', createdAt: '', updatedAt: '' };

function turns(n: number): MessageRecord[] {
  return Array.from({ length: n }, (_, i) => [
    { id: `u${i}`, conversationId: 'c', role: 'user' as const, content: `Question ${i}`, createdAt: `2026-10-14T10:${String(i).padStart(2, '0')}:00Z`, status: 'complete' as const },
    { id: `a${i}`, conversationId: 'c', role: 'assistant' as const, content: 'a'.repeat(600), toolContext: 's'.repeat(4_000), createdAt: `2026-10-14T10:${String(i).padStart(2, '0')}:30Z`, status: 'complete' as const },
  ]).flat();
}

describe('context budget', () => {
  it('sends the model no JSON Schema dialect marker', () => {
    const spec = toolSpecForModel({ name: 'ar_getAging', description: 'Aging', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: {} } });
    expect(spec.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('caps the history re-sent with each call and leaves the rest to the summary', () => {
    const history = turns(10);
    const budget = { maxContextTokens: 24_000, reservedOutputTokens: 1_500 };
    const window = buildContext({ system: 'S', conversation, history, userTurn: 'Now?', budget });
    const capped = buildContext({ system: 'S', conversation, history, userTurn: 'Now?', budget: { ...budget, maxHistoryTokens: 4_000 } });
    expect(window.messages).toHaveLength(22);
    expect(capped.messages.length).toBeLessThan(10);
    expect(capped.messages[1]).toMatchObject({ role: 'user' });
    expect(capped.overflow).toHaveLength(22 - capped.messages.length);
  });

  it('counts the tool definitions against the window', () => {
    const history = turns(10);
    const budget = { maxContextTokens: 24_000, reservedOutputTokens: 1_500 };
    const without = buildContext({ system: 'S', conversation, history, userTurn: 'Now?', budget });
    const withTools = buildContext({ system: 'S', conversation, history, userTurn: 'Now?', budget: { ...budget, toolTokens: 15_000 } });
    expect(withTools.messages.length).toBeLessThan(without.messages.length);
  });

  it('shortens the oldest tool results to their summary when a call would not fit', () => {
    const result = (summary: string) => fenceUntrusted('tool_result', JSON.stringify({ summary, rows: 'r'.repeat(20_000) }));
    const messages: LLMMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'ar_getAging', arguments: {} }] },
      { role: 'tool', toolCallId: '1', name: 'ar_getAging', content: result('Oldest result.') },
      { role: 'assistant', content: '', toolCalls: [{ id: '2', name: 'ar_getAging', arguments: {} }] },
      { role: 'tool', toolCallId: '2', name: 'ar_getAging', content: result('Latest result.') },
    ];
    const budget = { maxContextTokens: 16_000, reservedOutputTokens: 1_500, toolTokens: 5_000 };
    expect(fitToolResults(messages, budget)).toBe(1);
    expect(messages[3]!.content).toContain('Oldest result.');
    expect(messages[3]!.content).not.toContain('rrrr');
    expect(messages[3]!.content).toMatch(/^<untrusted kind="tool_result">/);
    expect(messages[5]!.content).toContain('rrrr');
    expect(messages.reduce((n, m) => n + estimateTokens(m.content), 0)).toBeLessThanOrEqual(16_000 - 1_500 - 5_000);
    // Nothing changes once it fits.
    expect(fitToolResults(messages, budget)).toBe(0);
  });
});

describe('what a FICO question sends the model', () => {
  const requests: LLMRequest[] = [];
  class Recorder extends MockProvider {
    override stream(req: LLMRequest) {
      requests.push(req);
      return super.stream(req);
    }
  }
  let stack: Awaited<ReturnType<typeof startStack>>;
  beforeAll(async () => {
    stack = await startStack({ providers: new Map<ProviderId, LLMProvider>([['mock', new Recorder()]]) });
  });
  afterAll(() => stack.stop());

  it('offers only the agent tools, without the Fiori page tools before a page is open, and fits the Standard window', async () => {
    const res = await stack.chat(USERS.jordan, { message: 'Why is invoice 5100012345 blocked?', agent: 'fico', modelTier: 'standard' });
    expect(res.status).toBe(200);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const names = requests[0]!.tools!.map((t) => t.name);
    expect(names).toContain('shared_showFioriGuide');
    expect(names.some((n) => n.startsWith('fiori_'))).toBe(false);
    expect(names.some((n) => /^(sf|pm)_/.test(n))).toBe(false);
    expect(requests[0]!.tools!.every((t) => !('$schema' in t.inputSchema))).toBe(true);
    for (const req of requests) {
      const tokens = req.messages.reduce((n, m) => n + estimateTokens(m.content), 0) + toolSpecTokens(req.tools ?? []);
      expect(tokens).toBeLessThan(24_000 - 1_500);
    }
  });
});
