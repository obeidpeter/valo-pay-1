# Pilot database isolation and recovery rehearsal

This is a **staging-only foundation**, not an enabled control on the deployed sandbox. By default the application uses its repository boundary and its existing credentials. No migration in this document runs during installation, build, startup or deployment.

## Restricted runtime isolation

The database isolation the application can run under is the optional restricted runtime described in `docs/pilot-operations-controls.md`: the migrations `lib/db/migrations/005_runtime_isolation.sql` and `lib/db/migrations/006_runtime_isolation_scope.sql`, applied in a separate `valopay_runtime_staging_<suffix>` schema, and `artifacts/api-server/src/lib/runtime-isolation.ts`, which checks the connection and the reviewed isolation set in every staff transaction and then binds it to the verified organisation and person. Each migration needs its own explicit `valopay.runtime_migration=staging-only` opt-in and refuses the `public` schema; 005 also refuses existing roles and policies, and 006 runs once, after 005. `docs/database-migrations.md` gives the commissioning commands, including how the runtime schema's tables are created before 005. Do not replace deployed database credentials with the runtime login.

005 creates a login with no superuser, database creation, role creation, replication or RLS-bypass capability, and a separate owner for the scope helpers that cannot log in. Row-level security is enabled and forced on the ten application tables, which neither role owns. A transaction sees only the workspace of its organisation and person, and only the lenders that person may use: every lender of the workspace for an administrator, otherwise those granted explicitly. Missing, partial or mismatched settings expose no rows and allow no writes. Column grants keep record, lender and workspace identifiers fixed, and the login cannot delete records, change a workspace row, alter policies, disable row security or give itself `BYPASSRLS`.

The scope settings are **scope controls, not authentication credentials**. A login that can issue arbitrary SQL can set custom PostgreSQL settings, so the server derives them from a verified Clerk session and a current membership, uses parameterised SQL and never lets a caller supply them. This does not claim to contain a compromised database account or arbitrary SQL execution. Domain validation and the audit chain remain necessary: a policy does not validate money, consent, record transitions or an audit chain.

## Run the automated isolation test

Use an ephemeral PostgreSQL 16 instance with administrative privileges and the ordinary Valo Pay schema already pushed. The GitHub database job is such an environment, and runs this test with the other database suites in `pnpm run test:integration`. Never use a production connection string.

```sh
# DATABASE_URL must already point to that disposable PostgreSQL instance.
VALOPAY_RUN_INTEGRATION=1 \
  scripts/node_modules/.bin/tsx artifacts/api-server/tests/runtime-isolation.integration.test.ts
```

The test copies the ten table definitions into a uniquely named `valopay_runtime_test_<random>` schema, inserts synthetic fixtures for two workspaces and applies 005 and 006 only there. It checks that each migration refuses to run without its opt-in and in the application's own schema, creating no role; the attributes of the roles 005 creates; forced row security and the reviewed policies, helpers and workspace guard, refusing eleven weakenings of them; that no scope, or only an organisation or only a person, sees and writes nothing; own-lender reads and writes, and that a rolled-back write leaves nothing; that writes to another workspace or an ungranted lender, changes to scope and identity columns, deletions, changes to row security or the login's own attributes and `row_security=off` are refused; that a reused connection keeps no scope; that an elevated connection is refused; and the application's repository, staff access and MFA under the restricted login. Its cleanup removes only the schema and roles it created, and it checks that the application's own tables are left as they were.

## The earlier four-table rehearsal

`lib/db/migrations/001_pilot_rls.sql` was the first form of this rehearsal: a `valopay_pilot_app` role with workspace and principal settings over four tables, used by a separate staging store and route. The restricted runtime replaces it. The staging store, route and their suite have been removed, and no procedure or test applies this migration any more; do not apply it.

## Before a pilot uses it

Staff access and the restricted runtime carry the transaction, access and scope integration this rehearsal was for: in staff mode verified memberships replace the sandbox personas, each staff transaction sets its scope with transaction-local `set_config(..., true)` after checking its connection, the background worker runs as a provisioned service member, and a transaction whose COMMIT PostgreSQL answers with ROLLBACK is reported as not saved. Before a pilot uses them:

1. Provision the restricted login, schema, service member, identity application and key access on the host. Never give that login table ownership, schema creation, membership of any role, superuser, `BYPASSRLS`, `REPLICATION` or a privilege migration 005 does not grant; the application refuses every one of these (`docs/pilot-operations-controls.md`).
2. Keep workspace provisioning and expiry as narrow administrative operations. Do not make the web process an administrator to get around a policy denial.
3. Retest the complete runtime under the restricted login: bootstrap, sign-in, invitations, permission changes, reconciliation, exports, idempotency, daily closes, recovery and connection-pool reuse. Record migration, rollback and recovery evidence before applying anything to a pilot database.

## Rehearse backup and restore before a pilot

Use a separate throwaway source database containing synthetic fixtures and a newly created empty restore target. This is a recovery exercise, not a rollback procedure for production. The administrator must verify both database names and connection hosts before running commands. Give the source a name such as `valopay_source_rehearsal_20260918` and the target `valopay_restore_rehearsal_20260918`; never restore over the source database.

The following commands assume the administrator has already created and verified those two disposable databases and configured their connection strings locally. Do not paste credentials into issues or evidence notes.

```sh
# SOURCE_REHEARSAL_URL: synthetic source, already populated and quiesced.
# EMPTY_RESTORE_REHEARSAL_URL: a different, verified, empty disposable target.
# Keep the dump in a protected local directory; do not commit it.
set -eu
: "${SOURCE_REHEARSAL_URL:?Set the verified synthetic rehearsal source URL}"
: "${EMPTY_RESTORE_REHEARSAL_URL:?Set the verified empty rehearsal target URL}"
source_name=$(psql --dbname="$SOURCE_REHEARSAL_URL" -X -v ON_ERROR_STOP=1 -Atc 'SELECT current_database()')
target_name=$(psql --dbname="$EMPTY_RESTORE_REHEARSAL_URL" -X -v ON_ERROR_STOP=1 -Atc 'SELECT current_database()')
case "$source_name" in valopay_source_rehearsal_*) ;; *) echo 'Refusing a source without the rehearsal name.' >&2; exit 1 ;; esac
case "$target_name" in valopay_restore_rehearsal_*) ;; *) echo 'Refusing a target without the rehearsal name.' >&2; exit 1 ;; esac
[ "$source_name" != "$target_name" ] || { echo 'Source and target must differ.' >&2; exit 1; }
target_objects=$(psql --dbname="$EMPTY_RESTORE_REHEARSAL_URL" -X -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f')")
[ "$target_objects" = 0 ] || { echo 'Restore target must be empty.' >&2; exit 1; }

pg_dump --dbname="$SOURCE_REHEARSAL_URL" --format=custom --no-owner \
  --file=valopay-synthetic-recovery.dump

pg_restore --dbname="$EMPTY_RESTORE_REHEARSAL_URL" --no-owner --no-acl \
  --exit-on-error --single-transaction valopay-synthetic-recovery.dump
```

After restoring, compare row counts and IDs for all eleven application/service tables; compare lender settings, outstanding amounts, allocations, daily-close snapshots, and idempotency responses. Include `valopay_export_cleanup` even when its source lenders and exports no longer exist: preserve storage identities, checksums, retry history, next-attempt times and lease state so deletion work can resume. The full dump above includes this service-only queue; do not add it to the restricted tenant runtime schema. Verify the complete audit chain with the application verifier. Run the existing repository and scheduler integration suites against the restored target, then perform a UI smoke test using synthetic data. Record elapsed backup and restore time, the snapshot timestamp, verification results, operator and evidence references. Agree acceptable recovery time and data loss with the pilot owner; do not treat an unmeasured target as a successful recovery claim.

This logical dump does not establish point-in-time recovery, restore external object storage or export files, recover encryption keys, or reproduce roles/grants (`--no-acl` intentionally excludes those for the rehearsal). A pilot needs separate tested procedures for each, with restricted backup access, retention, restore credentials, key recovery and a full disaster rehearsal. A successful database test alone does not satisfy the production security or restore readiness gates.
