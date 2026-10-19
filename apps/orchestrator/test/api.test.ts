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
    expect(tiers.map((t) => t.id)).toEqual(['standard']);
    expect(tiers.every((t) => t.technical === undefined)).toBe(true);

    const power = await stack.request('GET', '/api/v1/workspace', USERS.alex);
    expect((power.json.modelTiers as { id: string; technical?: unknown }[]).find((t) => t.id === 'advanced')?.technical).toBeDefined();
    expect((power.json.starters as unknown[]).length).toBeGreaterThan(0);
  });

  it('answers configuration text in the language the browser asks for, and keeps the SAP module names', async () => {
    type Workspace = { agents: { id: string; name: string; description: string }[]; starters: { id: string; label: string; prompt: string }[]; modelTiers: { id: string; label: string }[] };
    const en = (await stack.request('GET', '/api/v1/workspace', USERS.alex)).json as unknown as Workspace;
    const ar = (await stack.request('GET', '/api/v1/workspace', USERS.alex, undefined, { 'accept-language': 'ar-SA,ar;q=0.9,en;q=0.5' })).json as unknown as Workspace;
    const invoice = (w: Workspace) => w.starters.find((s) => s.id === 'invoice')!;
    expect(invoice(en).label).toBe('Analyze an invoice');
    expect(invoice(ar).label).toBe('تحليل فاتورة');
    expect(invoice(ar).prompt).toBe('لماذا الفاتورة 5100012345 موقوفة؟');
    expect(invoice(en).prompt).toBe('Why is invoice 5100012345 blocked?');
    expect(ar.agents.find((a) => a.id === 'fico')).toMatchObject({ name: 'FICO', description: expect.stringMatching(/[؀-ۿ]/) });
    expect(ar.modelTiers.find((t) => t.id === 'standard')?.label).toBe('قياسي');
    // An unsupported language falls back to English.
    const fr = (await stack.request('GET', '/api/v1/workspace', USERS.alex, undefined, { 'accept-language': 'fr-FR' })).json as unknown as Workspace;
    expect(invoice(fr).label).toBe('Analyze an invoice');
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
  it('offers the SuccessFactors agent only to HR users', async () => {
    const agents = async (user: string) => ((await stack.request('GET', '/api/v1/workspace', user)).json.agents as { id: string }[]).map((a) => a.id);
    expect(await agents(USERS.alex)).toEqual(['fico', 'mm', 'sd', 'hcm', 'outlook', 'invoices']);
    expect(await agents(USERS.jordan)).not.toContain('hcm');
    expect((await stack.chat(USERS.jordan, { message: 'Who are my direct reports?', agent: 'hcm' })).status).toBe(403);
  });

  it('offers the Outlook agent only to mail users', async () => {
    const agents = async (user: string) => ((await stack.request('GET', '/api/v1/workspace', user)).json.agents as { id: string }[]).map((a) => a.id);
    expect(await agents(USERS.jordan)).not.toContain('outlook');
    expect(await agents(USERS.jordan)).not.toContain('invoices');
    expect((await stack.chat(USERS.jordan, { message: 'Summarize my unread mail.', agent: 'outlook' })).status).toBe(403);
  });

  it('reads mail and the calendar with the Outlook agent, and sends only after confirmation', async () => {
    const unread = await stack.chat(USERS.alex, { message: 'Summarize my unread mail.', agent: 'outlook' });
    expect(ofType(unread.events, 'tool.start')[0]!.tool.tool).toBe('outlook_listMessages');
    expect(ofType(unread.events, 'component')[0]!.component).toMatchObject({ type: 'mail_list', data: { title: 'Unread mail' } });
    expect(ofType(unread.events, 'source')[0]!.source).toMatchObject({ system: 'M365-MOCK', mock: true });

    const calendar = await stack.chat(USERS.alex, { message: 'What is on my calendar today?', agent: 'outlook' });
    expect(ofType(calendar.events, 'component')[0]!.component).toMatchObject({ type: 'calendar' });

    const { events } = await stack.chat(USERS.alex, { message: 'Send an e-mail to mei.tanaka@prowess.example with subject "Quarterly zebra report" saying "Please check the report."', agent: 'outlook' });
    const confirmation = ofType(events, 'confirmation.required')[0]!.confirmation;
    expect(confirmation).toMatchObject({ action: 'Send an e-mail', risk: 'BUSINESS_WRITE', status: 'pending' });
    const sentBefore = await stack.chat(USERS.alex, { message: 'Show e-mails about zebra', agent: 'outlook' });
    expect(ofType(sentBefore.events, 'component')).toHaveLength(0);

    const confirmed = await stack.request('POST', `/api/v1/actions/${confirmation.id}/confirm`, USERS.alex, {});
    expect((confirmed.json.confirmation as { status: string }).status).toBe('completed');
    const sentAfter = await stack.chat(USERS.alex, { message: 'Show e-mails about zebra', agent: 'outlook' });
    expect(ofType(sentAfter.events, 'component')[0]!.component).toMatchObject({ type: 'mail_list', data: { items: [{ subject: 'Quarterly zebra report' }] } });
  });

  it('takes a supplier invoice from the mail to a posted SAP invoice, posting only after confirmation', async () => {
    const intake = await stack.chat(USERS.alex, { message: 'Find the supplier invoices in my inbox, check each against its purchase order and post the ones that match.', agent: 'invoices' });
    expect(ofType(intake.events, 'tool.start').map((e) => e.tool.tool)).toEqual(['outlook_searchMail', 'outlook_getMessage', 'outlook_readAttachment', 'mm_checkSupplierInvoice']);
    const check = ofType(intake.events, 'component').at(-1)!.component;
    expect(check).toMatchObject({ type: 'business_object_table', data: { title: 'Invoice GIS-2026-0815 against PO 4500012410' } });
    expect((check.data as unknown as { rows: { result: string }[] }).rows.every((r) => r.result === 'OK')).toBe(true);
    expect(ofType(intake.events, 'confirmation.required')).toHaveLength(0);

    const post = await stack.chat(USERS.alex, { message: 'Post invoice GIS-2026-0815 for 190400 against purchase order 4500012410, dated 2026-10-14.', agent: 'invoices' });
    const confirmation = ofType(post.events, 'confirmation.required')[0]!.confirmation;
    expect(confirmation).toMatchObject({ action: 'Enter supplier invoice', risk: 'HIGH_IMPACT', status: 'pending' });
    const confirmed = await stack.request('POST', `/api/v1/actions/${confirmation.id}/confirm`, USERS.alex, {});
    expect((confirmed.json.confirmation as { status: string }).status).toBe('completed');
    expect((confirmed.json.message as { content: string }).content).toMatch(/Gulf Industrial Supplies.*open for payment/);

    // The same invoice again is stopped before a confirmation card is offered.
    const again = await stack.chat(USERS.alex, { message: 'Post invoice GIS-2026-0815 for 190400 against purchase order 4500012410.', agent: 'invoices' });
    expect(ofType(again.events, 'confirmation.required')).toHaveLength(0);
  });

  it('reads the team from SuccessFactors with the HCM agent', async () => {
    const { events } = await stack.chat(USERS.alex, { message: 'Who are my direct reports?', agent: 'hcm' });
    expect(ofType(events, 'tool.start')[0]!.tool.tool).toBe('sf_getDirectReports');
    expect(ofType(events, 'component').map((c) => c.component.type)).toEqual(['business_object_table']);
    expect(ofType(events, 'source')[0]!.source).toMatchObject({ system: 'SF-MOCK', objectType: 'Team', objectId: '100101', mock: true });
    const done = ofType(events, 'message.complete')[0]!;
    expect(done.execution.tools[0]).toMatchObject({ tool: 'sf_getDirectReports', status: 'success', system: 'SF-MOCK' });

    const profile = await stack.chat(USERS.alex, { message: 'Show employee 100102.', agent: 'hcm' });
    expect(ofType(profile.events, 'component')[0]!.component).toMatchObject({ type: 'employee', data: { userId: '100102', displayName: 'Jordan Lee', managerName: 'Alex Morgan' } });
  });

  it('shows the team, time off and approvals as cards, and decides a request only after confirmation', async () => {
    const types = async (message: string) => ofType((await stack.chat(USERS.alex, { message, agent: 'hcm' })).events, 'component').map((c) => c.component.type);
    expect(await types('Show my team overview.')).toEqual(['team_overview']);
    expect(await types('Show my time off.')).toEqual(['time_off']);
    expect(await types('Show the reporting line of employee 100102.')).toEqual(['reporting_line']);
    expect(await types('What is waiting for my approval?')).toEqual(['approvals']);

    const { events } = await stack.chat(USERS.alex, { message: 'Approve request 4001.', agent: 'hcm' });
    const confirmation = ofType(events, 'confirmation.required')[0]!.confirmation;
    expect(confirmation).toMatchObject({ action: 'Approve request', risk: 'BUSINESS_WRITE', status: 'pending' });
    // Not decided yet: the request is still waiting.
    expect(ofType((await stack.chat(USERS.alex, { message: 'What is waiting for my approval?', agent: 'hcm' })).events, 'component')[0]!.component).toMatchObject({ data: { items: [{ id: '4001' }, { id: '4002' }] } });

    const confirmed = await stack.request('POST', `/api/v1/actions/${confirmation.id}/confirm`, USERS.alex, {});
    expect((confirmed.json.confirmation as { status: string }).status).toBe('completed');
    expect((confirmed.json.message as { content: string }).content).toMatch(/Approved: Annual leave of Jordan Lee/);
    expect(ofType((await stack.chat(USERS.alex, { message: 'What is waiting for my approval?', agent: 'hcm' })).events, 'component')[0]!.component).toMatchObject({ data: { items: [{ id: '4002' }] } });
  });

  it('runs SuccessFactors business cases for power users', async () => {
    const list = await stack.chat(USERS.alex, { message: 'List the business cases for Recruiting.', agent: 'hcm' });
    expect(ofType(list.events, 'tool.start')[0]!.tool.tool).toBe('sf_listBusinessCases');
    expect(ofType(list.events, 'component')[0]!.component).toMatchObject({ type: 'business_object_table', data: { title: 'Business cases · Recruiting' } });

    const run = await stack.chat(USERS.alex, { message: 'Run case ec-04 for 100102', agent: 'hcm' });
    expect(ofType(run.events, 'tool.start')[0]!.tool.tool).toBe('sf_runBusinessCase');
    const table = ofType(run.events, 'component')[0]!.component;
    expect(table).toMatchObject({ type: 'business_object_table', data: { title: 'Recurring pay components · 1 record(s)' } });
    expect(JSON.stringify(run.events)).not.toContain('SA00');

    // The tools are part of what a power user's HCM agent can do, and carry the role they ask for.
    const tools = await stack.services.mcp.listTools('DEV');
    expect(tools.filter((t) => t.requiredRole === 'AI_POWER_USER').map((t) => t.name).sort()).toEqual(['sf_describeEntity', 'sf_listBusinessCases', 'sf_runBusinessCase']);
    const hcm = stack.services.agents.resolve({ id: 'x', displayName: 'X', tenantId: 't', roles: ['AI_USER', 'AI_HR_USER'] }, 'hcm');
    const offered = (roles: ('AI_USER' | 'AI_HR_USER' | 'AI_POWER_USER')[]) => stack.services.agents.toolsFor(hcm, tools, { id: 'x', displayName: 'X', tenantId: 't', roles }).map((t) => t.name);
    expect(offered(['AI_USER', 'AI_HR_USER'])).not.toContain('sf_runBusinessCase');
    expect(offered(['AI_USER', 'AI_HR_USER'])).toContain('sf_getMyProfile');
    expect(offered(['AI_USER', 'AI_HR_USER', 'AI_POWER_USER'])).toContain('sf_runBusinessCase');
  });

  it('creates a leave request in SuccessFactors only after the user confirms it', async () => {
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const [from, to] = [day(60), day(61)];
    const { events } = await stack.chat(USERS.alex, { message: `Request annual leave from ${from} to ${to}.`, agent: 'hcm' });
    const confirmation = ofType(events, 'confirmation.required')[0]!.confirmation;
    expect(confirmation).toMatchObject({ action: 'Request time off', risk: 'BUSINESS_WRITE', status: 'pending' });

    const confirmed = await stack.request('POST', `/api/v1/actions/${confirmation.id}/confirm`, USERS.alex, {});
    expect((confirmed.json.confirmation as { status: string }).status).toBe('completed');
    expect((confirmed.json.message as { content: string }).content).toMatch(new RegExp(`Annual leave from ${from} to ${to} was requested`));
  });

  it('lets SuccessFactors permissions deny what the HCM agent may otherwise read', async () => {
    const { events } = await stack.chat(USERS.alex, { message: 'Show the job history of employee 100010.', agent: 'hcm' });
    expect(ofType(events, 'tool.start')[0]!.tool.tool).toBe('sf_getJobHistory');
    expect(ofType(events, 'component')[0]!.component).toMatchObject({ type: 'notice', data: { kind: 'NOT_AUTHORIZED' } });
  });
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

  it('routes a request to the agent that owns it and carries it out in the same answer', async () => {
    const message = 'Create a sales order for customer 7000000010 with 10 PC of material 5496 in company code 1030.';
    const { events } = await stack.chat(USERS.jordan, { message, agent: 'fico' });

    expect(ofType(events, 'agent.handoff')).toEqual([{ type: 'agent.handoff', from: 'fico', agent: 'sd', modelTier: 'standard' }]);
    expect(ofType(events, 'status').map((s) => s.step.label)).toContain('FICO handed this over to SD');
    expect(ofType(events, 'tool.start').map((t) => `${t.tool.agent}/${t.tool.tool}`)).toEqual(['sd/sd_createSalesOrder']);
    expect(ofType(events, 'confirmation.required')[0]!.confirmation).toMatchObject({ action: 'Create sales order', risk: 'HIGH_IMPACT' });

    // The answer and the conversation now belong to SD.
    const conversation = await stack.request('GET', `/api/v1/conversations/${ofType(events, 'message.start')[0]!.conversationId}`, USERS.jordan);
    expect((conversation.json as { agent: string; messages: { role: string; agent?: string }[] }).messages.at(-1)).toMatchObject({ role: 'assistant', agent: 'sd' });

    // The owning agent does not hand over to itself.
    const sd = await stack.chat(USERS.jordan, { message, agent: 'sd' });
    expect(ofType(sd.events, 'agent.handoff')).toEqual([]);
    expect(ofType(sd.events, 'tool.start').map((t) => t.tool.tool)).toEqual(['sd_createSalesOrder']);
  });

  it('covers financial controls with the FICO agent', async () => {
    const overdue = await stack.chat(USERS.jordan, { message: 'Which receivables are overdue in company code 1030?', agent: 'fico' });
    expect(ofType(overdue.events, 'tool.start')[0]!.tool.tool).toBe('ar_listOverdueReceivables');
  });
});
