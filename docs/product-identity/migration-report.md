# Valo Pay 1 identity migration

Prepared 3 October 2026. This is a staged migration record, not a production release certificate. The existing product becomes **Valo Pay 1**; a future independent product may use **Valo Pay** as its code identity. No future product is created by this change.

## Starting point and authority

- Repository observed: `obeidpeter/valo-pay`, GitHub repository ID `1374783064`, public, with administrator access available. Starting revision: `5acfb5b1743afc9a30c6b5294de7c1b23088e79f`, merged PR #83.
- The in-place GitHub rename completed through the authenticated repository settings on 3 October 2026. The canonical repository is now [obeidpeter/valo-pay-1](https://github.com/obeidpeter/valo-pay-1). The GitHub API confirmed the same repository ID `1374783064`, public visibility, permissions and retained history; the migration checkout's Git remote now uses the canonical path. No replacement repository was created. This completed source identity change does not establish that deployment consumers have migrated or that the old name is ready for reuse.
- Baseline: PR #83's eight post-merge CI jobs passed in [run 37038320715](https://github.com/obeidpeter/valo-pay-1/actions/runs/37038320715). This is baseline evidence, not evidence for the rename candidate.
- Replit application observed: UUID `da98915e-a44c-4f6e-af96-a37614f3a217`, display title `Valo Pay — Stage 1`, workspace address `https://replit.com/@obeidpeter1/Valo-Pay-Stage-1`.
- The public deployment at `https://valo-pay.replit.app` reported healthy PR #83 build `5acfb5b1 2026-10-03T06:22:11.222Z`. Its scheduler was **off**. This supersedes the older current-release claims in pre-migration documentation; those dated release records remain historical evidence.
- Replit's inspected development checkout was clean on `main` at publication checkpoint `e18441ca0111a1f3f05b3791c5efe82239c838ad`, with the PR #83 source. Its remote was updated and independently read back as `https://github.com/obeidpeter/valo-pay-1.git`; the app UUID, branch, source and publication remained unchanged. Its display title was then changed to **Valo Pay 1** through authenticated project settings and confirmed in the header/sidebar; the workspace slug and live hostname remain unchanged. Its development database reported `heliumdb`, role `postgres`, schema `public`; this is **not evidence of the production database binding**. Only secret names were inventoried. The managed Clerk integration is enabled, but its actual instance/origin configuration was not established.
- GitHub reported Pages disabled and no repository rulesets. The integration could not read branch protection (403), so required-check/protection parity is unverified. External app installations, deployment trust and automatic deployment behaviour remain unverified.
- The user authorises safe implementation and an in-place repository rename when its dependencies permit it. The request does **not** authorise a production cutover, destructive deletion, new billable services, ownership transfer or live financial transactions.

## Delivery status

The table is a release checklist. A prepared row must not be relabelled verified merely because a source edit exists.

| Area | Intended outcome | Status at preparation |
| --- | --- | --- |
| Application and source | Current UI, generated documents, owned symbols, package names and tooling use the versioned identity | Implementation and candidate verification in progress; do not infer deployment |
| Resource inventory | Public identities and source dependencies documented; secret values excluded | Prepared in [naming and resource map](naming-resource-map.md) |
| GitHub | Existing repository renamed in place to `obeidpeter/valo-pay-1`; ID, permissions, public visibility and history retained; local remote updated | Implemented and verified through authenticated UI and API; remaining integrations, protection verification and candidate CI are separate outstanding checks |
| Replit | Existing app retained exclusively for generation 1; labels and source links updated deliberately | Canonical Git remote and display title **Valo Pay 1** updated and verified; same UUID/clean branch/publication checkpoint; workspace slug/live hostname retained and no live cutover |
| Runtime configuration | Versioned owned keys and explicit expected resource bindings reject wrong destinations | Guard implemented; 88 backend identity/collision/session checks passed; no external secret binding or deployment verification claimed |
| Authentication and data | Existing identities, data, signed records and security controls remain intact; future project cannot reuse their bindings | Explicit cookie/browser transition implemented; records retained; private provider settings, backup and live connection validation remain required |
| Compatibility | Legacy repository, hostname and browser state have bounded treatment and owners | Register prepared; old repository name and hostname are not yet cleared for reuse |
| Documentation | Four handover documents and exact historical evidence register | Prepared; source implementation and final test evidence must be reconciled before release |
| Future generation | Independent repository, auth, database, storage and credentials | Setup rules prepared; no future product or external resources provisioned |

## Preserved deliberately

This work does not reset package/API versions, renumber migrations, rewrite Git history or edit completed audit/business records. Existing SQL relation names, RLS functions and settings, applied migration contents, encrypted-payload associated data, customer and transaction references, hashes, idempotency results, stored export locations and provider-generated IDs require compatibility. A branding substitution in any of those can make data unreadable or a completed operation appear new.

[Historical files](historical-files.json) lists individual evidence files with baseline digests and a reason for retaining each. Current maintained guidance may receive new names and commands. Exact quoted source-document titles and filenames remain attributable. A dated report's old source path describes its original revision, not the new active checkout.

Evidence hashes use the baseline Git object's UTF-8 content with CRLF normalised to LF, so a Windows checkout and Linux CI agree without normalising any other whitespace or content. Approved path/package mappings apply only after those historical contents are verified. New text in the release log remains subject to current-path checks.

The orange favicon contains no old wordmark. Shared/company-only `Valo` names and third-party names are outside the rename. The licensed **Valo Pack Sans** subset is not a product name to replace blindly; any embedded legacy producer metadata retained in that subset must be recorded separately from newly generated document branding. Existing downloaded manuals, issued PDFs and signed documents are not silently replaced.

## Verification record

Record each executed candidate command, revision, result and relevant limitation here before release. Keep detailed logs private when they contain host metadata; do not copy credentials or connection strings into this public repository.

| Check | Recorded evidence |
| --- | --- |
| Baseline CI | Eight PR #83 post-merge jobs passed; source and test configuration identified |
| Baseline public health | PR #83 healthy build at the original address; scheduler off |
| Candidate identity and collision checks | Backend and browser identity/collision tests pass; source identity check verifies 1,314 tracked files and exact compatibility contexts |
| Candidate types, pure/unit/integration/browser tests and production build | All workspace typechecks and production builds pass. Frontend: 1,103 initial passes; three cold-page timeouts passed a complete 66-test rerun without relaxed assertions. 46 desktop/mobile browser checks pass. Operational suites, monitor, documentation and source guards pass. PostgreSQL and Linux-only runtime checks require candidate CI; this Windows host has no /bin/bash |
| Canonical GitHub repository | In-place rename confirmed through authenticated UI and API; same ID, permissions, public visibility and history; canonical local remote; no deletion, recreation or ownership transfer |
| Replit source remote | Canonical versioned Git remote read back; app UUID and source/publication checkpoint retained; display title **Valo Pay 1** confirmed through authenticated UI; no new publication |
| Historical evidence validation | Installed-dependency checks passed: 2,559 documentation checks; traceability validates 251 requirements, 18 features, 14 gates and 32 symbol pointers; full tooling suite passed 54 checks, including the historical mapping regression cases |
| Focused backend verification | 88 identity/collision/session checks, 213 API security checks, 3,676 startup checks and API typecheck passed; full final release checks remain separate |
| Renamed-repository candidate Actions run | Not yet recorded |
| Private auth/database/storage/monitor bindings | Not verified by the public health response |
| Production cutover and post-cutover workflow rehearsal | Not executed by this documentation step |

## Implemented boundary to commission

The candidate requires an explicit `VALO_PAY_1_ENVIRONMENT` and a reviewed `VALO_PAY_1_RESOURCE_BINDINGS` document for a staging/production deployment. It compares the application/environment, retained Replit app ID, exact origins, database target, storage path, Clerk instance/key fingerprints, optional KMS resources and optional Paystack test credential fingerprint. A read-only database identity query must agree before the server or worker starts. Legacy `VALOPAY_` settings are rejected; no credential value is renamed or printed. This does not create a database marker or migrate data.

Storage reads, writes, metadata reads and deletion also check each stored job's object location against the reviewed private directory before contacting storage. An over-broad provider credential therefore does not permit an out-of-bound job path through these operations. Existing object names and metadata are preserved.

Browser keys use `valo-pay-1:<environment>:`. Legacy recovery references and preferences are copied only when explicitly enabled on the retained old origin, within a configured time window. New values win and originals remain for reviewed cleanup. An enabled copy failure stops the application before writes. The API's separate legacy sandbox-cookie transition is origin-bound and time-limited; it preserves the existing token/principal instead of creating a different visitor. Neither transition grants a future product access. See the exact operator settings below in the cutover runbook.

The browser's hosted authentication configuration now names an explicit app origin, auth mode and Clerk issuer, validated against the provider publishable key. It no longer derives an authentication project from an arbitrary hostname. The existing Clerk integration must retain its reviewed instance through cutover; disabling sign-in is not a completed identity migration.

## Remaining release decisions

Follow [cutover and recovery](cutover-recovery.md) rather than publishing a source-only rename. In particular, confirm the exact existing database and storage, obtain secure recovery evidence, configure every process's versioned keys together, audit deployment trust, and prepare the browser-state transition before any hostname is reassigned. A new display name does not provision a separate environment or establish ownership of a proposed hostname.

The future code identity is reserved by intention. The original repository name, public hostname and provider identities are **not declared safe to reuse** while their consumers and credentials remain unresolved. See [future setup](future-valo-pay.md).

The live export/cleanup workers were enabled and the close scheduler was off. This inspection does not provide a successful production backup/restore exercise, commissioned Paystack account, configured email delivery or independent monitoring schedule. None should be activated as an incidental consequence of this rename.
