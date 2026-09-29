/** Internal repository payload-rewrap. Import through valopay-store; external access is rejected by the boundary check. */
import type { PoolClient } from "@workspace/db";
import {
  protectStored,
  revealStored,
  payloadEncryptionKey,
} from "../protected-payloads";
type Dependencies = Pick<
  typeof import("./core"),
  "fail" | "operatorTransaction" | "rowsAffected"
>;

/** What one run of the operator's re-wrap step did (scripts/rewrap-payloads.ts): in which schema, and which other schemas hold the application's tables and were not scanned. */
export type PayloadRewrap = {
  key: string;
  schema: string;
  rewrapped: number;
  changed: number;
  remaining: number;
  remainingByKey: Array<{ key: string; payloads: number }>;
  otherSchemas: string[];
  message: string;
};

export function createPayloadRewrapRepository(dependencies: Dependencies) {
  const { operatorTransaction, rowsAffected } = dependencies;
  const fail: (message: string, status?: number) => never = dependencies.fail;

  /** A restricted runtime's schema, as runtime-isolation.ts accepts its name. */
  const RUNTIME_SCHEMA_NAME = /^valopay_runtime_(staging|test)_[a-z0-9_]+$/;
  /** The four tables the re-wrap reads: in the named schema, qualified, or unqualified, where the connection's search path finds them. The schema's name is checked first, never input. */
  const rewrapTables = (schema: string | undefined) => {
    const table = (name: string) => (schema ? `"${schema}".${name}` : name);
    return {
      records: table("valopay_records"),
      operations: table("valopay_operations"),
      idempotency: table("valopay_idempotency"),
      merchants: table("valopay_merchants"),
    };
  };
  type RewrapTables = ReturnType<typeof rewrapTables>;
  /**
   * Every protected payload and the scope it was sealed in, with the table it
   * lives in: an import batch's source rows and check, a journal entry's request
   * and receipt, and a replay copy's answer. The fields are fixed here, never
   * input. $1 is the current key; $2, when not null, limits it to those
   * workspaces (tests).
   */
  const sealedPayloadsSql = (tables: RewrapTables) => `WITH sealed AS (
    SELECT 'records' AS source, r.id, r.merchant_id, f.field, f.value FROM ${tables.records} r CROSS JOIN LATERAL (VALUES ('csv', r.data->'csv'), ('check', r.data->'check')) AS f(field, value) WHERE r.kind='import-batches'
    UNION ALL SELECT 'operations', o.id, o.merchant_id, f.field, f.value FROM ${tables.operations} o CROSS JOIN LATERAL (VALUES ('request', o.request), ('receipt', o.receipt)) AS f(field, value)
    UNION ALL SELECT 'idempotency', i.id, i.merchant_id, 'response', i.response FROM ${tables.idempotency} i)
  SELECT sealed.source, sealed.id, sealed.merchant_id, sealed.field, sealed.value FROM sealed JOIN ${tables.merchants} m ON m.id=sealed.merchant_id
  WHERE jsonb_typeof(sealed.value)='object' AND sealed.value ? 'protectedPayload' AND sealed.value->>'key' IS DISTINCT FROM $1 AND ($2::text[] IS NULL OR m.workspace_id=ANY($2::text[]))`;
  /** Writes a re-sealed payload back only while it is still the envelope that was read, so a request that changed it meanwhile wins. */
  const rewrapWrites = (tables: RewrapTables): Record<string, string> => ({
    "records:csv": `UPDATE ${tables.records} SET data=jsonb_set(data,'{csv}',$3::jsonb) WHERE id=$1 AND merchant_id=$2 AND kind='import-batches' AND data->'csv'=$4::jsonb`,
    "records:check": `UPDATE ${tables.records} SET data=jsonb_set(data,'{check}',$3::jsonb) WHERE id=$1 AND merchant_id=$2 AND kind='import-batches' AND data->'check'=$4::jsonb`,
    "operations:request": `UPDATE ${tables.operations} SET request=$3::jsonb WHERE id=$1 AND merchant_id=$2 AND request=$4::jsonb`,
    "operations:receipt": `UPDATE ${tables.operations} SET receipt=$3::jsonb WHERE id=$1 AND merchant_id=$2 AND receipt=$4::jsonb`,
    "idempotency:response": `UPDATE ${tables.idempotency} SET response=$3::jsonb WHERE id=$1 AND merchant_id=$2 AND response=$4::jsonb`,
  });
  /**
   * What the connection makes of the four tables before a payload is read: how
   * many it finds and in which schema, whether row security filters any of them
   * for it, whether it owns them all or bypasses row security, and the other
   * schemas that hold the application's tables.
   */
  const rewrapScopeSql = `WITH scanned AS (SELECT c.oid, c.relowner, n.nspname::text AS schema FROM unnest($1::text[]) AS t(name) JOIN pg_class c ON c.oid=to_regclass(t.name) JOIN pg_namespace n ON n.oid=c.relnamespace)
  SELECT (SELECT count(*)::int FROM scanned) AS tables, (SELECT string_agg(DISTINCT schema, ', ') FROM scanned) AS schema,
    (SELECT coalesce(bool_or(row_security_active(oid)), false) FROM scanned) AS filtered,
    (SELECT coalesce(bool_and(pg_has_role(current_user, relowner, 'USAGE')), false) FROM scanned) AS owns,
    (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypasses,
    (SELECT coalesce(array_agg(DISTINCT n.nspname::text ORDER BY n.nspname::text), '{}') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relname='valopay_operations' AND c.relkind='r' AND n.nspname::text NOT IN (SELECT schema FROM scanned)) AS "otherSchemas"`;
  /**
   * The schema the re-wrap reads, checked on the connection that reads it: a
   * connection that could miss a payload is refused before it reads one, since
   * it would count none left and say an earlier key may be retired. Row
   * security filters a login that does not bypass it wherever a table enables
   * it (the restricted runtime's schema forces it even on the tables' owner),
   * and a login that neither owns the tables nor bypasses row security sees
   * every row only for as long as no one enables it.
   */
  async function rewrapScope(
    client: PoolClient,
    tables: RewrapTables,
    named: string | undefined,
  ): Promise<{ schema: string; otherSchemas: string[] }> {
    const scope = (
      await client.query<{
        tables: number;
        schema: string | null;
        filtered: boolean;
        owns: boolean;
        bypasses: boolean | null;
        otherSchemas: string[];
      }>(rewrapScopeSql, [Object.values(tables)])
    ).rows[0]!;
    if (scope.tables !== Object.keys(tables).length)
      fail(
        named
          ? `VALOPAY_RUNTIME_SCHEMA names ${named}, which does not hold the application's tables; nothing was read.`
          : "The connection's search path does not reach the application's tables; nothing was read.",
        503,
      );
    if (scope.filtered)
      fail(
        `Row security filters what this connection reads in ${scope.schema}, so the re-wrap could miss payloads there; nothing was read. Run it with the migration owner's connection, which bypasses row security, never the restricted runtime login.`,
        503,
      );
    if (!scope.owns && !scope.bypasses)
      fail(
        `This connection neither owns the application's tables in ${scope.schema} nor bypasses row security, so the re-wrap could miss payloads there; nothing was read. Run it with the migration owner's connection, never the restricted runtime login.`,
        503,
      );
    return { schema: scope.schema!, otherSchemas: scope.otherSchemas };
  }
  /**
   * Operator-only (scripts/rewrap-payloads.ts); never called by an HTTP route.
   * After the payload wrapping key changes name (VALOPAY_KMS_KEY), re-seals at
   * most `limit` protected payloads that still name an earlier key: each is
   * opened with the key it names, which must still be listed in
   * VALOPAY_KMS_PREVIOUS_KEYS, and sealed again under the current key with a
   * fresh data key, in the scope it was sealed in. It reads one schema: the
   * restricted runtime's that VALOPAY_RUNTIME_SCHEMA names, whose tables it
   * names in full, or else the one the connection's search path reaches, and
   * only through a connection that sees every row there (rewrapScope). Nothing
   * is locked while the key service works: a payload is read, re-sealed, then
   * written back in a short transaction of its own only if it is still the
   * envelope that was read, so a run can stop at any point and be run again,
   * and a payload a request rewrote meanwhile is left to it (counted as
   * changed). Returns the schema it read, how many it re-sealed, how many still
   * name each earlier key, and the other schemas that hold the application's
   * tables: an earlier key may be retired once every schema reports none left
   * (docs/pilot-security.md, "Key rotation").
   */
  async function rewrapProtectedPayloads(
    options: { limit?: number; workspaces?: readonly string[] } = {},
  ): Promise<PayloadRewrap> {
    const key = payloadEncryptionKey();
    if (!key)
      fail(
        "Set VALOPAY_PAYLOAD_ENCRYPTION=kms and VALOPAY_KMS_KEY to the key payloads should be sealed under.",
        503,
      );
    const limit = options.limit ?? 100,
      workspaces = options.workspaces ? [...options.workspaces] : null;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      fail("Re-wrap between 1 and 1000 payloads at a time.");
    const named = process.env.VALOPAY_RUNTIME_SCHEMA || undefined;
    if (named && !RUNTIME_SCHEMA_NAME.test(named))
      fail(
        "VALOPAY_RUNTIME_SCHEMA must name a restricted runtime's schema (valopay_runtime_staging_<suffix>), or be unset for the tables the connection's search path reaches.",
        503,
      );
    const tables = rewrapTables(named),
      sealedSql = sealedPayloadsSql(tables),
      writes = rewrapWrites(tables);
    type Sealed = {
      source: string;
      id: string;
      merchant_id: string;
      field: string;
      value: { key?: string };
    };
    const { schema, batch } = await operatorTransaction(async (client) => ({
      schema: (await rewrapScope(client, tables, named)).schema,
      batch: (
        await client.query<Sealed>(
          `${sealedSql} ORDER BY sealed.source,sealed.merchant_id,sealed.id,sealed.field LIMIT $3`,
          [key, workspaces, limit],
        )
      ).rows,
    }));
    let rewrapped = 0,
      changed = 0;
    for (const payload of batch) {
      const scope = {
        lender: payload.merchant_id,
        record: payload.id,
        field: payload.field,
      };
      let sealed: unknown;
      try {
        sealed = await protectStored(
          await revealStored(payload.value, scope),
          scope,
        );
      } catch (error) {
        if ((error as { status?: unknown }).status !== 503) throw error;
        fail(
          `A payload sealed under ${String(payload.value.key)} could not be opened, so the run stopped after re-sealing ${rewrapped}. Keep that key in VALOPAY_KMS_PREVIOUS_KEYS and check this service may decrypt with it, then run the command again.`,
          503,
        );
      }
      const written = await operatorTransaction((client) =>
        client.query(writes[`${payload.source}:${payload.field}`]!, [
          payload.id,
          payload.merchant_id,
          JSON.stringify(sealed),
          JSON.stringify(payload.value),
        ]),
      );
      if (rowsAffected(written)) rewrapped++;
      else changed++;
    }
    // The count that may say none are left is checked on its own connection too.
    const { otherSchemas, counted } = await operatorTransaction(
      async (client) => ({
        otherSchemas: (await rewrapScope(client, tables, named)).otherSchemas,
        counted: (
          await client.query<{ key: string; payloads: string }>(
            `SELECT payload.value->>'key' AS key, count(*) AS payloads FROM (${sealedSql}) payload GROUP BY 1 ORDER BY 1`,
            [key, workspaces],
          )
        ).rows,
      }),
    );
    const remainingByKey = counted.map((row) => ({
      key: row.key,
      payloads: Number(row.payloads),
    }));
    const remaining = remainingByKey.reduce(
      (sum, row) => sum + row.payloads,
      0,
    );
    const moved = `Re-sealed ${rewrapped} protected payload${rewrapped === 1 ? "" : "s"} in ${schema} under ${key}${changed ? `; ${changed} changed while this run worked and will be checked again` : ""}.`;
    return {
      key,
      schema,
      rewrapped,
      changed,
      remaining,
      remainingByKey,
      otherSchemas,
      message: remaining
        ? `${moved} ${remaining} in ${schema} still name an earlier key: run the command again until none remain, and keep the earlier keys in VALOPAY_KMS_PREVIOUS_KEYS until then.`
        : otherSchemas.length
          ? `${moved} No protected payload in ${schema} names an earlier key, but ${otherSchemas.join(", ")} also ${otherSchemas.length === 1 ? "holds" : "hold"} the application's tables: re-wrap ${otherSchemas.length === 1 ? "it" : "each"} too (docs/pilot-security.md, "Key rotation"), and retire an earlier key only once every schema reports none and no backup you may restore still needs it.`
          : `${moved} No protected payload in ${schema} names an earlier key: an earlier key may be retired once no backup you may restore still needs it.`,
    };
  }
  return { rewrapProtectedPayloads };
}
