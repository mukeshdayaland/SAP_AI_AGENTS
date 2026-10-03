'use client';

import type { UIComponent } from '@prowess/contracts';
import { BookOpen, Building2, Check, CircleDashed, CircleSlash, Copy, Lock, SearchX, TriangleAlert, Unplug, Cog, FileText, Hourglass, Landmark, ListChecks, Minus, Workflow, X, Package, PackageCheck, ReceiptText, ScrollText, ShoppingCart, Truck, UserRound, Wrench } from 'lucide-react';
import { useState, type ComponentType } from 'react';
import { formatDate, formatMoney, humanize } from '@/lib/format';
import { Badge, cx, type Tone } from '../ui/primitives';
import { Field, Fields, SapArea, SapCard, toneText, useAsk } from './card';

type Of<T extends UIComponent['type']> = Extract<UIComponent, { type: T }>['data'];

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
  return (
    <SapCard
      kind="Supplier invoice"
      id={data.number}
      icon={<FileText size={18} />}
      status={{ label: humanize(data.status), tone: invoiceTone[data.status] }}
      actions={[
        { label: 'View invoice', prompt: `Show full details of invoice ${data.number}.` },
        { label: 'Analyze vendor', prompt: `Review vendor ${data.vendorId} exposure and payment behaviour.` },
        ...(data.purchaseOrder ? [{ label: 'Check related PO', prompt: `Check purchase order ${data.purchaseOrder} and its goods receipts.` }] : []),
      ]}
    >
      <Fields>
        <Field label="Vendor">
          {data.vendorName} <span className="text-ink-3">· {data.vendorId}</span>
        </Field>
        <Field label="Amount" emphasize>
          {formatMoney(data.amount)}
        </Field>
        <Field label="Company code / FY" mono>
          {data.companyCode} / {data.fiscalYear}
        </Field>
        <Field label="Due date">{formatDate(data.dueDate)}</Field>
        {data.paymentBlock && (
          <Field label="Payment block">
            <span className="font-mono font-semibold text-error">{data.paymentBlock.code}</span> — {data.paymentBlock.description}
          </Field>
        )}
        {data.purchaseOrder && (
          <Field label="Purchase order" mono>
            {data.purchaseOrder}
          </Field>
        )}
      </Fields>
      {data.blockReasons && data.blockReasons.length > 0 && (
        <div className="mt-3 rounded-lg border border-error/25 bg-error-soft px-3 py-2.5">
          <p className="text-xs font-semibold text-error">Verification issues</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12px] text-ink">
            {data.blockReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </SapCard>
  );
}

export function PurchaseOrderCard({ data }: { data: Of<'purchase_order'> }) {
  return (
    <SapCard
      kind="Purchase order"
      id={data.number}
      icon={<Package size={18} />}
      status={{ label: humanize(data.status), tone: poTone[data.status] }}
      actions={[
        { label: 'Goods receipts', prompt: `Show goods receipts for purchase order ${data.number}.` },
        { label: 'Analyze vendor', prompt: `Review vendor ${data.vendorId} exposure.` },
      ]}
    >
      <Fields>
        <Field label="Vendor">{data.vendorName}</Field>
        <Field label="Value" emphasize>
          {formatMoney(data.value)}
        </Field>
        <Field label="Created">{formatDate(data.createdOn)}</Field>
        {data.purchasingGroup && <Field label="Purchasing group">{data.purchasingGroup}</Field>}
      </Fields>
      {data.items && data.items.length > 0 && (
        <details className="mt-3 group">
          <summary className="cursor-pointer text-xs font-medium text-ink-2 hover:text-ink">Items ({data.items.length})</summary>
          <Table
            columns={[
              { key: 'item', label: 'Item' },
              { key: 'description', label: 'Description' },
              { key: 'qty', label: 'Quantity', align: 'right' },
              { key: 'value', label: 'Net value', align: 'right' },
            ]}
            rows={data.items.map((i) => ({ item: i.item, description: i.description, qty: `${i.quantity} ${i.unit}`, value: formatMoney(i.netValue) }))}
          />
        </details>
      )}
    </SapCard>
  );
}

export function PurchaseRequisitionCard({ data }: { data: Of<'purchase_requisition'> }) {
  return (
    <SapCard kind="Purchase requisition" id={data.number} icon={<ScrollText size={18} />} status={{ label: humanize(data.status), tone: data.status === 'APPROVED' ? 'success' : data.status === 'REJECTED' ? 'critical' : 'info' }}>
      <Fields>
        <Field label="Description">{data.description}</Field>
        <Field label="Value" emphasize>
          {formatMoney(data.value)}
        </Field>
        <Field label="Requester">{data.requester}</Field>
        <Field label="Created">{formatDate(data.createdOn)}</Field>
      </Fields>
    </SapCard>
  );
}

export function VendorCard({ data }: { data: Of<'vendor'> }) {
  const riskTone: Tone = data.riskRating === 'HIGH' ? 'critical' : data.riskRating === 'MEDIUM' ? 'warning' : 'success';
  return (
    <SapCard
      kind="Supplier"
      id={data.id}
      icon={<Building2 size={18} />}
      status={data.blocked ? { label: 'Blocked', tone: 'critical' } : data.riskRating ? { label: `${data.riskRating} risk`, tone: riskTone } : undefined}
    >
      <Fields>
        <Field label="Name">{data.name}</Field>
        <Field label="Location">{[data.city, data.country].filter(Boolean).join(', ')}</Field>
        {data.openItems && (
          <Field label="Open items" emphasize>
            {formatMoney(data.openItems)}
          </Field>
        )}
        {data.overdueItems && (
          <Field label="Overdue">
            <span className={data.overdueItems.amount > 0 ? 'font-semibold text-error' : ''}>{formatMoney(data.overdueItems)}</span>
          </Field>
        )}
        {data.paymentTerms && <Field label="Payment terms">{data.paymentTerms}</Field>}
      </Fields>
    </SapCard>
  );
}

export function GLBalanceCard({ data }: { data: Of<'gl_balance'> }) {
  return (
    <SapCard kind="G/L account balance" id={data.account} icon={<Landmark size={18} />}>
      <p className="mb-3 text-sm text-ink-2">
        {data.description} · CC {data.companyCode} · FY {data.fiscalYear} / P{data.period}
      </p>
      <Fields cols={3}>
        <Field label="Debit">{formatMoney(data.debit)}</Field>
        <Field label="Credit">{formatMoney(data.credit)}</Field>
        <Field label="Balance" emphasize>
          {formatMoney(data.balance)}
        </Field>
      </Fields>
    </SapCard>
  );
}

export function WorkOrderCard({ data }: { data: Of<'work_order'> }) {
  return (
    <SapCard kind={`Maintenance order · ${data.orderType}`} id={data.number} icon={<Wrench size={18} />} status={{ label: data.status, tone: 'info' }}>
      <p className="mb-3 text-sm text-ink">{data.description}</p>
      <Fields>
        <Field label="Priority">{data.priority}</Field>
        {data.equipment && (
          <Field label="Equipment" mono>
            {data.equipment}
          </Field>
        )}
        <Field label="Planned">
          {formatDate(data.plannedStart)} → {formatDate(data.plannedEnd)}
        </Field>
        {data.plannedCost && <Field label="Planned cost">{formatMoney(data.plannedCost)}</Field>}
      </Fields>
    </SapCard>
  );
}

export function EquipmentCard({ data }: { data: Of<'equipment'> }) {
  return (
    <SapCard
      kind="Equipment"
      id={data.number}
      icon={<Cog size={18} />}
      status={data.criticality ? { label: `Criticality ${data.criticality}`, tone: data.criticality === 'A' ? 'critical' : 'neutral' } : undefined}
      actions={[{ label: 'Maintenance history', prompt: `Analyze maintenance history for equipment ${data.number}.` }]}
    >
      <p className="mb-3 text-sm font-medium text-ink">{data.description}</p>
      <Fields>
        {data.functionalLocation && (
          <Field label="Functional location" mono>
            {data.functionalLocation}
          </Field>
        )}
        {data.manufacturer && <Field label="Manufacturer">{data.manufacturer}</Field>}
        <Field label="Status">{data.status}</Field>
      </Fields>
    </SapCard>
  );
}

export function GoodsReceiptCard({ data }: { data: Of<'goods_receipt'> }) {
  return (
    <SapCard kind="Goods receipt" id={`${data.materialDocument}/${data.year}`} icon={<PackageCheck size={18} />}>
      <Fields>
        <Field label="Purchase order" mono>
          {data.purchaseOrder}
        </Field>
        <Field label="Posted">{formatDate(data.postingDate)}</Field>
        <Field label="Quantity">
          {data.quantity} {data.unit}
        </Field>
        {data.value && <Field label="Value">{formatMoney(data.value)}</Field>}
      </Fields>
    </SapCard>
  );
}

type ProcessStatus = Of<'sales_order'>['deliveryStatus'];
const processTone: Record<ProcessStatus, Tone> = { NOT_RELEVANT: 'neutral', NOT_STARTED: 'warning', PARTIAL: 'info', COMPLETE: 'success' };
const processLabel: Record<ProcessStatus, string> = { NOT_RELEVANT: 'Not relevant', NOT_STARTED: 'Not started', PARTIAL: 'Partial', COMPLETE: 'Complete' };

function ProcessBadge({ status }: { status: ProcessStatus }) {
  return <Badge tone={processTone[status]}>{processLabel[status]}</Badge>;
}

export function SalesOrderCard({ data }: { data: Of<'sales_order'> }) {
  const blocked = data.creditStatus === 'BLOCKED' || (data.blocks?.length ?? 0) > 0;
  return (
    <SapCard
      kind={`Sales order · ${data.orderType}`}
      id={data.number}
      icon={<ShoppingCart size={18} />}
      status={blocked ? { label: 'Blocked', tone: 'critical' } : data.billingStatus === 'COMPLETE' ? { label: 'Billed', tone: 'success' } : { label: 'In process', tone: 'info' }}
      actions={[
        { label: 'Document flow', prompt: `Show the document flow of sales order ${data.number}.` },
        { label: 'Customer', prompt: `Show customer ${data.soldTo}.` },
      ]}
    >
      <Fields>
        <Field label="Sold-to party">
          {data.soldToName} <span className="text-ink-3">· {data.soldTo}</span>
        </Field>
        <Field label="Net value" emphasize>
          {formatMoney(data.netValue)}
        </Field>
        <Field label="Requested delivery">{formatDate(data.requestedDeliveryDate)}</Field>
        {data.salesArea && (
          <Field label="Sales area" mono>
            {data.salesArea}
          </Field>
        )}
        <Field label="Delivery">
          <ProcessBadge status={data.deliveryStatus} />
        </Field>
        <Field label="Billing">
          <ProcessBadge status={data.billingStatus} />
        </Field>
        {data.customerReference && <Field label="Customer reference">{data.customerReference}</Field>}
      </Fields>
      {data.blocks && data.blocks.length > 0 && (
        <div className="mt-3 rounded-lg border border-error/25 bg-error-soft px-3 py-2.5">
          <p className="text-xs font-semibold text-error">Blocks</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12px] text-ink">
            {data.blocks.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}
      {data.items && data.items.length > 0 && (
        <details className="mt-3 group">
          <summary className="cursor-pointer text-xs font-medium text-ink-2 hover:text-ink">Items ({data.items.length})</summary>
          <Table
            columns={[
              { key: 'item', label: 'Item' },
              { key: 'description', label: 'Description' },
              { key: 'qty', label: 'Quantity', align: 'right' },
              { key: 'value', label: 'Net value', align: 'right' },
            ]}
            rows={data.items.map((i) => ({ item: i.item, description: `${i.material} · ${i.description}`, qty: `${i.quantity} ${i.unit}`, value: formatMoney(i.netValue) }))}
          />
        </details>
      )}
    </SapCard>
  );
}

export function OutboundDeliveryCard({ data }: { data: Of<'outbound_delivery'> }) {
  return (
    <SapCard
      kind="Outbound delivery"
      id={data.number}
      icon={<Truck size={18} />}
      status={{ label: data.goodsIssueStatus === 'COMPLETE' ? 'Goods issued' : `Goods issue: ${processLabel[data.goodsIssueStatus].toLowerCase()}`, tone: processTone[data.goodsIssueStatus] }}
      actions={data.salesOrder ? [{ label: 'Sales order', prompt: `Show sales order ${data.salesOrder}.` }] : undefined}
    >
      <Fields>
        <Field label="Ship-to party">
          {data.shipToName} <span className="text-ink-3">· {data.shipTo}</span>
        </Field>
        {data.salesOrder && (
          <Field label="Sales order" mono>
            {data.salesOrder}
          </Field>
        )}
        <Field label="Planned goods issue">{formatDate(data.plannedGoodsIssueDate)}</Field>
        <Field label="Actual goods issue">{formatDate(data.actualGoodsIssueDate)}</Field>
      </Fields>
      {data.items && data.items.length > 0 && (
        <Table
          columns={[
            { key: 'item', label: 'Item' },
            { key: 'description', label: 'Description' },
            { key: 'qty', label: 'Quantity', align: 'right' },
            { key: 'plant', label: 'Plant' },
          ]}
          rows={data.items.map((i) => ({ item: i.item, description: `${i.material} · ${i.description}`, qty: `${i.quantity} ${i.unit}`, plant: [i.plant, i.storageLocation].filter(Boolean).join(' / ') || null }))}
        />
      )}
    </SapCard>
  );
}

export function BillingDocumentCard({ data }: { data: Of<'billing_document'> }) {
  return (
    <SapCard
      kind={`Billing document · ${data.billingType}`}
      id={data.number}
      icon={<ReceiptText size={18} />}
      status={data.cancelled ? { label: 'Cancelled', tone: 'neutral' } : data.postedToAccounting ? { label: 'Posted to accounting', tone: 'success' } : { label: 'Not posted', tone: 'warning' }}
      actions={[{ label: 'Customer open items', prompt: `Show the open items of customer ${data.payer} in company code ${data.companyCode}.` }]}
    >
      <Fields>
        <Field label="Payer">
          {data.payerName} <span className="text-ink-3">· {data.payer}</span>
        </Field>
        <Field label="Net value" emphasize>
          {formatMoney(data.netValue)}
        </Field>
        <Field label="Billing date">{formatDate(data.billingDate)}</Field>
        {data.taxAmount && <Field label="Tax">{formatMoney(data.taxAmount)}</Field>}
        <Field label="Company code" mono>
          {data.companyCode}
        </Field>
        {data.accountingDocument && (
          <Field label="Accounting document" mono>
            {data.accountingDocument}
          </Field>
        )}
        {data.salesOrder && (
          <Field label="Sales order" mono>
            {data.salesOrder}
          </Field>
        )}
      </Fields>
    </SapCard>
  );
}

export function CustomerCard({ data }: { data: Of<'customer'> }) {
  return (
    <SapCard
      kind="Customer"
      id={data.id}
      icon={<UserRound size={18} />}
      status={data.blocked ? { label: 'Blocked', tone: 'critical' } : undefined}
      actions={[{ label: 'Credit exposure', prompt: `Show the credit exposure of customer ${data.id}.` }]}
    >
      <Fields>
        <Field label="Name">{data.name}</Field>
        <Field label="Location">{[data.city, data.country].filter(Boolean).join(', ') || '—'}</Field>
        {data.openItems && (
          <Field label="Open items" emphasize>
            {formatMoney(data.openItems)}
          </Field>
        )}
        {data.overdueItems && (
          <Field label="Overdue">
            <span className={data.overdueItems.amount > 0 ? 'font-semibold text-error' : ''}>{formatMoney(data.overdueItems)}</span>
          </Field>
        )}
        {data.creditLimit && <Field label="Credit limit">{formatMoney(data.creditLimit)}</Field>}
        {data.creditExposure && <Field label="Credit exposure">{formatMoney(data.creditExposure)}</Field>}
        {data.riskClass && <Field label="Risk class">{data.riskClass}</Field>}
      </Fields>
    </SapCard>
  );
}

const itemTone: Record<Of<'open_items'>['items'][number]['status'], Tone> = { OPEN: 'info', OVERDUE: 'critical', CLEARED: 'success' };
const accountLabel: Record<Of<'open_items'>['accountType'], string> = { CUSTOMER: 'Customer line items', SUPPLIER: 'Supplier line items', GL: 'G/L line items' };

export function OpenItemsCard({ data }: { data: Of<'open_items'> }) {
  return (
    <SapCard
      kind={accountLabel[data.accountType]}
      id={data.account}
      icon={<ListChecks size={18} />}
      status={data.overdue && data.overdue.amount > 0 ? { label: 'Overdue items', tone: 'critical' } : undefined}
    >
      <Fields cols={3}>
        <Field label="Account">{data.accountName ?? data.account}</Field>
        <Field label="Company code" mono>
          {data.companyCode}
        </Field>
        <Field label="Balance of listed items" emphasize>
          {formatMoney(data.total)}
        </Field>
        {data.overdue && (
          <Field label="Overdue">
            <span className={data.overdue.amount > 0 ? 'font-semibold text-error' : ''}>{formatMoney(data.overdue)}</span>
          </Field>
        )}
      </Fields>
      <div className="mt-2 overflow-x-auto rounded-lg border border-area-sap/25">
        <table className="w-full border-collapse text-[12px]">
          <thead className="bg-area-sap-fill text-ink">
            <tr>
              {['Document', 'Type', 'Posted', 'Due'].map((h) => (
                <th key={h} scope="col" className="px-3 py-2 text-left font-semibold">
                  {h}
                </th>
              ))}
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                Amount
              </th>
              <th scope="col" className="px-3 py-2 text-left font-semibold">
                Status
              </th>
              <th scope="col" className="px-3 py-2 text-left font-semibold">
                Cleared by
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
                <td className="px-3 py-2 text-right tabular-nums text-ink">{formatMoney(i.amount)}</td>
                <td className="px-3 py-2">
                  <Badge tone={itemTone[i.status]}>{humanize(i.status)}</Badge>
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
  const side = (i: Of<'accounting_document'>['items'][number], dc: 'D' | 'C') => (i.debitCredit === dc ? formatMoney({ amount: Math.abs(i.amount.amount), currency: i.amount.currency }) : null);
  return (
    <SapCard kind={`Accounting document · ${data.documentType}`} id={data.number} icon={<BookOpen size={18} />}>
      <Fields cols={3}>
        <Field label="Company code / FY" mono>
          {data.companyCode} / {data.fiscalYear}
        </Field>
        <Field label="Posting date">{formatDate(data.postingDate)}</Field>
        {data.reference && (
          <Field label="Reference" mono>
            {data.reference}
          </Field>
        )}
      </Fields>
      <Table
        columns={[
          { key: 'item', label: 'Item' },
          { key: 'account', label: 'Account' },
          { key: 'description', label: 'Description' },
          { key: 'debit', label: 'Debit', align: 'right' },
          { key: 'credit', label: 'Credit', align: 'right' },
        ]}
        rows={data.items.map((i) => ({ item: i.item, account: i.account, description: i.description ?? null, debit: side(i, 'D'), credit: side(i, 'C') }))}
      />
    </SapCard>
  );
}

type RunStatus = Of<'workflow_run'>['status'];
type RunStepState = Of<'workflow_run'>['steps'][number]['state'];
const runTone: Record<RunStatus, Tone> = { running: 'info', awaiting_confirmation: 'warning', completed: 'success', blocked: 'critical', failed: 'critical', cancelled: 'neutral' };
const runLabel: Record<RunStatus, string> = {
  running: 'Running',
  awaiting_confirmation: 'Waiting for confirmation',
  completed: 'Completed',
  blocked: 'Blocked',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
const stepLabel: Record<RunStepState, string> = { pending: 'Not started', done: 'Done', skipped: 'Skipped', awaiting_confirmation: 'Waiting for confirmation', failed: 'Failed', cancelled: 'Cancelled' };
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
  const settled = data.steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;
  return (
    <SapCard kind={`Process run · ${data.workflow}`} id={data.title} icon={<Workflow size={18} />} status={{ label: runLabel[data.status], tone: runTone[data.status] }}>
      <p className="mb-3 text-xs text-ink-3">
        {settled} of {data.steps.length} steps done
      </p>
      <ol className="space-y-2.5">
        {data.steps.map((s) => (
          <li key={s.id} className="flex gap-3">
            <span aria-hidden className={cx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border', stepStyle[s.state])}>
              <StepIcon state={s.state} />
            </span>
            <div className="min-w-0">
              <p className={cx('text-sm', s.state === 'pending' ? 'text-ink-2' : 'text-ink')}>
                {s.title} <span className="text-ink-3">· {s.agent}</span>
                <span className="sr-only"> — {stepLabel[s.state]}</span>
              </p>
              {s.detail && <p className="text-[12px] text-ink-2">{s.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
      {data.reason && data.status !== 'completed' && (
        <p className={cx('mt-3 rounded-lg border px-3 py-2 text-[12px] text-ink', data.status === 'cancelled' ? 'border-line bg-area-nonsap-fill' : 'border-error/25 bg-error-soft')}>{data.reason}</p>
      )}
    </SapCard>
  );
}

function Table({ columns, rows }: Pick<Of<'business_object_table'>, 'columns' | 'rows'>) {
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-area-sap/25">
      <table className="w-full border-collapse text-[12px]">
        <thead className="bg-area-sap-fill text-ink">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx('px-3 py-2 font-semibold', c.align === 'right' ? 'text-right' : 'text-left')}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {columns.map((c) => (
                <td key={c.key} className={cx('px-3 py-2 text-ink', c.align === 'right' ? 'text-right tabular-nums' : 'text-left')}>
                  {r[c.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BusinessObjectTable({ data }: { data: Of<'business_object_table'> }) {
  return (
    <SapArea label={data.title}>
      <Table {...data} />
    </SapArea>
  );
}

export function KPIBlock({ data }: { data: Of<'kpi_block'> }) {
  return (
    <SapArea label={data.title ?? 'Key figures'}>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {data.items.map((k) => (
          <div key={k.label} className="rounded-lg border border-area-sap/20 bg-area-sap-fill px-3 py-2.5">
            <dt className="text-xs text-ink-3">{k.label}</dt>
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
  OTHER: { icon: TriangleAlert, frame: 'border-error/60 bg-error-soft', accent: 'text-error' },
  NOT_FOUND: { icon: SearchX, frame: 'border-line-strong bg-muted', accent: 'text-ink-2' },
  NOT_SUPPORTED: { icon: CircleSlash, frame: 'border-line-strong bg-muted', accent: 'text-ink-2' },
  INVALID_INPUT: { icon: CircleSlash, frame: 'border-line-strong bg-muted', accent: 'text-ink-2' },
};

/** A failed SAP call: what happened, what the user can do, and a reference to quote to support. */
export function Notice({ data }: { data: Of<'notice'> }) {
  const ask = useAsk();
  const [copied, setCopied] = useState(false);
  const { icon: Icon, frame, accent } = NOTICE[data.kind];
  const copy = async () => {
    await navigator.clipboard.writeText(data.reference ?? '').catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const button = 'inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-ink-2 transition-colors hover:border-brand/50 hover:text-brand';
  return (
    <section role="alert" aria-label={data.title} className={cx('flex gap-3 rounded-area border px-4 py-3', frame)}>
      <span className={cx('mt-0.5 shrink-0', accent)} aria-hidden>
        <Icon size={18} />
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <p className={cx('font-semibold', accent)}>{data.title}</p>
        <p className="mt-0.5 text-ink">{data.message}</p>
        {data.action && (
          <p className="mt-2 text-ink-2">
            <span className="font-semibold text-ink">What you can do: </span>
            {data.action}
          </p>
        )}
        {(data.reference || data.retryPrompt) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {data.reference && (
              <span className="text-xs text-ink-3">
                Reference <span className="font-mono text-ink-2">{data.reference}</span>
              </span>
            )}
            {data.reference && (
              <button type="button" onClick={copy} className={button}>
                {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />} {copied ? 'Copied' : 'Copy reference'}
              </button>
            )}
            {data.retryPrompt && (
              <button type="button" onClick={() => ask(data.retryPrompt!)} className={button}>
                Try again
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export function Timeline({ data }: { data: Of<'timeline'> }) {
  const dot: Record<string, string> = { neutral: 'bg-line-strong', positive: 'bg-success', warning: 'bg-warning', critical: 'bg-error' };
  return (
    <SapArea label={data.title}>
      <ol className="relative ml-1.5 border-l border-line">
        {data.events.map((e, i) => (
          <li key={i} className="relative pb-3.5 pl-5 last:pb-0">
            <span aria-hidden className={cx('absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-surface', dot[e.tone ?? 'neutral'])} />
            <p className="text-xs text-ink-3">{formatDate(e.date)}</p>
            <p className="text-sm text-ink">{e.title}</p>
            {e.detail && <p className="text-[12px] text-ink-2">{e.detail}</p>}
            {e.tone === 'critical' && <Badge tone="critical" className="mt-1">Critical</Badge>}
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
};

export function SapComponent({ component }: { component: UIComponent }) {
  const Render = REGISTRY[component.type] as ComponentType<{ data: unknown }> | undefined;
  return Render ? <Render data={component.data} /> : null;
}

