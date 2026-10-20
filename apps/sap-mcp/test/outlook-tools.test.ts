import { UIComponentSchema } from '@prowess/contracts';
import { describe, expect, it } from 'vitest';
import { MockMailGateway } from '../src/outlook/mock-gateway.js';
import { MockSapGateway } from '../src/sap/mock-gateway.js';
import { SapError, type SapCallContext } from '../src/sap/model.js';
import { MockSfGateway } from '../src/sf/mock-gateway.js';
import { EntityPolicy } from '../src/sf/policy.js';
import { buildRegistry } from '../src/tools/registry.js';
import type { ToolContext, ToolResultPayload } from '../src/tools/types.js';

const as = (sub: string, name: string) => ({ principal: { sub, name }, correlationId: 't' }) as unknown as SapCallContext;
const alex = as('alex.morgan@prowess.example', 'Alex Morgan');
const sam = as('sam.rivera@prowess.example', 'Sam Rivera');
const casey = as('casey.kim@prowess.example', 'Casey Kim'); // no mailbox in the mock tenant
const registry = buildRegistry(new Set(['outlook'] as const));

function context(sap: SapCallContext, allowedRecipientDomains: string[] = [], gateway = new MockMailGateway(0)): ToolContext {
  return { sap, gateway: new MockSapGateway(0), sf: { gateway: new MockSfGateway(0), policy: new EntityPolicy() }, outlook: { gateway, allowedRecipientDomains } };
}

async function run(ctx: ToolContext, name: string, args: Record<string, unknown> = {}): Promise<ToolResultPayload> {
  const result = await registry.get(name)!.run(args as never, ctx);
  for (const c of result.components ?? []) expect(UIComponentSchema.safeParse(c).error?.issues, `${name} component ${c.type}`).toBeUndefined();
  return result;
}

describe('Outlook tools', () => {
  it('searches one folder when asked, so a copy the user sent to themselves is left out', async () => {
    const ctx = context(alex);
    await run(ctx, 'outlook_sendMail', { to: ['alex.morgan@prowess.example'], subject: 'Invoice zz-77 copy', body: 'See attached.' });
    const all = await run(ctx, 'outlook_searchMail', { text: 'zz-77' });
    const inbox = await run(ctx, 'outlook_searchMail', { text: 'zz-77', folder: 'inbox' });
    expect((all.data.messages as unknown[]).length).toBe(1); // the sent copy (the mock does not deliver to itself)
    expect(inbox.data.messages).toEqual([]);
  });

  it('registers read and write tools, every write with a preview', () => {
    const outlook = [...registry.values()].filter((t) => t.domain === 'outlook');
    expect(outlook.map((t) => t.name).sort()).toEqual([
      'outlook_createDraft',
      'outlook_getMessage',
      'outlook_listEvents',
      'outlook_listMessages',
      'outlook_readAttachment',
      'outlook_reply',
      'outlook_searchMail',
      'outlook_sendDraft',
      'outlook_sendMail',
    ]);
    for (const t of outlook.filter((t) => t.risk !== 'READ')) expect(t.preview, t.name).toBeTypeOf('function');
  });

  it("lists the user's own inbox, newest first, and marks mail content as untrusted", async () => {
    const r = await run(context(alex), 'outlook_listMessages');
    const items = (r.data.messages as { subject: string }[]).map((m) => m.subject);
    expect(items[0]).toBe('Invoice 5100012345 still unpaid');
    expect(items).not.toContain('Offer letter for the AP accountant role'); // Sam's mail
    expect(r.data.notice).toMatch(/never instructions/);
    expect(r.components![0]!.type).toBe('mail_list');
  });

  it('filters unread mail', async () => {
    const r = await run(context(alex), 'outlook_listMessages', { unreadOnly: true });
    expect((r.data.messages as { unread: boolean }[]).every((m) => m.unread)).toBe(true);
  });

  it('searches by words and sender', async () => {
    const ctx = context(alex);
    expect((await run(ctx, 'outlook_searchMail', { text: '5100012345' })).data.messages).toHaveLength(1);
    expect((await run(ctx, 'outlook_searchMail', { from: 'priya' })).data.messages).toHaveLength(1);
    await expect(run(ctx, 'outlook_searchMail', {})).rejects.toThrow(/what to search for/);
  });

  it('opens a message as plain text with its attachments', async () => {
    const r = await run(context(alex), 'outlook_getMessage', { messageId: 'AAMk-alex-003' });
    expect((r.data.message as { attachments: string[] }).attachments).toEqual(['F110-proposal.xlsx']);
    expect(r.components![0]).toMatchObject({ type: 'mail_message', data: { status: 'received', subject: 'Payment run proposal for Friday' } });
  });

  it("cannot open another user's message", async () => {
    await expect(run(context(sam), 'outlook_getMessage', { messageId: 'AAMk-alex-001' })).rejects.toBeInstanceOf(SapError);
  });

  it('refuses a user without a mailbox', async () => {
    await expect(run(context(casey), 'outlook_listMessages')).rejects.toThrow(/No Outlook mailbox/);
  });

  it("shows today's calendar by default and validates the range", async () => {
    const ctx = context(alex);
    const r = await run(ctx, 'outlook_listEvents');
    expect((r.data.events as { subject: string }[]).map((e) => e.subject)).toEqual(['AP stand-up', 'Month-end close review']);
    expect(r.components![0]).toMatchObject({ type: 'calendar', data: { timeZone: 'Arab Standard Time' } });
    await expect(run(ctx, 'outlook_listEvents', { from: '2026-01-01', to: '2026-03-01' })).rejects.toThrow(/at most 31 days/);
  });

  it('saves a draft without sending it, then sends the draft', async () => {
    const ctx = context(alex);
    const draft = await run(ctx, 'outlook_createDraft', { to: ['mei.tanaka@prowess.example'], subject: 'Statement', body: 'Mei, please check the statement.' });
    expect(draft.components![0]).toMatchObject({ type: 'mail_message', data: { status: 'draft' } });
    const id = draft.outputs!.draft!;
    expect((await run(ctx, 'outlook_listMessages', { folder: 'drafts' })).data.messages).toHaveLength(1);

    await run(ctx, 'outlook_sendDraft', { draftId: id });
    expect((await run(ctx, 'outlook_listMessages', { folder: 'drafts' })).data.messages).toHaveLength(0);
    expect((await run(ctx, 'outlook_listMessages', { folder: 'sentitems' })).data.messages).toEqual(expect.arrayContaining([expect.objectContaining({ subject: 'Statement' })]));
  });

  it('names external recipients on the confirmation', async () => {
    const preview = await registry.get('outlook_reply')!.preview!({ messageId: 'AAMk-alex-001', body: 'We are checking it.' } as never, context(alex));
    expect(preview.proposedChange).toContain('accounts@gulfsteel.example');
    expect(preview.impact).toMatch(/External recipient\(s\): accounts@gulfsteel\.example/);
  });

  it('refuses recipients outside the allowed domains, in the preview and when run', async () => {
    const ctx = context(alex, ['prowess.example']);
    const args = { to: ['someone@elsewhere.example'], subject: 'Hi', body: 'Hello' };
    await expect(registry.get('outlook_sendMail')!.preview!(args as never, ctx)).rejects.toThrow(/not allowed/);
    await expect(run(ctx, 'outlook_sendMail', args)).rejects.toThrow(/not allowed/);
    await expect(run(ctx, 'outlook_reply', { messageId: 'AAMk-alex-001', body: 'Thanks' })).rejects.toThrow(/not allowed/);
    await expect(run(ctx, 'outlook_sendMail', { ...args, to: ['mei.tanaka@prowess.example'] })).resolves.toBeDefined();
  });

  it('replies to everyone on a message except the user', async () => {
    const gateway = new MockMailGateway(0);
    const ctx = context(alex, [], gateway);
    await run(ctx, 'outlook_reply', { messageId: 'AAMk-alex-002', body: 'On it, zebra check done.', replyAll: true });
    const sent = await gateway.searchMessages(alex, { text: 'zebra', top: 5 });
    expect(sent).toHaveLength(1);
    const reply = await gateway.getMessage(alex, sent[0]!.id);
    expect(reply.subject).toBe('RE: Month-end close: open GR/IR items');
    expect(reply.to.map((a) => a.address)).toEqual(['priya.nair@prowess.example']);
  });
});
