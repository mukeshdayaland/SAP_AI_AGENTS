'use client';

import type { UIComponent } from '@prowess/contracts';
import { Building2, Cog, FileText, Landmark, Package, PackageCheck, ScrollText, Wrench } from 'lucide-react';
import type { ComponentType } from 'react';
import { formatDate, formatMoney, humanize } from '@/lib/format';
import { Badge, cx, type Tone } from '../ui/primitives';
import { Field, Fields, SapArea, SapCard, toneText } from './card';

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
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[13px] text-ink">
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

function Table({ columns, rows }: Pick<Of<'business_object_table'>, 'columns' | 'rows'>) {
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-area-sap/25">
      <table className="w-full border-collapse text-[13px]">
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
            {e.detail && <p className="text-[13px] text-ink-2">{e.detail}</p>}
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
  business_object_table: BusinessObjectTable,
  kpi_block: KPIBlock,
  timeline: Timeline,
};

export function SapComponent({ component }: { component: UIComponent }) {
  const Render = REGISTRY[component.type] as ComponentType<{ data: unknown }> | undefined;
  return Render ? <Render data={component.data} /> : null;
}

