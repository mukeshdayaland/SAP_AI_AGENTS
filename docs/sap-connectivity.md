# SAP connectivity

SAP access lives **only** in `prowess-sap-mcp`, behind the `SapGateway` port:

| Mode | Class | Use |
| --- | --- | --- |
| `SAP_MODE=mock` | `MockSapGateway` | Local/CI. Fictitious data, simulated SAP authorizations. Refused in PROD. |
| `SAP_MODE=odata` | `ODataSapGateway` | S/4HANA released OData APIs (V2, and V4 for RAP services) via BTP Destination + Connectivity |

## Topology

```mermaid
flowchart LR
  M[prowess-sap-mcp] -->|destination lookup + user token exchange| DS[Destination service]
  M -->|HTTP via connectivity proxy| CP[Connectivity service]
  CP --> CC[SAP Cloud Connector<br/>customer network]
  CC -->|principal propagation<br/>X.509 short-lived cert| S4[(S/4HANA on-premise)]
  M -.->|cloud: OAuth2SAMLBearerAssertion| S4C[(S/4HANA Cloud)]
```

The SAP Cloud SDK (`@sap-cloud-sdk/http-client`) handles destination retrieval, token flows, the connectivity proxy
and CSRF tokens for writes.

## Destination `S4HANA`

On-premise (recommended):

| Property | Value |
| --- | --- |
| Type | HTTP |
| ProxyType | OnPremise |
| Authentication | PrincipalPropagation |
| URL | `http://s4h-virtual-host:44300` (Cloud Connector virtual host) |
| sap-client | your client (additional property) |

Cloud Connector: expose only the service paths below (path prefix, *not* `/`). Enable principal propagation with a
short-lived certificate mapping to SAP users. Trust the subaccount's IAS/XSUAA.

S/4HANA Cloud: `Authentication=OAuth2SAMLBearerAssertion` with a communication arrangement per API.

## APIs used (allow-list these)

| Tool(s) | Service |
| --- | --- |
| invoices, release | `API_SUPPLIERINVOICE_PROCESS_SRV` (`A_SupplierInvoice`, function `Release`) |
| vendors | `API_BUSINESS_PARTNER` (`A_Supplier`) |
| vendor addresses for the map | `API_BUSINESS_PARTNER` (`A_BusinessPartner` with `Supplier ne ''`, expanded with `to_BusinessPartnerAddress`, read in pages of 500) |
| purchase orders (read, create) | `API_PURCHASEORDER_PROCESS_SRV` (`A_PurchaseOrder`) |
| requisitions (read, create) | `API_PURCHASEREQ_PROCESS_SRV` (`A_PurchaseRequisitionHeader`) |
| goods receipts (read, post) | `API_MATERIAL_DOCUMENT_SRV` (`A_MaterialDocumentHeader`, goods movement code `01`, movement type `101`) |
| supplier invoice (create) | `API_SUPPLIERINVOICE_PROCESS_SRV` (`A_SupplierInvoice` with `to_SuplrInvcItemPurOrdRef`) |
| sales orders, document flow | `API_SALES_ORDER_SRV` (`A_SalesOrder`, `to_SubsequentProcFlowDoc`) |
| outbound deliveries | `API_OUTBOUND_DELIVERY_SRV;v=0002` |
| billing documents (read) | `API_BILLING_DOCUMENT_SRV` |
| billing documents (create) | OData V4 `api_billingdocument`, static action `CreateFromSDDocument` (path `/sap/opu/odata4/sap/api_billingdocument/`) |
| outbound delivery create, goods issue | `API_OUTBOUND_DELIVERY_SRV;v=0002` (`A_OutbDeliveryHeader`, function `PostGoodsIssue`) |
| customers | `API_BUSINESS_PARTNER` (`A_Customer`) |
| customer / supplier / G/L line items | `API_OPLACCTGDOCITEMCUBE_SRV` |
| accounting documents | `API_JOURNALENTRYITEMBASIC_SRV` (leading ledger `0L`) |
| credit limit and risk class | `API_CRDTMBUSINESSPARTNER` |
| payment requests (create, approve, reject, post) | Custom OData V4 service `ZAPI_FI_AGENTPAYMENT` (binding `ZAPI_FI_AGENTPAYMENT_O4`, entity `Payment`, bound actions `approve`, `reject`, `post`; path `/sap/opu/odata4/sap/zapi_fi_agentpayment_o4/`) |
| sales order create, change, item price | `API_SALES_ORDER_SRV` (`A_SalesOrder`, `A_SalesOrderItem`, `A_SalesOrderItemPrElement`; price condition PPR0 or PR00) |
| sales order incompletion log | Custom read-only OData V4 service `ZAPI_SD_INCOMPLETIONLOG` (binding `ZAPI_SD_INCOMPLETIONLOG_O4`, entity `IncompletionLog` on view `ZC_SD_IncompletionLog`, which casts the partner function because OData allows no conversion exit (PARVW) in a key, over `ZI_SD_IncompletionLog` on VBUV; access control on V_VBAK_VKO / V_VBAK_AAT; path `/sap/opu/odata4/sap/zapi_sd_incompletionlog_o4/`) |
| sales order item weight | Same service, entity `ItemWeight` (root view `ZR_SD_SalesOrderItemWeight` on VBAP), bound action `setWeight` (`GrossWeight`, `NetWeight`, `WeightUnit`). The unmanaged behavior `ZBP_R_SD_SALESORDERITEMWEIGHT` calls `BAPI_SALESORDER_CHANGE` in the action (not in simulation mode, which checks the order without its sales area); a rejection fails the action and RAP rolls back, otherwise RAP's commit writes the change; the weights are read-only in `API_SALES_ORDER_SRV` and `API_SALESORDER` |
| sales order simulation | `API_SALES_ORDER_SIMULATION_SRV` (`A_SalesOrderSimulation`) |
| credit memo request | `API_CREDIT_MEMO_REQUEST_SRV` (`A_CreditMemoRequest`), `API_BILLING_DOCUMENT_SRV` for the reference |
| goods receipt reversal | `API_MATERIAL_DOCUMENT_SRV` (function `Cancel`) |
| supplier invoice reversal | `API_SUPPLIERINVOICE_PROCESS_SRV` (function `Cancel`) |
| goods issue reversal | `API_OUTBOUND_DELIVERY_SRV;v=0002` (function `ReverseGoodsIssue`) |
| G/L balance, G/L activity by account | `FAC_GL_ACCOUNT_BALANCE_SRV` (`GL_ACCOUNT_BALANCESet`, ledger `0L`; period 000 is the balance carried forward) |
| G/L account search, clearing, journal entry | `FAC_GL_DOCUMENT_POST_SRV` (`FAC_POST_JOUR_ENTRY_GLACCT_VH`; `CreateClearingForOpenItem` → `ActivateItemsToBeCleared` → `Post`; `FinsPostingGLHeaders` → `FinsPostingGLItems` → `Post`) |
| receivables aging | `C_ARAGINGANALYSISOVW_CDS` (parameterized: display currency and intervals 30 / 60 / 90) |
| payables aging | `FAP_VENDOR_LINE_ITEMS_SRV` (`Items`, clearing status `2` = open) |
| supplier invoice list and approvals | `MM_SUPPLIER_INVOICE_LIST_ENH_SRV` (`C_SupplierInvoiceList`) |
| payment run proposal | `FAP_SCHEDULE_PAYMENT_PROPOSAL` (`PaymentSummarySet`, `PaymentItemSet`, `ExceptionSet`) |
| GR/IR cases | `FAC_GRIR_ANALYSIS_SRV` (`C_GRIRProcessDigest`) |
| credit-blocked sales orders | `API_SALES_ORDER_SRV` (`TotalCreditCheckStatus eq 'B'`) |
| bank reconciliation | `FAR_BS_ITM_REPROC_SRV` (`GLAccountHouseBankAccountWorklistItems`) |
| depreciation | `FAA_ASSET_MANAGE_SRV` (`C_FixedAssetMaintain`), `FAA_ASSET_VALUES_OVERVIEW_SRV` (parameterized per asset) |
| material stock | `API_MATERIAL_STOCK_SRV` |
| purchasing info records | `API_INFORECORD_PROCESS_SRV` |
| equipment / notifications / orders | `API_EQUIPMENT`, `API_MAINTNOTIFICATION`, `API_MAINTENANCEORDER` |

When SAP rejects a posting, its own message is passed on to the user (`SAP rejected …: <SAP message>`). Read errors
stay generic.

Credit exposure is not part of the released credit API: the gateway reports the sum of open receivables and flags
it as such (`exposureBasis: OPEN_RECEIVABLES`).

Not wired to standard APIs (these return a clear *not available* error): free-text search (Enterprise Search),
invoice notes, releasing a credit block and cancelling a billing document. The last two have no released API in
this landscape; they are done in SAP (credit management release, VF11). Extend `ODataSapGateway` to add them.

The finance analysis services above are Fiori application services, not released APIs. Their paths and fields were
taken from the tenant dictionary of the FI analyst agent (verified against this S/4HANA 2023 system in July and
September 2026) and must be re-verified on any other system. Writes carry `X-Requested-With: XMLHttpRequest`,
which this gateway uses for CSRF protection.

A posted payment request is a payment on account: the item stays open on the customer or supplier account and is
not cleared against invoices by the payment service. Clear it with `gl_clearOpenItems` once payment and invoice offset each other.

Field mappings follow the published API definitions on the SAP Business Accelerator Hub. **Validate them against
your S/4HANA release** in DEV (fields such as status texts vary between releases).

## SuccessFactors

The `sf` tool domain has its own gateway port, `SfGateway` (`apps/sap-mcp/src/sf`):

| Mode | Class | Use |
| --- | --- | --- |
| `SF_MODE=mock` | `MockSfGateway` | Local/CI. Fictitious employees, simulated role-based permissions. Refused in PROD. |
| `SF_MODE=odata` | `SfODataGateway` | SuccessFactors HCM OData V2 through a BTP destination |

### Destination `SF_ODATA`

| Property | Value |
| --- | --- |
| Type | HTTP |
| ProxyType | Internet |
| Authentication | OAuth2SAMLBearerAssertion |
| URL | `https://<api-host>/odata/v2` |
| tokenServiceURL | `https://<api-host>/oauth/token` |
| clientKey | API key of the OAuth client registered in SuccessFactors |

Take the remaining SAML properties (audience, company id, name ID format) from the destination that already works
for this tenant. `infrastructure/btp/sf-odata-destination.json` is the template; it carries no host and no key.

The destination must live in the subaccount whose XSUAA issued the user's token, and the OAuth client in
SuccessFactors must trust that subaccount's signing certificate. The SAP Cloud SDK exchanges the user's JWT for a
SuccessFactors token and caches it, so the service stores no tokens.

### Identity

- Every call runs **as the end user**, so SuccessFactors role-based permissions decide what comes back. There is no
  technical-user mode: a call without a user token is refused.
- `SF_USER_MAPPING` says how the login is matched to a SuccessFactors user: `email` (default) and `username` look
  the user up once in `User` and remember the user id for ten minutes; `userId` takes the login name as the user id.
  No match, or more than one, is an error. The gateway does not guess.

### Entities used

| Tool(s) | Entity |
| --- | --- |
| profile, search, direct reports, reporting line | `User` (expanded with `manager`) |
| job history | `EmpJob` (`fromDate=1900-01-01`, `toDate=9999-12-31`) |
| `sf_queryEntity` | whatever the entity allow-list names |

### Entity allow-list

`sf_queryEntity` reads only the entities and fields on the allow-list (`apps/sap-mcp/src/sf/policy.ts`): `User`,
`EmpJob`, `EmpEmployment`, `Position` and the foundation objects `FOCompany`, `FODepartment`, `FODivision`,
`FOLocation`, `FOJobCode`. Personal data and compensation entities are left out on purpose.

- Fields listed under `sensitiveFields` come back as `[REDACTED]` and cannot be used to filter or sort.
- A query without a filter returns at most 50 records; with a filter at most 200.
- `SF_ENTITY_ALLOWLIST_JSON` replaces the bundled list: `{ "<Entity>": { "operations": ["read"], "fields": [...],
  "sensitiveFields": [...], "keyFields": [...] } }`. Invalid JSON, a wildcard entry or an entry without `fields`
  fails startup, so a bad change cannot widen access.

Entity and field names follow the standard data model. **Validate them against the tenant's `$metadata`** before
going live; `scripts/validate_allowlist.py` of the `SAP_SF_MCP_V4` repository checks a list against tenant metadata.
## Identity

- User token present → the SDK exchanges it and S/4HANA executes **as the user**, so SAP authorizations apply.
- No user token → refused, unless `SAP_ALLOW_TECHNICAL_USER=true`. See the implications in [security.md](security.md).
- RFC/BAPI: expose them through an approved integration layer (for example an OData/REST wrapper in S/4 or SAP
  Integration Suite), then add a gateway method. The MCP server doesn't open RFC connections directly.

## Resilience

Each SAP call has a 20 s timeout and each tool call a 25 s timeout. Errors are mapped to safe messages
(`NOT_FOUND`, `NOT_AUTHORIZED`, `UNAVAILABLE`). Reads may be retried by the model. **Writes are never retried
automatically.** A failed write requires a new confirmation.
