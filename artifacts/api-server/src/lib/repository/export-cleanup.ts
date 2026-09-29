/** Internal repository export-cleanup. Import through valopay-store; external access is rejected by the boundary check. */
import type { PoolClient } from "@workspace/db";
import { deleteRetainedExport, exportIdentityMismatch } from "../export-download";
import { objectStorageClient } from "../objectStorage";
import {
  runtimeIsolationEnabled,
  runtimeServiceRead,
} from "../runtime-isolation";
import { randomUUID } from "node:crypto";
import type { SweptExportFile } from "./types";
type Dependencies = Pick<
  typeof import("./core"),
  "ANONYMOUS_WORKSPACE_DAYS" | "SYSTEM_ACTOR_PREFIX" | "rowsAffected" | "fail"
>;

export type SweepLog = { warn?(fields: object, message: string): void };

export function createExportCleanupRepository(dependencies: Dependencies) {
  const { ANONYMOUS_WORKSPACE_DAYS, SYSTEM_ACTOR_PREFIX, rowsAffected } =
    dependencies;
  const fail: (message: string, status?: number) => never = dependencies.fail;

  /**
   * Anonymous sandboxes older than the cookie lifetime with no change by a
   * person in that time are removed, children first; signed-in workspaces never
   * carry the flag and are never swept.  Activity is read from the audit chain,
   * which every request mutation appends to, so the scheduled close (a system
   * actor) never keeps an abandoned sandbox alive.  Ordinary DML inside the
   * caller's transaction.
   *
   * Nothing is deleted until the workspace row and every one of its lenders
   * are locked, in lender order and without waiting (SKIP LOCKED). The
   * scheduled close, the export worker, Paystack test deliveries and requests
   * all hold a lender's row while they write its records, and a request holds
   * its workspace row, so a sandbox with either held elsewhere is left whole
   * for a later sweep. Deleting the records first and then waiting for such a
   * lender deadlocked with a close that saved it. Each sandbox is locked in a
   * savepoint of its own and a busy one is undone at once, so its free lenders
   * and its row are not held for the rest of the caller's transaction. An export
   * renders and uploads outside that lock: any running export, even one with an
   * expired lease, keeps its workspace until the worker settles or recovers it.
   *
   * Answers the swept sandboxes' export files, read before their records go:
   * private storage is not part of the transaction, so the caller removes them
   * once the deletion has committed (removeSweptExportFiles).
   */
  async function sweepExpiredWorkspaces(
    client: PoolClient,
    limit: number,
  ): Promise<{ workspaces: number; files: SweptExportFile[] }> {
    const staleness = `w.created_at < now() - make_interval(days => $1)
       AND EXISTS (SELECT 1 FROM valopay_merchants m WHERE m.workspace_id=w.id AND m.settings->>'anonymousWorkspace'='true')
       AND NOT EXISTS (SELECT 1 FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id
                       WHERE m.workspace_id=w.id AND r.kind='audit' AND r.created_at >= now() - make_interval(days => $1)
                         AND COALESCE(r.data->>'actor','') NOT LIKE $2)`;
    const candidates = (
      await client.query<{ id: string }>(
        `SELECT w.id FROM valopay_workspaces w WHERE ${staleness} ORDER BY w.created_at LIMIT $3`,
        [ANONYMOUS_WORKSPACE_DAYS, `${SYSTEM_ACTOR_PREFIX}%`, limit],
      )
    ).rows.map((row) => row.id);
    const expired: string[] = [];
    for (const id of candidates) {
      await client.query("SAVEPOINT expired_workspace");
      // Read again once locked: a person may have used the sandbox since the list above was read.
      const still = rowsAffected(
        await client.query(
          `SELECT w.id FROM valopay_workspaces w WHERE w.id=$3 AND ${staleness} FOR UPDATE OF w SKIP LOCKED`,
          [ANONYMOUS_WORKSPACE_DAYS, `${SYSTEM_ACTOR_PREFIX}%`, id],
        ),
      );
      // The workspace row, once locked, keeps the lender list fixed: adding a lender needs its workspace.
      const lenders = still
        ? (
            await client.query<{ total: number }>(
              "SELECT count(*)::int AS total FROM valopay_merchants WHERE workspace_id=$1",
              [id],
            )
          ).rows[0]!.total
        : 0;
      const locked = still
        ? (
            await client.query(
              "SELECT id FROM valopay_merchants WHERE workspace_id=$1 ORDER BY id FOR UPDATE SKIP LOCKED",
              [id],
            )
          ).rowCount || 0
        : 0;
      // Recheck only after every lender is locked. A claim cannot start between
      // this check and deletion, and an upload in progress retains its job and
      // future cleanup identity even when its database lease has expired.
      const uploading =
        still &&
        locked === lenders &&
        rowsAffected(
          await client.query(
            `SELECT 1 FROM valopay_records r
      JOIN valopay_merchants m ON m.id=r.merchant_id WHERE m.workspace_id=$1 AND r.kind='exports' AND r.status='running' LIMIT 1`,
            [id],
          ),
        );
      if (still && locked === lenders && !uploading) {
        await client.query("RELEASE SAVEPOINT expired_workspace");
        expired.push(id);
      } else await client.query("ROLLBACK TO SAVEPOINT expired_workspace");
    }
    if (!expired.length) return { workspaces: 0, files: [] };
    // Every export that names a stored file, whatever its status; one an approved retention run removed is gone already.
    const files = (
      await client.query<{
        merchant_id: string;
        id: string;
        bucket: string;
        object_name: string;
        checksum: string | null;
      }>(
        `SELECT r.merchant_id, r.id, r.data->>'bucket' AS bucket, r.data->>'objectName' AS object_name, r.data->>'checksum' AS checksum
     FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id
     WHERE m.workspace_id = ANY($1::text[]) AND r.kind='exports' AND coalesce(r.data->>'bucket','') <> '' AND coalesce(r.data->>'objectName','') <> ''
       AND coalesce(r.data->>'fileDeletedAt','') = '' ORDER BY r.merchant_id, r.id`,
        [expired],
      )
    ).rows.map((row): SweptExportFile => ({
      merchantId: row.merchant_id,
      exportId: row.id,
      bucket: row.bucket,
      objectName: row.object_name,
      ...(row.checksum ? { checksum: row.checksum } : {}),
    }));
    // Written in the same transaction, before their source records disappear. A rolled-back sweep leaves no cleanup
    // work; a committed sweep keeps every remaining private file identifiable through outages and process restarts.
    // An interrupted upload may have lost its answer just before its job became
    // failed or queued. Retain that tombstone for five minutes before the first
    // storage check, covering the bounded four-minute attempt and one-minute
    // storage request. This is a quiescence allowance, not proof that an external
    // provider can never commit arbitrarily late after a client cancellation.
    if (files.length)
      await client.query(
        `INSERT INTO valopay_export_cleanup(id,merchant_id,bucket,object_name,checksum,next_attempt_at)
    SELECT r.id,r.merchant_id,r.data->>'bucket',r.data->>'objectName',r.data->>'checksum',
      CASE WHEN r.status<>'ready' AND CASE WHEN jsonb_typeof(r.data->'attempts')='number' THEN (r.data->>'attempts')::numeric>0 ELSE false END
        THEN now()+interval '5 minutes' ELSE now() END
    FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id
    WHERE m.workspace_id=ANY($1::text[]) AND r.kind='exports' AND coalesce(r.data->>'bucket','')<>'' AND coalesce(r.data->>'objectName','')<>''
      AND coalesce(r.data->>'fileDeletedAt','')='' ORDER BY r.merchant_id,r.id
    ON CONFLICT (id) DO NOTHING`,
        [expired],
      );
    await client.query(
      "DELETE FROM valopay_idempotency WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id = ANY($1::text[]))",
      [expired],
    );
    await client.query(
      "DELETE FROM valopay_records WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id = ANY($1::text[]))",
      [expired],
    );
    await client.query(
      "DELETE FROM valopay_merchants WHERE workspace_id = ANY($1::text[])",
      [expired],
    );
    await client.query(
      "DELETE FROM valopay_workspaces WHERE id = ANY($1::text[])",
      [expired],
    );
    return { workspaces: expired.length, files };
  }
  /** How long one bootstrap goes on starting removals of swept export files, so a new visitor never waits long for private storage. */
  const SWEPT_FILE_BUDGET_MS = 5_000;
  /** Removes one swept export's file: only the generation whose metadata names this export and lender, and its checksum once ready (deleteRetainedExport). */
  let removeSweptFile = (file: SweptExportFile) =>
    deleteRetainedExport(
      objectStorageClient.bucket(file.bucket).file(file.objectName),
      {
        id: file.exportId,
        merchantId: file.merchantId,
        ...(file.checksum ? { checksum: file.checksum } : {}),
      },
    );
  /** For tests only: replaces how a swept export's file is removed from private storage, and returns what restores it. */
  function overrideSweptExportRemoval(
    remove: typeof removeSweptFile,
  ): () => void {
    const previous = removeSweptFile;
    removeSweptFile = remove;
    return () => {
      removeSweptFile = previous;
    };
  }
  /**
   * Removes the export files of the sandboxes a sweep deleted, one at a time.
   * inWorkspace calls it once that deletion has committed, so a sweep that was
   * undone keeps its files with its records. It never throws, so it never fails
   * the request or undoes the sweep. A file not removed within the budget stays
   * in the durable queue, whose background worker retries after outages and
   * restarts. Logs identify only the job; private storage paths stay in the queue.
   */
  async function removeSweptExportFiles(
    files: SweptExportFile[],
    log?: SweepLog,
    budgetMs = SWEPT_FILE_BUDGET_MS,
  ): Promise<void> {
    try {
      await runExportCleanupPass({
        ids: files.map((file) => file.exportId),
        limit: files.length,
        budgetMs,
        log,
      });
    } catch {
      try {
        log?.warn?.(
          { event: "workspace.sweep_cleanup_deferred" },
          "Private export cleanup remains queued for retry",
        );
      } catch {
        /* logging cannot fail a bootstrap */
      }
    }
  }

  /** Claim one tombstone atomically. No connection is held during storage I/O; crashed claims become available after
   * two minutes. The token prevents a late worker from removing a newer worker's claim. Restricted tenant runtimes
   * neither read this global queue nor receive its database privileges. */
  async function runExportCleanupPass(
    options: {
      ids?: string[];
      limit?: number;
      budgetMs?: number;
      stopped?: () => boolean;
      log?: SweepLog;
    } = {},
  ) {
    if (runtimeIsolationEnabled())
      return { attempted: 0, removed: 0, deferred: 0 };
    const started = performance.now(),
      result = { attempted: 0, removed: 0, deferred: 0 };
    const limit = Math.max(0, Math.min(20, Math.floor(options.limit ?? 5)));
    for (
      let n = 0;
      n < limit &&
      performance.now() - started < (options.budgetMs ?? 10_000) &&
      !options.stopped?.();
      n++
    ) {
      const token = randomUUID();
      const row = await runtimeServiceRead(
        async (client) =>
          (
            await client.query<{
              id: string;
              merchant_id: string;
              bucket: string;
              object_name: string;
              checksum: string | null;
              attempts: number;
            }>(
              `WITH candidate AS (
      SELECT id FROM valopay_export_cleanup WHERE next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<=now())
        AND ($2::text[] IS NULL OR id=ANY($2::text[])) ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE valopay_export_cleanup q SET lease_token=$1,lease_until=now()+interval '2 minutes',attempts=least(q.attempts::bigint+1,2147483647)::int,updated_at=now()
      FROM candidate c WHERE q.id=c.id RETURNING q.id,q.merchant_id,q.bucket,q.object_name,q.checksum,q.attempts`,
              [token, options.ids ?? null],
            )
          ).rows[0],
      );
      if (!row) break;
      result.attempted++;
      const file: SweptExportFile = {
        exportId: row.id,
        merchantId: row.merchant_id,
        bucket: row.bucket,
        objectName: row.object_name,
        ...(row.checksum ? { checksum: row.checksum } : {}),
      };
      try {
        await removeSweptFile(file);
        await runtimeServiceRead((client) =>
          client.query(
            "DELETE FROM valopay_export_cleanup WHERE id=$1 AND lease_token=$2",
            [row.id, token],
          ),
        );
        result.removed++;
      } catch (error) {
        result.deferred++;
        // A bounded code, never a storage response, private path or credential. Storage, network, a timeout or the
        // delete's generation race is retried with backoff, under the same ownership guard. An object whose identity
        // does not match (exportIdentityMismatch) is parked instead: no retry changes it and it is never deleted by
        // force, so it waits for an operator's review with no further automatic attempt (next_attempt_at 'infinity').
        const mismatch = exportIdentityMismatch(error);
        const failure = mismatch ?? "storage_or_queue_unavailable";
        const retrySeconds = mismatch
          ? null
          : Math.min(3600, 30 * 2 ** Math.min(row.attempts - 1, 7));
        await runtimeServiceRead((client) =>
          client.query(
            `UPDATE valopay_export_cleanup SET lease_token=NULL,lease_until=NULL,last_failure=$3,
        next_attempt_at=CASE WHEN $4::int IS NULL THEN 'infinity'::timestamptz ELSE now()+make_interval(secs=>$4::int) END,updated_at=now() WHERE id=$1 AND lease_token=$2`,
            [row.id, token, failure, retrySeconds],
          ),
        );
        try {
          options.log?.warn?.(
            {
              event: "workspace.sweep_file_left",
              exportId: row.id,
              merchantId: row.merchant_id,
              reason: failure,
              ...(retrySeconds === null ? { parked: true } : { retrySeconds }),
            },
            retrySeconds === null
              ? "Private export cleanup found a file whose identity does not match; it is parked for an operator's review"
              : "Private export cleanup failed and remains queued for retry",
          );
        } catch {
          /* no effect on work */
        }
      }
    }
    return result;
  }

  const serviceOnly = () => {
    if (runtimeIsolationEnabled())
      fail(
        "Export cleanup is owned by the sandbox service, outside restricted tenant runtimes.",
        403,
      );
  };
  /** Operator-only aggregate status. No export payload, customer identifier or private storage path is returned.
   * failed counts files waiting for a retry after a failed attempt; parked, those parked for an operator's review. */
  async function exportCleanupStatus() {
    serviceOnly();
    const row = await runtimeServiceRead(
      async (client) =>
        (
          await client.query<{ pending: number; leased: number; ready: number; retried: number; failed: number; parked: number; oldest: Date | null }>(`SELECT count(*)::int AS pending,
    count(*) FILTER (WHERE lease_until>now())::int AS leased,
    count(*) FILTER (WHERE next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<=now()))::int AS ready,
    count(*) FILTER (WHERE attempts>0)::int AS retried,
    count(*) FILTER (WHERE last_failure IS NOT NULL AND next_attempt_at<>'infinity')::int AS failed,
    count(*) FILTER (WHERE next_attempt_at='infinity')::int AS parked,
    min(created_at) AS oldest FROM valopay_export_cleanup`)
        ).rows[0]!,
    );
    return { ...row, oldest: row.oldest?.toISOString() ?? null };
  }

  /** Operator-only: the files parked for review, longest parked first, with why; never their storage location. */
  async function parkedExportFiles(limit = 20) {
    serviceOnly();
    const rows = await runtimeServiceRead(
      async (client) =>
        (
          await client.query<{ id: string; merchant_id: string; last_failure: string; attempts: number; updated_at: Date }>(
            "SELECT id,merchant_id,last_failure,attempts,updated_at FROM valopay_export_cleanup WHERE next_attempt_at='infinity' ORDER BY updated_at,id LIMIT $1",
            [Math.max(1, Math.min(100, Math.floor(limit)))],
          )
        ).rows,
    );
    return rows.map((row) => ({ exportId: row.id, merchantId: row.merchant_id, failure: row.last_failure, attempts: row.attempts, since: row.updated_at.toISOString() }));
  }
  const notParked = () =>
    fail("No parked file has that export ID; nothing was changed.", 404);
  /** Operator-only, after review: makes a parked file due again with no failure recorded, for the next pass to attempt
   * under the same ownership guard. A file whose identity still does not match is parked again, never deleted. */
  async function requeueParkedExportFile(exportId: string) {
    serviceOnly();
    return runtimeServiceRead(async (client) => {
      const row = (
        await client.query<{ merchant_id: string; last_failure: string }>(
          "SELECT merchant_id,last_failure FROM valopay_export_cleanup WHERE id=$1 AND next_attempt_at='infinity' FOR UPDATE",
          [exportId],
        )
      ).rows[0];
      if (!row) return notParked();
      await client.query(
        "UPDATE valopay_export_cleanup SET last_failure=NULL,next_attempt_at=now(),updated_at=now() WHERE id=$1",
        [exportId],
      );
      return { exportId, merchantId: row.merchant_id, failure: row.last_failure };
    });
  }
  /** Operator-only, after review: removes a parked file's tombstone, the operator's reason logged
   * (workspace.sweep_file_released). Its object is left in storage: nothing whose identity does not match is deleted. */
  async function releaseParkedExportFile(
    exportId: string,
    reason: string,
    log: { warn(fields: object, message: string): void },
  ) {
    serviceOnly();
    const why = reason.trim();
    if (!/^[^\p{Cc}\u2028\u2029]{1,200}$/u.test(why))
      fail(
        "Give the release a reason of 1 to 200 characters on one line: it is written to the service log.",
      );
    const row = await runtimeServiceRead(
      async (client) =>
        (
          await client.query<{ merchant_id: string; last_failure: string }>(
            "DELETE FROM valopay_export_cleanup WHERE id=$1 AND next_attempt_at='infinity' RETURNING merchant_id,last_failure",
            [exportId],
          )
        ).rows[0],
    );
    if (!row) return notParked();
    const released = { exportId, merchantId: row.merchant_id, failure: row.last_failure };
    try {
      log.warn(
        { event: "workspace.sweep_file_released", ...released, reason: why },
        "An operator released a parked private export file from cleanup after review; its object is left in storage",
      );
    } catch {
      /* the release stands, and the command reports it */
    }
    return released;
  }
  return {
    sweepExpiredWorkspaces,
    overrideSweptExportRemoval,
    removeSweptExportFiles,
    runExportCleanupPass,
    exportCleanupStatus,
    parkedExportFiles,
    requeueParkedExportFile,
    releaseParkedExportFile,
  };
}
