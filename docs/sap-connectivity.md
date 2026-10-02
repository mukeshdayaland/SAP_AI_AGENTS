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
| purchase orders | `API_PURCHASEORDER_PROCESS_SRV` |
| requisitions | `API_PURCHASEREQ_PROCESS_SRV` |
| goods receipts | `API_MATERIAL_DOCUMENT_SRV` |
| sales orders, document flow | `API_SALES_ORDER_SRV` (`A_SalesOrder`, `to_SubsequentProcFlowDoc`) |
| outbound deliveries | `API_OUTBOUND_DELIVERY_SRV;v=0002` |
| billing documents (read) | `API_BILLING_DOCUMENT_SRV` |
| billing documents (create) | OData V4 `api_billingdocument`, static action `CreateFromSDDocument` (path `/sap/opu/odata4/sap/api_billingdocument/`) |
| outbound delivery create, goods issue | `API_OUTBOUND_DELIVERY_SRV;v=0002` (`A_OutbDeliveryHeader`, function `PostGoodsIssue`) |
| customers | `API_BUSINESS_PARTNER` (`A_Customer`) |
| customer / supplier / G/L line items | `API_OPLACCTGDOCITEMCUBE_SRV` |
| accounting documents | `API_JOURNALENTRYITEMBASIC_SRV` (leading ledger `0L`) |
| credit limit and risk class | `API_CRDTMBUSINESSPARTNER` |
| material stock | `API_MATERIAL_STOCK_SRV` |
| purchasing info records | `API_INFORECORD_PROCESS_SRV` |
| equipment / notifications / orders | `API_EQUIPMENT`, `API_MAINTNOTIFICATION`, `API_MAINTENANCEORDER` |

When SAP rejects a posting, its own message is passed on to the user (`SAP rejected …: <SAP message>`). Read errors
stay generic.

Credit exposure is not part of the released credit API: the gateway reports the sum of open receivables and flags
it as such (`exposureBasis: OPEN_RECEIVABLES`).

Not wired to standard APIs yet (these return a clear *not available* error): G/L balances (use a trial-balance CDS
view), free-text search (Enterprise Search), and invoice notes. Extend `ODataSapGateway` to add them.

Field mappings follow the published API definitions on the SAP Business Accelerator Hub. **Validate them against
your S/4HANA release** in DEV (fields such as status texts vary between releases).

## Identity

- User token present → the SDK exchanges it and S/4HANA executes **as the user**, so SAP authorizations apply.
- No user token → refused, unless `SAP_ALLOW_TECHNICAL_USER=true`. See the implications in [security.md](security.md).
- RFC/BAPI: expose them through an approved integration layer (for example an OData/REST wrapper in S/4 or SAP
  Integration Suite), then add a gateway method. The MCP server doesn't open RFC connections directly.

## Resilience

Each SAP call has a 20 s timeout and each tool call a 25 s timeout. Errors are mapped to safe messages
(`NOT_FOUND`, `NOT_AUTHORIZED`, `UNAVAILABLE`). Reads may be retried by the model. **Writes are never retried
automatically.** A failed write requires a new confirmation.
