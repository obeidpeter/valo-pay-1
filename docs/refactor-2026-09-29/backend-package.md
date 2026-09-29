# Connected capability boundaries and current permission validity

29 September 2026. Baseline `cd9d81c665ca08c29429e26bb3ed0d78863b5966`; implementation and scoped verification on the uncommitted `codex/comprehensive-refactor-2026-09-29` working tree. The programme release record supplies the eventual commit and combined verification. This package has not been deployed and enables no gate.

## Findings and decision

`domain/actions.ts` imported `resolveUnknownCheckout` from the entire `domain/connected.ts` coordinator. Its runtime graph therefore included Credit assessment and Cash/ERP/payroll implementations. Core needs to resolve an existing checkout outcome; it does not need those other capabilities. Separately, `connected-credit-service.ts::currentGrants` replaced a stored permission's `data.validFrom` with its creation time. A future effective start was consequently ignored during inference, disclosure, review and receipt replay. Its read-model permission predicate also omitted the positive safe-integer version check already present in the Permission Centre and Cash Desk.

The domain remains synchronous, pure and database-independent. Checkout transitions and outcome resolution move to `connected-checkout.ts`; consent grant/revoke logic to `connected-consents.ts`; revision-input selection and hashing to `connected-revision.ts`. `connected-context.ts` holds the existing scoped record, role and payment-state predicates. `connected.ts` composes the workspace and retains its existing public exports. Core imports the narrow checkout module. The effect-boundary guard now rejects direct or transitive dependencies from Core financial coordinators into the connected coordinator or Credit/Cash workflows, including hidden re-exports; type-only references remain permitted.

`connected-permission-validity.ts` shares only active status, effective time and positive safe numeric version validation. Each capability still separately binds tenant, entity, subject, purpose, account and saved authority. This helper is not a replacement permissive authorisation boolean. Credit now uses the stored effective start and this same validity rule. The existing grant selection, role separation, review policy and explicit synthetic restrictions remain unchanged.

Alternatives considered: retain the coordinator import and rely on review; duplicate the validity predicates; or introduce a generic service/permission framework. The chosen small modules remove demonstrated dependency and rule duplication without adding infrastructure or a speculative workflow abstraction. Reconsider this boundary only when an approved capability contract requires a new interaction; do not widen the source guard to make an unrelated import pass.

## Classification and compatibility

- Behaviour-preserving refactor: capability decomposition, existing export compatibility, checkout outcome interface and unchanged revision serialisation.
- Documented bug fix: honour future permission starts during Credit inference/review, withhold retained scores and saved receipts when current access is unavailable, and refuse malformed current versions consistently.
- New engineering control: transitive Core dependency enforcement and adversarial fixtures.

Requirement mapping: OB-CNS-04, CRD-02, CRD-12, CASH-08, API-03, UI-05 and NFR-OPS-05 for current permission and disclosure; CON-01, API-06, CRD-11, DEB-03/04/10 and A2A-06/07/12 for capability boundaries. See the programme traceability matrix for source sections and remaining acceptance; passing these scoped tests does not complete each full requirement.

Legacy grants without `validFrom` continue to use `createdAt`. Generated grants already carry positive numeric versions. Missing, zero, unsafe or non-numeric versions are not valid authority; the Credit read model now withholds them consistently with existing Cash/Permission Centre/inference controls. Previously coerced numeric strings are no longer accepted by the Credit service. No historical assessment or receipt is rewritten. An assessment made while valid remains immutable even when its current presentation is redacted.

No API field, endpoint, stored record format, schema migration, monetary rule, hash algorithm, provider call, dependency or host setting changes. Application rollback uses the previous build and the same stored records, but would restore the permission-start defect; prefer a corrected build. No financial or external action can be undone through application rollback.

## Fresh scoped verification

Environment: Windows, Node 24.19.0, installed repository dependencies. Fixtures are synthetic and local. These commands do not contact a provider or exercise PostgreSQL, hosted infrastructure, genuine MFA or independent review.

| Command, run from repository root | Expected and actual outcome |
| --- | --- |
| `node scripts/node_modules/tsx/dist/cli.mjs artifacts/api-server/tests/connected-credit.test.ts` before implementation, after adding the regression | Exit 1: the new future-start assertion expected `blocked`, but baseline returned `review_pending`. The preceding 65 scenarios passed. This records the defect, not desired behaviour. |
| Same command after implementation | Exit 0; 72 scenarios passed, including future-start inference refusal, retained-score redaction, review refusal and invalid current versions. |
| `node scripts/node_modules/tsx/dist/cli.mjs artifacts/api-server/tests/connected-authority.test.ts` | Exit 0; 13 grant-binding, revocation, stale-state, retained-outcome and recovery checks passed. |
| `node scripts/node_modules/tsx/dist/cli.mjs artifacts/api-server/tests/connected-replay.test.ts` | Exit 0; 58 checks passed, including refusal of an original scored receipt after the permission start changes, without mutating the receipt. |
| `node scripts/node_modules/tsx/dist/cli.mjs artifacts/api-server/tests/connected-workflows.test.ts` | Exit 0; 29 synthetic workflow, authority, race and final-state checks passed. This command is not a real PostgreSQL race test. |
| `node scripts/node_modules/tsx/dist/cli.mjs artifacts/api-server/tests/connected-cash-service.test.ts` | Exit 0; 58 lifecycle, permission, independent-persona approval and export checks passed. |
| `node scripts/node_modules/tsx/dist/cli.mjs artifacts/api-server/tests/connected-cash.test.ts` | Exit 0; 60 focused synthetic domain checks passed. |
| `node scripts/check-effect-boundaries.mjs` | Exit 0; 88 domain/helper modules checked at this working-tree point, with no forbidden effects or dependency cycles. |
| `node scripts/check-effect-boundaries.test.mjs` | Exit 0; existing and added direct/transitive Core, hidden re-export, allowed checkout, allowed pure validity and type-only fixtures passed. |

A scoped API typecheck attempted while the parallel billing package was in progress reported only that package's new shared commercial fields as unresolved. It was not recorded as passing; the programme's rebuilt shared libraries and final combined typecheck are authoritative.

## Comparable structural evidence

The same esbuild runtime import measurement was run before and after: entry `artifacts/api-server/src/domain/actions.ts`, `bundle: true`, `write: false`, `platform: "node"`, `packages: "external"`, `metafile: true`. Count `Object.keys(result.metafile.inputs)`; list paths containing `/connected`.

Before: 38 local modules; the connected subset was `connected.ts`, `connected-credit.ts`, `connected-credit-service.ts`, `connected-cash.ts` and `connected-cash-service.ts`. After: 36 local modules; the connected subset is only `connected-context.ts` and `connected-checkout.ts`. The after measurement also includes the parallel package's new `commercial-terms.ts`. The meaningful change is removal of unrelated capability dependencies, not a latency, memory or operating-cost claim.

A read-only TypeScript AST-printer comparison against `git show HEAD:artifacts/api-server/src/domain/connected.ts` verified the complete bodies of 15 functions unchanged after extraction: `reject`, `payable`, `owned`, `allow`, `intentOpen`, `externalScheduled`, `connectedRevision`, `addConsent`, `recordEvent`, `recordCheckoutReceipt`, `resolveUnknownCheckout`, `paymentAction`, `runConnectedAction`, `runConnectedActionWithNote` and `connectedView`. The intentional validity changes and coordinator delegation are outside that equivalence claim and are tested above.

The source guard is a maintenance control, not a process security sandbox. Production role/RLS commissioning, provider acceptance, external effect recovery, independently controlled custody and independent operator acceptance remain separate requirements. All live gates and the observation boundary remain unchanged.

## Independent billing package review and HTTP/database regression

The separate approved billing package was reviewed read-only across `domain/commercial-terms.ts`, `domain/billing.ts`, `validation.ts`, the shared commercial schema and billing golden tests. The source decision and commercial terms changes belong to that package; the compatibility statements above describe the connected package only. A follow-up review found malformed legacy review attribution could throw a `TypeError` while computing a billing report: stored commercial JSON is read without parsing fields that were formerly unknown passthrough data. Current API writes reject the malformed input, so this finding concerns persisted-data compatibility rather than a current write-path bypass. The package owner corrected the runtime review-shape checks and prevented ordinary commercial invoices from copying irrelevant review evidence; the reviewer added the regression and rechecked the fix.

`node scripts/node_modules/tsx/dist/cli.mjs artifacts/api-server/tests/billing-golden.test.ts` first reproduced the defect (exit 1): `TypeError: review.reviewedBy?.trim is not a function` in `designPartnerDiscount`, reached through `buildReports` by a numeric persisted reviewer. After the correction the same command exited 0 with 174 checks. The additional cases cover numeric reviewer, numeric/array timestamp, array/scalar review, malformed review dates/reference and malformed contract dates/reference. Each returns unavailable pricing and a documented invoice refusal without changing historical state. Ordinary non-design-partner pricing remains full price and excludes the irrelevant malformed review from its new invoice. Final review found no further actionable defect in the changed backend paths.

Added a regression journey to the existing `artifacts/api-server/tests/api-contract.integration.test.ts`. It uses a separate synthetic sandbox, the actual HTTP routes, generated response contracts and the disposable local PostgreSQL store. It verifies:

- An invoice with unreviewed contract dates is refused with HTTP 409 and does not create or change domain record counts.
- Read-only users cannot review terms; forged review attribution is refused. The service stamps the Finance identity and review time.
- A PATCH that omits commercial data preserves the stored review, and a stale `expectedUpdatedAt` is refused.
- Explicit, reviewed contract dates price the first invoice at 50%. Amending the contract prices the next invoice at its new full rate.
- A wrong-match correction on the previously billed payment reverses its original 50% usage charge. The complete earlier invoice remains unchanged after both contract amendment and correction.

Execution on the same uncommitted working tree, after the billing implementation: set `VALOPAY_RUN_INTEGRATION=1` and `DATABASE_URL` to the disposable local PostgreSQL database `valopay_refactor_20260929`, then run `node scripts/node_modules/tsx/dist/cli.mjs artifacts/api-server/tests/api-contract.integration.test.ts` from the repository root. Exit 0. Output:

```text
Billing HTTP/PostgreSQL contract checks passed: service review attribution, omitted PATCH fields, role/version refusals, atomic invoice refusal, amended future pricing and immutable historical-rate corrections.
API contract checks passed against PostgreSQL: 80 operations answered as documented, the sandbox directory's lenders, one 400 for a missing merchantId, offset date-times, optional and required keys, an invalid answer that saves nothing, 24 keyed writes gone (410) after a retention run, an export whose file expired, the export queue's and the new-sandbox limit's Retry-After, replayed receipts that never claim nothing was saved and a stored retention run's timestamps.
```

This is scoped integration evidence with synthetic data and local identity/storage substitutes. It does not prove hosted deployment, authentic identity-provider enforcement, restricted-runtime commissioning, genuine commercial review or independent acceptance. The programme's combined final verification remains authoritative for the complete release.
