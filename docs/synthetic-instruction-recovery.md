# Synthetic instruction recovery

This executable foundation exercises durable commands, claims, independent pre-call intent and received outcomes without a payment provider. It accepts only synthetic instructions and two distinct disposable loopback PostgreSQL databases. There is no network adapter, live mode, web route or deployment switch. Current application financial actions remain synthetic and use their existing recovery controls.

The application database holds scoped commands, the queue, versioned authority and an inbox. Before the deterministic synthetic provider can accept an instruction, the worker commits its frozen identity to a different journal database. That journal also holds the synthetic provider's receipt. Losing the application database therefore cannot erase the last known dispatch intent. These databases share the test machine: this proves logical database-loss recovery, not independent infrastructure, separately administered production custody or regional disaster recovery.

## Behaviour under interruption

- A command binds workspace, lender, purpose, economic unit, request key, amount, currency, source digest and authority version. Money is an exact integer string in kobo. The same request key with changed content is refused.
- At most one active command owns an economic unit. A hundred workers contending for one command receive one current lease. Expired workers fail the fence check before synthetic acceptance.
- The independent intent is committed before provider acceptance. A journal failure stops acceptance. Reclaiming work whose intent already exists produces an unknown outcome, never an automatic second send.
- A lost answer after acceptance is resolved by reading the independently stored receipt. Inbox receipt and final command state commit together. Duplicate reconciliation preserves the first answer.
- Stopping authority prevents new work. Recording an existing outcome is still allowed because it sends nothing. Restoring a command stops its authority, including when a conflicting restored identity prevents recovery from completing.
- A restored application cannot enqueue a new command for an economic unit already present in the journal. Recovery reconstructs the original frozen command as unknown, then reads its receipt. Missing evidence keeps it unknown.
- Inputs are copied at entry so a caller cannot mutate scope or command identity during an asynchronous operation. Database calls have bounded connection, lock and statement waits.

This conservative first version permanently reserves an economic unit in the independent journal. A fresh attempt after a confirmed provider failure is deliberately unsupported. Implement explicit attempt generations, approved remaining-value calculation and provider-contract rules before offering that retry. No timeout is treated as a confirmed failure.

## Run the isolated rehearsal

Use a disposable local PostgreSQL server and a login allowed to create databases. Set `DATABASE_URL` to its disposable application-test database, and `VALO_PAY_1_RUN_INTEGRATION=1`. Then run:

```sh
pnpm run rehearse:instructions
```

The suite creates uniquely named `valopay_instruction_app_*` and `valopay_instruction_journal_*` databases, applies migrations011 and012 only with the explicit synthetic opt-in in isolated schemas, and removes only those databases on completion. It verifies duplicate keys, changed source, cross-scope reads, concurrent claims, expired workers, lost responses, unknown outcomes, stop/regrant and complete application-schema loss. It never connects to Paystack or performs a financial instruction. The same suite runs in the disposable PostgreSQL CI job.

`lib/db/migrations/011_synthetic_instruction_recovery.sql` and `lib/db/migrations/012_synthetic_independent_journal.sql` are deliberately absent from Drizzle's application schema. Neither build nor startup applies them. Do not apply them to a production database.

## Remaining production integration

This is a tested staging component, not a completed live dispatch service. Production work still includes transactional integration with authoritative financial storage; trusted identity and renewable corporate grants; least-privilege journal credentials and independently protected retention; provider-specific idempotency, status and reversal contracts; a stop-epoch protocol for calls already crossing the network; restored tombstone/erasure handling; and separately approved worker deployment. The synthetic provider briefly holds the authority lock across a second local database write to make stop races testable. A remote provider adapter must not copy that transaction pattern.

Append-only triggers protect ordinary writes in the rehearsal. They do not protect against a database owner who can disable triggers or drop a schema. Passing these tests does not activate live collection, payout, accounting, tax or credit decisions.
