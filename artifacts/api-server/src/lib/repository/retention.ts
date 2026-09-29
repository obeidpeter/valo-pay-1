/** Internal repository retention. Import through valopay-store; external access is rejected by the boundary check. */
import { canonicalDigest } from "../digests";
import type { PoolClient } from "@workspace/db";
import type { DomainState } from "../../domain/types";
import type {
  LifecycleExternalCandidate,
  LifecycleCandidate,
} from "@workspace/valopay-schema";
import {
  lifecycleRunView,
  journalPayloadRule,
  type JournalWindow,
} from "../../domain/lifecycle";
import { deleteRetainedExport } from "../export-download";
import { objectStorageClient } from "../objectStorage";
import { executeApprovedRun } from "../../domain/lifecycle-run";
import type { OperationRow, StoreContext } from "./types";
type Dependencies = Pick<
  typeof import("./core"),
  "PURGED_REQUEST" | "sessionFor" | "fail" | "lockedMerchant" | "receiptIds"
>;

/**
 * A terminal journal entry as a retention source, read without its request or receipt. Its payload changes only when
 * the entry settles, which moves its version, and when retention purges it; sealing or re-wrapping changes how it is
 * stored, not what it holds. So its digest is of what identifies that payload: the fingerprint of the request as it was
 * sent (the digest a repeat of its key is compared with), the key, the outcome and the version.
 */
export type JournalSource = Pick<
  OperationRow,
  "id" | "request_key" | "request_hash" | "updated_at"
> & { status: "completed" | "cancelled"; row_version: string };

/** What a retention request reads of the journal: a page of the view (its offset), a preview's first eligible sources, a run's own sources or one named source. */
export type JournalNeed =
  { page: number } | { preview: true } | { run: string } | { source: string };

export function createRetentionRepository(dependencies: Dependencies) {
  const { PURGED_REQUEST, sessionFor, lockedMerchant, receiptIds } =
    dependencies;
  const fail: (message: string, status?: number) => never = dependencies.fail;

  const journalSourceDigest = (row: JournalSource) =>
    canonicalDigest({
      hash: row.request_hash,
      key: row.request_key,
      status: row.status,
      version: row.updated_at.toISOString(),
    });
  /**
   * The digest an earlier build gave a journal payload, of its stored request and receipt themselves, which it read
   * whole for every entry at every retention request. A run that build prepared holds it, and approving or executing
   * that run compares its sources with it, so the entries it names are digested so again, and match exactly when that
   * build's would have. Each digest is kept for the row version it was computed from (xmin, which any change to the row
   * moves), so a run repeated or resumed reads each request once in a process; at most 10,000 are kept.
   */
  const earlierDigests = new Map<string, string>();
  async function earlierJournalDigests(
    client: PoolClient,
    merchantId: string,
    sources: JournalSource[],
  ): Promise<Map<string, string>> {
    const found = new Map<string, string>(),
      keyOf = (id: string, version: string) =>
        `${merchantId}\u0000${id}\u0000${version}`;
    const missing = sources
      .filter((source) => {
        const known = earlierDigests.get(keyOf(source.id, source.row_version));
        if (known) found.set(source.id, known);
        return !known;
      })
      .map((source) => source.id);
    // Ten at a time: a run names at most 100 sources, each up to the 2 MB body limit.
    for (let start = 0; start < missing.length; start += 10) {
      const rows = (
        await client.query<OperationRow & { row_version: string }>(
          "SELECT id,request,receipt,request_key,request_hash,status,xmin::text AS row_version FROM valopay_operations WHERE merchant_id=$1 AND id=ANY($2::text[])",
          [merchantId, missing.slice(start, start + 10)],
        )
      ).rows;
      for (const row of rows) {
        const earlier = canonicalDigest(
          {
            request: row.request,
            receipt: row.receipt,
            key: row.request_key,
            hash: row.request_hash,
            status: row.status,
          },
          "legacy-en-us-null",
        );
        if (earlierDigests.size >= 10_000)
          earlierDigests.delete(earlierDigests.keys().next().value!);
        earlierDigests.set(keyOf(row.id, row.row_version), earlier);
        found.set(row.id, earlier);
      }
    }
    return found;
  }
  /** A terminal entry not purged under retention; and the inventory's order of those, by retention start and then ID. */
  const RETAINED_JOURNAL = `merchant_id=$1 AND status IN ('completed','cancelled') AND NOT(${PURGED_REQUEST})`,
    JOURNAL_ORDER = `date_trunc('milliseconds',updated_at),id COLLATE "C"`;
  /**
   * The retention sources kept outside the lender's records: the export files, and the terminal journal entries' payloads
   * a request needs (`need`), read without their requests (journalSourceDigest). The view and a preview read a window of
   * the journal in the inventory's order and count the rest (JournalWindow), so their cost does not grow with the
   * requests a lender's people have made. An approval or execution reads its run's own sources, and gives one the
   * digest an earlier build computed when the run holds it and the entry still has it.
   */
  async function lifecycleInventory(
    context: StoreContext,
    state: DomainState,
    need: JournalNeed = { page: 0 },
  ): Promise<{
    external: LifecycleExternalCandidate[];
    journal?: JournalWindow;
  }> {
    const session = sessionFor(context),
      merchantId = session.lockedMerchantId;
    // Inventory is also used by GET after loadState acquired a shared lender lock.
    // Physical execution still requires lockedMerchant's exclusive write snapshot.
    if (
      context.role !== "Admin" ||
      !merchantId ||
      state.merchant.id !== merchantId
    )
      fail("An administrator in this lender is required.", 403);
    const files = state.records
      .filter(
        (r) =>
          r.kind === "exports" &&
          ["ready", "failed"].includes(r.status) &&
          !r.data.fileDeletedAt &&
          r.data.bucket &&
          r.data.objectName,
      )
      .map((r) => ({
        kind: "export_file" as const,
        merchantId,
        sourceId: r.id,
        version: r.updatedAt,
        createdAt: String(r.data.generatedAt || r.updatedAt),
        label: "Private export file",
        digest: canonicalDigest(
          { id: r.id, status: r.status, data: r.data },
          "legacy-en-us-null",
        ),
        status: r.status as "ready" | "failed",
      }));
    const listed = (
      rows: JournalSource[],
      digests = new Map<string, string>(),
    ) =>
      rows.map((row) => ({
        kind: "journal_payload" as const,
        merchantId,
        sourceId: row.id,
        version: row.updated_at.toISOString(),
        createdAt: row.updated_at.toISOString(),
        label: "Terminal operation payload",
        digest: digests.get(row.id) ?? journalSourceDigest(row),
        status: row.status,
      }));
    const columns =
      "id,status,updated_at,request_key,request_hash,xmin::text AS row_version";
    if ("run" in need || "source" in need) {
      const run =
        "run" in need
          ? state.records.find(
              (r) =>
                r.id === need.run &&
                r.kind === "retention-runs" &&
                r.merchantId === merchantId,
            )
          : undefined;
      const saved = (
        Array.isArray(run?.data.candidates)
          ? (run.data.candidates as LifecycleCandidate[])
          : []
      ).filter((candidate) => candidate.kind === "journal_payload");
      const ids =
        "source" in need
          ? [need.source]
          : saved.map((candidate) => candidate.sourceId);
      const rows = ids.length
        ? (
            await session.client.query<JournalSource>(
              `SELECT ${columns} FROM valopay_operations WHERE ${RETAINED_JOURNAL} AND id=ANY($2::text[])`,
              [merchantId, ids],
            )
          ).rows
        : [];
      // A source whose version or outcome has changed matches no digest the run holds, so its request is not read.
      const byId = new Map(rows.map((row) => [row.id, row])),
        digests = new Map<string, string>();
      const earlier = saved.filter((candidate) => {
        const row = byId.get(candidate.sourceId);
        return (
          !!row &&
          candidate.digest !== journalSourceDigest(row) &&
          candidate.version === row.updated_at.toISOString() &&
          candidate.status === row.status
        );
      });
      if (earlier.length) {
        const computed = await earlierJournalDigests(
          session.client,
          merchantId,
          earlier.map((candidate) => byId.get(candidate.sourceId)!),
        );
        for (const candidate of earlier)
          if (computed.get(candidate.sourceId) === candidate.digest)
            digests.set(candidate.sourceId, candidate.digest);
      }
      return { external: [...listed(rows, digests), ...files] };
    }
    const rule = journalPayloadRule(state, context);
    const counted = (
      await session.client.query<{ total: string; eligible: string }>(
        `SELECT count(*) AS total,count(*) FILTER (WHERE date_trunc('milliseconds',updated_at)<=$2::timestamptz AND id<>ALL($3::text[])) AS eligible FROM valopay_operations WHERE ${RETAINED_JOURNAL}`,
        [merchantId, rule.oldEnough, rule.held],
      )
    ).rows[0]!;
    // The lender's import batches and exports bound its other sources (committed CSV and export files): a page's journal
    // payloads are among that many and 100 from its offset less that many. A preview's first 100 eligible are among the
    // first 100 and the held ones.
    const others = state.records.filter(
      (r) => r.kind === "import-batches" || r.kind === "exports",
    ).length;
    const [skipped, limit] =
      "preview" in need
        ? [0, 100 + rule.held.length]
        : [Math.max(0, need.page - others), others + 100];
    const rows = (
      await session.client.query<JournalSource>(
        `SELECT ${columns} FROM valopay_operations WHERE ${RETAINED_JOURNAL} ORDER BY ${JOURNAL_ORDER} OFFSET $2 LIMIT $3`,
        [merchantId, skipped, limit],
      )
    ).rows;
    return {
      external: [...listed(rows), ...files],
      journal: {
        total: Number(counted.total),
        eligible: Number(counted.eligible),
        skipped,
      },
    };
  }
  /**
   * Executes an approved retention run under the lender lock: as many of its
   * sources as fit in the step budget, each checked again and given a receipt,
   * stopping at a blocked source or a deletion that cannot be confirmed
   * (executeApprovedRun). The console repeats the request until the run is done.
   */
  async function executeLifecycleRun(
    context: StoreContext,
    state: DomainState,
    id: string,
  ) {
    const session = sessionFor(context),
      merchantId = lockedMerchant(session);
    if (
      context.role !== "Admin" ||
      session.access !== "write" ||
      state.merchant.id !== merchantId
    )
      fail("An administrator in this lender is required.", 403);
    const run = state.records.find(
      (r) => r.id === id && r.kind === "retention-runs",
    );
    if (!run) fail("Retention run not found.", 404);
    if (run.status === "completed") return lifecycleRunView(state, run);
    const { external } = await lifecycleInventory(context, state, { run: id });
    // A completed request's payload is purged in this transaction; an export file is deleted from private storage.
    const remove = async (
      candidate: LifecycleCandidate,
    ): Promise<"deleted" | "already_absent"> => {
      if (candidate.kind === "journal_payload") {
        const row = (
          await session.client.query<
            Pick<OperationRow, "id" | "status" | "request_key">
          >(
            "SELECT id,status,request_key FROM valopay_operations WHERE merchant_id=$1 AND id=$2 FOR UPDATE",
            [merchantId, candidate.sourceId],
          )
        ).rows[0];
        if (!row || !["completed", "cancelled"].includes(row.status))
          fail("The terminal request is no longer eligible.", 409);
        const tombstone = { purged: true, at: context.now, retentionRunId: id };
        await session.client.query(
          "UPDATE valopay_operations SET request=$3,receipt=$3 WHERE merchant_id=$1 AND id=$2 AND status IN ('completed','cancelled')",
          [merchantId, row.id, tombstone],
        );
        await session.client.query(
          "UPDATE valopay_idempotency SET response=$3 WHERE merchant_id=$1 AND id=ANY($2::text[])",
          [
            merchantId,
            receiptIds(merchantId, row.request_key, row.id),
            tombstone,
          ],
        );
        return "deleted";
      }
      const record = state.records.find(
        (r) => r.id === candidate.sourceId && r.kind === "exports",
      )!;
      const result = await deleteRetainedExport(
        objectStorageClient
          .bucket(record.data.bucket)
          .file(record.data.objectName),
        { id: record.id, merchantId, checksum: record.data.checksum },
      );
      record.data.fileDeletedAt = context.now;
      record.data.fileRetentionRunId = id;
      return result;
    };
    // A SQL error aborts the whole transaction; never mask it as a receipt.
    return executeApprovedRun(state, context, id, external, remove, {
      fatal: (error) =>
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string" &&
        /^[A-Z0-9]{5}$/.test(error.code),
    });
  }
  return { lifecycleInventory, executeLifecycleRun };
}
