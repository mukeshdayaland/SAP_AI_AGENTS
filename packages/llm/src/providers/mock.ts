import { collect, safeJsonObject, type LLMChunk, type LLMMessage, type LLMProvider, type LLMRequest, type LLMResponse, type ToolSpec } from '../types.js';

/**
 * Deterministic offline provider for local development, demos and CI.
 *
 * It imitates a tool-calling model with simple intent rules so the complete
 * orchestration path (tool selection → MCP → SAP mock → answer) runs without
 * credentials. It never invents business data: answers are built only from
 * tool results the orchestrator returned.
 */

interface Intent {
  tool: string;
  pattern: RegExp;
  args: (m: RegExpMatchArray, text: string) => Record<string, unknown>;
  when?: RegExp;
  /** Only when the offered tool accepts these arguments (e.g. the hand-off target is another agent). */
  accepts?: (tool: ToolSpec) => boolean;
}

/** An e-mail address after "to", for drafting or sending. */
const EMAIL_TO = /\bto\s+([^\s@,<>"]+@[^\s,<>"]+\.[a-z]{2,})/i;
const mailArgsIn = (m: RegExpMatchArray, text: string) => ({
  to: [m[1]!.toLowerCase()],
  subject: /\bsubject\s+["“](.+?)["”]/i.exec(text)?.[1] ?? 'Follow-up',
  body: /\b(?:saying|body|text)\s+["“](.+?)["”]/i.exec(text)?.[1] ?? 'Hello,\n\nFollowing up on our conversation.\n\nKind regards',
});
/** Today, tomorrow or the coming week. */
const calendarRangeIn = (text: string) => {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  if (/\b(week|7 days)\b/i.test(text)) return { from: day(0), to: day(6) };
  if (/\btomorrow\b/i.test(text)) return { from: day(1) };
  return {};
};

const INTENTS: Intent[] = [
  {
    tool: 'agent_handoff',
    when: /\b(create|enter|make|raise|book)\b/i,
    pattern: /\bsales order\b/i,
    accepts: (tool) => ((tool.inputSchema as { properties?: { agent?: { enum?: string[] } } }).properties?.agent?.enum ?? []).includes('sd'),
    args: () => ({ agent: 'sd', reason: 'Sales orders belong to SD.' }),
  },
  {
    tool: 'agent_handoff',
    pattern: /\bpayment requests?\b/i,
    accepts: (tool) => ((tool.inputSchema as { properties?: { agent?: { enum?: string[] } } }).properties?.agent?.enum ?? []).includes('fico'),
    args: () => ({ agent: 'fico', reason: 'Payment requests belong to finance.' }),
  },
  {
    tool: 'createSalesOrder',
    when: /\b(create|enter|make|raise|book)\b/i,
    pattern: /\bcustomer\D{0,12}(\d{4,10})\b.*?\b(\d+)\s*(?:PC|pieces?|units?)\b.*?\bmaterial\D{0,12}([A-Z0-9-]{1,18})\b/i,
    args: (m, t) => ({ customer: m[1], quantity: Number(m[2]), material: m[3], salesOrganization: companyCodeIn(t) }),
  },
  {
    tool: 'showFioriGuide',
    when: /\b(in fiori|guide me|walk me through|how do I|in SAP myself)\b/i,
    pattern: /\b(sales order|delivery|purchase order|goods receipt|invoice|supplier|vendor|customer|journal entry)\b\D{0,12}(\d{1,10})?/i,
    args: (m, t) => ({
      guide: {
        'sales order': /\bcredit\b/i.test(t) ? 'credit-decision' : 'sales-order-complete',
        delivery: 'delivery-goods-issue',
        'purchase order': 'purchase-order-change',
        'goods receipt': 'goods-receipt-post',
        invoice: 'invoice-release',
        supplier: 'supplier-items',
        vendor: 'supplier-items',
        customer: 'customer-items',
        'journal entry': 'journal-entry',
      }[m[1]!.toLowerCase()],
      ...(m[2] && { objectId: m[2] }),
    }),
  },
  { tool: 'fiori_read', pattern: /\b(?:enter|set|type)\s+"?[^"]+?"?\s+(?:as|in|into|for)\s+(?:the\s+)?[a-z ]+?(?:\s+and\s+(?:save|check))?[.!]?$/i, args: () => ({}) },
  { tool: 'showVendorMap', when: /\bmap\b/i, pattern: /\b(vendors?|suppliers?)\b/i, args: (_m, t) => ({ ...(/\bin ([A-Z]{2})\b/.exec(t) && { country: /\bin ([A-Z]{2})\b/.exec(t)![1] }) }) },
  { tool: 'clearOpenItems', when: /\bclear\b/i, pattern: /\bcustomer\D{0,12}(\d{4,10})\b/i, args: (m, t) => ({ accountType: 'CUSTOMER', partner: m[1], companyCode: companyCodeIn(t) }) },
  { tool: 'clearOpenItems', when: /\bclear\b/i, pattern: /\b(?:vendor|supplier)\D{0,12}(\d{4,10})\b/i, args: (m, t) => ({ accountType: 'SUPPLIER', partner: m[1], companyCode: companyCodeIn(t) }) },
  { tool: 'ar_proposeClearing', when: /\bclearing\b/i, pattern: /\b(customers?|receivables?)\b/i, args: (_m, t) => ({ companyCode: companyCodeIn(t) }) },
  { tool: 'ap_proposeClearing', when: /\bclearing\b/i, pattern: /\b(suppliers?|vendors?|payables?)\b/i, args: (_m, t) => ({ companyCode: companyCodeIn(t) }) },
  { tool: 'ar_getAging', when: /\baging\b/i, pattern: /\b(receivables?|customers?|AR)\b/i, args: (_m, t) => ({ companyCode: companyCodeIn(t), currency: 'SAR' }) },
  { tool: 'ap_getAging', when: /\baging\b/i, pattern: /\b(payables?|suppliers?|vendors?|AP)\b/i, args: (_m, t) => ({ companyCode: companyCodeIn(t) }) },
  { tool: 'getPaymentRunProposal', when: /\bpayment (run|proposal)\b/i, pattern: /\bpayment\b/i, args: (_m, t) => ({ companyCode: companyCodeIn(t) }) },
  { tool: 'getBankReconciliation', when: /\bbank\b/i, pattern: /\breconcil/i, args: (_m, t) => ({ companyCode: companyCodeIn(t) }) },
  { tool: 'getDepreciationOverview', when: /\bdepreciation\b/i, pattern: /\bdepreciation\b/i, args: (_m, t) => ({ companyCode: companyCodeIn(t), fiscalYear: /\b(20\d{2})\b/.exec(t)?.[1] ?? String(new Date().getFullYear()) }) },
  { tool: 'listCreditBlockedOrders', when: /\bcredit[- ]blocked\b/i, pattern: /\borders?\b/i, args: () => ({}) },
  { tool: 'listGRIRCases', when: /\bGR\/?IR\b/i, pattern: /\b(cases?|mismatch\w*|balances?)\b/i, args: (_m, t) => ({ companyCode: companyCodeIn(t) }) },
  { tool: 'searchGLAccounts', when: /\b(find|search|which)\b/i, pattern: /\bG\/?L accounts?\b.*?\b(?:for|named|called|containing|with)\s+["“]?([A-Za-z][A-Za-z /-]{1,30})/i, args: (m, t) => ({ searchText: m[1]!.trim(), companyCode: companyCodeIn(t) }) },
  { tool: 'approvePaymentRequest', when: /\bapprove\b/i, pattern: /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i, args: (m) => ({ paymentRequest: m[1]!.toLowerCase() }) },
  { tool: 'rejectPaymentRequest', when: /\breject\b/i, pattern: /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i, args: (m) => ({ paymentRequest: m[1]!.toLowerCase() }) },
  { tool: 'postPaymentRequest', when: /\bpost\b/i, pattern: /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i, args: (m) => ({ paymentRequest: m[1]!.toLowerCase() }) },
  {
    tool: 'listPaymentRequests',
    when: /\bpayment requests?\b/i,
    pattern: /\b(list|show|which|what)\b/i,
    args: (_m, t) => ({ companyCode: companyCodeIn(t), ...(/\b(waiting|approval|approve)\b/i.test(t) && { status: 'NEW' }) }),
  },
  {
    tool: 'requestIncomingPayment',
    when: /\bincoming payment\b/i,
    pattern: /\bcustomer\D{0,12}(\d{4,10})\b/i,
    args: (m, t) => ({ partner: m[1], companyCode: companyCodeIn(t), ...paymentArgsIn(t.replace(m[1]!, '')) }),
  },
  {
    tool: 'requestOutgoingPayment',
    when: /\boutgoing payment\b/i,
    pattern: /\b(?:vendor|supplier)\D{0,12}(\d{4,10})\b/i,
    args: (m, t) => ({ partner: m[1], companyCode: companyCodeIn(t), ...paymentArgsIn(t.replace(m[1]!, '')) }),
  },
  { tool: 'releaseInvoicePaymentBlock', when: /\b(release|unblock|remove (the )?block)\b/i, pattern: /\b(51\d{8})\b/, args: (m) => ({ invoiceNumber: m[1] }) },
  { tool: 'addInvoiceNote', when: /\b(add|attach|post) (a )?(note|comment)\b/i, pattern: /\b(51\d{8})\b/, args: (m, t) => ({ invoiceNumber: m[1], note: (/["“](.+?)["”]/.exec(t)?.[1] ?? 'Reviewed via Prowess AI').slice(0, 200) }) },
  { tool: 'getPaymentStatus', when: /\bpayment status|paid\b/i, pattern: /\b(51\d{8})\b/, args: (m) => ({ invoiceNumber: m[1] }) },
  { tool: 'getInvoice', pattern: /\b(51\d{8})\b/, args: (m) => ({ invoiceNumber: m[1] }) },
  {
    tool: 'start',
    when: /\b(run|start|process|carry out)\b/i,
    pattern: /\bpurchase order\D{0,12}(4[25]\d{8})\b/i,
    args: (m, t) => ({
      workflow: 'purchase-to-pay',
      input: {
        purchaseOrder: m[1],
        companyCode: companyCodeIn(t),
        invoiceReference: /\binvoice\s+([A-Z0-9./-]{1,16})\b/i.exec(t)?.[1] ?? '',
        invoiceAmount: (/\bfor\s+(?:[A-Z]{3}\s*)?(\d[\d,]*(?:\.\d{1,2})?)(?!\d)/i.exec(t.replace(m[1]!, ''))?.[1] ?? '').replaceAll(',', ''),
      },
    }),
  },
  {
    tool: 'createSupplierInvoice',
    when: /\bpost\b/i,
    pattern: /\binvoice\s+([A-Z0-9./-]{1,16})\s+for\s+(?:[A-Z]{3}\s*)?(\d[\d,]*(?:\.\d{1,2})?)\s+against purchase order\s+(4[1-5]\d{8})\b/i,
    args: (m, t) => ({ purchaseOrder: m[3], reference: m[1], grossAmount: Number(m[2]!.replaceAll(',', '')), ...(/\bdated (\d{4}-\d{2}-\d{2})\b/.exec(t) && { invoiceDate: /\bdated (\d{4}-\d{2}-\d{2})\b/.exec(t)![1] }) }),
  },
  { tool: 'searchMail', when: /\b(mail|inbox|e-?mails?)\b/i, pattern: /\b(?:supplier |vendor )?invoices?\b/i, args: () => ({ text: 'invoice', folder: 'inbox' }) },
  { tool: 'getGoodsReceipt', when: /\bgoods receipt|GR\b/i, pattern: /\b(4[25]\d{8})\b/, args: (m) => ({ purchaseOrder: m[1] }) },
  { tool: 'getPurchaseOrder', pattern: /\b(4[25]\d{8})\b/, args: (m) => ({ purchaseOrderNumber: m[1] }) },
  {
    tool: 'start',
    when: /\b(run|start|process|fulfil|fulfill|carry out)\b/i,
    pattern: /\bsales order\D{0,12}(\d{1,10})\b/i,
    args: (m, t) => ({ workflow: 'order-to-cash', input: { salesOrder: m[1], companyCode: companyCodeIn(t) } }),
  },
  { tool: 'getSalesOrderFlow', when: /\b(flow|trace|track|where is|stuck)\b/i, pattern: /\bsales order\D{0,12}(\d{1,10})\b/i, args: (m) => ({ salesOrder: m[1] }) },
  { tool: 'getSalesOrder', pattern: /\bsales order\D{0,12}(\d{1,10})\b/i, args: (m) => ({ salesOrder: m[1] }) },
  { tool: 'listOpenSalesOrders', when: /\bopen (sales )?orders\b/i, pattern: /orders/i, args: () => ({}) },
  { tool: 'getDelivery', pattern: /\bdelivery\D{0,12}(8\d{7,9})\b/i, args: (m) => ({ delivery: m[1] }) },
  { tool: 'getBillingDocument', pattern: /\b(?:billing document|billing|customer invoice)\D{0,12}(9\d{7,9})\b/i, args: (m) => ({ billingDocument: m[1] }) },
  { tool: 'getCreditExposure', when: /\bcredit\b/i, pattern: /\bcustomer\D{0,12}(\d{4,10})\b/i, args: (m) => ({ customer: m[1] }) },
  {
    tool: 'listCustomerOpenItems',
    when: /\b(open|line|cleared) items\b|\breceivables?\b/i,
    pattern: /\bcustomer\D{0,12}(\d{4,10})\b/i,
    args: (m, t) => ({ customer: m[1], companyCode: companyCodeIn(t), status: itemStatusIn(t) }),
  },
  {
    tool: 'listVendorOpenItems',
    when: /\b(open|line|cleared) items\b|\bpayables?\b/i,
    pattern: /\b(?:vendor|supplier)\D{0,12}(\d{4,10})\b/i,
    args: (m, t) => ({ supplier: m[1], companyCode: companyCodeIn(t), status: itemStatusIn(t) }),
  },
  { tool: 'listOverdueReceivables', when: /\boverdue\b/i, pattern: /\breceivables?|customers?\b/i, args: (_m, t) => ({ companyCode: companyCodeIn(t) }) },
  { tool: 'listInvoicesDue', when: /\bdue\b/i, pattern: /\b(payables?|payment run|for payment)\b/i, args: (_m, t) => ({ companyCode: companyCodeIn(t) }) },
  { tool: 'listBlockedInvoices', when: /\bblocked invoices\b/i, pattern: /invoices/i, args: (_m, t) => ({ companyCode: companyCodeIn(t) }) },
  { tool: 'listGRIROpenItems', when: /\bGR\/?IR\b/i, pattern: /\b(\d{6,10})\b/, args: (m, t) => ({ glAccount: m[1], companyCode: companyCodeIn(t) }) },
  {
    tool: 'getAccountingDocument',
    when: /\b(accounting|FI) document|journal entry\b/i,
    pattern: /\bdocument\D{0,12}(\d{5,10})\b/i,
    args: (m, t) => ({ documentNumber: m[1], companyCode: companyCodeIn(t), fiscalYear: /\b(20\d{2})\b/.exec(t.replace(m[1]!, ''))?.[1] ?? String(new Date().getFullYear()) }),
  },
  { tool: 'getInfoRecords', when: /\b(info records?|sources? of supply|which suppliers?)\b/i, pattern: /\bmaterial\D{0,12}([A-Z0-9-]{1,18})\b/i, args: (m) => ({ material: m[1] }) },
  { tool: 'getMaterialStock', when: /\bstock\b/i, pattern: /\bmaterial\D{0,12}([A-Z0-9-]{1,18})\b/i, args: (m) => ({ material: m[1] }) },
  { tool: 'getCustomer', pattern: /\bcustomer\D{0,12}(\d{4,10})\b/i, args: (m, t) => ({ customer: m[1], companyCode: companyCodeIn(t) }) },
  { tool: 'getPurchaseRequisition', pattern: /\b(10\d{8})\b/, when: /\brequisition|PR\b/i, args: (m) => ({ requisitionNumber: m[1] }) },
  { tool: 'getMaintenanceHistory', when: /\bmaintenance|history\b/i, pattern: /\b(EQ-?\d{4,8}|2\d{7})\b/i, args: (m) => ({ equipment: m[1]!.toUpperCase() }) },
  { tool: 'getEquipment', pattern: /\b(EQ-?\d{4,8}|2\d{7})\b/i, when: /\bequipment|asset\b/i, args: (m) => ({ equipment: m[1]!.toUpperCase() }) },
  { tool: 'getWorkOrder', pattern: /\b(4\d{6})\b/, when: /\bwork order|order\b/i, args: (m) => ({ workOrder: m[1] }) },
  { tool: 'getVendor', when: /\b(vendor|supplier)\b/i, pattern: /\b(1\d{6}|7\d{9}|V\d{4,8})\b/i, args: (m) => ({ vendorId: m[1]!.toUpperCase() }) },
  {
    tool: 'getGLBalance',
    when: /\b(G\/?L|general ledger|balance)\b/i,
    pattern: /\b(\d{6,8})\b/,
    args: (m, t) => ({
      glAccount: m[1],
      companyCode: /company code (\w{4})/i.exec(t)?.[1] ?? '1000',
      fiscalYear: /\b(20\d{2})\b/.exec(t)?.[1] ?? String(new Date().getFullYear()),
    }),
  },
  {
    tool: 'runBusinessCase',
    when: /\b(case|run)\b/i,
    pattern: /\b([a-z]{2,3}-\d{2})\b/i,
    args: (m, t) => ({ caseId: m[1]!.toLowerCase(), ...(/\bfor\s+([A-Za-z0-9._-]{1,60}?)[.?]?$/.exec(t) && { value: /\bfor\s+([A-Za-z0-9._-]{1,60}?)[.?]?$/.exec(t)![1] }) }),
  },
  {
    tool: 'listBusinessCases',
    pattern: /\bbusiness cases?\b/i,
    args: (_m, t) => {
      const module = ['Employee Central', 'Common Entities', 'Recruiting', 'Performance and Goals', 'Learning', 'Onboarding', 'Succession and Development', 'Job Profile Builder', 'Compensation', 'Calibration', 'Employee Profile', 'Execution Manager', 'Success Store'].find((name) => t.toLowerCase().includes(name.toLowerCase()));
      return module ? { module } : {};
    },
  },
  { tool: 'describeEntity', when: /\b(fields|describe|definition)\b/i, pattern: /\b(?:of|entity)\s+([A-Z][A-Za-z0-9_]{2,59})\b/, args: (m) => ({ entityName: m[1] }) },
  {
    tool: 'showEmployeeMap',
    when: /\b(map|hotspots?|where)\b/i,
    pattern: /\b(employees?|people|staff|colleagues|offices?)\b/i,
    args: (_m, t) => ({ ...(/\b(?:in|at)\s+([A-Z][a-z]{2,30})\b/.exec(t) && { location: /\b(?:in|at)\s+([A-Z][a-z]{2,30})\b/.exec(t)![1] }) }),
  },
  {
    tool: 'requestTimeOff',
    when: /\b(request|book|apply for|take)\b/i,
    pattern: /\bfrom\s+(\d{4}-\d{2}-\d{2})\s+(?:to|until|till)\s+(\d{4}-\d{2}-\d{2})\b/i,
    args: (m, t) => ({ timeType: /\bsick\b/i.test(t) ? 'SICK' : /\bunpaid\b/i.test(t) ? 'UNPAID' : 'ANNUAL', startDate: m[1], endDate: m[2] }),
  },
  { tool: 'listTimeTypes', pattern: /\b(time types?|kinds? of (leave|time off)|leave types?)\b/i, args: () => ({}) },
  { tool: 'approveRequest', when: /\bapprove\b/i, pattern: /\brequest\D{0,12}(\d{1,18})\b/i, args: (m) => ({ requestId: m[1] }) },
  {
    tool: 'declineRequest',
    when: /\b(decline|reject)\b/i,
    pattern: /\brequest\D{0,12}(\d{1,18})\b/i,
    args: (m, t) => ({ requestId: m[1], comment: (/["“](.+?)["”]/.exec(t)?.[1] ?? 'Declined by the approver').slice(0, 200) }),
  },
  { tool: 'listApprovals', pattern: /\b(my approvals?|waiting for my (approval|decision)|pending (requests|approvals))\b/i, args: () => ({}) },
  { tool: 'getTimeOff', when: /\b(time off|leave|vacation)\b/i, pattern: /\bemployee\D{0,12}(\d{4,10})\b/i, args: (m) => ({ userId: m[1] }) },
  { tool: 'getTimeOff', pattern: /\b(my (time off|leave|vacation)|leave balance|days? (off|of leave))\b/i, args: () => ({}) },
  { tool: 'getTeamOverview', when: /\bteam\b/i, pattern: /\bemployee\D{0,12}(\d{4,10})\b/i, args: (m) => ({ userId: m[1] }) },
  { tool: 'getTeamOverview', pattern: /\b(my team|team overview|who is out)\b/i, args: () => ({}) },
  { tool: 'getDirectReports', pattern: /\b(?:reports? to|team of|direct reports of)\s+(?:employee\s+)?(\d{4,10})\b/i, args: (m) => ({ userId: m[1] }) },
  { tool: 'getDirectReports', pattern: /\b(my (direct )?reports|reports? to me)\b/i, args: () => ({}) },
  { tool: 'getReportingLine', when: /\b(reporting line|reports? to|manager|chain of command)\b/i, pattern: /\bemployee\D{0,12}(\d{4,10})\b/i, args: (m) => ({ userId: m[1] }) },
  { tool: 'getReportingLine', pattern: /\b(my (reporting line|manager)|who do I report to)\b/i, args: () => ({}) },
  { tool: 'getJobHistory', when: /\b(job|career|employment) history\b/i, pattern: /\bemployee\D{0,12}(\d{4,10})\b/i, args: (m) => ({ userId: m[1] }) },
  { tool: 'getJobHistory', pattern: /\bmy (job|career|employment) history\b/i, args: () => ({}) },
  { tool: 'getMyProfile', pattern: /\b(my (profile|details|job)|who am I)\b/i, args: () => ({}) },
  { tool: 'listEntities', when: /\bsuccessfactors|query\b/i, pattern: /\bentities\b/i, args: () => ({}) },
  { tool: 'getEmployee', pattern: /\bemployee\D{0,12}(\d{4,10})\b/i, args: (m) => ({ userId: m[1] }) },
  { tool: 'searchEmployees', when: /\b(find|search|look up|who is)\b/i, pattern: /\b(?:employees?|colleagues?|people|person)\s+(?:named|called|with the name)?\s*([A-Za-z][A-Za-z .'-]{1,40})$/i, args: (m) => ({ query: m[1]!.trim() }) },
  { tool: 'createDraft', when: /\bdraft\b/i, pattern: EMAIL_TO, args: (m, t) => mailArgsIn(m, t) },
  { tool: 'sendMail', when: /\bsend\b/i, pattern: EMAIL_TO, args: (m, t) => mailArgsIn(m, t) },
  { tool: 'listEvents', pattern: /\b(calendar|meetings?|agenda|schedule)\b/i, args: (_m, t) => calendarRangeIn(t) },
  { tool: 'listMessages', pattern: /\bunread\b/i, args: () => ({ unreadOnly: true }) },
  { tool: 'searchMail', pattern: /\bopen the message\s+["“](.{2,120}?)["”]/i, args: (m) => ({ text: m[1] }) },
  { tool: 'searchMail', when: /\b(mail|e-?mails?|messages?)\b/i, pattern: /\b(?:about|regarding|mentioning)\s+["“]?([^"”?.]{2,60})/i, args: (m) => ({ text: m[1]!.trim() }) },
  { tool: 'searchMail', when: /\b(mail|e-?mails?|messages?)\b/i, pattern: /\bfrom\s+([A-Za-z][\w.@-]{1,60})/i, args: (m) => ({ from: m[1] }) },
  { tool: 'listMessages', pattern: /\b(my (mail|inbox|e-?mails?|messages)|inbox)\b/i, args: () => ({}) },
  { tool: 'searchBusinessObject', when: /\b(find|search|look up)\b/i, pattern: /(?:for|find|search)\s+(.{3,60})$/i, args: (m) => ({ query: m[1]!.trim() }) },
];

/** A value to put into a field of the Fiori page, and optionally the button to finish with. */
const FIELD_ENTRY = /\b(?:enter|set|type)\s+"?([^"]+?)"?\s+(?:as|in|into|for)\s+(?:the\s+)?([a-z ]+?)(?:\s+and\s+(save|check))?[.!]?$/i;

/** Company code named in the prompt, else the demo company code of the mock scenarios. */
const companyCodeIn = (text: string) => /company code (\w{4})/i.exec(text)?.[1] ?? '1030';
/** Amount ("of 2500") and bank G/L account ("bank account 220001") of a payment request. */
const paymentArgsIn = (text: string) => ({
  amount: (/\bof\s+(?:[A-Z]{3}\s*)?(\d[\d,]*(?:\.\d{1,2})?)/i.exec(text)?.[1] ?? '').replaceAll(',', ''),
  currency: 'SAR',
  bankAccount: /\bbank account\D{0,6}(\d{6,10})\b/i.exec(text)?.[1] ?? '220001',
});
const itemStatusIn = (text: string) => (/\ball\b/i.test(text) ? 'ALL' : /\bcleared\b/i.test(text) ? 'CLEARED' : 'OPEN');

/** What the offline model reads off an invoice: only values the document states, never guessed. */
function invoiceFieldsIn(text: string, purchaseOrder: string | undefined) {
  const reference = /\binvoice(?:[ \t]+(?:number|no\.?))?:?[ \t]+([A-Z0-9][A-Z0-9./-]{1,15})\b/i.exec(text)?.[1];
  const gross = [...text.matchAll(/\btotal\b[^\d\n]*([\d,]+\.\d{2})/gi)].at(-1)?.[1];
  if (!purchaseOrder || !reference || !gross) return undefined;
  const tax = /\b(?:VAT|tax)\b[^\d\n]*\d{1,2}%[^\d\n]*([\d,]+\.\d{2})/i.exec(text)?.[1];
  const date = /\b(?:invoice )?date:?\s+(\d{4}-\d{2}-\d{2})\b/i.exec(text)?.[1];
  const currency = /\b(SAR|USD|EUR|AED|GBP)\b/.exec(text)?.[1];
  const supplier = text.split('\n')[0]?.trim();
  return {
    purchaseOrder,
    reference,
    grossAmount: Number(gross.replaceAll(',', '')),
    ...(tax && { taxAmount: Number(tax.replaceAll(',', '')) }),
    ...(date && { invoiceDate: date }),
    ...(currency && { currency }),
    ...(supplier && supplier.length <= 120 && { supplierName: supplier }),
  };
}

/** The same values from the fields SAP Document AI recognized in a scan. */
function invoiceFromFields(fields: { name: string; value: string }[]) {
  const get = (name: string) => fields.find((f) => f.name === name)?.value || undefined;
  const [purchaseOrder, reference, gross] = [get('purchaseOrderNumber'), get('documentNumber'), get('grossAmount')];
  if (!purchaseOrder || !reference || !gross) return undefined;
  const [tax, date, currency, supplier] = [get('taxAmount'), get('documentDate'), get('currencyCode'), get('senderName')];
  return {
    purchaseOrder,
    reference,
    grossAmount: Number(gross),
    ...(tax && { taxAmount: Number(tax) }),
    ...(date && { invoiceDate: date }),
    ...(currency && { currency }),
    ...(supplier && { supplierName: supplier }),
  };
}

function findTool(tools: ToolSpec[] | undefined, suffix: string): ToolSpec | undefined {
  return tools?.find((t) => t.name === suffix || t.name.endsWith(`_${suffix}`));
}

function lastIndexOfRole(messages: LLMMessage[], role: LLMMessage['role']): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === role) return i;
  return -1;
}

export interface MockProviderOptions {
  /** Delay between streamed tokens, to make streaming visible in demos. */
  tokenDelayMs?: number;
  /** Makes every call fail — used to exercise router fallback in tests. */
  failWith?: Error;
}

export class MockProvider implements LLMProvider {
  readonly id = 'mock' as const;
  readonly private = true;

  constructor(private readonly opts: MockProviderOptions = {}) {}

  plan(req: LLMRequest): { text: string; toolCalls: { name: string; arguments: Record<string, unknown> }[] } {
    const messages = req.messages;
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const last = messages.at(-1);

    if (/conversation summarizer/i.test(system)) {
      const users = messages.filter((m) => m.role === 'user').map((m) => m.content.slice(0, 120));
      return { text: `Earlier in this conversation the user asked about: ${users.join('; ').slice(0, 800)}`, toolCalls: [] };
    }
    if (/title generator/i.test(system)) {
      const user = messages.find((m) => m.role === 'user')?.content ?? 'New conversation';
      return { text: user.replace(/\s+/g, ' ').slice(0, 48), toolCalls: [] };
    }

    if (last?.role === 'tool') {
      const next = this.browse(last, req.tools, messages[lastIndexOfRole(messages, 'user')]?.content ?? '');
      if (next) return next;
      const start = lastIndexOfRole(messages, 'user');
      const results = messages.slice(start + 1).filter((m): m is Extract<LLMMessage, { role: 'tool' }> => m.role === 'tool');
      return { text: this.summarize(results), toolCalls: [] };
    }

    const text = last?.role === 'user' ? last.content : '';
    for (const intent of INTENTS) {
      const tool = findTool(req.tools, intent.tool);
      if (!tool) continue;
      if (intent.when && !intent.when.test(text)) continue;
      if (intent.accepts && !intent.accepts(tool)) continue;
      const match = intent.pattern.exec(text);
      if (match) return { text: '', toolCalls: [{ name: tool.name, arguments: intent.args(match, text) }] };
    }

    const toolHint = req.tools?.length
      ? `I can look up SAP business objects for you — for example an invoice number (51…), a purchase order (45…), a sales order, a customer or vendor ID, or equipment. `
      : '';
    return {
      text:
        `**Prowess AI is running with the offline mock model.** ${toolHint}` +
        `Configure SAP AI Core, Azure AI Foundry, AWS Bedrock or Google Vertex AI to enable full natural-language reasoning.\n\n` +
        `Try: *"Why is invoice 5100012345 blocked?"*`,
      toolCalls: [],
    };
  }

  /**
   * Imitates an agent at work in the Fiori pane: once the app is open it reads
   * the page, then points at the first field that was left empty.
   */
  private browse(last: Extract<LLMMessage, { role: 'tool' }>, tools: ToolSpec[] | undefined, asked: string): { text: string; toolCalls: { name: string; arguments: Record<string, unknown> }[] } | undefined {
    if (last.isError) return undefined;
    const offered = (name: string) => tools?.some((t) => t.name === name);
    const call = (name: string, args: Record<string, unknown>) => ({ text: '', toolCalls: [{ name, arguments: args }] });
    const data = safeJsonObject(last.content.slice(last.content.indexOf('{'), last.content.lastIndexOf('}') + 1));
    const page = data.page as { messages?: string[]; elements?: { ref: string; role: string; label: string; value?: string; disabled?: boolean }[] } | undefined;
    const elements = page?.elements ?? [];
    // "Enter 0001 as payment terms and save": the value, the field, and the button to finish with.
    const entry = FIELD_ENTRY.exec(asked);
    const named = (role: string, label: string) => elements.find((e) => e.role === role && !e.disabled && e.label.toLowerCase().includes(label.toLowerCase()));

    // Invoice intake: from the invoice mail to its attachment, then the check against the purchase order.
    if (/\binvoices?\b/i.test(asked) && /\b(mail|inbox|e-?mails?)\b/i.test(asked)) {
      if (last.name === 'outlook_searchMail' && offered('outlook_getMessage')) {
        const hit = ((data.messages ?? []) as { id: string; subject: string; hasAttachments?: boolean }[]).find((m) => m.hasAttachments && /invoice/i.test(m.subject));
        if (hit) return call('outlook_getMessage', { messageId: hit.id });
      }
      if (last.name === 'outlook_getMessage' && offered('outlook_readAttachment')) {
        const message = data.message as { id: string; attachments?: string[] } | undefined;
        const file = message?.attachments?.find((a) => /\.(pdf|txt)$/i.test(a));
        if (message && file) return call('outlook_readAttachment', { messageId: message.id, attachment: file });
      }
      if (last.name === 'outlook_readAttachment' && offered('mm_checkSupplierInvoice')) {
        const fields = data.fields as { name: string; value: string }[] | undefined;
        const invoice = fields ? invoiceFromFields(fields) : invoiceFieldsIn(String(data.text ?? ''), (data.purchaseOrderCandidates as string[] | undefined)?.[0]);
        if (invoice) return call('mm_checkSupplierInvoice', invoice);
      }
    }
    if (last.name.endsWith('showFioriGuide') && data.agentCanAct === true && offered('fiori_read')) return call('fiori_read', {});
    if (last.name === 'fiori_read' && offered('fiori_point')) {
      const field = entry && named('textbox', entry[2]!);
      if (field) return call('fiori_type', { ref: field.ref, text: entry[1], note: `I am entering ${entry[1]} as ${field.label.toLowerCase()}.` });
      const empty = elements.find((e) => e.role === 'textbox' && !e.value && !e.disabled);
      if (empty) return call('fiori_point', { ref: empty.ref, note: `${empty.label} is empty. Enter the value here, then choose Save.` });
    }
    if (last.name === 'fiori_type') {
      const button = entry?.[3] && named('button', entry[3]);
      if (button) return call('fiori_click', { ref: button.ref, note: `${button.label} writes the change to SAP.` });
      return { text: 'I entered the value in the page on the right. Check it, then choose Save.', toolCalls: [] };
    }
    if (last.name === 'fiori_click') return { text: page?.messages?.[0] ? `SAP answered: ${page.messages[0]}` : 'I clicked it. SAP showed no message.', toolCalls: [] };
    if (last.name === 'fiori_point') return { text: 'I opened the app on the right and am pointing at the field that still needs a value.', toolCalls: [] };
    return undefined;
  }

  private summarize(results: Extract<LLMMessage, { role: 'tool' }>[]): string {
    const lines: string[] = [];
    for (const r of results) {
      // Tool output arrives fenced as untrusted data; read the JSON inside the fence.
      const json = r.content.slice(r.content.indexOf('{'), r.content.lastIndexOf('}') + 1);
      const parsed = safeJsonObject(json);
      const data = (parsed.data ?? parsed) as Record<string, unknown>;
      if (parsed.status === 'AWAITING_USER_CONFIRMATION') {
        lines.push(
          `I've prepared **${String(parsed.action ?? 'the requested change')}**. ${String(parsed.impact ?? '')}`.trim(),
          '',
          'Nothing changes in SAP until you review and confirm the card below. SAP will still check your own authorization when it executes.',
        );
        continue;
      }
      if (r.isError) {
        // The user already sees the failure as a notice card with the cause and the next step.
        lines.push('I could not complete this request. The notice above says why and what you can do.');
        continue;
      }
      const summary = typeof data.summary === 'string' ? data.summary : undefined;
      if (summary) lines.push(summary);
      const findings = Array.isArray(data.findings) ? (data.findings as unknown[]).map(String) : [];
      if (findings.length) lines.push('', '**What I found**', ...findings.map((f) => `- ${f}`));
      const next = Array.isArray(data.nextSteps) ? (data.nextSteps as unknown[]).map(String) : [];
      if (next.length) lines.push('', '**Suggested next steps**', ...next.map((f) => `- ${f}`));
      if (!summary && !findings.length) lines.push(`Retrieved the requested information from SAP.`);
    }
    if (results.some((r) => /"mock"\s*:\s*true/.test(r.content))) {
      lines.push('', '_Source data is from the Prowess mock SAP system — not a live S/4HANA tenant._');
    }
    return lines.join('\n');
  }

  async *stream(req: LLMRequest): AsyncGenerator<LLMChunk> {
    if (this.opts.failWith) throw this.opts.failWith;
    const { text, toolCalls } = this.plan(req);
    const delay = this.opts.tokenDelayMs ?? 0;
    for (const token of text.match(/\S+\s*|\s+/g) ?? []) {
      if (req.signal?.aborted) break;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      yield { type: 'text', text: token };
    }
    for (const [i, call] of toolCalls.entries()) {
      yield { type: 'tool_call', call: { id: `mock_call_${Date.now().toString(36)}_${i}`, ...call } };
    }
    const inputTokens = Math.ceil(req.messages.reduce((n, m) => n + m.content.length, 0) / 4);
    yield { type: 'usage', usage: { inputTokens, outputTokens: Math.ceil(text.length / 4) + toolCalls.length * 20 } };
    yield { type: 'finish', reason: toolCalls.length ? 'tool_calls' : 'stop' };
  }

  complete(req: LLMRequest): Promise<LLMResponse> {
    return collect(this.stream(req));
  }

  async healthCheck(): Promise<boolean> {
    return !this.opts.failWith;
  }
}
