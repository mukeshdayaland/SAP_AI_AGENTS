import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ofType, startStack, USERS } from './harness.js';

let stack: Awaited<ReturnType<typeof startStack>>;

beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

type Card = { id: string; status: string; reason?: string; steps: { id: string; state: string; agent: string }[] };
type FollowUp = { content: string; response?: { components?: { type: string; data: unknown }[]; confirmations?: { id: string; action: string }[] } };

const O2C = 'Run order-to-cash for sales order 649 in company code 1030.';
const states = (card: Card) => card.steps.map((s) => s.state);
const runCard = (m: FollowUp) => m.response!.components!.find((c) => c.type === 'workflow_run')!.data as Card;

async function startFromChat(user: string, message = O2C) {
  const { events } = await stack.chat(user, { message, agent: 'sd' });
  const cards = ofType(events, 'component').filter((c) => c.component.type === 'workflow_run');
  return { events, card: cards.at(-1)?.component.data as Card | undefined, confirmations: ofType(events, 'confirmation.required').map((c) => c.confirmation) };
}

// The tests share one mock SAP system and run in order: sales order 649 is delivered and billed by the third test.
describe('workflow runs', () => {
  it('lists the workflows a user may run, with the module agent of each step', async () => {
    const res = await stack.request('GET', '/api/v1/workflows', USERS.jordan);
    const o2c = (res.json as unknown as { id: string; steps: { id: string; agent: string }[] }[]).find((w) => w.id === 'order-to-cash')!;
    expect(o2c.steps.map((s) => `${s.id}:${s.agent}`)).toEqual([
      'order:SD',
      'credit:FICO',
      'delivery:SD',
      'goodsIssue:SD',
      'billing:SD',
      'verify:SD',
      'receivable:FICO',
    ]);
    expect((await stack.request('GET', '/api/v1/workflows', USERS.casey)).json).toEqual([]);
  });

  it('runs the read steps, then pauses at the first posting; cancelling it ends the run without touching SAP', async () => {
    const { events, card, confirmations } = await startFromChat(USERS.jordan);
    expect(ofType(events, 'tool.start').map((t) => `${t.tool.agent}/${t.tool.tool}`)).toEqual(['sd/sd_getSalesOrderFlow', 'fico/credit_getCreditExposure', 'sd/sd_createDelivery']);
    expect(card!.status).toBe('awaiting_confirmation');
    expect(states(card!)).toEqual(['done', 'done', 'awaiting_confirmation', 'pending', 'pending', 'pending', 'pending']);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({ action: 'Create outbound delivery', risk: 'HIGH_IMPACT', businessObject: { id: '649' } });
    expect(ofType(events, 'message.delta').map((d) => d.text).join('')).toMatch(/2 of 7 steps are done[\s\S]*Create the outbound delivery/);

    // Another user can neither see the run nor confirm its posting.
    expect((await stack.request('GET', `/api/v1/runs/${card!.id}`, USERS.alex)).status).toBe(404);
    expect((await stack.request('POST', `/api/v1/actions/${confirmations[0]!.id}/confirm`, USERS.alex, {})).status).toBe(404);

    const cancelled = await stack.request('POST', `/api/v1/actions/${confirmations[0]!.id}/cancel`, USERS.jordan, {});
    const followUp = (cancelled.json.followUp as FollowUp[])[0]!;
    expect(runCard(followUp)).toMatchObject({ status: 'cancelled', reason: 'The posting was cancelled.' });
    expect((await stack.request('GET', `/api/v1/runs/${card!.id}`, USERS.jordan)).json).toMatchObject({ status: 'cancelled' });

    // SAP is unchanged: a new run still has to create the delivery.
    expect((await startFromChat(USERS.jordan)).confirmations[0]).toMatchObject({ action: 'Create outbound delivery' });
  });

  it('resumes after each confirmation until the order is billed and the receivable is verified', async () => {
    const { card, confirmations } = await startFromChat(USERS.jordan);
    const confirm = async (id: string) => {
      const res = await stack.request('POST', `/api/v1/actions/${id}/confirm`, USERS.jordan, {});
      expect(res.status).toBe(200);
      expect((res.json.confirmation as { status: string }).status).toBe('completed');
      return (res.json.followUp as FollowUp[])[0]!;
    };

    const afterDelivery = await confirm(confirmations[0]!.id);
    expect(afterDelivery.response!.confirmations![0]!.action).toBe('Post goods issue');
    expect(states(runCard(afterDelivery))).toEqual(['done', 'done', 'done', 'awaiting_confirmation', 'pending', 'pending', 'pending']);

    const afterGoodsIssue = await confirm(afterDelivery.response!.confirmations![0]!.id);
    expect(afterGoodsIssue.response!.confirmations![0]!.action).toBe('Create billing document');

    const done = await confirm(afterGoodsIssue.response!.confirmations![0]!.id);
    expect(done.content).toMatch(/is complete: all 7 steps are done/);
    expect(done.response!.confirmations).toBeUndefined();
    expect(runCard(done).status).toBe('completed');
    // The verification steps ran after the last posting: document flow, then the customer account.
    expect(done.response!.components!.map((c) => c.type)).toEqual(['sales_order', 'timeline', 'open_items', 'workflow_run']);
    expect(done.response!.components!.find((c) => c.type === 'open_items')!.data).toMatchObject({ total: { amount: 15000, currency: 'SAR' } });

    const run = await stack.request('GET', `/api/v1/runs/${card!.id}`, USERS.jordan);
    expect(run.json).toMatchObject({ status: 'completed', title: 'Order-to-cash for sales order 649' });

    // The whole run is part of the conversation: the chat turn, three posting results and three follow-ups.
    const detail = await stack.request('GET', `/api/v1/conversations/${run.json.conversationId as string}`, USERS.jordan);
    expect((detail.json.messages as unknown[]).length).toBe(8);

    const audit = stack.auditBuffer.events.filter((e) => e.details?.runId === card!.id).map((e) => `${e.type}:${e.status}`);
    expect(audit).toEqual(expect.arrayContaining(['WORKFLOW_STARTED:success', 'WORKFLOW_ENDED:success']));
    expect(audit.filter((e) => e === 'SAP_WRITE_REQUESTED:pending')).toHaveLength(3);

    // Running it again posts nothing: every posting is already done in SAP.
    const again = await startFromChat(USERS.jordan);
    expect(again.confirmations).toHaveLength(0);
    expect(states(again.card!)).toEqual(['done', 'done', 'skipped', 'skipped', 'skipped', 'done', 'done']);
  });

  it('stops a credit-blocked order before any posting is proposed', async () => {
    const { card, confirmations } = await startFromChat(USERS.jordan, 'Run order-to-cash for sales order 650 in company code 1030.');
    expect(confirmations).toHaveLength(0);
    expect(card).toMatchObject({ status: 'blocked' });
    expect(card!.reason).toMatch(/credit manager must release it/);
    expect(states(card!)).toEqual(['done', 'done', 'pending', 'pending', 'pending', 'pending', 'pending']);
  });

  it('starts a run through the API in a conversation of its own, and validates the input', async () => {
    const start = (user: string, input: Record<string, string>, workflow = 'order-to-cash') => stack.request('POST', `/api/v1/workflows/${workflow}/runs`, user, { input });
    const res = await start(USERS.jordan, { salesOrder: '648', companyCode: '1030' });
    expect(res.status).toBe(201);
    expect(res.json.run).toMatchObject({ status: 'completed', conversationId: res.json.conversationId });
    expect(states(res.json.run as Card)).toEqual(['done', 'done', 'skipped', 'skipped', 'skipped', 'done', 'done']);
    const detail = await stack.request('GET', `/api/v1/conversations/${res.json.conversationId as string}`, USERS.jordan);
    expect(detail.json).toMatchObject({ title: 'Order-to-cash for sales order 648' });

    const before = ((await stack.request('GET', '/api/v1/conversations', USERS.jordan)).json as unknown as unknown[]).length;
    expect((await start(USERS.jordan, { salesOrder: 'abc', companyCode: '1030' })).status).toBe(400);
    expect((await start(USERS.jordan, { salesOrder: '648' })).status).toBe(400);
    expect((await start(USERS.jordan, {}, 'unknown-flow')).status).toBe(400);
    expect((await start(USERS.casey, { salesOrder: '648', companyCode: '1030' })).status).toBe(400);
    // A rejected request leaves no empty conversation behind.
    expect(((await stack.request('GET', '/api/v1/conversations', USERS.jordan)).json as unknown as unknown[]).length).toBe(before);
  });

  it('fails the run, not the chat, when SAP cannot find the order', async () => {
    const { card, events } = await startFromChat(USERS.jordan, 'Run order-to-cash for sales order 999 in company code 1030.');
    expect(card).toMatchObject({ status: 'failed' });
    expect(card!.reason).toMatch(/Sales order 999 was not found/);
    expect(ofType(events, 'message.complete')[0]!.status).toBe('complete');
  });

  it('only offers the workflow to agents that own it', async () => {
    const { events } = await stack.chat(USERS.jordan, { message: O2C, agent: 'fi-ar' });
    expect(ofType(events, 'component').some((c) => c.component.type === 'workflow_run')).toBe(false);
    expect(ofType(events, 'confirmation.required')).toHaveLength(0);
  });
});
