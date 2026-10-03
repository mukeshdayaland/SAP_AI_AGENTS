import { z } from 'zod';

/**
 * Trusted UI component contract.
 *
 * Components are produced by the orchestrator from *validated tool results*,
 * never from free-form model output. The web app maps each `type` to a
 * predefined React component; unknown types are dropped server-side.
 */

const money = z.object({
  amount: z.number().finite(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

const text = (max = 200) => z.string().max(max);

export const InvoiceComponent = z.object({
  type: z.literal('invoice'),
  data: z.object({
    number: text(20),
    fiscalYear: text(4),
    companyCode: text(10),
    vendorId: text(20),
    vendorName: text(),
    amount: money,
    postingDate: text(20).optional(),
    dueDate: text(20).optional(),
    status: z.enum(['OPEN', 'PAYMENT_BLOCKED', 'PARKED', 'PAID', 'REVERSED']),
    paymentBlock: z
      .object({ code: text(4), description: text() })
      .nullable(),
    purchaseOrder: text(20).optional(),
    blockReasons: z.array(text(300)).max(10).optional(),
  }),
});

export const PurchaseOrderComponent = z.object({
  type: z.literal('purchase_order'),
  data: z.object({
    number: text(20),
    vendorId: text(20),
    vendorName: text(),
    value: money,
    status: z.enum(['DRAFT', 'AWAITING_APPROVAL', 'RELEASED', 'PARTIALLY_DELIVERED', 'DELIVERED', 'CLOSED']),
    createdOn: text(20),
    purchasingGroup: text(20).optional(),
    items: z
      .array(
        z.object({
          item: text(10),
          material: text(40),
          description: text(),
          quantity: z.number(),
          unit: text(6),
          netValue: money,
        }),
      )
      .max(50)
      .optional(),
  }),
});

export const PurchaseRequisitionComponent = z.object({
  type: z.literal('purchase_requisition'),
  data: z.object({
    number: text(20),
    requester: text(),
    value: money,
    status: z.enum(['OPEN', 'APPROVED', 'REJECTED', 'CONVERTED']),
    createdOn: text(20),
    description: text(300),
  }),
});

export const VendorComponent = z.object({
  type: z.literal('vendor'),
  data: z.object({
    id: text(20),
    name: text(),
    country: text(3),
    city: text().optional(),
    paymentTerms: text(20).optional(),
    blocked: z.boolean(),
    openItems: money.optional(),
    overdueItems: money.optional(),
    riskRating: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  }),
});

export const GLBalanceComponent = z.object({
  type: z.literal('gl_balance'),
  data: z.object({
    account: text(20),
    description: text(),
    companyCode: text(10),
    fiscalYear: text(4),
    period: text(3),
    debit: money,
    credit: money,
    balance: money,
  }),
});

export const WorkOrderComponent = z.object({
  type: z.literal('work_order'),
  data: z.object({
    number: text(20),
    description: text(300),
    equipment: text(20).optional(),
    orderType: text(10),
    priority: text(20),
    status: text(40),
    plannedStart: text(20).optional(),
    plannedEnd: text(20).optional(),
    plannedCost: money.optional(),
  }),
});

export const EquipmentComponent = z.object({
  type: z.literal('equipment'),
  data: z.object({
    number: text(20),
    description: text(300),
    functionalLocation: text(60).optional(),
    manufacturer: text().optional(),
    status: text(40),
    criticality: z.enum(['A', 'B', 'C']).optional(),
  }),
});

export const GoodsReceiptComponent = z.object({
  type: z.literal('goods_receipt'),
  data: z.object({
    materialDocument: text(20),
    year: text(4),
    purchaseOrder: text(20),
    postingDate: text(20),
    quantity: z.number(),
    unit: text(6),
    value: money.optional(),
  }),
});

const processStatus = z.enum(['NOT_RELEVANT', 'NOT_STARTED', 'PARTIAL', 'COMPLETE']);

export const SalesOrderComponent = z.object({
  type: z.literal('sales_order'),
  data: z.object({
    number: text(20),
    orderType: text(10),
    salesArea: text(40).optional(),
    soldTo: text(20),
    soldToName: text(),
    customerReference: text(40).optional(),
    netValue: money,
    requestedDeliveryDate: text(20).optional(),
    deliveryStatus: processStatus,
    billingStatus: processStatus,
    creditStatus: z.enum(['NOT_CHECKED', 'APPROVED', 'BLOCKED']),
    blocks: z.array(text(120)).max(5).optional(),
    items: z
      .array(
        z.object({
          item: text(10),
          material: text(40),
          description: text(),
          quantity: z.number(),
          unit: text(6),
          netValue: money,
        }),
      )
      .max(50)
      .optional(),
  }),
});

export const OutboundDeliveryComponent = z.object({
  type: z.literal('outbound_delivery'),
  data: z.object({
    number: text(20),
    shipTo: text(20),
    shipToName: text(),
    salesOrder: text(20).optional(),
    plannedGoodsIssueDate: text(20).optional(),
    actualGoodsIssueDate: text(20).optional(),
    goodsIssueStatus: processStatus,
    items: z
      .array(
        z.object({
          item: text(10),
          material: text(40),
          description: text(),
          quantity: z.number(),
          unit: text(6),
          plant: text(10).optional(),
          storageLocation: text(10).optional(),
        }),
      )
      .max(50)
      .optional(),
  }),
});

export const BillingDocumentComponent = z.object({
  type: z.literal('billing_document'),
  data: z.object({
    number: text(20),
    billingType: text(10),
    payer: text(20),
    payerName: text(),
    billingDate: text(20),
    netValue: money,
    taxAmount: money.optional(),
    companyCode: text(10),
    accountingDocument: text(20).optional(),
    postedToAccounting: z.boolean(),
    cancelled: z.boolean(),
    salesOrder: text(20).optional(),
  }),
});

export const CustomerComponent = z.object({
  type: z.literal('customer'),
  data: z.object({
    id: text(20),
    name: text(),
    country: text(3).optional(),
    city: text().optional(),
    blocked: z.boolean(),
    openItems: money.optional(),
    overdueItems: money.optional(),
    creditLimit: money.optional(),
    creditExposure: money.optional(),
    riskClass: text(20).optional(),
  }),
});

/** Customer, supplier or G/L line items (FBL5N / FBL1N / FBL3N). Amounts are signed. */
export const OpenItemsComponent = z.object({
  type: z.literal('open_items'),
  data: z.object({
    accountType: z.enum(['CUSTOMER', 'SUPPLIER', 'GL']),
    account: text(20),
    accountName: text().optional(),
    companyCode: text(10),
    total: money,
    overdue: money.optional(),
    items: z
      .array(
        z.object({
          document: text(20),
          documentType: text(4),
          postingDate: text(20),
          dueDate: text(20).optional(),
          amount: money,
          status: z.enum(['OPEN', 'OVERDUE', 'CLEARED']),
          clearingDocument: text(20).optional(),
          text: text(120).optional(),
        }),
      )
      .max(200),
  }),
});

export const AccountingDocumentComponent = z.object({
  type: z.literal('accounting_document'),
  data: z.object({
    number: text(20),
    companyCode: text(10),
    fiscalYear: text(4),
    documentType: text(4),
    postingDate: text(20),
    reference: text(40).optional(),
    items: z
      .array(
        z.object({
          item: text(10),
          account: text(20),
          description: text().optional(),
          amount: money,
          debitCredit: z.enum(['D', 'C']),
        }),
      )
      .max(100),
  }),
});

export const WORKFLOW_RUN_STATUSES = ['running', 'awaiting_confirmation', 'completed', 'blocked', 'failed', 'cancelled'] as const;
export const WORKFLOW_STEP_STATES = ['pending', 'done', 'skipped', 'awaiting_confirmation', 'failed', 'cancelled'] as const;

/** Snapshot of a multi-step process run: which module agent owns each step and how far the run has come. */
export const WorkflowRunComponent = z.object({
  type: z.literal('workflow_run'),
  data: z.object({
    id: text(64),
    workflow: text(60),
    title: text(),
    status: z.enum(WORKFLOW_RUN_STATUSES),
    reason: text(400).optional(),
    steps: z
      .array(
        z.object({
          id: text(40),
          title: text(120),
          agent: text(60),
          state: z.enum(WORKFLOW_STEP_STATES),
          detail: text(400).optional(),
        }),
      )
      .max(30),
  }),
});

export const BusinessObjectTableComponent = z.object({
  type: z.literal('business_object_table'),
  data: z.object({
    title: text(),
    columns: z.array(z.object({ key: text(40), label: text(80), align: z.enum(['left', 'right']).optional() })).max(12),
    rows: z.array(z.record(z.string(), z.union([z.string().max(300), z.number(), z.null()]))).max(200),
  }),
});

export const KPIBlockComponent = z.object({
  type: z.literal('kpi_block'),
  data: z.object({
    title: text().optional(),
    items: z
      .array(
        z.object({
          label: text(80),
          value: text(60),
          tone: z.enum(['neutral', 'positive', 'warning', 'critical']).optional(),
        }),
      )
      .max(8),
  }),
});

export const NOTICE_KINDS = ['NOT_AUTHORIZED', 'NOT_FOUND', 'BUSINESS_RULE', 'UNAVAILABLE', 'NOT_SUPPORTED', 'INVALID_INPUT', 'OTHER'] as const;

/** A failed SAP call, told to the user: what happened, what to do, and a reference for support. */
export const NoticeComponent = z.object({
  type: z.literal('notice'),
  data: z.object({
    kind: z.enum(NOTICE_KINDS),
    title: text(120),
    message: text(400),
    action: text(400).optional(),
    reference: text(80).optional(),
    /** The user's request, offered as "Try again" for temporary failures. */
    retryPrompt: text(600).optional(),
  }),
});

export const TimelineComponent = z.object({
  type: z.literal('timeline'),
  data: z.object({
    title: text(),
    events: z
      .array(
        z.object({
          date: text(20),
          title: text(),
          detail: text(400).optional(),
          tone: z.enum(['neutral', 'positive', 'warning', 'critical']).optional(),
        }),
      )
      .max(100),
  }),
});

export const UIComponentSchema = z.discriminatedUnion('type', [
  InvoiceComponent,
  PurchaseOrderComponent,
  PurchaseRequisitionComponent,
  VendorComponent,
  GLBalanceComponent,
  WorkOrderComponent,
  EquipmentComponent,
  GoodsReceiptComponent,
  SalesOrderComponent,
  OutboundDeliveryComponent,
  BillingDocumentComponent,
  CustomerComponent,
  OpenItemsComponent,
  AccountingDocumentComponent,
  WorkflowRunComponent,
  BusinessObjectTableComponent,
  KPIBlockComponent,
  TimelineComponent,
  NoticeComponent,
]);

export type UIComponent = z.infer<typeof UIComponentSchema>;
export type UIComponentType = UIComponent['type'];
export type Money = z.infer<typeof money>;

/** Validates an untrusted candidate; returns null rather than throwing. */
export function parseUIComponent(candidate: unknown): UIComponent | null {
  const result = UIComponentSchema.safeParse(candidate);
  return result.success ? result.data : null;
}
