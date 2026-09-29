import { collect, safeJsonObject, type LLMChunk, type LLMMessage, type LLMProvider, type LLMRequest, type LLMResponse, type ToolSpec } from '../types.js';

/**
 * Deterministic offline provider for local development, demos and CI.
 *
 * It imitates a tool-calling model with simple intent rules so the complete
 * orchestration path (tool selection → MCP → SAP mock → answer) runs without
 * credentials. It never invents business data: answers are built only from
 * tool results the orchestrator returned.
 */

interface Intent {
  tool: string;
  pattern: RegExp;
  args: (m: RegExpMatchArray, text: string) => Record<string, unknown>;
  when?: RegExp;
}

const INTENTS: Intent[] = [
  { tool: 'releaseInvoicePaymentBlock', when: /\b(release|unblock|remove (the )?block)\b/i, pattern: /\b(51\d{8})\b/, args: (m) => ({ invoiceNumber: m[1] }) },
  { tool: 'addInvoiceNote', when: /\b(add|attach|post) (a )?(note|comment)\b/i, pattern: /\b(51\d{8})\b/, args: (m, t) => ({ invoiceNumber: m[1], note: (/["“](.+?)["”]/.exec(t)?.[1] ?? 'Reviewed via Prowess AI').slice(0, 200) }) },
  { tool: 'getPaymentStatus', when: /\bpayment status|paid\b/i, pattern: /\b(51\d{8})\b/, args: (m) => ({ invoiceNumber: m[1] }) },
  { tool: 'getInvoice', pattern: /\b(51\d{8})\b/, args: (m) => ({ invoiceNumber: m[1] }) },
  { tool: 'getGoodsReceipt', when: /\bgoods receipt|GR\b/i, pattern: /\b(45\d{8})\b/, args: (m) => ({ purchaseOrder: m[1] }) },
  { tool: 'getPurchaseOrder', pattern: /\b(45\d{8})\b/, args: (m) => ({ purchaseOrderNumber: m[1] }) },
  { tool: 'getPurchaseRequisition', pattern: /\b(10\d{8})\b/, when: /\brequisition|PR\b/i, args: (m) => ({ requisitionNumber: m[1] }) },
  { tool: 'getMaintenanceHistory', when: /\bmaintenance|history\b/i, pattern: /\b(EQ-?\d{4,8}|2\d{7})\b/i, args: (m) => ({ equipment: m[1]!.toUpperCase() }) },
  { tool: 'getEquipment', pattern: /\b(EQ-?\d{4,8}|2\d{7})\b/i, when: /\bequipment|asset\b/i, args: (m) => ({ equipment: m[1]!.toUpperCase() }) },
  { tool: 'getWorkOrder', pattern: /\b(4\d{6})\b/, when: /\bwork order|order\b/i, args: (m) => ({ workOrder: m[1] }) },
  { tool: 'getVendor', when: /\b(vendor|supplier)\b/i, pattern: /\b(1\d{6}|V\d{4,8})\b/i, args: (m) => ({ vendorId: m[1]!.toUpperCase() }) },
  {
    tool: 'getGLBalance',
    when: /\b(G\/?L|general ledger|balance)\b/i,
    pattern: /\b(\d{6,8})\b/,
    args: (m, t) => ({
      glAccount: m[1],
      companyCode: /company code (\w{4})/i.exec(t)?.[1] ?? '1000',
      fiscalYear: /\b(20\d{2})\b/.exec(t)?.[1] ?? String(new Date().getFullYear()),
    }),
  },
  { tool: 'searchBusinessObject', when: /\b(find|search|look up)\b/i, pattern: /(?:for|find|search)\s+(.{3,60})$/i, args: (m) => ({ query: m[1]!.trim() }) },
];

function findTool(tools: ToolSpec[] | undefined, suffix: string): ToolSpec | undefined {
  return tools?.find((t) => t.name === suffix || t.name.endsWith(`_${suffix}`));
}

function lastIndexOfRole(messages: LLMMessage[], role: LLMMessage['role']): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === role) return i;
  return -1;
}

export interface MockProviderOptions {
  /** Delay between streamed tokens, to make streaming visible in demos. */
  tokenDelayMs?: number;
  /** Makes every call fail — used to exercise router fallback in tests. */
  failWith?: Error;
}

export class MockProvider implements LLMProvider {
  readonly id = 'mock' as const;
  readonly private = true;

  constructor(private readonly opts: MockProviderOptions = {}) {}

  plan(req: LLMRequest): { text: string; toolCalls: { name: string; arguments: Record<string, unknown> }[] } {
    const messages = req.messages;
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const last = messages.at(-1);

    if (/conversation summarizer/i.test(system)) {
      const users = messages.filter((m) => m.role === 'user').map((m) => m.content.slice(0, 120));
      return { text: `Earlier in this conversation the user asked about: ${users.join('; ').slice(0, 800)}`, toolCalls: [] };
    }
    if (/title generator/i.test(system)) {
      const user = messages.find((m) => m.role === 'user')?.content ?? 'New conversation';
      return { text: user.replace(/\s+/g, ' ').slice(0, 48), toolCalls: [] };
    }

    if (last?.role === 'tool') {
      const start = lastIndexOfRole(messages, 'user');
      const results = messages.slice(start + 1).filter((m): m is Extract<LLMMessage, { role: 'tool' }> => m.role === 'tool');
      return { text: this.summarize(results), toolCalls: [] };
    }

    const text = last?.role === 'user' ? last.content : '';
    for (const intent of INTENTS) {
      const tool = findTool(req.tools, intent.tool);
      if (!tool) continue;
      if (intent.when && !intent.when.test(text)) continue;
      const match = intent.pattern.exec(text);
      if (match) return { text: '', toolCalls: [{ name: tool.name, arguments: intent.args(match, text) }] };
    }

    const toolHint = req.tools?.length
      ? `I can look up SAP business objects for you — for example an invoice number (51…), a purchase order (45…), a vendor ID, or equipment. `
      : '';
    return {
      text:
        `**Prowess AI is running with the offline mock model.** ${toolHint}` +
        `Configure SAP AI Core, Azure AI Foundry, AWS Bedrock or Google Vertex AI to enable full natural-language reasoning.\n\n` +
        `Try: *"Why is invoice 5100012345 blocked?"*`,
      toolCalls: [],
    };
  }

  private summarize(results: Extract<LLMMessage, { role: 'tool' }>[]): string {
    const lines: string[] = [];
    for (const r of results) {
      // Tool output arrives fenced as untrusted data; read the JSON inside the fence.
      const json = r.content.slice(r.content.indexOf('{'), r.content.lastIndexOf('}') + 1);
      const parsed = safeJsonObject(json);
      const data = (parsed.data ?? parsed) as Record<string, unknown>;
      if (parsed.status === 'AWAITING_USER_CONFIRMATION') {
        lines.push(
          `I've prepared **${String(parsed.action ?? 'the requested change')}**. ${String(parsed.impact ?? '')}`.trim(),
          '',
          'Nothing changes in SAP until you review and confirm the card below. SAP will still check your own authorization when it executes.',
        );
        continue;
      }
      if (r.isError) {
        lines.push(`I couldn't complete **${r.name.replace(/^[a-z]+_/, '')}**: ${String(data.error ?? parsed.error ?? 'the SAP system returned an error')}.`);
        continue;
      }
      const summary = typeof data.summary === 'string' ? data.summary : undefined;
      if (summary) lines.push(summary);
      const findings = Array.isArray(data.findings) ? (data.findings as unknown[]).map(String) : [];
      if (findings.length) lines.push('', '**What I found**', ...findings.map((f) => `- ${f}`));
      const next = Array.isArray(data.nextSteps) ? (data.nextSteps as unknown[]).map(String) : [];
      if (next.length) lines.push('', '**Suggested next steps**', ...next.map((f) => `- ${f}`));
      if (!summary && !findings.length) lines.push(`Retrieved the requested information from SAP.`);
    }
    if (results.some((r) => /"mock"\s*:\s*true/.test(r.content))) {
      lines.push('', '_Source data is from the Prowess mock SAP system — not a live S/4HANA tenant._');
    }
    return lines.join('\n');
  }

  async *stream(req: LLMRequest): AsyncGenerator<LLMChunk> {
    if (this.opts.failWith) throw this.opts.failWith;
    const { text, toolCalls } = this.plan(req);
    const delay = this.opts.tokenDelayMs ?? 0;
    for (const token of text.match(/\S+\s*|\s+/g) ?? []) {
      if (req.signal?.aborted) break;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      yield { type: 'text', text: token };
    }
    for (const [i, call] of toolCalls.entries()) {
      yield { type: 'tool_call', call: { id: `mock_call_${Date.now().toString(36)}_${i}`, ...call } };
    }
    const inputTokens = Math.ceil(req.messages.reduce((n, m) => n + m.content.length, 0) / 4);
    yield { type: 'usage', usage: { inputTokens, outputTokens: Math.ceil(text.length / 4) + toolCalls.length * 20 } };
    yield { type: 'finish', reason: toolCalls.length ? 'tool_calls' : 'stop' };
  }

  complete(req: LLMRequest): Promise<LLMResponse> {
    return collect(this.stream(req));
  }

  async healthCheck(): Promise<boolean> {
    return !this.opts.failWith;
  }
}
