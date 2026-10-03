import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ofType, startStack, USERS } from './harness.js';

let stack: Awaited<ReturnType<typeof startStack>>;

beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

describe('health and platform controls', () => {
  it('serves liveness and readiness without authentication', async () => {
    expect((await fetch(`${stack.base}/api/health`)).status).toBe(200);
    const ready = await fetch(`${stack.base}/api/readiness`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready', checks: { store: true, mcp: { sap: true } } });
  });

  it('rejects mutating requests without the CSRF header', async () => {
    const res = await stack.request('POST', '/api/v1/chat', USERS.alex, { message: 'hi' }, { 'x-requested-with': 'nope' });
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe('CSRF_CHECK_FAILED');
  });

  it('returns a safe error envelope with a support reference', async () => {
    const res = await stack.request('GET', '/api/v1/conversations/c_doesnotexistdoesnotexist');
    expect(res.status).toBe(404);
    const err = res.json.error as unknown as { reference: string; correlationId: string };
    expect(err.reference).toMatch(/^PRW-\d{8}-[0-9A-F]{4}$/);
    expect(err.correlationId.startsWith(err.reference)).toBe(true);
    expect(res.text).not.toMatch(/stack|at .*\.ts/);
  });
});

describe('workspace configuration', () => {
  it('exposes business tiers but hides provider details from standard users', async () => {
    const standard = await stack.request('GET', '/api/v1/workspace', USERS.jordan);
    const tiers = standard.json.modelTiers as { id: string; technical?: unknown }[];
    expect(tiers.map((t) => t.id)).toEqual(['standard', 'private']);
    expect(tiers.every((t) => t.technical === undefined)).toBe(true);

    const power = await stack.request('GET', '/api/v1/workspace', USERS.alex);
    expect((power.json.modelTiers as { id: string; technical?: unknown }[]).find((t) => t.id === 'advanced')?.technical).toBeDefined();
    expect((power.json.starters as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('Invoice analysis vertical slice', () => {
  it('streams tool execution, a validated invoice card, sources and the answer', async () => {
    const { status, events } = await stack.chat(USERS.jordan, { message: 'Why is invoice 5100012345 blocked?', agent: 'fi-ap' });
    expect(status).toBe(200);
    expect(events[0]!.type).toBe('message.start');
    expect(ofType(events, 'tool.start')[0]!.tool.tool).toBe('mm_getInvoice');
    const card = ofType(events, 'component').find((c) => c.component.type === 'invoice');
    expect(card?.component.data).toMatchObject({ number: '5100012345', status: 'PAYMENT_BLOCKED', paymentBlock: { code: 'R' } });
    expect(ofType(events, 'source')[0]!.source).toMatchObject({ system: 'S4-MOCK', mock: true, objectType: 'SupplierInvoice' });
    const text = ofType(events, 'message.delta').map((d) => d.text).join('');
    expect(text).toMatch(/blocked for payment/);
    expect(text).toMatch(/mock SAP system/);
    const done = ofType(events, 'message.complete')[0]!;
    expect(done.status).toBe('complete');
    expect(done.actions.map((a) => a.label)).toContain('Check related PO');
    // Standard users never see the provider/model.
    expect(done.execution.provider).toBeUndefined();
    expect(done.execution.tools[0]).toMatchObject({ tool: 'mm_getInvoice', status: 'success', system: 'S4-MOCK' });

    const audit = stack.auditBuffer.events.map((e) => e.type);
    expect(audit).toEqual(expect.arrayContaining(['CONVERSATION_CREATED', 'AGENT_INVOKED', 'MCP_TOOL_INVOKED', 'SAP_READ', 'MODEL_PROVIDER_USED']));
    expect(JSON.stringify(stack.auditBuffer.events)).not.toMatch(/428[,.]?350|ABC Trading/);
  });

  it('surfaces SAP authorization denials without overriding them', async () => {
    const { events } = await stack.chat(USERS.alex, { message: 'Show invoice 5100099999', agent: 'fi-ap' });
    const err = ofType(events, 'tool.error')[0]!;
    expect(err.message).toMatch(/not authorized for company code 3000/);
    expect(err.tool.status).toBe('denied');

    // The user gets one notice that says what happened and what to do; no SAP data and no internal code.
    const components = ofType(events, 'component').map((c) => c.component);
    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({
      type: 'notice',
      data: { kind: 'NOT_AUTHORIZED', title: 'SAP did not allow this', action: expect.stringMatching(/^Ask your SAP authorization team/), reference: expect.stringMatching(/^PRW-/) },
    });
    expect((components[0]!.data as { message: string }).message).toMatch(/not authorized for company code 3000/);
    expect(JSON.stringify(components)).not.toMatch(/SAP_NOT_AUTHORIZED|retryPrompt/);
  });

  it('explains other failed SAP reads by their cause', async () => {
    const { events } = await stack.chat(USERS.alex, { message: 'Check purchase order 4599999999', agent: 'mm' });
    expect(ofType(events, 'tool.error')[0]!.tool.status).toBe('error');
    expect(ofType(events, 'component').map((c) => c.component)).toEqual([
      { type: 'notice', data: { kind: 'NOT_FOUND', title: 'Not found in SAP', message: 'Purchase order 4599999999 was not found in SAP.', action: 'Check the number and the company code, then ask again.', reference: expect.stringMatching(/^PRW-/) } },
    ]);
  });
});

describe('conversation privacy', () => {
  it('never returns or deletes another user’s conversation', async () => {
    const { events } = await stack.chat(USERS.alex, { message: 'Check purchase order 4500012345', agent: 'mm' });
    const id = ofType(events, 'message.start')[0]!.conversationId;

    expect((await stack.request('GET', `/api/v1/conversations/${id}`, USERS.alex)).status).toBe(200);
    expect((await stack.request('GET', `/api/v1/conversations/${id}`, USERS.jordan)).status).toBe(404);
    expect((await stack.request('DELETE', `/api/v1/conversations/${id}`, USERS.jordan)).status).toBe(404);
    expect((await stack.chat(USERS.jordan, { conversationId: id, message: 'continue' })).status).toBe(404);
    const list = await stack.request('GET', '/api/v1/conversations', USERS.jordan);
    expect((list.json as unknown as { id: string }[]).some((c) => c.id === id)).toBe(false);

    const detail = await stack.request('GET', `/api/v1/conversations/${id}`, USERS.alex);
    const messages = detail.json.messages as { role: string; response?: { execution?: { provider?: string } } }[];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]!.response?.execution?.provider).toBe('mock'); // power user sees technical details
    expect(JSON.stringify(detail.json)).not.toContain('toolContext');
  });

  it('renames, rates and deletes own conversations', async () => {
    const { events } = await stack.chat(USERS.jordan, { message: 'Analyze maintenance history for equipment 20001234.', agent: 'maintenance' });
    const start = ofType(events, 'message.start')[0]!;
    expect(ofType(events, 'component').map((c) => c.component.type)).toEqual(['equipment', 'timeline']);
    expect((await stack.request('PATCH', `/api/v1/conversations/${start.conversationId}`, USERS.jordan, { title: 'Pump P-101' })).json.title).toBe('Pump P-101');
    expect((await stack.request('POST', `/api/v1/conversations/${start.conversationId}/messages/${start.messageId}/feedback`, USERS.jordan, { rating: 'up' })).status).toBe(204);
    expect((await stack.request('DELETE', `/api/v1/conversations/${start.conversationId}`, USERS.jordan)).status).toBe(204);
    expect((await stack.request('GET', `/api/v1/conversations/${start.conversationId}`, USERS.jordan)).status).toBe(404);
  });
});

describe('human confirmation for SAP writes', () => {
  it('never executes a write from the chat turn, and executes exactly once after confirmation', async () => {
    const { events } = await stack.chat(USERS.alex, { message: 'Release the payment block on invoice 5100012345.', agent: 'fi-ap' });
    const confirmation = ofType(events, 'confirmation.required')[0]!.confirmation;
    expect(confirmation).toMatchObject({ action: 'Release invoice payment block', risk: 'HIGH_IMPACT', environment: 'DEV', status: 'pending' });
    expect(confirmation.impact).toMatch(/payment run/);
    expect(ofType(events, 'message.complete')[0]!.execution.tools[0]!.status).toBe('pending_confirmation');

    // Still blocked: the model alone cannot execute the change.
    const check = await stack.chat(USERS.alex, { message: 'What is the payment status of invoice 5100012345?', agent: 'fi-ap' });
    expect(ofType(check.events, 'message.delta').map((d) => d.text).join('')).toMatch(/not paid/);

    // Another user cannot confirm it.
    expect((await stack.request('POST', `/api/v1/actions/${confirmation.id}/confirm`, USERS.jordan, {})).status).toBe(404);

    const confirmed = await stack.request('POST', `/api/v1/actions/${confirmation.id}/confirm`, USERS.alex, {});
    expect(confirmed.status).toBe(200);
    expect((confirmed.json.confirmation as { status: string }).status).toBe('completed');
    expect((confirmed.json.message as { content: string }).content).toMatch(/was released/);

    const again = await stack.request('POST', `/api/v1/actions/${confirmation.id}/confirm`, USERS.alex, {});
    expect(again.status).toBe(400);
    expect(again.json.error?.code).toBe('ACTION_NOT_PENDING');

    const audit = stack.auditBuffer.events.filter((e) => e.details?.actionId === confirmation.id).map((e) => e.type);
    expect(audit).toEqual(expect.arrayContaining(['SAP_WRITE_REQUESTED', 'SAP_WRITE_CONFIRMED', 'SAP_WRITE_COMPLETED']));
  });

  it('records SAP’s refusal when the user lacks SAP release authorization', async () => {
    const { events } = await stack.chat(USERS.jordan, { message: 'Add a note "Price checked with buyer" to invoice 5100012346', agent: 'fi-ap' });
    const confirmation = ofType(events, 'confirmation.required')[0]!.confirmation;
    expect(confirmation.risk).toBe('LOW_RISK_WRITE');
    const cancelled = await stack.request('POST', `/api/v1/actions/${confirmation.id}/cancel`, USERS.jordan, {});
    expect((cancelled.json.confirmation as { status: string }).status).toBe('cancelled');
  });
});

describe('role-based access', () => {
  it('denies agents and tiers the user is not entitled to', async () => {
    const auditor = await stack.chat(USERS.casey, { message: 'hello', agent: 'fi-ap' });
    expect(auditor.status).toBe(403);
    const tier = await stack.chat(USERS.jordan, { message: 'hello', agent: 'fi-ap', modelTier: 'advanced' });
    expect(tier.status).toBe(403);
  });

  it('restricts administration and audit views', async () => {
    expect((await stack.request('GET', '/api/v1/admin/overview', USERS.jordan)).status).toBe(403);
    const overview = await stack.request('GET', '/api/v1/admin/overview', USERS.sam);
    expect(overview.status).toBe(200);
    expect(JSON.stringify(overview.json)).not.toMatch(/secret|api[-_]?key/i);
    expect((await stack.request('GET', '/api/v1/admin/audit', USERS.casey)).status).toBe(200);
    expect((await stack.request('GET', '/api/v1/admin/audit', USERS.jordan)).status).toBe(403);
  });
});

describe('help', () => {
  type Help = { agents: { id: string; capabilities: { title: string; description: string; risk: string; needsConfirmation: boolean }[] }[]; activity: { type: string; action?: string; object?: string; agent?: string; status: string }[] };

  it('describes what each agent can do without tool names or configuration', async () => {
    const res = await stack.request('GET', '/api/v1/help', USERS.jordan);
    expect(res.status).toBe(200);
    const help = res.json as unknown as Help;
    expect(help.agents.map((a) => a.id)).toEqual(['fico', 'mm', 'sd']);
    const receipt = help.agents.find((a) => a.id === 'mm')!.capabilities.find((c) => c.title === 'Post goods receipt')!;
    expect(receipt).toMatchObject({ risk: 'HIGH_IMPACT', needsConfirmation: true });
    expect(receipt.description).toMatch(/^Post the goods receipt .*\.$/);
    expect(help.agents.find((a) => a.id === 'sd')!.capabilities.some((c) => c.title === 'Post goods receipt')).toBe(false);
    expect(JSON.stringify(help.agents)).not.toMatch(/mm_|sd_|allowedTools|requiredRoles|instructions/);
  });

  it("lists only the caller's own SAP activity", async () => {
    const activity = async (user: string) => ((await stack.request('GET', '/api/v1/help', user)).json as unknown as Help).activity;
    const before = (await activity(USERS.jordan)).length;
    await stack.chat(USERS.jordan, { message: 'Check purchase order 4200000402 and its goods receipts.', agent: 'mm' });
    const mine = await activity(USERS.jordan);
    expect(mine.length).toBeGreaterThan(before);
    expect(mine[0]).toMatchObject({ type: 'SAP_READ', action: 'Get goods receipts', agent: 'MM', object: 'PurchaseOrder 4200000402', status: 'success' });
    expect(JSON.stringify(mine)).not.toMatch(/USER_LOGIN|MODEL_PROVIDER|AGENT_INVOKED/);

    // Another user's activity is not included, and a user who did nothing sees nothing.
    await stack.chat(USERS.alex, { message: 'Check purchase order 4200000402 and its goods receipts.', agent: 'mm' });
    expect(await activity(USERS.jordan)).toHaveLength(mine.length);
    expect(await activity(USERS.casey)).toEqual([]);
  });
});

describe('file uploads', () => {
  const upload = (name: string, content: Buffer | string, user = USERS.alex) => {
    const form = new FormData();
    form.append('file', new Blob([content]), name);
    return fetch(`${stack.base}/api/v1/files`, { method: 'POST', headers: { 'x-prowess-dev-user': user, 'x-requested-with': 'prowess' }, body: form });
  };

  it('accepts a valid text file and uses it as untrusted context', async () => {
    const res = await upload('../../notes.txt', 'Invoice 5100012345 was discussed with the buyer.');
    expect(res.status).toBe(201);
    const ref = (await res.json()) as { id: string; fileName: string };
    expect(ref.fileName).toBe('notes.txt');
    const { status } = await stack.chat(USERS.alex, { message: 'Summarize the attached notes', attachments: [ref.id] });
    expect(status).toBe(200);
    // Another user cannot reference it.
    expect((await stack.chat(USERS.jordan, { message: 'x', attachments: [ref.id] })).status).toBe(400);
  });

  it('rejects content that does not match the extension', async () => {
    const res = await upload('invoice.pdf', 'this is not a pdf');
    expect(res.status).toBe(400);
    const res2 = await upload('evil.exe', 'MZ...');
    expect(res2.status).toBe(400);
  });
});

describe('agents by SAP area', () => {
  it('offers FICO, MM and SD', async () => {
    const workspace = await stack.request('GET', '/api/v1/workspace', USERS.jordan);
    const ids = (workspace.json.agents as { id: string }[]).map((a) => a.id);
    expect(ids).toEqual(['fico', 'mm', 'sd']);
    expect(workspace.json.defaultAgent).toBe('fico');
  });

  it('keeps conversations of a former agent id working', async () => {
    const { status, events } = await stack.chat(USERS.jordan, { message: 'Why is invoice 5100012345 blocked?', agent: 'fi-ap' });
    expect(status).toBe(200);
    expect(ofType(events, 'tool.start')[0]!.tool.tool).toBe('mm_getInvoice');
    expect((await stack.chat(USERS.jordan, { message: 'Check purchase order 4500012345', agent: 'procurement' })).status).toBe(200);
    expect((await stack.chat(USERS.jordan, { message: 'Analyze maintenance history for equipment 20001234.', agent: 'maintenance' })).status).toBe(200);
  });

  it('traces order-to-cash with the SD agent', async () => {
    const { events } = await stack.chat(USERS.jordan, { message: 'Show the document flow of sales order 648.', agent: 'sd' });
    expect(ofType(events, 'tool.start')[0]!.tool.tool).toBe('sd_getSalesOrderFlow');
    expect(ofType(events, 'component').map((c) => c.component.type)).toEqual(['sales_order', 'timeline']);
    expect(ofType(events, 'source')[0]!.source).toMatchObject({ objectType: 'SalesOrder', objectId: '648', mock: true });
  });

  it('shows cleared and open customer items with the FICO agent', async () => {
    const { events } = await stack.chat(USERS.jordan, { message: 'Show all line items of customer 7000000010 in company code 1030.', agent: 'fico' });
    expect(ofType(events, 'tool.start')[0]!.tool.tool).toBe('ar_listCustomerOpenItems');
    const card = ofType(events, 'component').find((c) => c.component.type === 'open_items');
    expect(card?.component.data).toMatchObject({ accountType: 'CUSTOMER', account: '7000000010', total: { amount: 2500, currency: 'SAR' } });
  });

  it('scopes tools to the module: the SD agent cannot read supplier invoices', async () => {
    const { events } = await stack.chat(USERS.jordan, { message: 'Why is invoice 5100012345 blocked?', agent: 'sd' });
    expect(ofType(events, 'tool.start')).toHaveLength(0);
  });

  it('covers financial controls with the FICO agent', async () => {
    const overdue = await stack.chat(USERS.jordan, { message: 'Which receivables are overdue in company code 1030?', agent: 'fico' });
    expect(ofType(overdue.events, 'tool.start')[0]!.tool.tool).toBe('ar_listOverdueReceivables');
  });
});
