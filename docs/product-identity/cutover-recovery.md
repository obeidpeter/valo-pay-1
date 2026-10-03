# Valo Pay 1 cutover and recovery

Prepared 3 October 2026. This runbook prepares an authorised operator action. It is not approval to publish, change a hostname, recreate a database, enable scheduled closes or start live payments. The identified Replit app is UUID `da98915e-a44c-4f6e-af96-a37614f3a217`; another app named Valo is outside scope.

## 1. Establish the release and recovery evidence

1. Record the reviewed candidate commit, clean migration branch, source tree and executed tests. Keep the baseline commit `5acfb5b1743afc9a30c6b5294de7c1b23088e79f` available. Preserve all unrelated work and local checkpoint history; never force-push, push all branches or upload the private Replit history.
2. Identify each actual web, worker, one-shot close job, monitor and operator-script environment. Record private resource identities: deployment/app ID, database host/database/schema/role, storage bucket/prefix/principal, auth instance/issuer, ingress configuration and optional KMS keys. The public map deliberately omits secret values. A matching display label is insufficient.
3. Capture a protected copy of the current deployment configuration, with access restricted to authorised operators. Check backup age, retention and a demonstrated restore into an isolated disposable target before any stateful change. A backup file that has never been restored is not recovery evidence.
4. Record current migration set, row/record counts, pending operations, idempotency receipts, current close state, export jobs/leases and cleanup tombstones. Use aggregate/private reports rather than publishing customer records. Record stored object metadata and retention rules without moving existing objects.
5. Review the pending cutover and rollback plan with the accountable owner. Keep the existing scheduler **off** unless a separate release decision changes it. The public deployment is a synthetic sandbox, but persistent records still need protection.

Stop dependent stateful work if the target or recovery path is ambiguous. Continue source validation and external inventory without altering state.

## 2. Verify the candidate in disposable environments

Run the repository's identity check, contract and documentation checks, typechecks, pure/golden tests, applicable PostgreSQL integration tests, browser tests and production build with the locked dependencies. Record exact failures and distinguish baseline/tool limitations from candidate regressions. Use existing package scripts; consult the candidate `package.json` for the renamed package identifiers.

Run the collision harness with a dummy future identity and distinct disposable targets. Negative cases must reject wrong product/environment/resource bindings, legacy/conflicting configuration and inappropriate auth origins. Exercise interrupted request recovery, returning-browser state, existing sample records, old exports and unchanged encrypted payloads. Do not use production secrets or a live payment instruction to run the harness.

Regenerate API clients and lockfiles with their normal project tools, then rerun the identity check. Verify an unchanged second rename/check pass does not append another `1`. A disposable harness is evidence about these checks, not evidence that the unbuilt future product has been tested.

## 3. Change GitHub identity and its consumers

**Current status:** the in-place rename to `obeidpeter/valo-pay-1` completed through authenticated GitHub settings on 3 October 2026. The migration and Replit checkouts now use the canonical remote; Replit's remote was independently read back with its app UUID, clean branch and publication checkpoint retained. Do not repeat the repository rename or create another repository. The remaining verification and consumer steps below still apply. Replit's display title **Valo Pay 1** and canonical [workspace address](https://replit.com/@obeidpeter1/Valo-Pay-1) are verified; the previous workspace address redirects there. Publishing and the live hostname have not changed. The user has authorised merging and deploying PR #84; preparation and verification remain in progress.

1. Refetch the source repository and confirm ID `1374783064`, owner `obeidpeter`, current name, visibility, default branch and latest commit. Resolve concurrent changes before modifying settings. The completed rename establishes that the provider accepted the new repository name; do not infer availability of other names from a 404 lookup.
2. Inventory branch/ruleset checks, environments, Pages, hosted actions, deployment hooks, installed apps, selected-repository secrets/package access, remote clones and external automation. Record anything the available API cannot reveal. The source CI currently has no deployment/OIDC permission; still inspect external trust providers.
3. **Completed:** the existing repository was renamed in place to `valo-pay-1`. Verify retained ID, history, visibility, ownership, collaborators and protection settings. Do not rename it again, delete and recreate it or create the future repository.
4. Verify clean Git remotes and source upload destinations use the versioned canonical repository. Confirm that the upload guard still excludes private history and secrets. In each clean clone, migrate the local Git key from `valopay.cleanGitAnchor` to `valo-pay-1.cleanGitAnchor` using the exact existing reviewed commit value, then check the guard; follow [GitHub syncing](../github-sync.md). The migration checkout is updated; the Replit checkout and other clones need their own anchor verification. Never manufacture a new anchor or rewrite history to make this pass. Reconcile remaining consumers against this same repository ID/path.
5. Inspect actual GitHub OIDC claims/trust if used. A newly created repository with the old name must not gain the old deployment authority. Prefer verified immutable repository/owner IDs and narrowly scoped ref/environment subjects where the provider supports them. Record provider-specific rules; do not broaden a trust policy to make a rename pass. Remove any temporary dual-name permission after verification.
6. Run the candidate CI on the renamed repository. Keep existing required-check names unless protection settings are deliberately updated together. Record the actual run URL and results. A successful redirect from the old URL does not verify consumers.

If a material deployment/trust consumer cannot be verified, leave the old repository name reserved and report the specific missing access. The canonical source can be renamed while release remains blocked; do not claim the old name is ready to reuse.

## 4. Prepare host settings without publishing

1. Verify the retained Replit UUID and the now-confirmed display title **Valo Pay 1**. A versioned label does not change the app's UUID, workspace slug, storage, database or deployed build.
2. Prepare all `VALO_PAY_1_*` settings required by the candidate and the identity manifest. Preserve actual provider/framework values through the secret manager. Do not mechanically substitute text in `DATABASE_URL`, signing secrets, object paths, client IDs or KMS resource names. Remove unsupported old owned keys only in the coordinated environment update, with the protected pre-cutover configuration available for recovery.
3. Privately compare expected resource bindings with the real target and its effective permissions. The current guard performs a read-only database identity check and adds no database marker or migration. Never derive and approve an expected identity from whichever unverified connection happens to be configured.
4. Prepare the same changes for workers, operator commands and the monitor. Keep their incident state and leases attached to generation 1. Do not attach the renamed code to an empty replacement database, bucket or volume.
5. Retain the current hostname unless a versioned address under the owner's control has been verified and separately approved. No new domain is purchased and no guessed hostname is treated as available.
6. If changing address, configure exact TLS/host bindings, canonical URLs, auth callbacks/origins and provider allowlists. Plan API and signed-webhook continuity explicitly; an HTTP browser redirect is not a webhook migration. Keep legacy ingress routed to generation 1 until verified retired.

### Exact configuration to prepare

`VALO_PAY_1_ENVIRONMENT` distinguishes **development**, **test**, **staging** and **production** deployments. A workspace's synthetic sandbox mode is a different concept; a public production build can still contain only synthetic data. A production process cannot evade resource verification by declaring development.

The same review is needed before running development services or database operator commands against a non-loopback database. Without a resource binding they accept only the exact database hostnames `localhost`, `127.0.0.1` and `[::1]`; a Replit development database with another hostname is refused even when `NODE_ENV=development`. Prepare that workspace's own reviewed development binding, with `VALO_PAY_1_ENVIRONMENT=development`, the retained actual app UUID and its separately verified development database, assigned HTTPS origins and service identities. Do not reuse production binding values or manufacture a provider identity to bypass the check. A deployed or production-mode process must still declare staging or production. Keep local unbound tests on separately provisioned disposable loopback databases.

Prepare `VALO_PAY_1_RESOURCE_BINDINGS` as private deployment configuration using the reviewed fields below. This public repository must not contain the actual private identifiers, key fingerprints or credential values. Derive fingerprints with the implementation's helpers, not by printing the underlying values.

| Field | Required evidence |
| --- | --- |
| `applicationId` | Exactly `valo-pay-1` |
| `environment` | Same approved environment as `VALO_PAY_1_ENVIRONMENT` |
| `deploymentId` | The retained Replit UUID, also matching the process's actual `REPL_ID` |
| `origins` | Exact HTTPS origins configured for this deployment; no broad wildcard or provider-derived fallback |
| `database` | `targetSha256`, `database`, `user`, `schema`; the target digest covers the parsed lower-case hostname, port, decoded database and user, excluding the password. The guard refuses URL target/search-path overrides and checks the connected server's identity |
| `storagePrivateDirectory` | Exact private object directory, or null when storage is deliberately unavailable |
| `authentication` | Reviewed `issuer`, `jwtPublicKeySha256`, `publishableKeySha256`, `secretKeySha256`, or whole-service null with no Clerk credentials; use the existing generation-1 instance only. An explicit `jwtPublicKeySha256: null` records an absent JWT public key only outside staff mode, preserving managed Clerk verification with the bound issuer and keys |
| `kms` | Reviewed `activeKey` and `previousKeys`, or null; no substitution inside provider-generated paths |
| `paystackTestKeySha256` | Reviewed test-key fingerprint, or null while unconfigured; live credentials remain refused |

No automatic resource-discovery result is approval of a binding. Review actual provider ownership/access separately. Any credential rotation requires updating its reviewed fingerprint through the same controlled procedure. Keep these settings consistent across the web process, background worker and close pass.

For an existing managed Clerk host without `CLERK_JWT_KEY`, retain authentication and explicitly bind `jwtPublicKeySha256` to null. The property cannot be omitted, the existing publishable and secret keys must still match, and introducing a JWT key requires its reviewed fingerprint instead of null. A bound fingerprint also requires the key to remain present. Staff mode requires both the public key and its fingerprint; it cannot use the null option. This preserves the existing non-staff verification path and does not permit another Clerk instance or disable sign-in.

The hosted browser build also requires `VITE_VALO_PAY_1_AUTH_MODE` (`clerk` or `disabled`) and `VITE_VALO_PAY_1_APP_ORIGIN` (the exact assigned HTTPS origin). For the existing managed Clerk deployment, keep `clerk` and supply the actual `VITE_CLERK_PUBLISHABLE_KEY` plus matching `VITE_VALO_PAY_1_CLERK_ISSUER_URL`; the issuer must match the host encoded in the provider's publishable key. An optional `VITE_CLERK_PROXY_URL` must be same-origin. The build no longer invents a Clerk instance from an arbitrary application hostname. Disabled mode rejects leftover provider configuration; it is not a shortcut for moving an existing signed-in deployment. All Vite settings require rebuilding the browser bundle, and the server's reviewed Clerk binding must identify the same instance.

### Returning-browser transition on the retained hostname

For a coordinated initial release at `https://valo-pay.replit.app`, set a reviewed deadline and configure both independent transitions. Neither is enabled by default:

- API: `VALO_PAY_1_LEGACY_COOKIE_ORIGIN` must be that exact retained HTTPS origin. `VALO_PAY_1_LEGACY_COOKIE_UNTIL` must be an explicit deadline no more than 30 days ahead. Within the window, only the old secure host-only sandbox cookie is eligible; the token and stored principal are preserved, the new environment-specific cookie is set and the old cookie expires. The old plain cookie is never trusted.
- Browser build: set `VITE_VALO_PAY_1_ENVIRONMENT` to the deployment environment; set `VITE_VALO_PAY_1_MIGRATE_LEGACY_BROWSER_STATE=true` and `VITE_VALO_PAY_1_LEGACY_BROWSER_STATE_UNTIL` to an explicit future ISO UTC deadline. Rebuild for changed Vite settings. On the exact retained origin, the transition copies the enumerated theme, starting guide, guide dismissals, saved queue views, selected lender, submission recovery references, presentation checklist and preparation-role keys. It does not copy arbitrary keys, auth tokens or request bodies. Each store records completion; existing versioned values win; old values remain for reviewed cleanup.
- Coordinate deadlines so browser recovery references and the sandbox principal remain associated with the same records. Verify both transitions on a disposable same-origin rehearsal before release, including refresh, quota/storage failure, prior partial copying and expired deadlines. A failed enabled copy must not expose the application as ready for new writes.
- No cross-origin transfer is implemented. If adopting a new hostname, plan sign-in, sandbox continuity and outstanding-request recovery explicitly. A redirect alone does not transfer browser state. If no transition is enabled, preferences/recovery state are not silently adopted; review existing uncertain requests before permitting users to repeat them.

After the transition period, disable both mechanisms and record verification. Do not delete legacy storage globally: reconcile pending work and obtain a reviewed cleanup decision. Continue to reserve the original origin for generation 1 until every other compatibility condition is satisfied.

## 5. Authorised production cutover

Proceed only after the reviewed target, backup, configuration, required checks and owner approval are recorded.

1. Record pending work and quiesce writes/jobs if required by the candidate's cookie/config/state transition. Keep one generation of worker ownership during transition. Do not requeue completed operations or clear leases/receipts to force progress.
2. The rename candidate adds no data migration. If a later separate change requires a forward migration, review it independently; applied migration files themselves stay unchanged. Verify the target immediately before any such execution and retain the result privately.
3. Publish the reviewed build and matching monitor/configuration together. Confirm all old instances have stopped before releasing writes whose interpretation or identity handling differs.
4. Verify the health build SHA, configured generation/environment, database/schema readiness and required resource identity checks. Observe an advancing worker heartbeat and cleanup state on the same instance; allow startup checks time to complete. Autoscale probes must be frequent enough to keep an instance running for meaningful observation.
5. Smoke-test the visible Valo Pay 1 branding, sign-in and sign-out, same-workspace return for an existing authorised visitor, invitation recovery, request recovery, sample import, reconciliation, exception handling, close review and evidence export. Use synthetic data. Check that old stored exports still download and new exports carry the new label.
6. Verify negative cases on an isolated deployment: a future-product token/origin/cookie/resource binding cannot access generation 1; wrong-target settings fail clearly without leaking values. Do not mutate live payment-provider instructions.
7. Check logs for identity mismatches, failed auth, duplicate jobs or webhook retries. Compare pre/post aggregate data and business identifiers. Record what was actually exercised; external auth/provider/alert delivery remains unverified if not exercised.

## 6. Recovery is state-aware

- **Before any cutover:** discard only the migration candidate's reversible settings changes if necessary. Restore canonical remotes/integration settings carefully by repository ID. Renaming the repository back is optional and does not restore every external consumer automatically.
- **After a source-only deployment with no state change:** prefer a forward fix. A rollback must restore the matching monitor, owned environment keys and browser transition behaviour together. A previous binary may no longer read the new cookie or browser-key namespace. Keep both configuration revisions in protected operator storage, not Git.
- **After browser migration:** follow the candidate's explicit compatibility path. Do not rotate tokens indiscriminately or erase request journals to make an older build start. If browser state moved, verify returning users and uncertain writes before permitting retries. The original preference/recovery keys remain, but a successful sandbox-cookie transition expires the old cookie. Unmodified PR #83 cannot recognise the new cookie and therefore does not preserve the visitor's existing session on rollback. No reverse-cookie bridge is implemented. Prefer a forward fix or a rollback candidate that retains the tested generation-specific cookie adapter.
- **After any new writes:** keep the authoritative database/storage and its transaction, idempotency and audit history. Pointing back to a stale snapshot loses those writes and can repeat completed work. Capture post-cutover writes, quiesce processing, and reconcile them under a reviewed recovery plan before any restore. Prefer restoring into a separate target and verifying it before switching.
- **If auth/hostname fails:** keep the old ingress bound to generation 1. Restore exact trusted callbacks/origins from the protected configuration; never widen trust to an arbitrary domain. Separate auth sessions from synthetic sandbox recovery.
- **If exports/workers fail:** retain queues, cleanup tombstones, leases, checksums and object locations. Fix the resource binding or credential permission; do not clear the queue or start a competing deployment against it.

No rollback should undo the two-person contract-date review, live-operation restrictions or existing security controls.

## 7. Close compatibility only after evidence

Revisit each row in the [compatibility register](naming-resource-map.md#compatibility-register). Record destination, owner, observed consumers, verification and removal condition. Retire a legacy alias only after clients, callbacks and provider traffic have moved; monitor failed requests during the chosen retirement period.

Before the old hostname is reused, explicitly assess host-only/domain cookies, storage namespaces, authenticated sessions, browser caches, cached redirects and any service workers. The new product must not read the legacy keys even if they remain on an old visitor's device. Do not copy existing browser-state migration logic into the future product.

Record final statuses in the migration report. Repository rename, host relabelling, secret preparation and a passing build are separate events; only an observed authorised release verifies a production cutover.
