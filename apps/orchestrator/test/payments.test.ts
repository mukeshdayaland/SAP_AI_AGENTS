import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ofType, startStack, USERS } from './harness.js';

type Stack = Awaited<ReturnType<typeof startStack>>;
let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

/** Sends a chat message that proposes a write, confirms it as the same user and returns the result message. */
async function confirmed(user: string, message: string) {
  const { events } = await stack.chat(user, { message, agent: 'fico' });
  const confirmation = ofType(events, 'confirmation.required')[0]!.confirmation;
  const res = await stack.request('POST', `/api/v1/actions/${confirmation.id}/confirm`, user, {});
  return { confirmation, status: res.status, body: res.json as { confirmation?: { status: string }; message?: { content: string }; error?: { message: string } } };
}

async function queue(user: string) {
  const { events } = await stack.chat(user, { message: 'List the payment requests waiting for approval in company code 1030.', agent: 'fico' });
  expect(ofType(events, 'tool.start')[0]!.tool.tool).toBe('gl_listPaymentRequests');
  const table = ofType(events, 'component').find((c) => c.component.type === 'business_object_table');
  return ((table?.component.data as { rows: { id: string; status: string; partner: string }[] } | undefined)?.rows ?? []) as { id: string; status: string; partner: string }[];
}

// The tests run in order against one mock SAP system.
describe('payment requests with second-person approval', () => {
  let id: string;

  it('lets a user request an incoming payment, which then waits in the approval queue', async () => {
    expect(await queue(USERS.alex)).toEqual([]);
    const { confirmation, status, body } = await confirmed(USERS.jordan, 'Request an incoming payment of 2500 from customer 7000000010 in company code 1030.');
    expect(confirmation).toMatchObject({ action: 'Request incoming payment', risk: 'BUSINESS_WRITE', proposedChange: 'Request an incoming payment of SAR 2,500 from Local Customer-01 to bank account 220001 in company code 1030.' });
    expect(status).toBe(200);
    expect(body.message!.content).toMatch(/waiting for approval by a second person/);

    const rows = await queue(USERS.alex);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'Waiting for approval', partner: 'Local Customer-01 (7000000010)' });
    id = rows[0]!.id;
  });

  it('refuses approval by the person who created the request', async () => {
    const { status, body } = await confirmed(USERS.jordan, `Approve payment request ${id}.`);
    expect(status).toBe(200);
    expect(body.confirmation!.status).toBe('failed');
    expect(body.message!.content).toMatch(/was not completed.*second person must approve/);
    expect(await queue(USERS.alex)).toHaveLength(1);
  });

  it('posts the payment after a second person approved it', async () => {
    const approval = await confirmed(USERS.alex, `Approve payment request ${id}.`);
    expect(approval.confirmation).toMatchObject({ action: 'Approve payment request', risk: 'HIGH_IMPACT' });
    expect(approval.body.message!.content).toMatch(/was approved and can now be posted/);

    const posting = await confirmed(USERS.alex, `Post payment request ${id}.`);
    expect(posting.confirmation.proposedChange).toBe('Post SAR 2,500: debit bank account 220001, credit customer Local Customer-01 (7000000010).');
    expect(posting.body.message!.content).toMatch(/was posted as accounting document \*\*5000007\*\*/);
    expect(await queue(USERS.alex)).toEqual([]);

    // The payment is on the customer account next to the open invoice of SAR 2,500.
    const { events } = await stack.chat(USERS.alex, { message: 'Show the open items of customer 7000000010 in company code 1030.', agent: 'fico' });
    expect(ofType(events, 'component').find((c) => c.component.type === 'open_items')!.component.data).toMatchObject({ total: { amount: 0, currency: 'SAR' } });
  });

  it('keeps payment tools away from the MM and SD agents', async () => {
    for (const agent of ['mm', 'sd']) {
      const { events } = await stack.chat(USERS.alex, { message: 'List the payment requests waiting for approval in company code 1030.', agent });
      expect(ofType(events, 'tool.start')).toHaveLength(0);
    }
  });
});
