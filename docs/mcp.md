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
| Credit | `credit_getCreditExposure` | READ | Credit limit, exposure, utilization, risk class |
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
  "followUps":  [{ "label": "Check related PO", "prompt": "…" }]          // → suggested prompts, never executions
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
