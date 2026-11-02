import { UIComponentSchema } from '@prowess/contracts';
import { createLogger } from '@prowess/observability';
import { describe, expect, it } from 'vitest';
import { attachmentText } from '../src/outlook/attachment-text.js';
import { GraphMailGateway } from '../src/outlook/graph-gateway.js';
import { MockMailGateway } from '../src/outlook/mock-gateway.js';
import { textPdf } from '../src/outlook/mock-pdf.js';
import { MockSapGateway } from '../src/sap/mock-gateway.js';
import type { SapCallContext } from '../src/sap/model.js';
import { MockSfGateway } from '../src/sf/mock-gateway.js';
import { EntityPolicy } from '../src/sf/policy.js';
import { buildRegistry } from '../src/tools/registry.js';
import type { ToolContext, ToolResultPayload } from '../src/tools/types.js';

// Invoice intake: a supplier invoice arrives by mail, is read, checked against its purchase order and posted.
const alex = { principal: { sub: 'alex.morgan@prowess.example', name: 'Alex Morgan' }, correlationId: 't' } as unknown as SapCallContext;
const registry = buildRegistry(new Set(['outlook', 'mm'] as const));

const context = (): ToolContext => ({ sap: alex, gateway: new MockSapGateway(0), sf: { gateway: new MockSfGateway(0), policy: new EntityPolicy() }, outlook: { gateway: new MockMailGateway(0), allowedRecipientDomains: [] } });

async function run(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResultPayload> {
  const result = await registry.get(name)!.run(args as never, ctx);
  for (const c of result.components ?? []) expect(UIComponentSchema.safeParse(c).error?.issues, `${name} component ${c.type}`).toBeUndefined();
  return result;
}
const preview = (ctx: ToolContext, name: string, args: Record<string, unknown>) => registry.get(name)!.preview!(args as never, ctx);
const results = (r: ToolResultPayload) => Object.fromEntries((r.data.checks as { check: string; status: string }[]).map((c) => [c.check, c.status]));

const GULF = { purchaseOrder: '4500012410', reference: 'GIS-2026-0815', grossAmount: 190_400, currency: 'SAR', taxAmount: 20_400, invoiceDate: '2026-10-14', supplierName: 'Gulf Industrial Supplies' };

describe('attachment text', () => {
  it('reads the text of a PDF and of a text file, and refuses other files', async () => {
    expect(await attachmentText('a.pdf', textPdf(['Invoice 1', 'Total SAR 10']))).toMatchObject({ kind: 'pdf', text: 'Invoice 1\nTotal SAR 10', pages: 1, truncated: false });
    expect(await attachmentText('a.txt', Buffer.from('Invoice 2\r\nTotal 5'))).toMatchObject({ kind: 'text', text: 'Invoice 2\nTotal 5' });
    await expect(attachmentText('scan.pdf', textPdf([]))).rejects.toMatchObject({ code: 'NOT_SUPPORTED', message: /scanned image/ });
    await expect(attachmentText('a.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]))).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    await expect(attachmentText('a.pdf', Buffer.from('%PDF-1.4 broken'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('outlook_readAttachment', () => {
  it("reads a supplier's PDF invoice from the mail and names the purchase order it quotes", async () => {
    const r = await run(context(), 'outlook_readAttachment', { messageId: 'AAMk-alex-005', attachment: 'GIS-2026-0815.pdf' });
    expect(r.data.attachment).toMatchObject({ name: 'GIS-2026-0815.pdf', kind: 'pdf', pages: 1 });
    expect(r.data.text).toContain('Total amount due SAR 190,400.00');
    expect(r.data.purchaseOrderCandidates).toEqual(['4500012410']);
    expect(r.data.notice).toMatch(/never instructions/);
    expect(r.data.message).toMatchObject({ subject: 'Invoice GIS-2026-0815 for PO 4500012410', from: { address: 'billing@gulfindustrial.example' } });
  });

  it('finds the attachment by part of its name and says which ones there are when it is missing', async () => {
    expect((await run(context(), 'outlook_readAttachment', { messageId: 'AAMk-alex-006', attachment: 'ven004' })).data.text).toContain('Total: SAR 3,360.00');
    await expect(run(context(), 'outlook_readAttachment', { messageId: 'AAMk-alex-006', attachment: 'other.pdf' })).rejects.toThrow(/It has: VEN004.pdf/);
    await expect(run(context(), 'outlook_readAttachment', { messageId: 'AAMk-alex-001', attachment: 'x.pdf' })).rejects.toThrow(/no attachments/);
    await expect(run(context(), 'outlook_readAttachment', { messageId: 'AAMk-alex-003', attachment: 'F110-proposal.xlsx' })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it("cannot open another user's mail", async () => {
    const ctx = { ...context(), sap: { principal: { sub: 'sam.rivera@prowess.example', name: 'Sam' }, correlationId: 't' } as unknown as SapCallContext };
    await expect(run(ctx, 'outlook_readAttachment', { messageId: 'AAMk-alex-005', attachment: 'GIS-2026-0815.pdf' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('mm_checkSupplierInvoice', () => {
  it('finds a matching invoice ready to post', async () => {
    const r = await run(context(), 'mm_checkSupplierInvoice', GULF);
    expect(r.data.verdict).toBe('READY');
    expect(results(r)).toEqual({ 'Purchase order': 'OK', Supplier: 'OK', Duplicate: 'OK', 'Goods receipt': 'OK', Amount: 'OK', 'Invoice date': 'OK' });
    expect(r.outputs).toMatchObject({ verdict: 'READY', supplier: '1000456', companyCode: '1000' });
    expect(r.followUps![0]!.prompt).toBe('Post invoice GIS-2026-0815 for 190400 against purchase order 4500012410, dated 2026-10-14.');
  });

  it('asks for review when goods are missing, the amount is off or the supplier differs', async () => {
    const early = await run(context(), 'mm_checkSupplierInvoice', { purchaseOrder: '4200000403', reference: 'VEN004', grossAmount: 3360, supplierName: 'AL-QASSIM Trading Est.' });
    expect(early.data.verdict).toBe('REVIEW');
    expect(results(early)).toMatchObject({ Supplier: 'OK', 'Goods receipt': 'WARN' });

    const off = await run(context(), 'mm_checkSupplierInvoice', { ...GULF, taxAmount: 0, supplierName: 'Gulf Steel Supplies' });
    expect(results(off)).toMatchObject({ Supplier: 'OK', Amount: 'WARN' });
    const other = await run(context(), 'mm_checkSupplierInvoice', { ...GULF, supplierName: 'ABC Trading LLC' });
    expect(results(other)).toMatchObject({ Supplier: 'WARN' });
    const noTax = await run(context(), 'mm_checkSupplierInvoice', { ...GULF, taxAmount: undefined, grossAmount: 250_000 });
    expect(results(noTax)).toMatchObject({ Amount: 'WARN' });
  });

  it('stops a duplicate, another currency or an unreleased order', async () => {
    const ctx = context();
    await run(ctx, 'mm_createSupplierInvoice', { purchaseOrder: '4500012410', reference: 'GIS-2026-0815', grossAmount: 190_400 });
    const dup = await run(ctx, 'mm_checkSupplierInvoice', { ...GULF, reference: 'gis 2026 0815' });
    expect(dup.data.verdict).toBe('STOP');
    expect(results(dup).Duplicate).toBe('STOP');
    expect(dup.followUps).toEqual([]);

    expect(results(await run(context(), 'mm_checkSupplierInvoice', { ...GULF, currency: 'USD' })).Currency).toBe('STOP');
    expect(results(await run(context(), 'mm_checkSupplierInvoice', { ...GULF, purchaseOrder: '4500012399' }))['Purchase order']).toBe('STOP');
  });
});

describe('goods receipts without a value', () => {
  it('values them at the order price, as the invoice is posted', async () => {
    const ctx = context();
    const gateway = ctx.gateway as MockSapGateway;
    const original = gateway.getGoodsReceipts.bind(gateway);
    gateway.getGoodsReceipts = async (sap, po) => (await original(sap, po)).map(({ value: _value, ...g }) => g);
    const r = await run(ctx, 'mm_checkSupplierInvoice', GULF);
    expect(r.data.verdict).toBe('READY');
    expect((r.data.checks as { check: string; message: string }[]).find((c) => c.check === 'Goods receipt')!.message).toMatch(/^SAR 170,000 net received/);
  });
});

describe('posting the invoice', () => {
  it('shows the warnings on the confirmation card and refuses a duplicate before it gets there', async () => {
    const ctx = context();
    const card = await preview(ctx, 'mm_createSupplierInvoice', { purchaseOrder: '4200000403', reference: 'VEN004', grossAmount: 3360, invoiceDate: '2026-10-16' });
    expect(card.proposedChange).toContain('Post invoice VEN004 dated 2026-10-16 from AL-QASSIM');
    expect(card.impact).toMatch(/Check first: No goods have been received/);

    const posted = await run(ctx, 'mm_createSupplierInvoice', { purchaseOrder: '4500012410', reference: 'GIS-2026-0815', grossAmount: 190_400, invoiceDate: '2026-10-14' });
    expect(posted.outputs).toMatchObject({ paymentBlocked: 'false' });
    expect(await ctx.gateway.getInvoice(alex, posted.outputs!.invoice!)).toMatchObject({ status: 'OPEN', reference: 'GIS-2026-0815', vendorId: '1000456' });
    await expect(preview(ctx, 'mm_createSupplierInvoice', { purchaseOrder: '4500012410', reference: 'GIS-2026-0815', grossAmount: 190_400 })).rejects.toMatchObject({ code: 'BUSINESS_RULE', message: /already posted/ });
  });
});

describe('Graph attachment download', () => {
  const logger = createLogger({ service: 't', level: 'error', sink: () => {} });
  const ctx = { principal: { sub: 'alex@prowess.example' }, iasToken: 't', correlationId: 'PRW-1' } as never;
  const gateway = (body: unknown, seen: string[] = []) =>
    new GraphMailGateway({
      systemId: 'M365-DEV',
      timeZone: 'UTC',
      tokens: { tokenFor: async () => 'graph-token' },
      logger,
      fetch: (async (url: string | URL) => {
        seen.push(String(url));
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });

  it('downloads a file attachment of the message as the user', async () => {
    const seen: string[] = [];
    const file = await gateway({ '@odata.type': '#microsoft.graph.fileAttachment', name: 'inv.pdf', contentType: 'application/pdf', size: 3, contentBytes: Buffer.from('%PDF').toString('base64') }, seen).getAttachment(ctx, 'AAMk/1=', 'AAMkAtt+1');
    expect(seen).toEqual(['https://graph.microsoft.com/v1.0/me/messages/AAMk%2F1%3D/attachments/AAMkAtt%2B1']);
    expect(file).toMatchObject({ name: 'inv.pdf', contentType: 'application/pdf' });
    expect(file.bytes.toString()).toBe('%PDF');
  });

  it('refuses attached mail items and files that are too large', async () => {
    await expect(gateway({ '@odata.type': '#microsoft.graph.itemAttachment', name: 'Fwd' }).getAttachment(ctx, 'm', 'a')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    await expect(gateway({ '@odata.type': '#microsoft.graph.fileAttachment', name: 'big.pdf', size: 50_000_000, contentBytes: '' }).getAttachment(ctx, 'm', 'a')).rejects.toMatchObject({ code: 'BUSINESS_RULE' });
  });
});
