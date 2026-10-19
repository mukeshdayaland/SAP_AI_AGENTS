'use client';

import type { UIComponent } from '@prowess/contracts';
import { BookOpen, Building2, Check, CircleDashed, CircleHelp, CircleSlash, Copy, Lock, SearchX, TriangleAlert, Unplug, Cog, FileText, Hourglass, Landmark, ListChecks, Minus, Workflow, X, Package, PackageCheck, ReceiptText, ScrollText, ShoppingCart, Truck, UserRound, Wrench } from 'lucide-react';
import { useState, type ComponentType } from 'react';
import { formatDate, formatMoney, humanize } from '@/lib/format';
import { isMessageKey, translateServer, useT, type MessageKey, type T } from '@/lib/i18n';
import { Badge, cx, type Tone } from '../ui/primitives';
import { EmployeeMapCard, VendorMapCard } from '../vendors/VendorMap';
import { Field, Fields, SapArea, SapCard, toneText, useAsk, useShowMore } from './card';
import { FioriGuideCard } from './fiori-guide';
import { ApprovalsCard, EmployeeCard, ReportingLineCard, TeamOverviewCard, TimeOffCard } from './hcm-cards';
import { CalendarCard, MailListCard, MailMessageCard } from './mail-cards';

type Of<K extends UIComponent['type']> = Extract<UIComponent, { type: K }>['data'];

/** An SAP status code in the user's language; codes the catalog does not know are shown readable as they are. */
const sapLabel = (t: T, code: string) => {
  const key = `sap.${code}`;
  return isMessageKey(key) ? t(key) : humanize(code);
};

const invoiceTone: Record<Of<'invoice'>['status'], Tone> = { OPEN: 'info', PAYMENT_BLOCKED: 'critical', PARKED: 'warning', PAID: 'success', REVERSED: 'neutral' };
const poTone: Record<Of<'purchase_order'>['status'], Tone> = {
  DRAFT: 'neutral',
  AWAITING_APPROVAL: 'warning',
  RELEASED: 'success',
  PARTIALLY_DELIVERED: 'info',
  DELIVERED: 'success',
  CLOSED: 'neutral',
};

export function InvoiceCard({ data }: { data: Of<'invoice'> }) {
  const t = useT();
  return (
    <SapCard
      kind={t('kind.invoice')}
      id={data.number}
      icon={<FileText size={18} />}
      status={{ label: sapLabel(t, data.status), tone: invoiceTone[data.status] }}
      actions={[
        { label: t('action.viewInvoice'), prompt: t('prompt.viewInvoice', { number: data.number }) },
        { label: t('action.analyzeVendor'), prompt: t('prompt.vendorBehaviour', { vendor: data.vendorId }) },
        ...(data.purchaseOrder ? [{ label: t('action.checkPo'), prompt: t('prompt.checkPo', { po: data.purchaseOrder }) }] : []),
      ]}
    >
      <Fields>
        <Field label={t('field.vendor')}>
          {data.vendorName} <span className="text-ink-3">· {data.vendorId}</span>
        </Field>
        <Field label={t('field.amount')} emphasize>
          {formatMoney(data.amount)}
        </Field>
        <Field label={t('field.ccFy')} mono>
          {data.companyCode} / {data.fiscalYear}
        </Field>
        <Field label={t('field.due')}>{formatDate(data.dueDate)}</Field>
        {data.paymentBlock && (
          <Field label={t('field.paymentBlock')}>
            <span className="font-mono font-semibold text-error">{data.paymentBlock.code}</span> — {data.paymentBlock.description}
          </Field>
        )}
        {data.purchaseOrder && (
          <Field label={t('field.po')} mono>
            {data.purchaseOrder}
          </Field>
        )}
      </Fields>
      {data.blockReasons && data.blockReasons.length > 0 && (
        <div className="mt-3 rounded-lg border border-error/25 bg-error-soft px-3 py-2.5">
          <p className="text-xs font-semibold text-error">{t('card.verificationIssues')}</p>
          <ul className="mt-1 list-disc space-y-0.5 ps-4 text-[12px] text-ink">
            {data.blockReasons.map((r) => (
              <li key={r} dir="auto">
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}
    </SapCard>
  );
}

export function PurchaseOrderCard({ data }: { data: Of<'purchase_order'> }) {
  const t = useT();
  return (
    <SapCard
      kind={t('kind.po')}
      id={data.number}
      icon={<Package size={18} />}
      status={{ label: sapLabel(t, data.status), tone: poTone[data.status] }}
      actions={[
        { label: t('action.goodsReceipts'), prompt: t('prompt.goodsReceipts', { po: data.number }) },
        { label: t('action.analyzeVendor'), prompt: t('prompt.vendorExposure', { vendor: data.vendorId }) },
      ]}
    >
      <Fields>
        <Field label={t('field.vendor')}>{data.vendorName}</Field>
        <Field label={t('field.value')} emphasize>
          {formatMoney(data.value)}
        </Field>
        <Field label={t('field.created')}>{formatDate(data.createdOn)}</Field>
        {data.purchasingGroup && <Field label={t('field.purchasingGroup')}>{data.purchasingGroup}</Field>}
      </Fields>
      {data.items && data.items.length > 0 && (
        <details className="mt-3 group">
          <summary className="cursor-pointer text-xs font-medium text-ink-2 hover:text-ink">{t('card.items', { count: data.items.length })}</summary>
          <Table
            columns={[
              { key: 'item', label: t('field.item') },
              { key: 'description', label: t('field.description') },
              { key: 'qty', label: t('field.quantity'), align: 'right' },
              { key: 'value', label: t('field.netValue'), align: 'right' },
            ]}
            rows={data.items.map((i) => ({ item: i.item, description: i.description, qty: `${i.quantity} ${i.unit}`, value: formatMoney(i.netValue) }))}
          />
        </details>
      )}
    </SapCard>
  );
}

export function PurchaseRequisitionCard({ data }: { data: Of<'purchase_requisition'> }) {
  const t = useT();
  return (
    <SapCard kind={t('kind.pr')} id={data.number} icon={<ScrollText size={18} />} status={{ label: sapLabel(t, data.status), tone: data.status === 'APPROVED' ? 'success' : data.status === 'REJECTED' ? 'critical' : 'info' }}>
      <Fields>
        <Field label={t('field.description')}>{data.description}</Field>
        <Field label={t('field.value')} emphasize>
          {formatMoney(data.value)}
        </Field>
        <Field label={t('field.requester')}>{data.requester}</Field>
        <Field label={t('field.created')}>{formatDate(data.createdOn)}</Field>
      </Fields>
    </SapCard>
  );
}

export function VendorCard({ data }: { data: Of<'vendor'> }) {
  const t = useT();
  const riskTone: Tone = data.riskRating === 'HIGH' ? 'critical' : data.riskRating === 'MEDIUM' ? 'warning' : 'success';
  return (
    <SapCard
      kind={t('kind.supplier')}
      id={data.id}
      icon={<Building2 size={18} />}
      status={data.blocked ? { label: t('card.blocked'), tone: 'critical' } : data.riskRating ? { label: t('card.riskRating', { rating: sapLabel(t, data.riskRating) }), tone: riskTone } : undefined}
    >
      <Fields>
        <Field label={t('field.name')}>{data.name}</Field>
        <Field label={t('field.location')}>{[data.city, data.country].filter(Boolean).join(', ')}</Field>
        {data.openItems && (
          <Field label={t('field.openItems')} emphasize>
            {formatMoney(data.openItems)}
          </Field>
        )}
        {data.overdueItems && (
          <Field label={t('field.overdue')}>
            <span className={data.overdueItems.amount > 0 ? 'font-semibold text-error' : ''}>{formatMoney(data.overdueItems)}</span>
          </Field>
        )}
        {data.paymentTerms && <Field label={t('field.paymentTerms')}>{data.paymentTerms}</Field>}
      </Fields>
    </SapCard>
  );
}

export function GLBalanceCard({ data }: { data: Of<'gl_balance'> }) {
  const t = useT();
  return (
    <SapCard kind={t('kind.gl')} id={data.account} icon={<Landmark size={18} />}>
      <p className="mb-3 text-sm text-ink-2">
        {t('card.glLine', { description: data.description, companyCode: data.companyCode, fiscalYear: data.fiscalYear, period: data.period })}
      </p>
      <Fields cols={3}>
        <Field label={t('field.debit')}>{formatMoney(data.debit)}</Field>
        <Field label={t('field.credit')}>{formatMoney(data.credit)}</Field>
        <Field label={t('field.balance')} emphasize>
          {formatMoney(data.balance)}
        </Field>
      </Fields>
    </SapCard>
  );
}

export function WorkOrderCard({ data }: { data: Of<'work_order'> }) {
  const t = useT();
  return (
    <SapCard kind={t('kind.workOrder', { type: data.orderType })} id={data.number} icon={<Wrench size={18} />} status={{ label: data.status, tone: 'info' }}>
      <p className="mb-3 text-sm text-ink">{data.description}</p>
      <Fields>
        <Field label={t('field.priority')}>{data.priority}</Field>
        {data.equipment && (
          <Field label={t('field.equipment')} mono>
            {data.equipment}
          </Field>
        )}
        <Field label={t('field.planned')}>
          {formatDate(data.plannedStart)} → {formatDate(data.plannedEnd)}
        </Field>
        {data.plannedCost && <Field label={t('field.plannedCost')}>{formatMoney(data.plannedCost)}</Field>}
      </Fields>
    </SapCard>
  );
}

export function EquipmentCard({ data }: { data: Of<'equipment'> }) {
  const t = useT();
  return (
    <SapCard
      kind={t('kind.equipment')}
      id={data.number}
      icon={<Cog size={18} />}
      status={data.criticality ? { label: t('card.criticality', { level: data.criticality }), tone: data.criticality === 'A' ? 'critical' : 'neutral' } : undefined}
      actions={[{ label: t('action.maintenanceHistory'), prompt: t('prompt.maintenanceHistory', { equipment: data.number }) }]}
    >
      <p className="mb-3 text-sm font-medium text-ink">{data.description}</p>
      <Fields>
        {data.functionalLocation && (
          <Field label={t('field.functionalLocation')} mono>
            {data.functionalLocation}
          </Field>
        )}
        {data.manufacturer && <Field label={t('field.manufacturer')}>{data.manufacturer}</Field>}
        <Field label={t('field.status')}>{data.status}</Field>
      </Fields>
    </SapCard>
  );
}

export function GoodsReceiptCard({ data }: { data: Of<'goods_receipt'> }) {
  const t = useT();
  return (
    <SapCard kind={t('kind.gr')} id={`${data.materialDocument}/${data.year}`} icon={<PackageCheck size={18} />}>
      <Fields>
        <Field label={t('field.po')} mono>
          {data.purchaseOrder}
        </Field>
        <Field label={t('field.posted')}>{formatDate(data.postingDate)}</Field>
        <Field label={t('field.quantity')}>
          {data.quantity} {data.unit}
        </Field>
        {data.value && <Field label={t('field.value')}>{formatMoney(data.value)}</Field>}
      </Fields>
    </SapCard>
  );
}

type ProcessStatus = Of<'sales_order'>['deliveryStatus'];
const processTone: Record<ProcessStatus, Tone> = { NOT_RELEVANT: 'neutral', NOT_STARTED: 'warning', PARTIAL: 'info', COMPLETE: 'success' };
const processLabel = (t: T, status: ProcessStatus) => t(`process.${status}`);

function ProcessBadge({ status }: { status: ProcessStatus }) {
  const t = useT();
  return <Badge tone={processTone[status]}>{processLabel(t, status)}</Badge>;
}

export function SalesOrderCard({ data }: { data: Of<'sales_order'> }) {
  const t = useT();
  const blocked = data.creditStatus === 'BLOCKED' || (data.blocks?.length ?? 0) > 0;
  return (
    <SapCard
      kind={t('kind.salesOrder', { type: data.orderType })}
      id={data.number}
      icon={<ShoppingCart size={18} />}
      status={blocked ? { label: t('card.blocked'), tone: 'critical' } : data.billingStatus === 'COMPLETE' ? { label: t('card.billed'), tone: 'success' } : { label: t('card.inProcess'), tone: 'info' }}
      actions={[
        { label: t('action.documentFlow'), prompt: t('prompt.documentFlow', { order: data.number }) },
        { label: t('action.customer'), prompt: t('prompt.customer', { customer: data.soldTo }) },
      ]}
    >
      <Fields>
        <Field label={t('field.soldTo')}>
          {data.soldToName} <span className="text-ink-3">· {data.soldTo}</span>
        </Field>
        <Field label={t('field.netValue')} emphasize>
          {formatMoney(data.netValue)}
        </Field>
        <Field label={t('field.requestedDelivery')}>{formatDate(data.requestedDeliveryDate)}</Field>
        {data.salesArea && (
          <Field label={t('field.salesArea')} mono>
            {data.salesArea}
          </Field>
        )}
        <Field label={t('field.delivery')}>
          <ProcessBadge status={data.deliveryStatus} />
        </Field>
        <Field label={t('field.billing')}>
          <ProcessBadge status={data.billingStatus} />
        </Field>
        {data.customerReference && <Field label={t('field.customerReference')}>{data.customerReference}</Field>}
      </Fields>
      {data.blocks && data.blocks.length > 0 && (
        <div className="mt-3 rounded-lg border border-error/25 bg-error-soft px-3 py-2.5">
          <p className="text-xs font-semibold text-error">{t('card.blocks')}</p>
          <ul className="mt-1 list-disc space-y-0.5 ps-4 text-[12px] text-ink">
            {data.blocks.map((b) => (
              <li key={b} dir="auto">
                {b}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.items && data.items.length > 0 && (
        <details className="mt-3 group">
          <summary className="cursor-pointer text-xs font-medium text-ink-2 hover:text-ink">{t('card.items', { count: data.items.length })}</summary>
          <Table
            columns={[
              { key: 'item', label: t('field.item') },
              { key: 'description', label: t('field.description') },
              { key: 'qty', label: t('field.quantity'), align: 'right' },
              { key: 'value', label: t('field.netValue'), align: 'right' },
            ]}
            rows={data.items.map((i) => ({ item: i.item, description: `${i.material} · ${i.description}`, qty: `${i.quantity} ${i.unit}`, value: formatMoney(i.netValue) }))}
          />
        </details>
      )}
    </SapCard>
  );
}

export function OutboundDeliveryCard({ data }: { data: Of<'outbound_delivery'> }) {
  const t = useT();
  return (
    <SapCard
      kind={t('kind.delivery')}
      id={data.number}
      icon={<Truck size={18} />}
      status={{ label: data.goodsIssueStatus === 'COMPLETE' ? t('card.goodsIssued') : t('card.goodsIssue', { status: processLabel(t, data.goodsIssueStatus) }), tone: processTone[data.goodsIssueStatus] }}
      actions={data.salesOrder ? [{ label: t('action.salesOrder'), prompt: t('prompt.salesOrder', { order: data.salesOrder }) }] : undefined}
    >
      <Fields>
        <Field label={t('field.shipTo')}>
          {data.shipToName} <span className="text-ink-3">· {data.shipTo}</span>
        </Field>
        {data.salesOrder && (
          <Field label={t('field.salesOrder')} mono>
            {data.salesOrder}
          </Field>
        )}
        <Field label={t('field.plannedGi')}>{formatDate(data.plannedGoodsIssueDate)}</Field>
        <Field label={t('field.actualGi')}>{formatDate(data.actualGoodsIssueDate)}</Field>
      </Fields>
      {data.items && data.items.length > 0 && (
        <Table
          columns={[
            { key: 'item', label: t('field.item') },
            { key: 'description', label: t('field.description') },
            { key: 'qty', label: t('field.quantity'), align: 'right' },
            { key: 'plant', label: t('field.plant') },
          ]}
          rows={data.items.map((i) => ({ item: i.item, description: `${i.material} · ${i.description}`, qty: `${i.quantity} ${i.unit}`, plant: [i.plant, i.storageLocation].filter(Boolean).join(' / ') || null }))}
        />
      )}
    </SapCard>
  );
}

export function BillingDocumentCard({ data }: { data: Of<'billing_document'> }) {
  const t = useT();
  return (
    <SapCard
      kind={t('kind.billing', { type: data.billingType })}
      id={data.number}
      icon={<ReceiptText size={18} />}
      status={data.cancelled ? { label: t('card.cancelled'), tone: 'neutral' } : data.postedToAccounting ? { label: t('card.postedToAccounting'), tone: 'success' } : { label: t('card.notPosted'), tone: 'warning' }}
      actions={[{ label: t('action.customerOpenItems'), prompt: t('prompt.customerOpenItems', { customer: data.payer, companyCode: data.companyCode }) }]}
    >
      <Fields>
        <Field label={t('field.payer')}>
          {data.payerName} <span className="text-ink-3">· {data.payer}</span>
        </Field>
        <Field label={t('field.netValue')} emphasize>
          {formatMoney(data.netValue)}
        </Field>
        <Field label={t('field.billingDate')}>{formatDate(data.billingDate)}</Field>
        {data.taxAmount && <Field label={t('field.tax')}>{formatMoney(data.taxAmount)}</Field>}
        <Field label={t('field.companyCode')} mono>
          {data.companyCode}
        </Field>
        {data.accountingDocument && (
          <Field label={t('field.accountingDocument')} mono>
            {data.accountingDocument}
          </Field>
        )}
        {data.salesOrder && (
          <Field label={t('field.salesOrder')} mono>
            {data.salesOrder}
          </Field>
        )}
      </Fields>
    </SapCard>
  );
}

export function CustomerCard({ data }: { data: Of<'customer'> }) {
  const t = useT();
  return (
    <SapCard
      kind={t('kind.customer')}
      id={data.id}
      icon={<UserRound size={18} />}
      status={data.blocked ? { label: t('card.blocked'), tone: 'critical' } : undefined}
      actions={[{ label: t('action.creditExposure'), prompt: t('prompt.creditExposure', { customer: data.id }) }]}
    >
      <Fields>
        <Field label={t('field.name')}>{data.name}</Field>
        <Field label={t('field.location')}>{[data.city, data.country].filter(Boolean).join(', ') || '—'}</Field>
        {data.openItems && (
          <Field label={t('field.openItems')} emphasize>
            {formatMoney(data.openItems)}
          </Field>
        )}
        {data.overdueItems && (
          <Field label={t('field.overdue')}>
            <span className={data.overdueItems.amount > 0 ? 'font-semibold text-error' : ''}>{formatMoney(data.overdueItems)}</span>
          </Field>
        )}
        {data.creditLimit && <Field label={t('field.creditLimit')}>{formatMoney(data.creditLimit)}</Field>}
        {data.creditExposure && <Field label={t('field.creditExposure')}>{formatMoney(data.creditExposure)}</Field>}
        {data.riskClass && <Field label={t('field.riskClass')}>{data.riskClass}</Field>}
      </Fields>
    </SapCard>
  );
}

const itemTone: Record<Of<'open_items'>['items'][number]['status'], Tone> = { OPEN: 'info', OVERDUE: 'critical', CLEARED: 'success' };
const accountLabel: Record<Of<'open_items'>['accountType'], MessageKey> = { CUSTOMER: 'kind.customerItems', SUPPLIER: 'kind.supplierItems', GL: 'kind.glItems' };

export function OpenItemsCard({ data }: { data: Of<'open_items'> }) {
  const t = useT();
  return (
    <SapCard
      kind={t(accountLabel[data.accountType])}
      id={data.account}
      icon={<ListChecks size={18} />}
      status={data.overdue && data.overdue.amount > 0 ? { label: t('card.overdueItems'), tone: 'critical' } : undefined}
    >
      <Fields cols={3}>
        <Field label={t('field.account')}>{data.accountName ?? data.account}</Field>
        <Field label={t('field.companyCode')} mono>
          {data.companyCode}
        </Field>
        <Field label={t('field.listedBalance')} emphasize>
          {formatMoney(data.total)}
        </Field>
        {data.overdue && (
          <Field label={t('field.overdue')}>
            <span className={data.overdue.amount > 0 ? 'font-semibold text-error' : ''}>{formatMoney(data.overdue)}</span>
          </Field>
        )}
      </Fields>
      <div className="mt-2 overflow-x-auto rounded-lg border border-area-sap/25">
        <table className="w-full border-collapse text-[12px]">
          <thead className="bg-area-sap-fill text-ink">
            <tr>
              {[t('field.document'), t('field.type'), t('field.posted'), t('field.dueShort')].map((h) => (
                <th key={h} scope="col" className="px-3 py-2 text-start font-semibold">
                  {h}
                </th>
              ))}
              <th scope="col" className="px-3 py-2 text-end font-semibold">
                {t('field.amount')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-semibold">
                {t('field.status')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-semibold">
                {t('field.clearedBy')}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((i) => (
              <tr key={`${i.document}-${i.amount.amount}`} className="border-t border-line">
                <td className="px-3 py-2 font-mono text-ink">{i.document}</td>
                <td className="px-3 py-2 text-ink">{i.documentType}</td>
                <td className="px-3 py-2 text-ink">{formatDate(i.postingDate)}</td>
                <td className="px-3 py-2 text-ink">{formatDate(i.dueDate)}</td>
                <td className="px-3 py-2 text-end tabular-nums text-ink">{formatMoney(i.amount)}</td>
                <td className="px-3 py-2">
                  <Badge tone={itemTone[i.status]}>{sapLabel(t, i.status)}</Badge>
                </td>
                <td className="px-3 py-2 font-mono text-ink">{i.clearingDocument ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SapCard>
  );
}

export function AccountingDocumentCard({ data }: { data: Of<'accounting_document'> }) {
  const t = useT();
  const side = (i: Of<'accounting_document'>['items'][number], dc: 'D' | 'C') => (i.debitCredit === dc ? formatMoney({ amount: Math.abs(i.amount.amount), currency: i.amount.currency }) : null);
  return (
    <SapCard kind={t('kind.accounting', { type: data.documentType })} id={data.number} icon={<BookOpen size={18} />}>
      <Fields cols={3}>
        <Field label={t('field.ccFy')} mono>
          {data.companyCode} / {data.fiscalYear}
        </Field>
        <Field label={t('field.postingDate')}>{formatDate(data.postingDate)}</Field>
        {data.reference && (
          <Field label={t('field.reference')} mono>
            {data.reference}
          </Field>
        )}
      </Fields>
      <Table
        columns={[
          { key: 'item', label: t('field.item') },
          { key: 'account', label: t('field.account') },
          { key: 'description', label: t('field.description') },
          { key: 'debit', label: t('field.debit'), align: 'right' },
          { key: 'credit', label: t('field.credit'), align: 'right' },
        ]}
        rows={data.items.map((i) => ({ item: i.item, account: i.account, description: i.description ?? null, debit: side(i, 'D'), credit: side(i, 'C') }))}
      />
    </SapCard>
  );
}

type RunStatus = Of<'workflow_run'>['status'];
type RunStepState = Of<'workflow_run'>['steps'][number]['state'];
const runTone: Record<RunStatus, Tone> = { running: 'info', awaiting_confirmation: 'warning', completed: 'success', blocked: 'critical', failed: 'critical', cancelled: 'neutral' };

const stepStyle: Record<RunStepState, string> = {
  pending: 'border-line text-ink-3',
  done: 'border-success bg-success text-surface',
  skipped: 'border-line-strong text-ink-3',
  awaiting_confirmation: 'border-warning bg-warning-soft text-warning',
  failed: 'border-error bg-error-soft text-error',
  cancelled: 'border-line-strong text-ink-3',
};

function StepIcon({ state }: { state: RunStepState }) {
  const size = 12;
  if (state === 'done') return <Check size={size} strokeWidth={3} />;
  if (state === 'skipped') return <Minus size={size} />;
  if (state === 'awaiting_confirmation') return <Hourglass size={size} />;
  if (state === 'failed' || state === 'cancelled') return <X size={size} />;
  return <CircleDashed size={size} />;
}

/** A process run: every step, the module agent that owns it, and how far the run has come. */
export function WorkflowRunCard({ data }: { data: Of<'workflow_run'> }) {
  const t = useT();
  const settled = data.steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;
  return (
    <SapCard kind={t('kind.run', { workflow: translateServer(data.workflow) })} id={translateServer(data.title)} icon={<Workflow size={18} />} status={{ label: t(`run.${data.status}`), tone: runTone[data.status] }}>
      <p className="mb-3 text-xs text-ink-3">
        {t('card.stepsDone', { done: settled, total: data.steps.length })}
      </p>
      <ol className="space-y-2.5">
        {data.steps.map((s) => (
          <li key={s.id} className="flex gap-3">
            <span aria-hidden className={cx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border', stepStyle[s.state])}>
              <StepIcon state={s.state} />
            </span>
            <div className="min-w-0">
              <p className={cx('text-sm', s.state === 'pending' ? 'text-ink-2' : 'text-ink')}>
                {translateServer(s.title)} <span className="text-ink-3">· {s.agent}</span>
                <span className="sr-only"> — {t(`step.${s.state}`)}</span>
              </p>
              {s.detail && <p className="text-[12px] text-ink-2">{translateServer(s.detail)}</p>}
            </div>
          </li>
        ))}
      </ol>
      {data.reason && data.status !== 'completed' && (
        <p className={cx('mt-3 rounded-lg border px-3 py-2 text-[12px] text-ink', data.status === 'cancelled' ? 'border-line bg-area-nonsap-fill' : 'border-error/25 bg-error-soft')}>{translateServer(data.reason)}</p>
      )}
    </SapCard>
  );
}

/** Rows a table shows before "Show more". */
const TABLE_PREVIEW_ROWS = 10;

function Table({ columns, rows: all }: Pick<Of<'business_object_table'>, 'columns' | 'rows'>) {
  const { visible: rows, toggle } = useShowMore(all, TABLE_PREVIEW_ROWS);
  return (
    <>
    <div className="mt-2 overflow-x-auto rounded-lg border border-area-sap/25">
      <table className="w-full border-collapse text-[12px]">
        <thead className="bg-area-sap-fill text-ink">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx('px-3 py-2 font-semibold', c.align === 'right' ? 'text-end' : 'text-start')}>
                {translateServer(c.label)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {columns.map((c) => (
                <td key={c.key} className={cx('px-3 py-2 text-ink', c.align === 'right' ? 'text-end tabular-nums' : 'text-start')}>
                  {r[c.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {toggle}
    </>
  );
}

export function BusinessObjectTable({ data }: { data: Of<'business_object_table'> }) {
  return (
    <SapArea label={translateServer(data.title)}>
      <Table {...data} />
    </SapArea>
  );
}

export function KPIBlock({ data }: { data: Of<'kpi_block'> }) {
  const t = useT();
  return (
    <SapArea label={data.title ? translateServer(data.title) : t('card.keyFigures')}>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {data.items.map((k) => (
          <div key={k.label} className="rounded-lg border border-area-sap/20 bg-area-sap-fill px-3 py-2.5">
            <dt className="text-xs text-ink-3">{translateServer(k.label)}</dt>
            <dd className={cx('mt-0.5 text-base font-semibold', toneText[k.tone === 'positive' ? 'success' : (k.tone ?? 'neutral')])}>{k.value}</dd>
          </div>
        ))}
      </dl>
    </SapArea>
  );
}

const NOTICE: Record<Of<'notice'>['kind'], { icon: ComponentType<{ size?: number }>; frame: string; accent: string }> = {
  NOT_AUTHORIZED: { icon: Lock, frame: 'border-warning/60 bg-warning-soft', accent: 'text-warning' },
  BUSINESS_RULE: { icon: TriangleAlert, frame: 'border-warning/60 bg-warning-soft', accent: 'text-warning' },
  UNAVAILABLE: { icon: Unplug, frame: 'border-error/60 bg-error-soft', accent: 'text-error' },
  OUTCOME_UNKNOWN: { icon: CircleHelp, frame: 'border-error/60 bg-error-soft', accent: 'text-error' },
  OTHER: { icon: TriangleAlert, frame: 'border-error/60 bg-error-soft', accent: 'text-error' },
  NOT_FOUND: { icon: SearchX, frame: 'border-line-strong bg-muted', accent: 'text-ink-2' },
  NOT_SUPPORTED: { icon: CircleSlash, frame: 'border-line-strong bg-muted', accent: 'text-ink-2' },
  INVALID_INPUT: { icon: CircleSlash, frame: 'border-line-strong bg-muted', accent: 'text-ink-2' },
};

/** A failed SAP call: what happened, what the user can do, and a reference to quote to support. */
export function Notice({ data }: { data: Of<'notice'> }) {
  const t = useT();
  const ask = useAsk();
  const [copied, setCopied] = useState(false);
  const { icon: Icon, frame, accent } = NOTICE[data.kind];
  const title = t(`notice.${data.kind}.title`);
  const copy = async () => {
    await navigator.clipboard.writeText(data.reference ?? '').catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const button = 'inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-ink-2 transition-colors hover:border-brand/50 hover:text-brand';
  return (
    <section role="alert" aria-label={title} className={cx('flex gap-3 rounded-area border px-4 py-3', frame)}>
      <span className={cx('mt-0.5 shrink-0', accent)} aria-hidden>
        <Icon size={18} />
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <p className={cx('font-semibold', accent)}>{title}</p>
        <p dir="auto" className="mt-0.5 text-ink">
          {translateServer(data.message)}
        </p>
        {data.action && (
          <p className="mt-2 text-ink-2">
            <span className="font-semibold text-ink">{t('notice.whatToDo')}</span>
            {t(`notice.${data.kind}.action`)}
          </p>
        )}
        {(data.reference || data.retryPrompt) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {data.reference && (
              <span className="text-xs text-ink-3">
                {t('common.referenceLabel')} <span className="font-mono text-ink-2">{data.reference}</span>
              </span>
            )}
            {data.reference && (
              <button type="button" onClick={copy} className={button}>
                {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />} {t(copied ? 'common.copied' : 'notice.copyReference')}
              </button>
            )}
            {data.retryPrompt && (
              <button type="button" onClick={() => ask(data.retryPrompt!)} className={button}>
                {t('notice.tryAgain')}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export function Timeline({ data }: { data: Of<'timeline'> }) {
  const t = useT();
  const dot: Record<string, string> = { neutral: 'bg-line-strong', positive: 'bg-success', warning: 'bg-warning', critical: 'bg-error' };
  return (
    <SapArea label={translateServer(data.title)}>
      <ol className="relative ms-1.5 border-s border-line">
        {data.events.map((e, i) => (
          <li key={i} className="relative pb-3.5 ps-5 last:pb-0">
            <span aria-hidden className={cx('absolute -start-[5px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-surface', dot[e.tone ?? 'neutral'])} />
            <p className="text-xs text-ink-3">{formatDate(e.date)}</p>
            <p className="text-sm text-ink">{e.title}</p>
            {e.detail && <p className="text-[12px] text-ink-2">{e.detail}</p>}
            {e.tone === 'critical' && <Badge tone="critical" className="mt-1">
                {t('card.critical')}
              </Badge>}
          </li>
        ))}
      </ol>
    </SapArea>
  );
}

/**
 * The only mapping from server-provided component types to React components.
 * Unknown types render nothing — model output can never introduce new UI.
 */
const REGISTRY: { [K in UIComponent['type']]: ComponentType<{ data: Of<K> }> } = {
  invoice: InvoiceCard,
  purchase_order: PurchaseOrderCard,
  purchase_requisition: PurchaseRequisitionCard,
  vendor: VendorCard,
  gl_balance: GLBalanceCard,
  work_order: WorkOrderCard,
  equipment: EquipmentCard,
  employee: EmployeeCard,
  reporting_line: ReportingLineCard,
  time_off: TimeOffCard,
  team_overview: TeamOverviewCard,
  approvals: ApprovalsCard,
  mail_list: MailListCard,
  mail_message: MailMessageCard,
  calendar: CalendarCard,
  goods_receipt: GoodsReceiptCard,
  sales_order: SalesOrderCard,
  outbound_delivery: OutboundDeliveryCard,
  billing_document: BillingDocumentCard,
  customer: CustomerCard,
  open_items: OpenItemsCard,
  accounting_document: AccountingDocumentCard,
  workflow_run: WorkflowRunCard,
  business_object_table: BusinessObjectTable,
  kpi_block: KPIBlock,
  timeline: Timeline,
  notice: Notice,
  vendor_map: VendorMapCard,
  employee_map: EmployeeMapCard,
  fiori_guide: FioriGuideCard,
};

export function SapComponent({ component }: { component: UIComponent }) {
  const Render = REGISTRY[component.type] as ComponentType<{ data: unknown }> | undefined;
  return Render ? <Render data={component.data} /> : null;
}

