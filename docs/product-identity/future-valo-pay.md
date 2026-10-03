# Creating the future Valo Pay independently

This guide reserves the intended code identity for a future product. It does not create that product, prove provider-name availability or authorise spending. The existing application and its records belong exclusively to **Valo Pay 1**.

## Name availability and boundaries

| Name or resource | Treatment for the future product | Current reuse status |
| --- | --- | --- |
| Product name Valo Pay; `ValoPay`, `valoPay`, `valo_pay` code identifiers | Intended future application naming | Reserved by the owner; code names can be selected independently when starting the future project |
| `obeidpeter/valo-pay` repository path | The existing repository has been renamed to `obeidpeter/valo-pay-1`; move and verify every material consumer/trust rule before reuse | **Not yet cleared**; the completed rename does not verify external consumers or deployment trust |
| `valo-pay` package/project slugs | May be considered after checking actual registry/provider ownership and scopes | Availability not established; keep existing ownership scopes unless separately authorised |
| `https://valo-pay.replit.app` | Remains generation-1 traffic until an approved retirement/reuse plan is complete | **Temporarily retained for compatibility**, not available by assumption |
| Existing Replit app UUID `da98915e-a44c-4f6e-af96-a37614f3a217` | Never use for the future product | **Assigned to Valo Pay 1**; changing its title does not release its identity |
| Existing database, storage, Clerk project and deployment authority | Do not share with future generation | **Reserved exclusively for Valo Pay 1**, even where generic configuration key names are used |
| Provider-generated IDs, bucket/project names and custom domains | Obtain fresh, valid identities from actual providers | **Not verified**; some are immutable or permanently unavailable after use/deletion; no resource is deleted to free a name |
| Shared company/owner identities such as Valo and `obeidpeter` | Leave unchanged; follow normal account access controls | Outside this product rename |

The existence of a generation-specific prefix does not establish separation. Compare actual resources and effective access before connecting the future application.

## Do not copy these from Valo Pay 1

- Production `.env` files, Replit Secrets, secret-manager exports, connection strings, signing keys, JWT keys, API credentials or webhook secrets.
- The Clerk project/instance, OAuth client, issuer, audiences, authorised parties, session settings or user/organisation mappings. Provision separate auth and test wrong-instance token rejection.
- `DATABASE_URL`, runtime/owner roles, database/schema bindings, KMS keys, encrypted records, migration state, RLS deployment state, storage bucket/prefix bindings or private export locations.
- Replit app/deployment IDs, deployment tokens, GitHub environment secrets, cloud IAM/OIDC trust, selected-repository permissions, infrastructure state files or state backends.
- Provider connection mappings, Paystack integration credentials, signed-ingress endpoints, event subscription IDs, notification credentials or sender authorisations.
- Worker/scheduler targets, queue/lease namespaces, incident-state files, monitor deployment targets, alert webhooks or idempotency/audit records.
- Existing browser cookies, local/session storage, request journals, drafts or legacy-state migration code. A future product must never adopt generation-1 authentication or pending operations just because it uses a familiar hostname.
- Issued invoices, signed agreements, commercial permissions, customer consents or audit evidence as default seed data. Reusing the brand name confers none of their authority.

Do not copy the existing production environment and then edit the visible product name. Start with empty configuration and explicitly approved, freshly provisioned bindings. The existing configuration may be consulted privately as a checklist of required *types* of settings, not as a source of values.

## Independent setup checklist

1. Create a separate repository only when requested. Confirm its new immutable repository ID differs from `1374783064`. Establish its own branch protections, environments and required checks.
2. Use fresh development/test databases and storage before any live environment. Record product, environment, server/database/schema, role, bucket/prefix and owning principal in the future project's own credential-free identity manifest.
3. Provision a separate auth instance and clients. Register only the actual future origins/callbacks. Verify tokens from generation 1 are rejected and that future tokens cannot access generation 1.
4. Provision separate deployment and service identities. Review GitHub OIDC using actual claims and immutable repository/owner identifiers where supported. An old-name match must not grant the new repository generation-1 deployment or secret access.
5. Assign distinct local ports, temporary directories, volumes, queues, cache namespaces, monitor state and browser-key prefixes per environment. Provider-assigned ports may remain generic but their deployment targets must be separate. Check running listeners before selecting local ports.
6. Configure fresh integrations and webhook secrets. Keep the old signed webhook endpoint routed to Valo Pay 1 until its provider migration is approved and verified. Use test accounts/sandboxes for verification; never send a live financial instruction to test isolation.
7. If reusing a retired hostname, review legacy cookies, browser storage, service workers, caches, cached redirects and incoming API/auth/provider traffic first. Do not load generation-1 transition helpers into the new application. Treat unexplained legacy requests as evidence to investigate, not data to adopt.
8. Run a disposable coexistence test with both identities and distinct synthetic targets. Exercise wrong product/environment/configuration, token, origin, cookie, queue, database, storage and deployment target cases. Verify rejection and absence of cross-product writes.
9. Recheck actual provider-name availability and constraints at setup time. Do not delete generation-1 resources to free names. Choose a different provider identifier when literal reuse is impossible while retaining the future application's intended code identity.

## Handover evidence required

Before saying that the future product is isolated, retain its own repository/app IDs, configuration review, permission/trust review, fresh resource attestations, negative-test results, backup/restore procedure and authorised deployment evidence. Document any deliberate shared company-level service and enforce separate credentials, access and data scopes within it.

The current migration can establish safeguards and a versioned identity for Valo Pay 1. It cannot prove the behaviour of an unbuilt future application or guarantee that no external clone, hidden integration or cached client still uses an old address. Those dependencies must be checked again when the future project is created.
