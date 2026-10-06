import { describe, expect, it } from 'vitest';
import { api, components, missingSettings, runWorkflow, testData } from './client.js';

/**
 * Order-to-cash against the real S/4HANA system, through the deployed application and as the test user:
 * sign-in, roles, agents, tools, principal propagation and SAP authorization are all on the path.
 * Every run posts real documents (a sales order, a delivery, a goods issue and an invoice) on the test data.
 */
describe('order-to-cash on S/4HANA', () => {
  it('has its settings', () => {
    expect(missingSettings(), 'settings missing from the environment').toEqual([]);
  });

  it('signs in as the test user', async () => {
    const res = await api('GET', '/api/v1/workspace');
    expect(res.status, `workspace → HTTP ${res.status}, reference ${res.reference}`).toBe(200);
    const user = res.json.user as { email?: string; id?: string } | undefined;
    expect((user?.email ?? user?.id ?? '').toLowerCase()).toBe(process.env.AIUSER_MAIL!.toLowerCase());
  });

  let salesOrder = '';

  it('creates a complete sales order', async () => {
    const data = testData();
    const outcome = await runWorkflow('sales-order-entry', {
      customer: data.customer,
      material: data.material,
      quantity: data.quantity,
      salesOrganization: data.salesOrganization,
      distributionChannel: data.distributionChannel,
      division: data.division,
      customerReference: `IT-${new Date().toISOString().slice(0, 16).replace(/\D/g, '')}`,
    });
    console.log(outcome.log.join('\n'));
    salesOrder = String(components(outcome.responses.map((r) => r.json), 'sales_order').at(-1)?.data.number ?? '');
    expect(salesOrder, 'no sales order was created').not.toBe('');
    expect(outcome.card?.status, outcome.log.at(-1)).toBe('completed');
  });

  it('delivers, goods-issues and bills the order and posts the receivable', async () => {
    expect(salesOrder, 'the sales order step did not create an order').not.toBe('');
    const outcome = await runWorkflow('order-to-cash', { salesOrder, companyCode: testData().companyCode });
    console.log(outcome.log.join('\n'));
    expect(outcome.card?.status, outcome.log.at(-1)).toBe('completed');
    const billing = components(outcome.responses.map((r) => r.json), 'billing_document').at(-1)?.data;
    expect(billing?.postedToAccounting, 'the invoice has no accounting document').toBe(true);
  });
});
