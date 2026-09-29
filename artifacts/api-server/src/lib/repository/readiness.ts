/** Internal repository readiness. Import through valopay-store; external access is rejected by the boundary check. */
import * as tables from "@workspace/db/schema";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  runtimeIsolationConfiguration,
  runtimeIsolationEnabled,
} from "../runtime-isolation";
import { pool, Pool } from "@workspace/db";

export type SchemaCatalogue = {
  columns: Array<{ table: string; column: string }>;
  indexes: Array<{
    table: string;
    schema: string;
    name: string;
    unique: boolean;
    valid: boolean;
    definition: string;
  }>;
  checks: Array<{ table: string; definition: string }>;
};

/**
 * The readiness check's findings: whether the database answered, and whether
 * it holds everything this build needs. `incomplete` means a table or column
 * the queries use is missing, so requests would fail, or an integrity guard
 * is, so the database would accept what the application relies on it to
 * refuse, or a superseded guard remains, so it would refuse what the
 * application relies on it to accept; `indexes_missing` means only a read
 * index a migration adds is missing, so some reads are slower but every
 * request still works. `missing` names each, for the log.
 */
export interface DatabaseReadiness {
  status: "ok" | "failed";
  latencyMs: number;
  error?: string;
  /** The schema checked, when one is named (the isolated runtime schema); absent when the connection's search path decides. */
  searched?: string;
  schema: {
    status: "ok" | "indexes_missing" | "incomplete" | "unchecked";
    missing: string[];
  };
}

export function createReadinessRepository() {
  /** Where a table comes from: the base schema, or the migration in lib/db/migrations that adds it. */
  const tableMigrations: Record<string, string> = {
    valopay_operations: "003_pilot_workflow.sql",
    valopay_teams: "003_pilot_workflow.sql",
    valopay_staff_memberships: "003_pilot_workflow.sql",
    valopay_staff_invitations: "003_pilot_workflow.sql",
    valopay_staff_events: "003_pilot_workflow.sql",
    valopay_staff_lender_access: "004_staff_lender_access.sql",
    valopay_export_cleanup: "013_export_cleanup.sql",
  };
  const schemaSource = (table: string) =>
    tableMigrations[table]
      ? `apply lib/db/migrations/${tableMigrations[table]}`
      : "create it from the Drizzle schema in lib/db";
  /**
   * Where a missing column comes from: no migration adds one, since each creates its tables whole (CREATE TABLE IF NOT
   * EXISTS) and applying it again leaves a table that exists as it is, so a column is added as the Drizzle schema declares it.
   */
  const columnSource = "add it from the Drizzle schema in lib/db";
  /** Every table this build uses, with every column the Drizzle schema in lib/db gives it. */
  const requiredTables = [
    tables.workspaces,
    tables.merchants,
    tables.records,
    tables.idempotency,
    tables.operations,
    tables.teams,
    tables.staffMemberships,
    tables.staffInvitations,
    tables.staffEvents,
    tables.staffLenderAccess,
    tables.exportCleanup,
  ].map((table) => {
    const config = getTableConfig(table);
    return {
      name: config.name,
      columns: config.columns.map((column) => column.name),
    };
  });
  /**
   * The integrity guards the Drizzle schema in lib/db declares: every unique
   * index (those behind primary keys and unique constraints included) and every
   * check constraint, as PostgreSQL 16 writes their definitions. Without one the
   * database accepts what the application relies on it to refuse: a second
   * workspace for one principal, two attempts in flight for one instalment, a
   * provider event recorded twice, money outside the safe range. So a missing
   * guard makes the schema incomplete, not slower. Compared by definition, not
   * by name, like the indexes below.
   */
  const integrityGuards = [
    {
      type: "unique index",
      name: "valopay_workspaces_pkey",
      table: "valopay_workspaces",
      definition: "USING btree (id)",
    },
    {
      type: "unique index",
      name: "valopay_workspaces_principal_hash_unique",
      table: "valopay_workspaces",
      definition: "USING btree (principal_hash)",
    },
    {
      type: "unique index",
      name: "valopay_merchants_pkey",
      table: "valopay_merchants",
      definition: "USING btree (id)",
    },
    {
      type: "unique index",
      name: "valopay_records_pkey",
      table: "valopay_records",
      definition: "USING btree (id)",
    },
    {
      type: "unique index",
      name: "valopay_unique_due_reference",
      table: "valopay_records",
      definition:
        "USING btree (merchant_id, reference) WHERE ((kind = 'due-items'::text) AND (reference <> ''::text))",
    },
    {
      type: "unique index",
      name: "valopay_unique_customer_reference",
      table: "valopay_records",
      definition:
        "USING btree (merchant_id, reference) WHERE ((kind = 'customers'::text) AND (reference <> ''::text))",
    },
    {
      type: "unique index",
      name: "valopay_unique_provider_event",
      table: "valopay_records",
      definition:
        "USING btree (merchant_id, translate(COALESCE(NULLIF(btrim((data ->> 'providerConnection'::text)), ''::text), NULLIF(btrim((data ->> 'provider'::text)), ''::text), ''::text), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'::text, 'abcdefghijklmnopqrstuvwxyz'::text), COALESCE((data ->> 'source'::text), ''::text), ((data ->> 'eventId'::text))) WHERE ((kind = 'observations'::text) AND ((data ->> 'eventId'::text) IS NOT NULL))",
    },
    {
      type: "unique index",
      name: "valopay_one_inflight",
      table: "valopay_records",
      definition:
        "USING btree (merchant_id, ((data ->> 'dueItemId'::text))) WHERE ((kind = 'attempts'::text) AND (status = ANY (ARRAY['scheduled'::text, 'sent'::text, 'unknown'::text])))",
    },
    {
      type: "check",
      name: "valopay_money_integer",
      table: "valopay_records",
      definition:
        "CHECK (((amount_kobo >= 0) AND (amount_kobo <= '9007199254740991'::bigint)))",
    },
    {
      type: "check",
      name: "valopay_ticket_floor",
      table: "valopay_records",
      definition:
        "CHECK (((kind <> 'due-items'::text) OR (amount_kobo >= 500000)))",
    },
    {
      type: "unique index",
      name: "valopay_idempotency_pkey",
      table: "valopay_idempotency",
      definition: "USING btree (id)",
    },
    {
      type: "unique index",
      name: "valopay_idempotency_tenant_key",
      table: "valopay_idempotency",
      definition: "USING btree (merchant_id, id)",
    },
    {
      type: "unique index",
      name: "valopay_operations_pkey",
      table: "valopay_operations",
      definition: "USING btree (id)",
    },
    {
      type: "check",
      name: "valopay_operation_status",
      table: "valopay_operations",
      definition:
        "CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'cancelled'::text])))",
    },
    {
      type: "unique index",
      name: "valopay_teams_pkey",
      table: "valopay_teams",
      definition: "USING btree (workspace_id)",
    },
    {
      type: "unique index",
      name: "valopay_teams_organization_id_unique",
      table: "valopay_teams",
      definition: "USING btree (organization_id)",
    },
    {
      type: "unique index",
      name: "valopay_staff_memberships_pkey",
      table: "valopay_staff_memberships",
      definition: "USING btree (id)",
    },
    {
      type: "unique index",
      name: "valopay_staff_workspace_user",
      table: "valopay_staff_memberships",
      definition: "USING btree (workspace_id, user_id)",
    },
    {
      type: "check",
      name: "valopay_staff_status",
      table: "valopay_staff_memberships",
      definition:
        "CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'revoked'::text])))",
    },
    {
      type: "check",
      name: "valopay_staff_role",
      table: "valopay_staff_memberships",
      definition:
        "CHECK ((role = ANY (ARRAY['Admin'::text, 'Operations'::text, 'Finance'::text, 'Compliance reviewer'::text, 'Read-only'::text])))",
    },
    {
      type: "unique index",
      name: "valopay_staff_invitations_pkey",
      table: "valopay_staff_invitations",
      definition: "USING btree (id)",
    },
    {
      type: "unique index",
      name: "valopay_staff_invitations_token_hash_unique",
      table: "valopay_staff_invitations",
      definition: "USING btree (token_hash)",
    },
    {
      type: "check",
      name: "valopay_invitation_status",
      table: "valopay_staff_invitations",
      definition:
        "CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text])))",
    },
    {
      type: "unique index",
      name: "valopay_staff_events_pkey",
      table: "valopay_staff_events",
      definition: "USING btree (id)",
    },
    {
      type: "unique index",
      name: "valopay_staff_lender_access_membership_id_merchant_id_pk",
      table: "valopay_staff_lender_access",
      definition: "USING btree (membership_id, merchant_id)",
    },
    {
      type: "unique index",
      name: "valopay_export_cleanup_pkey",
      table: "valopay_export_cleanup",
      definition: "USING btree (id)",
    },
    {
      type: "check",
      name: "valopay_export_cleanup_attempts",
      table: "valopay_export_cleanup",
      definition: "CHECK ((attempts >= 0))",
    },
  ] as const;
  /**
   * The migration in lib/db/migrations that builds an integrity guard again
   * when applied: 009 its two, and 003 the membership index it creates on its
   * own. Every other guard comes with its table, from the Drizzle schema or
   * inside the CREATE TABLE IF NOT EXISTS of 003 or 004, which leaves a table
   * that exists as it is, so it is restored by hand (docs/database-migrations.md).
   */
  const guardMigrations: Partial<
    Record<(typeof integrityGuards)[number]["name"], string>
  > = {
    valopay_unique_customer_reference: "009_record_identity_guards.sql",
    valopay_unique_provider_event: "009_record_identity_guards.sql",
    valopay_staff_workspace_user: "003_pilot_workflow.sql",
  };
  const guardSource = (name: (typeof integrityGuards)[number]["name"]) =>
    guardMigrations[name]
      ? `apply lib/db/migrations/${guardMigrations[name]}`
      : "restore it as docs/database-migrations.md describes";
  /**
   * Unique indexes this build must not find, compared by definition: the
   * provider event guard before migration 009, one event ID per lender and
   * source whatever the provider, which refuses a second provider's delivery.
   * 009 drops it under any name; tables copied with LIKE ... INCLUDING ALL, as
   * an isolated runtime schema's are, hold it under a generated one.
   */
  const supersededGuards = [
    {
      name: "valopay_unique_observation",
      table: "valopay_records",
      definition:
        "USING btree (merchant_id, ((data ->> 'source'::text)), ((data ->> 'eventId'::text))) WHERE ((kind = 'observations'::text) AND ((data ->> 'eventId'::text) IS NOT NULL))",
      description:
        "the earlier provider event guard, which refuses one event ID from two providers",
      migration: "009_record_identity_guards.sql",
    },
  ] as const;
  /**
   * The read indexes later migrations add, as PostgreSQL 16 writes their
   * definitions after the name and table. They are compared by definition, not
   * by name: an isolated runtime schema holds copies of the tables whose indexes
   * carry generated names.
   */
  const requiredIndexes = [
    {
      name: "valopay_export_cleanup_due",
      table: "valopay_export_cleanup",
      definition: "USING btree (next_attempt_at, id)",
      migration: "013_export_cleanup.sql",
    },
    {
      name: "valopay_records_lender_kind_page",
      table: "valopay_records",
      definition: "USING btree (merchant_id, kind, created_at, id)",
      migration: "002_record_list_indexes.sql",
    },
    {
      name: "valopay_records_lender_kind_status_page",
      table: "valopay_records",
      definition: "USING btree (merchant_id, kind, status, created_at, id)",
      migration: "002_record_list_indexes.sql",
    },
    {
      name: "valopay_records_lender_customer",
      table: "valopay_records",
      definition: "USING btree (merchant_id, customer_id, created_at, id)",
      migration: "002_record_list_indexes.sql",
    },
    {
      name: "valopay_records_lender_kind_updated",
      table: "valopay_records",
      definition: "USING btree (merchant_id, kind, updated_at)",
      migration: "002_record_list_indexes.sql",
    },
    {
      name: "valopay_staff_lender_access_lender",
      table: "valopay_staff_lender_access",
      definition: "USING btree (merchant_id, membership_id)",
      migration: "004_staff_lender_access.sql",
    },
    {
      name: "valopay_operations_pending",
      table: "valopay_operations",
      definition:
        "USING btree (merchant_id, owner) WHERE (status = 'pending'::text)",
      migration: "007_journal_and_lender_indexes.sql",
    },
    {
      name: "valopay_merchants_workspace",
      table: "valopay_merchants",
      definition: "USING btree (workspace_id, id)",
      migration: "007_journal_and_lender_indexes.sql",
    },
    {
      name: "valopay_records_export_queue",
      table: "valopay_records",
      definition:
        "USING btree (created_at, id) WHERE ((kind = 'exports'::text) AND (status = ANY (ARRAY['queued'::text, 'running'::text])))",
      migration: "008_export_queue_index_and_foreign_key_names.sql",
    },
  ] as const;
  /**
   * The columns, ready indexes and validated check constraints of the
   * application's tables, in one catalogue read: in the schema named, or else the
   * tables the connection's unqualified queries reach along its search path
   * (pg_table_is_visible), which is not always the first schema on it. A check
   * added NOT VALID is left out: it has not checked the rows already stored. An
   * index that is ready but not valid, as an interrupted concurrent build or drop
   * leaves it, is kept on every write, so a unique one still refuses duplicates,
   * but it may not cover every row: it counts as a guard or read index only once
   * valid, and as a superseded guard while ready.
   */
  const schemaCatalogue = `SELECT
  (SELECT coalesce(json_agg(json_build_object('table',c.relname,'column',a.attname)),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE CASE WHEN $1::text IS NULL THEN pg_table_is_visible(c.oid) ELSE n.nspname=$1::text END AND c.relname=ANY($2::text[]) AND c.relkind IN ('r','p')) AS columns,
  (SELECT coalesce(json_agg(json_build_object('table',t.relname,'schema',n.nspname,'name',x.relname,'unique',i.indisunique,'valid',i.indisvalid,'definition',regexp_replace(pg_get_indexdef(i.indexrelid),'^CREATE (UNIQUE )?INDEX \\S+ ON (ONLY )?\\S+ ',''))),'[]')
    FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE CASE WHEN $1::text IS NULL THEN pg_table_is_visible(t.oid) ELSE n.nspname=$1::text END AND t.relname=ANY($2::text[]) AND i.indisready) AS indexes,
  (SELECT coalesce(json_agg(json_build_object('table',t.relname,'definition',pg_get_constraintdef(k.oid))),'[]')
    FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE CASE WHEN $1::text IS NULL THEN pg_table_is_visible(t.oid) ELSE n.nspname=$1::text END AND t.relname=ANY($2::text[]) AND k.contype='c' AND k.convalidated) AS checks`;
  /**
   * What the catalogue lacks of what this build needs, each with where it comes
   * from: the tables and columns the queries use and the integrity guards, and
   * any superseded guard still in place, by its own name and with the schema to
   * migrate; then the read indexes; at most 20 of each, then a count.
   */
  function schemaGaps(catalogue: SchemaCatalogue): {
    required: string[];
    indexes: string[];
  } {
    const present = new Map<string, Set<string>>(),
      required: string[] = [],
      indexes: string[] = [];
    for (const { table, column } of catalogue.columns)
      present.set(table, (present.get(table) ?? new Set<string>()).add(column));
    for (const table of requiredTables) {
      if (table.name === "valopay_export_cleanup" && runtimeIsolationEnabled())
        continue;
      const columns = present.get(table.name);
      if (!columns) {
        required.push(`table ${table.name}: ${schemaSource(table.name)}`);
        continue;
      }
      for (const column of table.columns)
        if (!columns.has(column))
          required.push(`column ${table.name}.${column}: ${columnSource}`);
    }
    const valid = catalogue.indexes.filter((index) => index.valid);
    const defined = new Set(
      valid.map((index) => `${index.table} ${index.definition}`),
    );
    const guarded = new Set([
      ...valid
        .filter((index) => index.unique)
        .map((index) => `${index.table} unique index ${index.definition}`),
      ...catalogue.checks.map(
        (check) => `${check.table} check ${check.definition}`,
      ),
    ]);
    // A missing table is named above; its guards and indexes are not listed again.
    for (const guard of integrityGuards)
      if (
        present.has(guard.table) &&
        !guarded.has(`${guard.table} ${guard.type} ${guard.definition}`)
      )
        required.push(
          `${guard.type} ${guard.name}: ${guardSource(guard.name)}`,
        );
    // One that is not valid is still enforced; the migration refuses it, so it is dropped by hand first.
    for (const guard of supersededGuards)
      for (const index of catalogue.indexes
        .filter(
          (index) =>
            index.unique &&
            index.table === guard.table &&
            index.definition === guard.definition,
        )
        .sort((a, b) => a.name.localeCompare(b.name)))
        required.push(
          `superseded unique index ${index.name}: ${guard.description}${index.valid ? ";" : ", left not valid but still enforced on writes; drop it by hand once reviewed, as the migration refuses it, then"} apply lib/db/migrations/${guard.migration} with ${index.schema} first on the search path`,
        );
    for (const index of requiredIndexes)
      if (
        present.has(index.table) &&
        !defined.has(`${index.table} ${index.definition}`)
      )
        indexes.push(
          `index ${index.name}: apply lib/db/migrations/${index.migration}`,
        );
    const capped = (list: string[]) =>
      list.length > 20
        ? [...list.slice(0, 20), `and ${list.length - 20} more`]
        : list;
    return { required: capped(required), indexes: capped(indexes) };
  }
  let readiness: InstanceType<typeof Pool> | undefined;
  /**
   * Readiness: one bounded round trip to the database, on its own connection,
   * so a request pool that is busy does not read as a database that cannot be
   * reached. The round trip reads the catalogue, so a database that answers but
   * lacks a table or a column this build needs (a migration not yet applied), or
   * a unique index or check constraint it relies on (a push stopped part way),
   * or that still holds a guard this build replaced, is not ready either; a
   * missing read index is reported without failing, since every request still
   * works, only slower. A SELECT 1 could not tell. It checks
   * the application's schema: the isolated runtime schema when runtime isolation
   * is on, otherwise the connection's own (`schema` names another, for tests).
   * Never throws; a connection error stays in the caller's log, not in an
   * answer.
   */
  async function pingDatabase(
    options: { timeoutMs?: number; schema?: string } = {},
  ): Promise<DatabaseReadiness> {
    const timeoutMs = options.timeoutMs ?? 2000,
      started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      if (!readiness) {
        readiness = new Pool({
          connectionString: process.env.DATABASE_URL,
          max: 1,
          connectionTimeoutMillis: timeoutMs,
          idleTimeoutMillis: 10_000,
          allowExitOnIdle: true,
        });
        // An idle connection that fails is replaced; the next ping reports whether the database answers.
        readiness.on("error", () => {});
      }
      const schema =
        options.schema ?? runtimeIsolationConfiguration()?.schema ?? null;
      const catalogue = (
        await Promise.race([
          readiness.query<SchemaCatalogue>(schemaCatalogue, [
            schema,
            requiredTables.map((table) => table.name),
          ]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`no answer within ${timeoutMs} ms`)),
              timeoutMs,
            );
          }),
        ])
      ).rows[0]!;
      const gaps = schemaGaps(catalogue);
      const status = gaps.required.length
        ? "incomplete"
        : gaps.indexes.length
          ? "indexes_missing"
          : "ok";
      return {
        status: "ok",
        latencyMs: Math.round(performance.now() - started),
        ...(schema ? { searched: schema } : {}),
        schema: { status, missing: [...gaps.required, ...gaps.indexes] },
      };
    } catch (error) {
      return {
        status: "failed",
        latencyMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
        schema: { status: "unchecked", missing: [] },
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** An idle connection that fails emits an error on the pool; unheard, that event ends the process. Heard, it is a log line and the pool replaces the connection. */
  function watchDatabase(log: {
    error: (fields: object, message: string) => void;
  }): void {
    pool.on("error", (error) =>
      log.error(
        { event: "database.pool_error", err: error },
        "Database connection error on an idle client",
      ),
    );
  }

  /** Ends the pools on shutdown, after the last transaction. */
  async function closeDatabase(): Promise<void> {
    const ending = readiness;
    readiness = undefined;
    await Promise.all([pool.end(), ending?.end()]);
  }
  return {
    integrityGuards,
    guardMigrations,
    supersededGuards,
    pingDatabase,
    watchDatabase,
    closeDatabase,
  };
}
