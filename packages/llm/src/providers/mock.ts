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
  {
    tool: 'start',
    when: /\b(run|start|process|carry out)\b/i,
    pattern: /\bpurchase order\D{0,12}(4[25]\d{8})\b/i,
    args: (m, t) => ({
      workflow: 'purchase-to-pay',
      input: {
        purchaseOrder: m[1],
        companyCode: companyCodeIn(t),
        invoiceReference: /\binvoice\s+([A-Z0-9./-]{1,16})\b/i.exec(t)?.[1] ?? '',
        invoiceAmount: (/\bfor\s+(?:[A-Z]{3}\s*)?(\d[\d,]*(?:\.\d{1,2})?)(?!\d)/i.exec(t.replace(m[1]!, ''))?.[1] ?? '').replaceAll(',', ''),
      },
    }),
  },
  { tool: 'getGoodsReceipt', when: /\bgoods receipt|GR\b/i, pattern: /\b(4[25]\d{8})\b/, args: (m) => ({ purchaseOrder: m[1] }) },
  { tool: 'getPurchaseOrder', pattern: /\b(4[25]\d{8})\b/, args: (m) => ({ purchaseOrderNumber: m[1] }) },
  {
    tool: 'start',
    when: /\b(run|start|process|fulfil|fulfill|carry out)\b/i,
    pattern: /\bsales order\D{0,12}(\d{1,10})\b/i,
    args: (m, t) => ({ workflow: 'order-to-cash', input: { salesOrder: m[1], companyCode: companyCodeIn(t) } }),
  },
  { tool: 'getSalesOrderFlow', when: /\b(flow|trace|track|where is|stuck)\b/i, pattern: /\bsales order\D{0,12}(\d{1,10})\b/i, args: (m) => ({ salesOrder: m[1] }) },
  { tool: 'getSalesOrder', pattern: /\bsales order\D{0,12}(\d{1,10})\b/i, args: (m) => ({ salesOrder: m[1] }) },
  { tool: 'listOpenSalesOrders', when: /\bopen (sales )?orders\b/i, pattern: /orders/i, args: () => ({}) },
  { tool: 'getDelivery', pattern: /\bdelivery\D{0,12}(8\d{7,9})\b/i, args: (m) => ({ delivery: m[1] }) },
  { tool: 'getBillingDocument', pattern: /\b(?:billing document|billing|customer invoice)\D{0,12}(9\d{7,9})\b/i, args: (m) => ({ billingDocument: m[1] }) },
  { tool: 'getCreditExposure', when: /\bcredit\b/i, pattern: /\bcustomer\D{0,12}(\d{4,10})\b/i, args: (m) => ({ customer: m[1] }) },
  {
    tool: 'listCustomerOpenItems',
    when: /\b(open|line|cleared) items\b|\breceivables?\b/i,
    pattern: /\bcustomer\D{0,12}(\d{4,10})\b/i,
    args: (m, t) => ({ customer: m[1], companyCode: companyCodeIn(t), status: itemStatusIn(t) }),
  },
  {
    tool: 'listVendorOpenItems',
    when: /\b(open|line|cleared) items\b|\bpayables?\b/i,
    pattern: /\b(?:vendor|supplier)\D{0,12}(\d{4,10})\b/i,
    args: (m, t) => ({ supplier: m[1], companyCode: companyCodeIn(t), status: itemStatusIn(t) }),
  },
  { tool: 'listOverdueReceivables', when: /\boverdue\b/i, pattern: /\breceivables?|customers?\b/i, args: (_m, t) => ({ companyCode: companyCodeIn(t) }) },
  { tool: 'listInvoicesDue', when: /\bdue\b/i, pattern: /\b(payables?|payment run|for payment)\b/i, args: (_m, t) => ({ companyCode: companyCodeIn(t) }) },
  { tool: 'listBlockedInvoices', when: /\bblocked invoices\b/i, pattern: /invoices/i, args: (_m, t) => ({ companyCode: companyCodeIn(t) }) },
  { tool: 'listGRIROpenItems', when: /\bGR\/?IR\b/i, pattern: /\b(\d{6,10})\b/, args: (m, t) => ({ glAccount: m[1], companyCode: companyCodeIn(t) }) },
  {
    tool: 'getAccountingDocument',
    when: /\b(accounting|FI) document|journal entry\b/i,
    pattern: /\bdocument\D{0,12}(\d{5,10})\b/i,
    args: (m, t) => ({ documentNumber: m[1], companyCode: companyCodeIn(t), fiscalYear: /\b(20\d{2})\b/.exec(t.replace(m[1]!, ''))?.[1] ?? String(new Date().getFullYear()) }),
  },
  { tool: 'getInfoRecords', when: /\b(info records?|sources? of supply|which suppliers?)\b/i, pattern: /\bmaterial\D{0,12}([A-Z0-9-]{1,18})\b/i, args: (m) => ({ material: m[1] }) },
  { tool: 'getMaterialStock', when: /\bstock\b/i, pattern: /\bmaterial\D{0,12}([A-Z0-9-]{1,18})\b/i, args: (m) => ({ material: m[1] }) },
  { tool: 'getCustomer', pattern: /\bcustomer\D{0,12}(\d{4,10})\b/i, args: (m, t) => ({ customer: m[1], companyCode: companyCodeIn(t) }) },
  { tool: 'getPurchaseRequisition', pattern: /\b(10\d{8})\b/, when: /\brequisition|PR\b/i, args: (m) => ({ requisitionNumber: m[1] }) },
  { tool: 'getMaintenanceHistory', when: /\bmaintenance|history\b/i, pattern: /\b(EQ-?\d{4,8}|2\d{7})\b/i, args: (m) => ({ equipment: m[1]!.toUpperCase() }) },
  { tool: 'getEquipment', pattern: /\b(EQ-?\d{4,8}|2\d{7})\b/i, when: /\bequipment|asset\b/i, args: (m) => ({ equipment: m[1]!.toUpperCase() }) },
  { tool: 'getWorkOrder', pattern: /\b(4\d{6})\b/, when: /\bwork order|order\b/i, args: (m) => ({ workOrder: m[1] }) },
  { tool: 'getVendor', when: /\b(vendor|supplier)\b/i, pattern: /\b(1\d{6}|7\d{9}|V\d{4,8})\b/i, args: (m) => ({ vendorId: m[1]!.toUpperCase() }) },
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

/** Company code named in the prompt, else the demo company code of the mock scenarios. */
const companyCodeIn = (text: string) => /company code (\w{4})/i.exec(text)?.[1] ?? '1030';
const itemStatusIn = (text: string) => (/\ball\b/i.test(text) ? 'ALL' : /\bcleared\b/i.test(text) ? 'CLEARED' : 'OPEN');

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
      ? `I can look up SAP business objects for you — for example an invoice number (51…), a purchase order (45…), a sales order, a customer or vendor ID, or equipment. `
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
