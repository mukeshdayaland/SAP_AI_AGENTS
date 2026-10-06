import { afterAll, describe, expect, it } from 'vitest';
import { startStack, USERS } from './harness.js';

type Stack = Awaited<ReturnType<typeof startStack>>;
type Card = { status: string; reason?: string; steps: { id: string; state: string }[] };
type Message = { content: string; response?: { components?: { type: string; data: unknown }[]; confirmations?: { id: string; action: string }[] } };

const stacks: Stack[] = [];
async function freshStack() {
  const stack = await startStack();
  stacks.push(stack);
  return stack;
}
afterAll(() => Promise.all(stacks.map((s) => s.stop())));

const ORDER = { customer: '7000000010', material: '5496', quantity: '10', salesOrganization: '1030', distributionChannel: '10', division: '00', customerReference: 'PO-77' };
const runCard = (m: Message) => m.response!.components!.find((c) => c.type === 'workflow_run')!.data as Card;

/** Confirms each posting of a run; returns the last follow-up and every confirmation response. */
async function confirmAll(stack: Stack, first: Message): Promise<{ last: Message; responses: Record<string, unknown>[] }> {
  let message = first;
  const responses: Record<string, unknown>[] = [];
  for (let i = 0; i < 5 && message.response?.confirmations?.length; i++) {
    const res = await stack.request('POST', `/api/v1/actions/${message.response.confirmations[0]!.id}/confirm`, USERS.jordan, {});
    expect((res.json.confirmation as { status: string }).status).toBe('completed');
    responses.push(res.json);
    message = (res.json.followUp as Message[])[0]!;
  }
  return { last: message, responses };
}

/** The sales order a posting created, from the card of its result. */
const createdOrder = (responses: Record<string, unknown>[]) => JSON.stringify(responses).match(/"type":"sales_order","data":\{"number":"(\d+)"/)?.[1];

describe('sales order entry workflow', () => {
  it('creates a complete sales order that order-to-cash then delivers and bills', async () => {
    const stack = await freshStack();
    const start = await stack.request('POST', '/api/v1/workflows/sales-order-entry/runs', USERS.jordan, { input: ORDER });
    expect(start.status).toBe(201);
    const first = start.json.message as Message;
    expect(first.response!.confirmations![0]).toMatchObject({ action: 'Create sales order' });

    const entered = await confirmAll(stack, first);
    const card = runCard(entered.last);
    expect(card.status).toBe('completed');
    expect(card.steps.map((s) => s.state)).toEqual(['done', 'done', 'done']);
    const order = createdOrder(entered.responses);
    expect(order).toBe('651');

    const o2c = await stack.request('POST', '/api/v1/workflows/order-to-cash/runs', USERS.jordan, { input: { salesOrder: order, companyCode: '1030' } });
    expect(o2c.status).toBe(201);
    const done = await confirmAll(stack, o2c.json.message as Message);
    expect(runCard(done.last).status).toBe('completed');
  });

  it('creates nothing when the credit check would block the order', async () => {
    const stack = await freshStack();
    const start = await stack.request('POST', '/api/v1/workflows/sales-order-entry/runs', USERS.jordan, { input: { ...ORDER, quantity: '100' } });
    const card = runCard(start.json.message as Message);
    expect(card.status).toBe('blocked');
    expect(card.reason).toMatch(/blocked by the credit check, so it was not created/);
    expect((start.json.message as Message).response!.confirmations).toBeUndefined();
  });
});
