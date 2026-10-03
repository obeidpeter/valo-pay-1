# Typed financial conservation rehearsal

This release adds an **opt-in staging projection** of receipts, obligations and confirmed allocations. The existing v1 records remain the source of truth. It is not a production ledger cutover, a settlement confirmation, or a provider instruction engine. Nothing automatically migrates a deployed database.

With staging enabled, the ordinary repository save also writes this projection inside the **same PostgreSQL transaction**. A refused typed write rolls back the v1 change and its audit effects as well. With staging off, current production behaviour and schema requirements are unchanged.

## What the database enforces

- Every parent and allocation carries workspace and lender identity. Allocation foreign keys also include payer and currency, preventing links across these boundaries.
- Money is PostgreSQL `numeric` **without a rounding scale**, with integral, non-negative and v1-safe upper-bound checks. Fractional input is rejected rather than rounded. JavaScript sums use `BigInt`; stored/read amounts remain decimal strings.
- Confirmed allocations plus returned money cannot exceed their receipt; confirmed allocations cannot exceed their obligation. Triggers protect direct SQL inserts and updates, including parent amount reductions. Updating the scope row serialises competing writes and forces stale repeatable-read writers to abort.
- An allocation source ID can appear once per scope. Legitimate splits may have distinct source IDs; their combined total must fit both parents.
- Source counters must agree with confirmed allocation rows before migration. Each projected row and lender snapshot has a source digest, and every typed field is read back for exact parity before commit.
- Every write verifies the installed schema fingerprint: removed or disabled triggers, altered constraints, indexes or functions fail closed. This detects accidental drift; it does not defend against a database owner who deliberately changes both the schema and its fingerprint.

## Historical states and the enforcement boundary

Proposed, rejected and superseded allocations do not consume capacity. Their histories remain in v1 records and still contribute to the lender source digest. Reversals are projected after their confirmed allocations have been superseded and the affected obligations reopened. An externally recorded refund contributes its actual returned amount (or the historical full-payment interpretation when an old refund has no amount). A legacy refunded receipt whose confirmed allocations still consume returned money is **refused for review**, never silently reinterpreted or repaired.

Closed or cancelled obligations retain their historical original amount; the projection does not erase prior confirmed allocations. Original amounts are not claims that money is settled or currently collectible. Unidentified receipts may exist, but cannot gain an allocation until the payer is identified. Every obligation and confirmed allocation needs a lender-local customer.

The stage accepts only a source whose environment is `sandbox`, at most **5,000 financial records per lender**; the operator source read additionally stops at 10,000 customer and financial records combined. It deliberately refuses larger migrations, requiring a separately designed batch/cutover process. It does not activate restricted runtime grants, copy production customer data, or claim independently durable audit/erasure recovery. A complete authoritative ledger cutover remains future work.

## Owner-run commissioning

Use an isolated disposable/staging PostgreSQL database and a migration-owner connection. Never place a connection string in a command argument or report. `DATABASE_URL` is supplied through the operator's protected environment. Start with the current application schema already installed. Set `VALO_PAY_1_FINANCIAL_PROJECTION=staging` only in this rehearsal environment.

1. Choose a new dedicated schema such as `valopay_finance_staging_rehearsal`. Initialise it explicitly:

   ```sh
   pnpm --filter @workspace/valo-pay-1-scripts exec tsx src/financial-projection.ts --schema valopay_finance_staging_rehearsal --initialise
   ```

   This runs migration `010_financial_projection_staging.sql`, whose schema-name and opt-in checks refuse an ordinary application schema. Initialisation refuses an existing schema; it never replaces unknown objects. If installation fails after schema creation, the empty schema may remain for the owner to inspect. Review the error before choosing another name or explicitly removing that isolated schema.

2. Select an existing synthetic workspace and its lender. Review a bounded backfill:

   ```sh
   pnpm --filter @workspace/valo-pay-1-scripts exec tsx src/financial-projection.ts --schema valopay_finance_staging_rehearsal --workspace WORKSPACE_ID --lender LENDER_ID
   ```

   The command verifies ownership, holds the lender lock, reads the financial snapshot, writes and compares the typed projection, then **rolls back**. Its summary gives counts and a digest, never source records or credentials. It changes no source data.

3. Repeat with `--apply` to commit only the verified staging projection. Set `VALO_PAY_1_FINANCIAL_PROJECTION_SCHEMA=valopay_finance_staging_rehearsal` alongside `VALO_PAY_1_FINANCIAL_PROJECTION=staging` on the staging application. Exercise the ordinary import, reconciliation, allocation, supersession and reversal workflows. Missing schema or failed parity prevents saving; it does not downgrade silently to unguarded writes.

4. Record the source digest, application commit, schema version, refused source issues and successful rehearsal evidence. This is staging evidence only. Production activation requires a separately reviewed bounded migration, authorisation model, capacity plan and cutover/rollback decision.

## Rollback and compatibility

Disable the staging setting and restart the staging application to stop dual writes. No v1 data conversion is required because the source format never changed. The isolated projection can remain for comparison; dropping it is a separate owner action after checking the exact schema and retaining any needed rehearsal evidence. Never drop application tables. A failed backfill or failed domain transaction rolls back all projection changes; tests also demonstrate a v1 settings change rolling back with its paired typed write.

## Verification

`financial-projection.test.ts` checks exact mapping, counters, source identity, currencies, refunds/reversals and bounds. `financial-projection.integration.test.ts` installs the guarded migration in a throwaway local schema, verifies parity and rollback, tests direct SQL negative cases and races 100 allocation writers against one receipt. These tests use synthetic data only and drop their own exact generated schema after completion.
