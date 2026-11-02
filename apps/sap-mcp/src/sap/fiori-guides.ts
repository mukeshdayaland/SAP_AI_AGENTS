/**
 * Guided tasks in SAP Fiori, for what the agents cannot do through a tool: the
 * user does the work in the app, under their own SAP authorizations, and the
 * workspace walks them through it.
 *
 * Intents are those of the SAP standard launchpad content of S/4HANA. A system
 * that assigns an app to another intent overrides it with SAP_FIORI_INTENTS_JSON.
 */
export interface FioriGuide {
  id: string;
  title: string;
  /** Name of the Fiori app as the launchpad shows it. */
  app: string;
  /** Semantic object and action of the app in the launchpad. */
  intent: string;
  /** Navigation parameter that takes the business object, for apps that open one directly. */
  param?: string;
  /** Told to the model: when this guide is the right one. */
  when: string;
  /** Tool domains of the agents that are offered the guide: those that have all tools of one of them. */
  domains: string[];
  /** `{id}` stands for the business object the guide was opened for. */
  steps: { title: string; detail?: string }[];
}

export const FIORI_GUIDES: FioriGuide[] = [
  {
    id: 'sales-order-complete',
    title: 'Complete a sales order',
    app: 'Change Sales Orders',
    intent: 'SalesOrder-change',
    param: 'SalesOrder',
    when: 'a sales order is incomplete or has a delivery or billing block no tool can fix',
    domains: ['sd'],
    steps: [
      { title: 'Open sales order {id}', detail: 'The app opens the order in change mode. If it asks for a number, enter {id} and press Enter.' },
      { title: 'Open the incompletion log', detail: 'Choose More > Edit > Incompletion Log. SAP lists every field that is still missing.' },
      { title: 'Fill the missing fields', detail: 'Choose Complete Data for each entry; SAP jumps to the field. Enter the value and go back to the log.' },
      { title: 'Check the blocks', detail: 'On the header, look at Delivery Block and Billing Block. Remove a block only if you are the one to decide it.' },
      { title: 'Save', detail: 'Choose Save. SAP confirms with the order number in the message bar.' },
    ],
  },
  {
    id: 'credit-decision',
    title: 'Decide a credit-blocked order',
    app: 'Manage Documented Credit Decisions',
    intent: 'DocumentedCreditDecision-manage',
    when: 'the user is the credit manager deciding a credit-blocked sales order',
    domains: ['credit'],
    steps: [
      { title: 'Find the order', detail: 'Enter {id} in the Document field of the filter bar and choose Go.' },
      { title: 'Open the credit decision', detail: 'Select the row. The page shows the credit limit, the exposure and why the check failed.' },
      { title: 'Release or reject', detail: 'Choose Release to let the order continue, or Reject. SAP asks for a reason.' },
    ],
  },
  {
    id: 'delivery-goods-issue',
    title: 'Post goods issue for a delivery',
    app: 'Change Outbound Delivery',
    intent: 'OutboundDelivery-change',
    param: 'OutboundDelivery',
    when: 'a goods issue fails: picking incomplete, batch or storage location missing, or stock short',
    domains: ['sd'],
    steps: [
      { title: 'Open delivery {id}', detail: 'The app opens the delivery in change mode.' },
      { title: 'Complete picking', detail: 'On the Picking tab, enter the storage location and the picked quantity for every item.' },
      { title: 'Check the incompletion log', detail: 'Choose More > Edit > Incompleteness. Fill what SAP still lists, such as a batch or a weight.' },
      { title: 'Post goods issue', detail: 'Choose Post Goods Issue. SAP confirms that the delivery was saved.' },
    ],
  },
  {
    id: 'purchase-order-change',
    title: 'Change a purchase order',
    app: 'Manage Purchase Orders',
    intent: 'PurchaseOrder-manage',
    when: 'a purchase order needs a change no tool offers, e.g. price, quantity, delivery date or account assignment',
    domains: ['mm'],
    steps: [
      { title: 'Find purchase order {id}', detail: 'Enter {id} in the search field and choose Go, then select the row.' },
      { title: 'Choose Edit', detail: 'The purchase order opens in edit mode. An order that was already released may need a new approval after the change.' },
      { title: 'Change the item', detail: 'Open the item and correct the value. Price and quantity are on the General Information tab of the item.' },
      { title: 'Save', detail: 'Choose Save. SAP shows the messages of its checks; an error must be resolved before it saves.' },
    ],
  },
  {
    id: 'goods-receipt-post',
    title: 'Post a goods receipt',
    app: 'Post Goods Receipt for Purchasing Document',
    intent: 'PurchaseOrder-createGR',
    when: 'a goods receipt was rejected, e.g. for a missing storage location, batch or serial number',
    domains: ['mm'],
    steps: [
      { title: 'Enter purchase order {id}', detail: 'Type {id} in the Purchasing Document field and press Enter. SAP lists the open items.' },
      { title: 'Check each item', detail: 'Confirm the quantity delivered and choose the storage location. Enter a batch where SAP asks for one.' },
      { title: 'Select the items to receive', detail: 'Tick the items that arrived. Leave the others open.' },
      { title: 'Post', detail: 'Choose Post. SAP returns the material document number.' },
    ],
  },
  {
    id: 'invoice-release',
    title: 'Release a blocked supplier invoice',
    app: 'Release Blocked Invoices',
    intent: 'SupplierInvoice-release',
    when: 'a supplier invoice stays blocked for payment and no tool can release it, or the user wants to review the blocking reasons in SAP',
    domains: ['mm', 'ap'],
    steps: [
      { title: 'Select the invoice', detail: 'Enter {id} in the Invoice Document field, add the company code, choose Release Manually and execute.' },
      { title: 'Review the blocking reasons', detail: 'Each column marks one reason: price, quantity, date or a manual block.' },
      { title: 'Remove the reasons or release', detail: 'Select the invoice and choose Release Invoice, or clear single blocking reasons you have checked.' },
      { title: 'Save', detail: 'Choose Save Changes. The invoice is then picked up by the next payment run.' },
    ],
  },
  {
    id: 'supplier-items',
    title: 'Work on supplier line items',
    app: 'Manage Supplier Line Items',
    intent: 'Supplier-manageLineItems',
    param: 'Supplier',
    when: 'the user wants to set or remove a payment block, or change the due date or text of a supplier item',
    domains: ['ap'],
    steps: [
      { title: 'Show the items of supplier {id}', detail: 'Set the company code and the status Open Items in the filter bar and choose Go.' },
      { title: 'Select the item', detail: 'Tick the line of the document you want to change.' },
      { title: 'Choose the action', detail: 'Use Set Payment Block or Change Documents above the table and enter the new value.' },
      { title: 'Confirm', detail: 'Choose OK. The table shows the changed value.' },
    ],
  },
  {
    id: 'customer-items',
    title: 'Work on customer line items',
    app: 'Manage Customer Line Items',
    intent: 'Customer-manageLineItems',
    param: 'Customer',
    when: 'the user wants to set a dunning block, change the due date or text of a customer item, or review open receivables in SAP',
    domains: ['ar'],
    steps: [
      { title: 'Show the items of customer {id}', detail: 'Set the company code and the status Open Items in the filter bar and choose Go.' },
      { title: 'Select the item', detail: 'Tick the line of the document you want to change.' },
      { title: 'Choose the action', detail: 'Use Set Dunning Block or Change Documents above the table and enter the new value.' },
      { title: 'Confirm', detail: 'Choose OK. The table shows the changed value.' },
    ],
  },
  {
    id: 'journal-entry',
    title: 'Review or reverse a journal entry',
    app: 'Manage Journal Entries',
    intent: 'AccountingDocument-manage',
    when: 'the user wants to inspect a journal entry in SAP or reverse one',
    domains: ['gl'],
    steps: [
      { title: 'Find journal entry {id}', detail: 'Enter {id}, the company code and the fiscal year in the filter bar and choose Go.' },
      { title: 'Open the entry', detail: 'Select the row to see the header and every line with its account and amount.' },
      { title: 'Reverse, if that is what you need', detail: 'Choose Reverse, pick the reversal reason and the posting date, and confirm. SAP posts a new document; the original stays.' },
    ],
  },
];

export interface FioriSettings {
  /** The Fiori launchpad: a path on the workspace's own address (/sap/bc/ui2/flp?sap-client=100) or an https address. */
  launchpadUrl?: string;
  /** Whether SAP allows the workspace to frame the launchpad. */
  embed: boolean;
  /** Guide id to the intent this system uses for the app. */
  intents: Record<string, string>;
}

/** The app's address in the launchpad, opened for the business object when the app takes one. */
export function fioriUrl(guide: FioriGuide, settings: FioriSettings, objectId?: string): string | undefined {
  if (!settings.launchpadUrl) return undefined;
  const intent = settings.intents[guide.id] ?? guide.intent;
  const query = guide.param && objectId ? `?${guide.param}=${encodeURIComponent(objectId)}` : '';
  return `${settings.launchpadUrl.replace(/#.*$/, '')}#${intent}${query}`;
}
