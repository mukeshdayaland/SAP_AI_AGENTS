import { afterAll, describe, expect, it } from 'vitest';
import { ofType, startStack, USERS } from './harness.js';

type Stack = Awaited<ReturnType<typeof startStack>>;
type Card = { id: string; status: string; reason?: string; steps: { id: string; state: string; agent: string }[] };
type Message = { content: string; response?: { components?: { type: string; data: unknown }[]; confirmations?: { id: string; action: string; proposedChange: string }[] } };

const stacks: Stack[] = [];
// Each test gets its own mock SAP system: purchase order 4200000403 can be received and invoiced only once.
async function freshStack() {
  const stack = await startStack();
  stacks.push(stack);
  return stack;
}
afterAll(() => Promise.all(stacks.map((s) => s.stop())));

const states = (card: Card) => card.steps.map((s) => s.state);
const runCard = (m: Message) => m.response!.components!.find((c) => c.type === 'workflow_run')!.data as Card;

async function confirm(stack: Stack, id: string): Promise<Message> {
  const res = await stack.request('POST', `/api/v1/actions/${id}/confirm`, USERS.jordan, {});
  expect(res.status).toBe(200);
  expect((res.json.confirmation as { status: string }).status).toBe('completed');
  return (res.json.followUp as Message[])[0]!;
}

describe('purchase-to-pay workflow', () => {
  it('receives and invoices a purchase order from chat, with a confirmation for each posting', async () => {
    const stack = await freshStack();
    const { events } = await stack.chat(USERS.jordan, { message: 'Run purchase-to-pay for purchase order 4200000403 in company code 1030 with invoice VEN004 for 3360.', agent: 'mm' });

    expect(ofType(events, 'tool.start').map((t) => `${t.tool.agent}/${t.tool.tool}`)).toEqual(['mm/mm_getPurchaseOrderFlow', 'mm/mm_postGoodsReceipt']);
    const card = ofType(events, 'component').filter((c) => c.component.type === 'workflow_run').at(-1)!.component.data as Card;
    expect(card.steps.map((s) => `${s.id}:${s.agent}`)).toEqual(['order:MM', 'receipt:MM', 'invoice:MM', 'verify:MM', 'payable:FICO']);
    expect(states(card)).toEqual(['done', 'awaiting_confirmation', 'pending', 'pending', 'pending']);
    const first = ofType(events, 'confirmation.required')[0]!.confirmation;
    expect(first).toMatchObject({ action: 'Post goods receipt', risk: 'HIGH_IMPACT', proposedChange: 'Receive 3 PC RAW MATERIAL:ACGC from AL-QASSIM.' });

    const afterReceipt = await confirm(stack, first.id);
    const second = afterReceipt.response!.confirmations![0]!;
    expect(second).toMatchObject({ action: 'Enter supplier invoice' });
    expect(second.proposedChange).toMatch(/invoice VEN004 from AL-QASSIM for SAR 3,360 gross/);

    const done = await confirm(stack, second.id);
    expect(done.content).toMatch(/is complete: all 5 steps are done/);
    expect(runCard(done).status).toBe('completed');
    expect(done.response!.components!.map((c) => c.type)).toEqual(['purchase_order', 'timeline', 'open_items', 'workflow_run']);
    // The supplier account now holds the earlier open invoice and the new one.
    expect(done.response!.components!.find((c) => c.type === 'open_items')!.data).toMatchObject({ accountType: 'SUPPLIER', total: { amount: -4480, currency: 'SAR' } });

    // Running it again posts nothing.
    const again = await stack.chat(USERS.jordan, { message: 'Run purchase-to-pay for purchase order 4200000403 in company code 1030 with invoice VEN004 for 3360.', agent: 'mm' });
    expect(ofType(again.events, 'confirmation.required')).toHaveLength(0);
    const repeat = ofType(again.events, 'component').filter((c) => c.component.type === 'workflow_run').at(-1)!.component.data as Card;
    expect(states(repeat)).toEqual(['done', 'skipped', 'skipped', 'done', 'done']);
  });

  it('stops as blocked when invoice verification blocks the invoice', async () => {
    const stack = await freshStack();
    const start = await stack.request('POST', '/api/v1/workflows/purchase-to-pay/runs', USERS.jordan, {
      input: { purchaseOrder: '4200000403', companyCode: '1030', invoiceReference: 'VEN004', invoiceAmount: '3900' },
    });
    expect(start.status).toBe(201);
    const afterReceipt = await confirm(stack, (start.json.message as Message).response!.confirmations![0]!.id);
    const end = await confirm(stack, afterReceipt.response!.confirmations![0]!.id);

    const card = runCard(end);
    expect(card.status).toBe('blocked');
    expect(card.reason).toMatch(/blocked for payment by invoice verification/);
    expect(states(card)).toEqual(['done', 'done', 'done', 'done', 'pending']);
    expect(end.response!.confirmations).toBeUndefined();
  });

  it('validates the invoice details before anything is read or posted', async () => {
    const stack = await freshStack();
    const start = (input: Record<string, string>) => stack.request('POST', '/api/v1/workflows/purchase-to-pay/runs', USERS.jordan, { input });
    expect((await start({ purchaseOrder: '4200000403', companyCode: '1030', invoiceReference: 'VEN004' })).status).toBe(400);
    expect((await start({ purchaseOrder: '4200000403', companyCode: '1030', invoiceReference: 'VEN004', invoiceAmount: '-5' })).status).toBe(400);
    expect((await start({ purchaseOrder: '42', companyCode: '1030', invoiceReference: 'VEN004', invoiceAmount: '3360' })).status).toBe(400);
  });

  it('offers the workflow to the MM agent only', async () => {
    const stack = await freshStack();
    const { events } = await stack.chat(USERS.jordan, { message: 'Run purchase-to-pay for purchase order 4200000403 in company code 1030 with invoice VEN004 for 3360.', agent: 'fico' });
    expect(ofType(events, 'component').some((c) => c.component.type === 'workflow_run')).toBe(false);
    expect(ofType(events, 'confirmation.required')).toHaveLength(0);
  });
});
