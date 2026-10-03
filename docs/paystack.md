# Paystack test adapter

Status: **adapter and durable test inbox tested offline; external account connection not verified**. No Paystack account or test key is available. The optional signed test ingress stays off until an operator configures a test key and a server-only workspace and lender mapping; [Signed test ingress](#signed-test-ingress) gives its address, configuration and answers. All debit instructions remain disabled. See [pilot operations controls](pilot-operations-controls.md) for fixtures, duplicate receipts and conflict quarantine.

## What is implemented

`artifacts/api-server/src/providers/paystack.ts` is a reusable, read-only test adapter. It accepts only `sk_test_` credentials, uses the fixed `https://api.paystack.co` origin, refuses redirects, bounds a request and response read to 10 seconds by default (15 seconds maximum), and limits response bodies to 256 KiB. Errors contain fixed messages, never provider payloads, authorisation headers, keys or nested transport errors.

- Connection check: authenticated `GET /transaction?perPage=1&page=1`; returns no transaction details.
- Transaction verification: requires an expected reference, positive integer kobo amount and NGN currency. A caller checking Direct Debit must additionally request the `direct_debit` channel. A successful HTTP request alone is not a successful payment. A test transaction with another reference, amount, currency or channel is a mismatch; an answer that cannot be read, including a currency that is not a code, is an invalid response.
- Mandate verification: checks an existing test mandate reference and returns only its state and an authorisation fingerprint. Raw authorisation codes never leave the adapter.
- Webhook parsing: verifies HMAC-SHA512 over the body's bytes (for a body sent with `Content-Encoding` gzip, deflate or br, the JSON bytes after decompression, not the compressed bytes), with constant-time digest comparison, before parsing JSON. Payment events must explicitly say `domain: test`; any declared non-test domain is refused. Mandate events may omit domain as in Paystack's documented payload and must still carry a signature made with the configured test key.
- Unknown-outcome recovery: verifies the original reference once. Timeouts, unavailable responses, rate limits, references not yet found, refused credentials and unreadable or live-mode answers remain unknown, and the next step is to verify the same reference once the cause is put right; only a mismatch asks for review. It never issues a debit, changes the reference or automatically reissues an instruction.

The read endpoints and response fields follow Paystack's [Transaction API](https://paystack.com/docs/api/transaction/). Signature handling follows its [webhook documentation](https://paystack.com/docs/payments/webhooks/).

## Direct Debit availability is not assumed

Paystack documents Direct Debit for Nigerian businesses, with authorisation creation and activation as separate states. Its Direct Debit documentation does not establish whether this account can use the feature in test mode, and the Test Payments guide does not provide a Direct Debit test recipe. A general test-key connection therefore reports `directDebitAvailability: unconfirmed`. Obtain Paystack confirmation or verify an existing, correctly identified test Direct Debit mandate/transaction before reporting that capability as observed. A card or ordinary bank test transaction is not Direct Debit evidence. Sources: [Direct Debit](https://paystack.com/docs/payments/direct-debit/), [Test Payments](https://paystack.com/docs/payments/test-payments/).

An observed test mandate verifies only that reference and state. It does not prove production activation, settlement, retry permissions, bank coverage or launch readiness.

## Operator verification

Supply `PAYSTACK_TEST_SECRET_KEY` securely in the operator process environment. Do not put the key in source, command arguments, screenshots, tickets or browser code. The checker does not edit environment files or application configuration.

From the repository root:

```sh
pnpm run check:paystack
```

To verify an existing test payment against its expected amount (in kobo), add:

```sh
pnpm run check:paystack --reference TEST_REFERENCE --amount-kobo 100000 --direct-debit
```

To inspect an existing test mandate without creating or charging one:

```sh
pnpm run check:paystack --mandate-reference TEST_MANDATE_REFERENCE
```

A `--` before the options is skipped, since pnpm passes one on to the script where npm would not. The checker prints only safe check results and states. It never prints the secret, transaction reference, amount, customer details, authorisation code or full provider response. `webhookIngestion` (`disabled`, `test_only` or `misconfigured`) and `mappedConnections` (a count, never the IDs) report the ingress setting of the process the check runs in, so run it with the API's environment to see what the API would do. Exit 0 means the requested read checks succeeded; it does not mark the Valo Pay 1 integration connected. Missing or rejected credentials and failed/mismatched checks exit 1.

## Signed test ingress

The API can save Paystack test events for a synthetic lender. The address is `POST /api/v1/providers/paystack/{connectionId}/events`, and it is off unless the API's environment has all three settings:

- `VALO_PAY_1_PAYSTACK_INGRESS=test` turns it on. Unset or any other value answers 503.
- `PAYSTACK_TEST_SECRET_KEY` is the `sk_test_` key of the Paystack test account. The running API reads it only to check signatures, never to call Paystack.
- `VALO_PAY_1_PAYSTACK_CONNECTIONS` maps each connection ID to one existing workspace and lender: `{"<connection ID>":{"workspaceId":"<workspace ID>","merchantId":"<lender ID>"}}`. A connection ID is 64 lower-case hexadecimal characters; make one with `openssl rand -hex 32`.

The mapped lender must be in sandbox or observation mode with its kill switch on. In the Paystack dashboard, under Settings, API Keys & Webhooks, register `https://<API host>/api/v1/providers/paystack/<connection ID>/events` as the test-mode webhook URL.

The signature authenticates a delivery, not the connection ID. The API checks the `x-paystack-signature` header, an HMAC-SHA512 under the test key of the body's exact bytes (the JSON as sent or, for a body sent with `Content-Encoding` gzip, deflate or br, the JSON bytes after decompression; another encoding is refused with 415), before it looks up the connection or locks, reads or decrypts anything. A forged or tampered delivery gets 401 and nothing else, whichever connection ID it names; only a verified event reaches the lender. Browser state, query strings and event fields never choose the lender.

The answers, in the order they are checked:

| Answer | When |
| --- | --- |
| 429 | More than 120 deliveries a minute from one client network (an IPv4 address, or an IPv6 /64). |
| 413 | The body is larger than 256 KiB. |
| 400 | The connection ID is malformed, or the body is not `application/json`. |
| 503 | The ingress is off, or the test key is missing or not an `sk_test_` key. |
| 401 | The signature is missing or does not match the body's bytes (decompressed first, when the body is compressed). Nothing was locked, read or saved. |
| 400 | The signed event is not JSON, is inconsistent, or comes from live mode. |
| 503 | The connection map is not valid. |
| 404 | No lender is mapped to the connection ID. |
| 429 | More than 60 signed deliveries a minute to this connection, whichever addresses they come from, so a replayed capture cannot evade the limit by rotating addresses. Paystack delivers the event again. |
| 404 | The mapped lender could not be locked, and a read without the lock does not find it in the mapped workspace: it was removed, or the mapping names the wrong lender or workspace. The answer says the mapped lender was not found; correct or remove the mapping, because delivering again will not help. |
| 503 | The mapped lender is in the mapped workspace but busy with another change. Paystack delivers the event again. |
| 403 | The lender was locked, and the mapping names another workspace or the lender is not in sandbox or observation mode with its kill switch on. |
| 200 | `{"accepted":true,"duplicate":false}` when the event is saved, and `duplicate: true` for a repeat delivery of an event already saved. |

Paystack's signature carries no time, so a captured delivery can be sent again at will. A repeat of a saved event is acknowledged without an audit entry, and nothing is written for it within a minute of its receipt's last write: the API process tallies such repeats and adds them to the receipt's delivery count at its next write, at most once a minute. A burst of replays therefore costs at most one write a minute per receipt and never lengthens the audit chain; a tally not yet written when the process stops is lost, so the count shown is a floor.

A verified event is saved in the mapped lender's inbox as a receipt, with the audit entry `paystack.test_event` (a repeat delivery adds none), and appears in the Paystack test connection panel on the Sources page. `charge.success` waits for independent verification, and evidence that conflicts with an earlier receipt or the lender's saved expectation is quarantined. The two `direct_debit.authorization.*` events record mandate evidence only, and any other signed event is recorded as ignored. None of them creates a payment, allocation, debit or mandate authority.

## Applying evidence later

`parsePaystackTestWebhook` authenticates and normalises a candidate; it does not apply money. The signed test ingress saves each verified event as a receipt under the lender lock, with its audit entry, and acknowledges it only after the transaction commits. A repeat delivery is recognised under the same lock by its connection, event identity and payload digest, so the key stays the same even if JSON formatting changes; a raw-body hash alone would not be enough. The receipts carry no database unique constraint: the lender lock is what keeps them single. `verifyPaymentWebhook` additionally fetches authoritative transaction status and checks the expected payment and provider transaction identity. The [saved-event verification command](paystack-test-verification.md) now applies that check to an eligible authenticated inbox receipt, using the existing collection attempt, customer, instalment, exact amount, currency and provider connection from trusted storage. It checks current authority again after HTTP and refuses a changed expectation. This workflow is implemented and covered by offline tests; it has not been observed against a real Paystack account or test credential.

Use `reconcilePaystackEvidence` with the previously persisted verified payment under the same lock/transaction. Identical verified evidence is a duplicate; a pending result cannot roll back a completed state; conflicting identity or terminal evidence requires review. A verified reversal is explicit evidence, not an inferred consequence of a timeout. `reconcilePaystackMandateEvidence` likewise prevents a late authorisation-created event from rolling an active mandate back to pending. The inbox applies both to each received event under the lender lock, against the receipts already saved for the same connection.

A successful independent test verification records a normalised observation and verification history. It creates no payment or allocation itself; ordinary reconciliation consumes the observation under the existing rules, and separate settlement evidence is still required. Only a real disagreement quarantines the event: another transaction, amount, currency or channel, or a failed or reversed payment. A refused key, an unreadable or live-mode answer, a timeout or an unavailable response leaves it awaiting verification with the outcome named in its history, rather than quarantining genuine evidence or authorising another debit, and the command prints and logs a distinct outcome for each case. An event an earlier build quarantined after such an answer can be checked again, but only a conclusive answer moves it, since those builds also reported a test transaction in another currency as unreadable. The operator command is explicit, not a scheduled poller.

Not yet introduced: a database-held binding of connections and keys (the mapping and key live in the server environment), mandate initialisation, charge dispatch, production credential support and an automatic retry dispatcher. Those require the remaining access, storage, tenant-binding and operational gates. Actual test-provider connectivity and Direct Debit product acceptance also remain unverified because no account or test key is configured.

## Offline verification

`artifacts/api-server/tests/paystack.test.ts` exercises the adapter with injected responses and signed synthetic bytes. It covers valid and mismatched payments (a test transaction in another currency is a mismatch), live-mode refusal, tampering, repeated and reordered deliveries, conflicting and stale evidence, timeout recovery using the original reference, which recovery outcomes ask for review, key/redirect restrictions, response limits and redacted failures. `artifacts/api-server/tests/source-ingress.test.ts` checks that the ingress opens no lender for a tampered, forged, unsigned or live-mode delivery or while it is off, and reads its settings from the environment; `artifacts/api-server/tests/api-security.test.ts` sends a forged delivery through the whole application with no database and gets 401. `scripts/operator-commands.test.mjs` runs the checker's command line: options after a `--`, a reference without its amount and a missing key, each refused before any request, with the reference never printed. No test calls Paystack or needs a key.

Documentation checked against the official pages on 18 September 2026. Provider behaviour observed with real test credentials must be recorded separately from these offline checks.

Repository implementation status reviewed on 26 September 2026. The saved-event workflow and its refusal/unknown-outcome tests are detailed in [saved-event verification](paystack-test-verification.md); the date above remains the date of the external documentation research, not a fresh provider confirmation.
