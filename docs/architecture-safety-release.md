# Architecture safety release

This release strengthens the existing synthetic application. It does not authorise real customer data, real debit instructions, bank transfers or production use. No provider account, test credential, paid infrastructure or external acceptance was available for this work.

## Exact money and controlled failure

The shared money helpers use integer/BigInt intermediates for multiplication, division and aggregation, then validate the result before returning a v1 JSON number. Rounding stays explicit: ordinary fee calculations floor; signed invoice VAT retains truncation toward zero. Invalid rates and final amounts outside the safe-integer minor-unit range are refused. Historical decimal discounts are converted without an intermediate floating-point money product.

Billing, reconciliation, close, reports, alerts and the Cash Desk use these helpers. The Credit Desk's sums, medians and basis-point ratios use exact BigInt arithmetic of its own, and its monthly averages use the shared division, rounded down for income and up for observed spending (the review of 26 September found them dividing in floating point; for safe whole amounts that division was already exact, so no assessment changes). Customer-history SQL aggregate strings are parsed exactly before conversion, including each separate currency. A money-range refusal returns a controlled 422 response with a request ID and the refusal's code, and logs only its code, without the amount. It cannot partially save an invoice or a close. It is a definitive refusal: a request with an Idempotency-Key is closed in the operations journal as refused, so it neither waits in Operations nor counts towards the pending limit, and its key cannot run again. Until the review of 26 September it left the entry pending, and a Cash Desk total beyond the range answered 400 on an action and 500 on `GET /v1/connected`. A generic programming RangeError still remains an internal error.

The public number contract is unchanged: this is not a bigint/decimal database migration and cannot represent unlimited money. Commercial basis-point inputs are bounded at 10,000. Existing transaction and repository checks remain necessary.

## Current authority and review recovery

Cash preparation and approval bind to the actual permission grant, its version, contents and validity window. Revoking and then recreating a permission does not restore an old approval. Accounting review and manifest generation recheck the current closed period and already-recorded receipts. A stale preparation or review must be refreshed and approved again.

Cash Desk exposes **Refresh accounting review** for this recovery. The person preparing the material can see the recovery action while a new Finance approval remains a separate step. A manifest is withheld when its underlying authority or content no longer matches. The desk withholds a saved VAT schedule or forecast the same way: it stays listed, to be prepared again under the current permission, without its figures, when the grants it was saved under are no longer the current ones or the evidence it was made from changed, and one saved without those bindings is treated alike. Connected cached answers are also checked against current access and source state before disclosure; a retry never reruns an already-completed action to recover permission. The person who sent a request retries it, a sandbox visitor or a signed-in staff member alike, in a synthetic sandbox lender: the journal and the request's fingerprint bind its key to them, so a colleague cannot receive their answer.

## Paystack test-event verification

An explicit operator command can independently verify a saved authenticated test event through the existing fixed-origin GET-only adapter. It compares the saved reference, provider connection, customer, instalment, amount, NGN currency and direct-debit channel; checks authority again after the HTTP request; and appends one observation. It sends no payment instruction and writes no Payment or allocation itself. Normal reconciliation consumes the observation, while separate settlement evidence is still required.

See [the operator procedure](paystack-test-verification.md) for the exact prerequisites, refusal rules and command. Offline tests use injected provider responses. Provider connectivity and access remain unverified.

## Source boundaries and concurrent writes

`pnpm run check:effect-boundaries` inspects domain modules and their transitive shared helpers. Domain decisions cannot acquire database, provider, network, filesystem or credential access through normal imports, and credit analytics cannot import cash or instruction entrypoints. Mutation fixtures check the guard. This is a source-maintenance check, not a security sandbox against malicious code or a compromised process.

The disposable PostgreSQL concurrency suite sends 100 competing allocation requests, 100 competing checkout/debit requests and 100 repeats of the same keyed request. It checks conservation of the available payment, a single durable active claim, one checkout/audit result on replay, rollback of invalid state and exact SQL aggregate overflow refusal. It runs with `pnpm run test:integration` under the existing disposable-database rules in `README.md`.

These are tests of the existing lender transaction and application controls. They do not prove provider-side exactly-once execution or protection against a privileged direct SQL writer.

## Workflow refactor · 29 September 2026

The refactor starts from PR #72's merged source, `41b988f`. It separates responsibilities within the existing TypeScript application:

- `artifacts/api-server/src/domain/final-state-integrity.ts` checks the loaded and proposed lender state, including immutable evidence, references and allocation limits. `valopay-store.ts` still supplies the trusted snapshot and calls the check inside its existing locked transaction before saving. The domain module receives no database client.
- `artifacts/api-server/src/domain/provider-event-integrity.ts` owns the pure rules for changes to saved provider evidence. The provider adapter still owns ingress and verification; moving the guard does not give domain code provider access.
- `artifacts/api-server/src/domain/reconciliation-exceptions.ts` owns exception currency, creation, condition clearing and outcome confirmation. Shared record values live in `reconciliation-values.ts`; reconciliation still controls the order of the financial workflow. Existing public imports remain available through explicit re-exports.
- `artifacts/valo-pay/src/lib/submission-attempt.ts` owns the request key, original input, prepared payload, pending/uncertain state and recovery marker lifecycle for both console mutation adapters. Pure error classification lives in `submission-outcomes.ts`. The adapters retain receipt validation, transport, React Query callbacks and their distinct completion policies.

For connected actions, the first prepared payload includes the original workspace revision; retries never substitute a refreshed revision. A withheld saved answer ends a connected request, while ordinary generated and pilot mutations retain their existing recovery policy. Scope changes detach the in-memory attempt, and any late answer settles only according to its original scope and adapter policy. Browser storage still holds only the opaque request identity, never the payload or fingerprint. A storage refusal still prevents transmission.

This is a source refactor, not a change to HTTP contracts, stored records, monetary calculations or permissions. It introduces no migration, dependency, environment setting or deployment step. Existing golden financial tests, mounted console recovery tests and PostgreSQL workflow tests exercise the same public entrypoints; the domain effect guard now also covers the extracted integrity checks and their dependencies.

## Validation and release boundary

The normal offline runner includes exact-money oracle/rounding tests, database-money parsing, authority revocation/regrant, Paystack verification and command refusal, source-boundary mutation tests and the affected console tests. Database-backed workflows check real persistence, concurrent writes, access isolation, journal behaviour and saved response contracts. All test figures are synthetic; timings are local measurements, not production guarantees.

This change needs no new database migration, credential, environment variable or enabled gate. Existing runtime-isolation and provider-ingress configuration remain opt-in. Rollback is the previous application build with the same schema; retain records and audit history and do not delete new verification evidence to make an earlier build appear current. Revalidate grants and preparations before any later live activation.

The larger architecture still needs separate implementation and acceptance: a typed financial ledger and database-level conservation constraints, a durable instruction outbox with provider unknown-outcome recovery, independently anchored audit evidence, deployed restricted-role/RLS verification, managed key custody, a full restore rehearsal, provider product/contract acceptance, cost evidence and the original production gates. This release does not mark those controls accepted.
