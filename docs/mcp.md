# MCP tool layer

The orchestrator is the MCP **client**. `prowess-sap-mcp` is an MCP **server** that uses the Streamable HTTP
transport in stateless mode (one short-lived server per request). The model chooses tools by intent, the orchestrator
authorizes them, and the MCP server executes them against SAP.

## Tools

| Domain | Tool | Risk | Notes |
| --- | --- | --- | --- |
| SD | `sd_getSalesOrder` | READ | Items, delivery / billing status, credit, delivery and billing blocks (VA01) |
| SD | `sd_getSalesOrderFlow` | READ | Order → delivery → goods issue → billing → accounting, with the outstanding step |
| SD | `sd_listOpenSalesOrders` | READ | Orders not completely delivered or billed, or blocked |
| SD | `sd_getDelivery` | READ | Outbound delivery, picking and goods issue status (VL01N) |
| SD | `sd_getBillingDocument` | READ | Billing document and its accounting document (VF01) |
| SD | `sd_createDelivery` | HIGH_IMPACT | Confirmation required. Outbound delivery for a sales order (VL01N) |
| SD | `sd_postGoodsIssue` | HIGH_IMPACT | Confirmation required. Reduces stock, posts cost of goods sold |
| SD | `sd_createBillingDocument` | HIGH_IMPACT | Confirmation required. Bills the goods-issued delivery (VF01) and posts it to accounting |
| SD | `sd_simulateSalesOrder` | READ | Price, availability and credit check for an order that is not saved |
| SD | `sd_createSalesOrder` | HIGH_IMPACT | Confirmation required. Standard order for one material (VA01) |
| SD | `sd_releaseCreditBlock` | HIGH_IMPACT | Confirmation required. Demo gateway only; not available through the released S/4HANA APIs |
| SD | `sd_reverseGoodsIssue` | HIGH_IMPACT | Confirmation required. Reverses the goods issue of a delivery (VL09) |
| SD | `sd_cancelBillingDocument` | HIGH_IMPACT | Confirmation required. Demo gateway only; cancel in SAP with VF11 |
| SD | `sd_createCreditMemoRequest` | BUSINESS_WRITE | Confirmation required. Request for the full value of a billing document |
| Credit | `credit_getCreditExposure` | READ | Credit limit, exposure, utilization, risk class |
| FI-AR | `ar_getAging` | READ | Open receivables per customer by days overdue |
| FI-AR | `ar_proposeClearing` | READ | Customers whose open items offset each other; nothing is cleared |
| FI-AP | `ap_getAging` | READ | Open payables by days overdue at a key date, with totals per supplier |
| FI-AP | `ap_listInvoiceApprovals` | READ | Supplier invoices with status, block and approver |
| FI-AP | `ap_getPaymentRunProposal` | READ | Payment run (F110) proposal: items to be paid and exceptions. The run is never released here |
| FI-AP | `ap_proposeClearing` | READ | Suppliers whose open items offset each other; nothing is cleared |
| FI-GL | `gl_searchGLAccounts` | READ | G/L account numbers by a part of the account name |
| FI-GL | `gl_getAccountActivity` | READ | Debit and credit postings per G/L account for a period range |
| FI-GL | `gl_listGRIRCases` | READ | Purchase order items with an open GR/IR balance, with root cause |
| FI-GL | `gl_getBankReconciliation` | READ | Open bank statement items per house bank account |
| FI-GL | `gl_getDepreciationOverview` | READ | Posted and not yet posted depreciation per fixed asset |
| FI-GL | `gl_clearOpenItems` | HIGH_IMPACT | Confirmation required. Clears the open items of one customer or supplier that offset to zero (F-32 / F-44) |
| FI-GL | `gl_postJournalEntry` | HIGH_IMPACT | Confirmation required. Balanced manual G/L entry (FB50) |
| Credit | `credit_listCreditBlockedOrders` | READ | Sales orders blocked by the credit check |
| FI-AR | `ar_requestIncomingPayment` | BUSINESS_WRITE | Confirmation required. Creates a payment request (F-28); nothing is posted yet |
| FI-AP | `ap_requestOutgoingPayment` | BUSINESS_WRITE | Confirmation required. Creates a payment request (F-53); nothing is posted yet |
| FI-GL | `gl_listPaymentRequests` | READ | Approval queue: waiting, approved, posted, rejected |
| FI-GL | `gl_approvePaymentRequest` | HIGH_IMPACT | Confirmation required. SAP refuses approval by the creator of the request |
| FI-GL | `gl_rejectPaymentRequest` | BUSINESS_WRITE | Confirmation required |
| FI-GL | `gl_postPaymentRequest` | HIGH_IMPACT | Confirmation required. Posts an approved request as a payment on account (DZ / KZ) |
| FI-AR | `ar_getCustomer` | READ | Customer master, blocks, open and overdue receivables |
| FI-AR | `ar_listCustomerOpenItems` | READ | Customer line items, open / cleared / all (FBL5N) |
| FI-AR | `ar_listOverdueReceivables` | READ | Overdue customer items across a company code |
| FI-AP | `ap_getVendor` | READ | Vendor exposure (open/overdue) |
| FI-AP | `ap_getPaymentStatus` | READ | Paid / open / blocked |
| FI-AP | `ap_listVendorOpenItems` | READ | Supplier line items, open / cleared / all (FBL1N) |
| FI-AP | `ap_listInvoicesDue` | READ | Open supplier items due for payment by a date |
| FI-GL | `gl_getGLBalance` | READ | Debit/credit/balance |
| FI-GL | `gl_getAccountingDocument` | READ | Journal entry with debit and credit lines |
| FI-GL | `gl_listGRIROpenItems` | READ | GR/IR clearing account, balanced per purchase order |
| MM | `mm_getPurchaseOrder`, `mm_getPurchaseRequisition`, `mm_getGoodsReceipt`, `mm_getVendorDetails` | READ | |
| MM | `mm_getMaterialStock` | READ | Stock by plant and storage location |
| MM | `mm_getInfoRecords` | READ | Sources of supply: supplier, price, delivery time, last PO |
| MM | `mm_getInvoice` | READ | Header, payment block, verification issues (MIRO) |
| MM | `mm_analyzeInvoice` | READ | Invoice vs PO vs goods receipts → findings and next steps |
| MM | `mm_listBlockedInvoices` | READ | Invoices blocked for payment (MRBR worklist) |
| MM | `mm_getPurchaseOrderFlow` | READ | Order → goods receipt → supplier invoice, with open quantities and the outstanding step |
| MM | `mm_createPurchaseRequisition` | BUSINESS_WRITE | Confirmation required. Requisition for a material (ME51N) |
| MM | `mm_createPurchaseOrder` | HIGH_IMPACT | Confirmation required. Standard order; price from the info record unless given (ME21N) |
| MM | `mm_postGoodsReceipt` | HIGH_IMPACT | Confirmation required. Receives the open quantity of a purchase order (MIGO, movement 101) |
| MM | `mm_createSupplierInvoice` | HIGH_IMPACT | Confirmation required. Invoice for the received quantity (MIRO); SAP blocks it for payment on a variance |
| MM | `mm_reverseGoodsReceipt` | HIGH_IMPACT | Confirmation required. Reverses the latest goods receipt of a purchase order |
| MM | `mm_reverseSupplierInvoice` | HIGH_IMPACT | Confirmation required. Reverses a posted supplier invoice (MR8M) |
| MM | `mm_addInvoiceNote` | LOW_RISK_WRITE | Confirmation required |
| MM | `mm_releaseInvoicePaymentBlock` | HIGH_IMPACT | Confirmation required; SAP release authorization |
| PM | `pm_getEquipment`, `pm_getNotification`, `pm_getWorkOrder`, `pm_getMaintenanceHistory` | READ | |
| Shared | `shared_getUserContext`, `shared_getSystemInformation`, `shared_searchBusinessObject` | READ | |
| System | `system_previewAction` | READ (internal) | Hidden from models; builds the confirmation card |

Every tool publishes metadata in `_meta`: `prowess/risk`, `prowess/domain`, `prowess/targetSystem`,
`prowess/operation`, `prowess/statusLabel`, plus MCP `annotations` (`readOnlyHint`, `destructiveHint`).

## Tool result contract

```jsonc
{
  "data":       { "summary": "…", "findings": ["…"], "nextSteps": ["…"] }, // → model, fenced as untrusted
  "components": [{ "type": "invoice", "data": { … } }],                    // → UI, re-validated by the orchestrator
  "source":     { "system": "S4-PRD", "objectType": "SupplierInvoice", "objectId": "5100012345/2026", "retrievedAt": "…", "mock": false },
  "followUps":  [{ "label": "Check related PO", "prompt": "…" }],         // → suggested prompts, never executions
  "outputs":    { "delivery": "80000258" }                                // → values later steps of a workflow run can use
}
```

## Write workflow

```mermaid
sequenceDiagram
  participant L as Model
  participant O as Orchestrator
  participant U as User
  participant M as SAP MCP
  L->>O: tool_call mm_releaseInvoicePaymentBlock{…}
  O->>M: system_previewAction (read-only)
  M-->>O: preview + normalized arguments
  O->>O: store PendingAction (user, env, args hash, TTL)
  O-->>U: confirmation.required card
  O-->>L: "NOT executed — awaiting confirmation"
  U->>O: POST /actions/{id}/confirm (+ PROD acknowledgement)
  O->>O: pending→confirmed (atomic), sign confirmation assertion
  O->>M: tools/call + x-prowess-confirmation
  M->>M: verify signature · user · tool · args hash · env · single use
  M->>M: execute (never auto-retried)
```

## Splitting domains into services

Tool domains follow SAP modules: `sd`, `credit`, `ar`, `ap`, `gl`, `mm`, `pm` and `shared`. The domain modules are
independent. To extract accounts payable:

1. Deploy `apps/sap-mcp` a second time as `prowess-mcp-ap` with `MCP_DOMAINS=ap` (and remove `ap` from the original).
2. Configure the orchestrator with
   `MCP_SERVERS=[{"id":"ap","url":"https://…/mcp"},{"id":"sap","url":"https://…/mcp"}]`.

The former `fico` domain is still accepted in `MCP_DOMAINS` and expands to `ar,ap,gl,credit`.

No other code changes are needed. Tool names are unique across servers (duplicates are rejected at discovery).
The same pattern adds `prowess-mcp-hcm`, Ariba or SuccessFactors servers.
