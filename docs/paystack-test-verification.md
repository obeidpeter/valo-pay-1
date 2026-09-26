# Independently verify a saved Paystack test event

This is an explicit operator workflow for synthetic workspaces. It is not a live payment integration, an instruction route or an automatic background poller. The application still refuses live credentials and live connected operations. No provider account or credential was available during implementation; all automated verification uses injected offline HTTP responses.

## Prerequisites

Use the existing operator-provisioned `VALOPAY_PAYSTACK_INGRESS=test` configuration, a valid `PAYSTACK_TEST_SECRET_KEY` in secret storage, and the existing `VALOPAY_PAYSTACK_CONNECTIONS` mapping. The opaque connection ID must identify the intended workspace and lender. Never supply a credential on the command line.

The lender must have `settings.environment=sandbox`, mode `observation` or `sandbox`, and its emergency stop **on**. If restricted runtime isolation is enabled, the configured service identity must also retain the appropriate membership and lender grant; the ordinary repository checks still apply.

The inbox must contain an authenticated `test`-mode payment event in `awaiting_verification`, or one an earlier build quarantined only because a check was inconclusive ([earlier quarantines](#earlier-quarantines)). A local fixture, mandate event or event quarantined for a disagreement cannot be promoted. There must be exactly one persisted collection attempt matching the reference, bound to an existing customer and that customer's instalment. Its amount and currency must match the event, its currency must explicitly be `NGN`, and its `data.providerConnection` must equal `paystack:test:<opaque connection ID>`. The verified channel must be `direct_debit`. Create/review that expectation through the existing controlled import or record workflow before verifying; the command does not create its own expectation or accept an amount/customer from CLI input.

## Run after access is available

```sh
pnpm --filter @workspace/scripts exec tsx ./src/verify-paystack-event.ts --connection-id <opaque-test-connection> --event-id <saved-test-event>
```

`--help` reads no provider or database. A configured run makes a fixed-origin `GET https://api.paystack.co/transaction/verify/<saved-reference>` only. Redirects are refused and the existing bounded response/timeout controls apply. There is no initialise, transfer, debit or retry-payment endpoint in this adapter.

The command first snapshots the signed event and collection expectation under the mapped lender transaction. It releases the transaction before HTTP. A second transaction checks the current mapping, credential, workspace mode, emergency stop, event identity and exact saved attempt contents again. A changed expectation or authority prevents application of the result. Concurrent attempts converge on the existing verified receipt; an incomplete restore that lost its observation is held for operator recovery review.

A matching successful response appends one normalised observation and an immutable verification entry to the event's existing append-only check history. Original signed evidence is unchanged. It creates **no Payment or allocation**. Run ordinary reconciliation to consume the observation: it may create/link the canonical payment and allocate it under the existing rules. The payment remains **unsettled** until separate settlement evidence exists. Reconciliation of the same observation does not create a second payment.

Only a real disagreement quarantines the event: Paystack's answer names another transaction, amount, currency or channel than the signed event and its saved expectation, or reports the payment failed or reversed. A refused key (401 or 403), an unreadable or live-mode answer, a pending payment, a reference Paystack has not returned, a timeout or another transport failure leaves the event awaiting verification, with a history entry naming the outcome (`check`), so the operator can put the key right or check again. None of them authorises a replacement debit. Ordinary replay cannot regress a verified event. At most 100 recorded checks are allowed per event before operator investigation.

## Outcomes

The command prints one JSON report, on standard output when the event is verified and on standard error otherwise, and exits with its status: 0 verified; 2 not verified yet, with nothing to put right first, so check the same event later; 1 a problem the operator must fix or review first. `result` names the outcome, `message` says what to do, and `eventStatus` and `observationCreated` are present when the run reached the event's verification. It also writes one `paystack.test_verification` log line naming the same outcome ([observability](observability.md)); it goes where the API's log goes, standard output or `LOG_FILE`. Neither the report nor the line ever names the key, the connection or event ID, the reference, the amount or the customer. A run that records a check in the event's history also adds the audit entry `paystack.test_verification`, which names the outcome, to the lender's audit trail.

| Result | Exit | Meaning |
| --- | --- | --- |
| `verified` | 0 | Paystack confirmed the signed event and its saved expectation. One observation waits for reconciliation (`observationCreated`), or the event was verified earlier and nothing was repeated. |
| `pending` | 2 | Paystack reports the payment as still pending. The event awaits verification. |
| `reference_not_found` | 2 | Paystack has not returned the reference. The event awaits verification. |
| `provider_unavailable` | 2 | Paystack timed out, could not be reached, limited the rate or failed. The event awaits verification. |
| `invalid_response` | 2 | Paystack's answer could not be read as a test transaction. The event awaits verification; investigate if this repeats. |
| `lender_unavailable` | 2 | The mapped lender was busy or could not be locked. Nothing was recorded. |
| `database_unavailable` | 2 | The database was unavailable or busy. Nothing was recorded. |
| `credentials_refused` | 1 | Paystack refused the test key. The event awaits verification: correct the key, then check again. |
| `live_mode` | 1 | Paystack answered with live-mode data, which is never accepted. The event awaits verification: check that the key belongs to the test account. |
| `mismatch` | 1 | Paystack's answer disagrees with the signed event. The event is quarantined with both results retained; no observation was created. |
| `evidence_changed` | 1 | The saved expectation or signed event changed during the check. Nothing was recorded; review it before checking again. |
| `configuration_changed` | 1 | The connection mapping or key changed during the check. Nothing was recorded. |
| `held_for_review` | 1 | The event is quarantined for a disagreement, at receipt or by an earlier check, and cannot be verified. |
| `not_a_test_payment` | 1 | The event is a local fixture or not a payment. Fixtures are never promoted. |
| `event_not_found` | 1 | The mapped lender has no such event for this connection. |
| `lender_not_eligible` | 1 | The lender is not a synthetic workspace in observation or sandbox mode with its emergency stop on, before or after the HTTP request. |
| `expectation_mismatch` | 1 | No single saved collection attempt matches the reference, or it differs from the signed event. |
| `check_limit_reached` | 1 | The event has 100 recorded checks. |
| `duplicate_observation` | 1 | Another observation already holds this transaction identity. |
| `observation_missing` | 1 | A verified event lost its observation, for example in an incomplete restore. It is held for recovery review and never recreated. |
| `connection_not_mapped` | 1 | `VALOPAY_PAYSTACK_CONNECTIONS` does not map the connection ID. |
| `connection_unavailable` | 1 | The mapping names a lender outside the mapped workspace. |
| `not_configured` | 1 | The ingress is off, the key is missing or not an `sk_test_` key, the connection map is not valid, or the database settings are missing. Nothing was checked. |
| `usage` | 1 | The arguments are missing or malformed; `--help` shows the form. |
| `failed` | 1 | Anything else. Its own words are neither printed nor logged, since they could quote a setting; check the configuration and the database, then check the same event again. |

## Earlier quarantines

A build before this change quarantined the event when Paystack refused the key or answered unreadably or in live mode, and a quarantined event could then never be verified or replayed. Such an event's last history entry is a check (`independent_transaction_check`) that quarantined it with an `unknown` outcome whose reason is `authentication`, `invalid_response` or `live_mode`. The command now accepts it as if it were awaiting verification: put the key right, then run the command for it again. The new check is appended after the earlier one, which stays in its history, and the event's status then follows the new check. Nothing changes such an event until the command runs for it, and replay from the Sources page still refuses it. An event quarantined for a disagreement stays held.

## Verification evidence and limits

`artifacts/api-server/tests/paystack-verification.test.ts` runs the actual adapter with injected HTTP, the actual domain workflow, repository final-state guards and normal reconciliation. It checks fixed-origin GET-only behaviour, no network while a lender transaction is held, fixture refusal, subject/route/money binding, fresh authority after HTTP, no-regression/deduplication, commit rollback, lost response and missing-observation restore holds. It checks that a 401, an unreadable body, a live-mode answer and a timeout leave the event awaiting verification with the outcome named in its history, and that the same event then verifies; that another amount, currency, channel or transaction, a failure and a reversal quarantine it; that an event an earlier build quarantined after an inconclusive check verifies again while one quarantined for a disagreement stays held; and each outcome's exit status. `artifacts/api-server/tests/paystack-verification.integration.test.ts` (a database-backed suite) runs the same check against PostgreSQL under the mapped lender's lock, with Paystack's answers faked in the process: a refused key leaves the event awaiting verification with the outcome in its history and the lender's audit trail, an earlier build's quarantine after a refused key verifies again through the store's guard, and a disagreement stays held without another lookup. `scripts/paystack-verification-command.test.mjs` executes the CLI entrypoint and checks help, and that each refusal before the network (arguments, credentials, mapping, database settings and an unreachable database) prints and logs its own outcome and exit status without the key or an identifier.

These tests do not establish provider connectivity, direct-debit product access, merchant ownership, bank route coverage, provider event delivery, production recovery or contractual authority. An actual account/test credential and independently reviewed provider acceptance evidence remain required. Real instruction routes, scheduled verification and live-data use stay disabled.
