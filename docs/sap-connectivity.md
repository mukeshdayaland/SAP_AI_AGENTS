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
| time off balances | `TimeAccount` for the employee's open accounts, then `EmpTimeAccountBalance` once per account type (SuccessFactors requires `userId` and `timeAccountType` in the filter) |
| absences, who is out today | `EmployeeTime` (`startDate`, `endDate`, `quantityInDays`, `approvalStatus`) |
| open positions of a team | `EmpJob` for the manager's position, then `Position` (`parentPosition/code`, `vacant eq true`) |
| time types | `TimeType` |
| leave request | `POST /upsert` of an `EmployeeTime` record (`externalCode`, `userId`, `timeType`, `startDate`, `endDate`, `comment`); a refusal in the per-record status of the 200 answer is passed on |
| pending approvals | `MyPendingWorkflow`, merged with the approval items of the user's to-do list (`TodoEntryV2`, which holds forwarded and delegated requests) |
| approve / decline | function imports `approveWfRequest` / `rejectWfRequest` (POST, `wfRequestId`, `comment`) |
| `sf_queryEntity` | whatever the entity allow-list names |

`EmpTimeAccountBalance`, `Position` and `MyPendingWorkflow` are read without `$select`, because their properties
differ between tenants and releases; the gateway maps the names it knows and logs the property names of the first
record once (`sf.entity_shape`), so the mapping can be checked from the logs. The team overview leaves out a figure
when its entity is missing or the user may not read it, instead of failing.

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

## Fiori pane

Some things an agent cannot do through a tool: SAP rejected the action for a reason that has to be fixed in the
document, or no released API covers the change. For these the agent opens the Fiori app in a browser pane beside the
conversation (`shared_showFioriGuide`) and works in the page with the user:

| Agent tool | What it does in the page |
|---|---|
| `fiori_read` | Reads the fields with their values, the buttons, and the messages SAP shows. Password fields are never read |
| `fiori_point` | Moves the agent's cursor to an element and shows a note beside it. Changes nothing |
| `fiori_type` | Enters a value into a field. Nothing is saved by typing |
| `fiori_click` | Clicks a button, tab or link. A click that may save, post, release or delete waits until the user allows it in the pane |

The steps are shown in the browser only, next to the element they concern; the conversation keeps a one-line note.
"Take over" stops the agent and leaves the page to the user.

How it works: the `fiori_*` tools are not SAP calls. The orchestrator sends the action down the chat stream
(`browser.action`), the pane carries it out in the page the user has open, and posts the result to
`POST /api/v1/browser/results`. SAP sees the user's own session, so SAP authorizations apply exactly as when the user
clicks. Every action is written to the audit trail (`BROWSER_ACTION`). What the page contains reaches the model as
untrusted data, like any tool result. Results are matched in memory, so the orchestrator must run as one instance, or
with sticky sessions, for this feature.

The agent can only do this when Fiori is served **on the workspace's own address**; a browser does not let one site
read or click inside another. The approuter does that: `xs-app.json` forwards `/sap/*` to the `S4HANA_2023_PP` destination as
the signed-in user, and `start.mjs` gives those pages their own Content-Security-Policy (`frame-ancestors 'self'`)
instead of the workspace's.

| Setting | Where | Meaning |
|---|---|---|
| `SAP_FIORI_LAUNCHPAD_URL` | sap-mcp | `/sap/bc/ui2/flp` (add `?sap-client=<client>` if needed): Fiori through the approuter, the agent can act. An `https://` address: Fiori on its own host, the pane shows the guide's steps and the agent cannot see the page. Empty: steps only |
| `SAP_FIORI_EMBED` | sap-mcp | `false` opens Fiori in a new window instead of the pane |
| `SAP_FIORI_INTENTS_JSON` | sap-mcp | `{ "<guide id>": "SemanticObject-action" }` for apps this system assigns to another intent |
| `FIORI_ORIGIN` | front end | Only for an `https://` launchpad: its origin, allowed as a frame in the Content-Security-Policy |

What the SAP side needs for `/sap/*` through the approuter:

- The `S4HANA_2023_PP` destination must sign the user in without a prompt (principal propagation through the Cloud
  Connector, or OAuth2SAMLBearerAssertion), as it already does for the OData calls.
- The launchpad service (`/sap/bc/ui2/flp`) and the apps' services must be reachable through that destination; with
  the Cloud Connector, expose the `/sap/` path with all sub-paths.

Things to know before relying on it:

- Serving Fiori on the workspace's address puts both in one browser origin. A script-injection flaw in a Fiori page
  could then call the workspace's API as the user. This is the price of letting the agent act in the page.
- The apps the agent opens come from a fixed catalogue (`apps/sap-mcp/src/sap/fiori-guides.ts`); the model chooses
  an entry and names the document, it cannot supply an address. **Validate the intents against the system** (app
  finder, or the target mappings in `/UI2/FLPD_CUST`): they are those of the SAP standard content.
- Pages are read through their HTML: labels, roles and values. This suits Fiori elements and freestyle UI5 apps.
  Classic transactions shown as SAP GUI for HTML are read too, but their labels are poorer and they need Enter to
  confirm an entry, which the agent does not press.
- Local development: with `SAP_MODE=mock` the sap-mcp service serves a mock Fiori page at `/sap/bc/ui2/flp` and the
  web dev server forwards `/sap/*` to it, so the whole flow runs without SAP.
- The Cloudflare Pages front end cannot reach S/4HANA itself. With `FIORI_URL` set it forwards `/sap/*` to the approuter
  with the user's token (`x-approuter-authorization`), and the approuter forwards to S/4HANA as above.

## Identity

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
| time off balances | `TimeAccount` for the employee's open accounts, then `EmpTimeAccountBalance` once per account type (SuccessFactors requires `userId` and `timeAccountType` in the filter) |
| absences, who is out today | `EmployeeTime` (`startDate`, `endDate`, `quantityInDays`, `approvalStatus`) |
| open positions of a team | `EmpJob` for the manager's position, then `Position` (`parentPosition/code`, `vacant eq true`) |
| time types | `TimeType` |
| leave request | `POST /upsert` of an `EmployeeTime` record (`externalCode`, `userId`, `timeType`, `startDate`, `endDate`, `comment`); a refusal in the per-record status of the 200 answer is passed on |
| pending approvals | `MyPendingWorkflow`, merged with the approval items of the user's to-do list (`TodoEntryV2`, which holds forwarded and delegated requests) |
| approve / decline | function imports `approveWfRequest` / `rejectWfRequest` (POST, `wfRequestId`, `comment`) |
| `sf_queryEntity` | whatever the entity allow-list names |

`EmpTimeAccountBalance`, `Position` and `MyPendingWorkflow` are read without `$select`, because their properties
differ between tenants and releases; the gateway maps the names it knows and logs the property names of the first
record once (`sf.entity_shape`), so the mapping can be checked from the logs. The team overview leaves out a figure
when its entity is missing or the user may not read it, instead of failing.

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

## Fiori guides

Some things an agent cannot do through a tool: SAP rejected the action for a reason the user has to fix in the
document, or no released API covers the change. For these the agent calls `shared_showFioriGuide`. The user gets a
card with the steps and opens the Fiori app in the workspace's built-in browser, next to the conversation. The user
does the work in SAP under their own sign-in and authorizations; the workspace cannot read or drive the app. "I'm
stuck" sends the step to the agent, and "Done, check the result" asks it to read the document again.

The guides are a fixed catalogue in `apps/sap-mcp/src/sap/fiori-guides.ts`: the app, its launchpad intent and the
steps. The model only chooses a guide and names the business object; it cannot supply an address or steps.

| Setting | Where | Meaning |
|---|---|---|
| `SAP_FIORI_LAUNCHPAD_URL` | sap-mcp | Launchpad address, https only, e.g. `https://s4.example.com:44300/sap/bc/ui2/flp?sap-client=100`. Without it the guides show their steps only |
| `SAP_FIORI_EMBED` | sap-mcp | `true` (default) shows the app inside the workspace; `false` opens it in a new window |
| `SAP_FIORI_INTENTS_JSON` | sap-mcp | `{ "<guide id>": "SemanticObject-action" }` for apps this system assigns to another intent |
| `FIORI_ORIGIN` | front end | Origin of the launchpad, e.g. `https://s4.example.com:44300`. Added to the Content-Security-Policy as the only allowed frame. Cloudflare Pages: a project variable. Approuter: set it when running `npm run build:cf` |

To show the app inside the workspace, S/4HANA must allow it:

- Clickjacking protection: add the workspace's origin to the HTTP allowlist (transaction `UCONCOCKPIT`, scenario
  *Clickjacking Framing Protection*). Otherwise the frame stays blank.
- Sign-in: the browser must accept the SAP session cookie inside a frame. With single sign-on through the same
  identity provider this works without a prompt; browsers that block third-party cookies need the launchpad on the
  same site as the workspace, or `SAP_FIORI_EMBED=false`.

The pane always offers "open in a new window", which needs none of this.

**Validate the intents against the system** before going live (launchpad app finder, or the target mappings in
`/UI2/FLPD_CUST`): they are those of the SAP standard content and were not checked against a tenant.

## Identity

- User token present → the SDK exchanges it and S/4HANA executes **as the user**, so SAP authorizations apply.
- No user token → refused, unless `SAP_ALLOW_TECHNICAL_USER=true`. See the implications in [security.md](security.md).
- RFC/BAPI: expose them through an approved integration layer (for example an OData/REST wrapper in S/4 or SAP
  Integration Suite), then add a gateway method. The MCP server doesn't open RFC connections directly.

## Resilience

Each SAP call has a 20 s timeout and each tool call a 25 s timeout. Errors are mapped to safe messages
(`NOT_FOUND`, `NOT_AUTHORIZED`, `UNAVAILABLE`). Reads may be retried by the model. **Writes are never retried
automatically.** A failed write requires a new confirmation.
