/** Internal repository journal. Import through valopay-store; external access is rejected by the boundary check. */
import { requestLabel, summariseRequest } from "../operation-summary";
import { storedRequestLabel } from "../action-names";
import { LENDER_NOT_FOUND, onlyRoles, sentWithAnotherRole } from "../refusal-words";
import { requestFingerprint } from "../digests";
import {
  markOperationClosed,
  markOperationState,
  type OperationState,
} from "../refused-operations";
import { protectStored, revealStored } from "../protected-payloads";
import { markRolledBack } from "../transaction-outcome";
import {
  beginStatement,
  checkOut,
  databaseLimits,
  DatabaseLimitError,
} from "../database-limits";
import { definitiveRefusalStatuses } from "@workspace/valopay-schema";
import type { Request } from "express";
import { pool, type PoolClient } from "@workspace/db";
import {
  bindRuntimeIdentity,
  runtimeIsolationEnabled,
} from "../runtime-isolation";
import { getAuth } from "@clerk/express";
import type { VerifiedClerkSession } from "../pilot-access";
import type {
  OperationRow,
  StoreContext,
  StoredRequest,
  Session,
} from "./types";
type Dependencies = Pick<
  typeof import("./core"),
  | "sessionFor"
  | "readMerchant"
  | "digest"
  | "fail"
  | "requestOperations"
  | "boundMerchant"
  | "rowsAffected"
  | "lockedMerchant"
  | "scopedMerchantQuery"
  | "conflict"
>;

export type OperationListRow = Pick<
  OperationRow,
  "id" | "label" | "actor" | "role" | "status" | "created_at" | "updated_at"
> & {
  rejected: unknown;
  record_id: unknown;
  record_kind: unknown;
  receipt_id: unknown;
  receipt_kind: unknown;
  answered_kind: string | null;
} & {
  method: string | null;
  path: string | null;
  action: string | null;
  decision: string | null;
  body_status: string | null;
  kind: string | null;
  format: string | null;
  target: string | null;
  target_kind: string | null;
};

/** Why a cancelled request cannot run again, in the words of its original refusal when the same person and role
 * ask and it was refused outright. The receipt may be absent (cancelled from Operations), expired under retention,
 * unreadable or a failure that saved nothing ("try again" would mislead here), so a general sentence stands in. */
export type PriorEntry = Pick<
  OperationRow,
  "id" | "actor" | "role" | "status" | "request_hash" | "receipt"
>;

export type EntryRow = Pick<
  OperationRow,
  "id" | "actor" | "role" | "status" | "request_key"
> & { purged: boolean; request?: unknown };

/** JSON fields are unknown until narrowed; malformed historical receipts keep their existing fallback behavior. */
function objectField(value: unknown, field: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[field]
    : undefined;
}

export function createJournalRepository(dependencies: Dependencies) {
  const {
    sessionFor,
    readMerchant,
    digest,
    requestOperations,
    boundMerchant,
    rowsAffected,
    lockedMerchant,
    scopedMerchantQuery,
    conflict,
  } = dependencies;
  const fail: (message: string, status?: number) => never = dependencies.fail;

  // An entry's request is the keyed write as it was sent, up to the 2 MB body limit, and an entry an earlier build
  // completed keeps its whole answer as its receipt. Only what needs them selects them (a retry, the payload protection
  // batch, a retention run an earlier build prepared): every other read of the journal names the columns it uses, so
  // none parses or digests a body, and none costs more because a lender's entries hold large ones, but for the
  // operations list, which opens its page of requests in the database for their summaries' few fields.
  /** Whether retention purged an entry's payload, read without opening its request: the purge leaves a marker of about
   * 100 bytes in its place, so only a request that small is opened to look for it. */
  const PURGED_REQUEST =
    "CASE WHEN pg_column_size(request)>1024 THEN false ELSE request ? 'purged' END";
  /** A body field the operations summary reads, by jsonb operators: a string of 1 to 100 characters, else nothing. */
  const shortField = (field: string) =>
    `CASE WHEN jsonb_typeof(q#>'{body,${field}}')='string' AND length(q#>>'{body,${field}}') BETWEEN 1 AND 100 THEN q#>>'{body,${field}}' END`;
  /** What Operations lists of an entry: its identity and outcome and, by jsonb operators, the refusal a cancelled request
   * was given, the saved record's ID and kind, and the facts its summary is made from (summariseRequest): the request's
   * method and path and a few short body fields, read only from a request stored as JSON, never a sealed or purged one.
   * The body itself is never selected, so a lender whose entries hold large bodies costs one page of them, opened in
   * the database, and the API parses none. The record the body names, and the one the answer names, are looked up for
   * their kind alone. */
  const OPERATION_LIST = `SELECT o.id,o.label,o.actor,o.role,o.status,o.created_at,o.updated_at,o.receipt->'rejected' AS rejected,
    o.receipt->'record'->'id' AS record_id,o.receipt->'record'->'kind' AS record_kind,o.receipt->'id' AS receipt_id,o.receipt->'kind' AS receipt_kind,
    (SELECT r.kind FROM valopay_records r WHERE r.id=o.receipt->>'id' AND r.merchant_id=o.merchant_id) AS answered_kind,
    f.method,f.path,f.action,f.decision,f.status AS body_status,f.kind,f.format,f.target,(SELECT r.kind FROM valopay_records r WHERE r.id=f.target AND r.merchant_id=o.merchant_id) AS target_kind
  FROM (SELECT id,merchant_id,label,actor,role,status,created_at,updated_at,receipt,request FROM valopay_operations
    WHERE merchant_id=$1 AND owner=$2 ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET $3) o
  LEFT JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(q->'method')='string' AND length(q->>'method')<=10 THEN q->>'method' END AS method,
      CASE WHEN jsonb_typeof(q->'path')='string' AND length(q->>'path')<=1000 THEN q->>'path' END AS path,
      ${shortField("action")} AS action,${shortField("decision")} AS decision,${shortField("status")} AS status,${shortField("kind")} AS kind,${shortField("format")} AS format,
      COALESCE(${["recordId", "targetId", "closeId", "batchId"].map(shortField).join(",")}) AS target
    FROM (SELECT o.request || '{}'::jsonb AS q OFFSET 0) opened WHERE NOT (q ? 'protectedPayload' OR q ? 'purged')) f ON true
  ORDER BY o.created_at DESC,o.id DESC`;
  const operationView = (row: OperationListRow) => {
    const described = summariseRequest({
      method: row.method,
      path: row.path,
      action: row.action,
      decision: row.decision,
      status: row.body_status,
      kind: row.kind,
      format: row.format,
      target: row.target,
      targetKind: row.target_kind,
    });
    const record = textOrNull(row.record_id),
      answered = textOrNull(row.receipt_id);
    return {
      id: row.id,
      // A label an earlier build stored as a spelled-out code reads in words.
      label: storedRequestLabel(row.label),
      actor: row.actor,
      role: row.role,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      message:
        row.status === "completed"
          ? "Valo Pay saved this request."
          : row.status === "cancelled"
            ? row.rejected
              ? `Valo Pay refused this request: ${objectField(row.rejected, "message")} Correct it and send it again.`
              : "Cancelled before it completed. This request cannot run again."
            : "Valo Pay has not confirmed this request yet. Check the original request.",
      // Only a compact result reference. Original payloads and export locations stay private. The saved record's kind is
      // the lender's record's, else the answer's own, else its route's: an export's answer named the kind it exports
      // before the journal recorded the export itself, a sealed request names no route, and some answers name no kind.
      recordId: record ?? answered,
      recordKind: record
        ? textOrNull(row.record_kind)
        : !answered
          ? null
          : (textOrNull(row.answered_kind) ??
            (described?.resultOverrides
              ? described.resultKind
              : (textOrNull(row.receipt_kind) ??
                described?.resultKind ??
                null))),
      summary: described?.summary ?? null,
    };
  };
  /** A receipt field as the journal names it: text, or null for anything else (a sealed receipt, a count, nothing). */
  function textOrNull(value: unknown): string | null {
    return typeof value === "string" && value ? value : null;
  }

  /** The lock of one journal entry: the attempt running its request holds it for its whole transaction (holdOperation). */
  const OPERATION_LOCK = "hashtextextended('valopay.operation:' || $1, 0)";
  /**
   * The journal entry of a keyed request: the one its key already has, or a new
   * pending one. An existing entry is read without the lender's lock, so a repeat
   * of a saved or running request is never turned away by a busy lender before
   * it can be answered for its key. A new entry is made under a lock of the
   * person's own in that lender, so the pending limit holds and a duplicate sent
   * at the same moment binds the same entry (the entry's reference to the lender
   * still waits for a write holding the lender). `created` says whether this
   * attempt made the entry: only that attempt, or a definitive refusal, may close
   * it (rejectOperation). `unused` is told, just before a new entry is made, that
   * nothing is saved under the key (no entry and no stored answer), so a failure
   * that follows may say nothing was saved.
   */
  async function prepareOperation(
    ctx: StoreContext,
    merchantId: string,
    key: string,
    request: StoredRequest,
    unused?: () => void,
  ): Promise<{ id: string; created: boolean }> {
    const session = sessionFor(ctx);
    await readMerchant(ctx, merchantId, "none");
    const owner = session.owner || session.principal,
      id = digest(`operation:${merchantId}:${owner}:${key}`);
    const hash = requestFingerprint(request);
    const existing = async () => {
      // A cancelled entry's receipt holds the refusal its answer repeats; no other part of the entry is read.
      const prior = (
        await session.client.query<PriorEntry>(
          "SELECT id,actor,role,status,request_hash,CASE WHEN status='cancelled' THEN receipt END AS receipt FROM valopay_operations WHERE id=$1 AND merchant_id=$2 AND owner=$3",
          [id, merchantId, owner],
        )
      ).rows[0];
      if (!prior) return undefined;
      // A cancelled entry is final (completeOperation refuses it), whatever the role now: the answer says so, and the
      // person who sent it hears the original reason.
      if (prior.status === "cancelled")
        throw markOperationClosed(
          Object.assign(
            new Error(await cancelledRefusal(ctx, merchantId, prior)),
            { status: 409 },
          ),
        );
      if (prior.request_hash !== hash)
        fail(
          "This request was already sent with different details. Check the original request in Request history first.",
          409,
        );
      if (prior.actor !== ctx.actor || prior.role !== ctx.role)
        fail(sentWithAnotherRole(ctx.accessMode), 403);
      return { id: prior.id, created: false };
    };
    const found = await existing();
    if (found) return found;
    await session.client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('valopay.operations:' || $1 || ':' || $2, 0))",
      [merchantId, owner],
    );
    // Another attempt with the key may have created the entry while this one waited.
    const raced = await existing();
    if (raced) return raced;
    if (!(await receiptStored(session.client, merchantId, key, id))) unused?.();
    if (ctx.role === "Read-only")
      fail(onlyRoles(["Admin", "Operations", "Finance", "Compliance reviewer"], "make changes", ctx.accessMode), 403);
    const count = Number(
      (
        await session.client.query<{ count: string }>(
          "SELECT count(*) FROM valopay_operations WHERE merchant_id=$1 AND owner=$2 AND status='pending'",
          [merchantId, owner],
        )
      ).rows[0]!.count,
    );
    if (count >= 100)
      fail(
        "You have 100 requests that Valo Pay has not confirmed. Check them in Request history before you send more.",
        409,
      );
    // What Request history calls the request once it can no longer be read: its route or action in words.
    const label = requestLabel(request);
    await session.client.query(
      `INSERT INTO valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [
        id,
        merchantId,
        owner,
        ctx.actor,
        ctx.role,
        key,
        hash,
        await protectStored(request, {
          lender: merchantId,
          record: id,
          field: "request",
        }),
        label,
        ctx.now,
      ],
    );
    return { id, created: true };
  }
  /**
   * A journaled write holds its entry, before it waits for the lender, until its
   * transaction ends. A repeat of the request meanwhile (a double submission, a
   * retry after a lost answer) is turned away at once as still running (503 with
   * Retry-After) and leaves the entry to the attempt running it: it neither waits
   * for that attempt nor closes the entry when its own wait fails.
   */
  async function holdOperation(session: Session): Promise<void> {
    const held = (
      await session.client.query<{ held: boolean }>(
        `SELECT pg_try_advisory_xact_lock(${OPERATION_LOCK}) AS held`,
        [session.operationId],
      )
    ).rows[0]?.held;
    if (!held)
      throw markRolledBack(new DatabaseLimitError("operation_running"));
  }
  async function cancelledRefusal(
    ctx: StoreContext,
    merchantId: string,
    prior: PriorEntry,
  ): Promise<string> {
    let reason: unknown;
    if (prior.actor === ctx.actor && prior.role === ctx.role) {
      try {
        const rejected = (
          await revealStored(prior.receipt, {
            lender: merchantId,
            record: prior.id,
            field: "receipt",
          })
        )?.rejected;
        if (
          (definitiveRefusalStatuses as readonly unknown[]).includes(
            rejected?.status,
          )
        )
          reason = rejected.message;
      } catch {
        reason = undefined;
      }
    }
    return typeof reason === "string" && reason.trim()
      ? `Valo Pay refused this request and saved nothing: ${reason.trim()} It cannot run again. Check the latest records, then send a new request.`
      : "This request was cancelled before it completed, and nothing was saved. It cannot run again. Check the latest records, then send a new request.";
  }
  // The journal is read without the lender's lock: a busy lender never holds up Operations, a retry or a cancel's checks.
  async function listOperations(
    ctx: StoreContext,
    merchantId: string,
    offset = 0,
  ) {
    const session = sessionFor(ctx);
    await readMerchant(ctx, merchantId, "none");
    const scope = [merchantId, session.owner || session.principal];
    const total = Number(
      (
        await session.client.query<{ count: string }>(
          "SELECT count(*) FROM valopay_operations WHERE merchant_id=$1 AND owner=$2",
          scope,
        )
      ).rows[0]!.count,
    );
    const items = (
      await session.client.query<OperationListRow>(OPERATION_LIST, [
        ...scope,
        offset,
      ])
    ).rows.map(operationView);
    return { items, total, offset };
  }
  /** How many of the caller's requests in the lender wait for confirmation: the console shows it where a person who
   * reloads sees it. Counted on the journal's pending index; no request is read. */
  async function countPendingOperations(ctx: StoreContext, merchantId: string) {
    const session = sessionFor(ctx);
    await readMerchant(ctx, merchantId, "none");
    const pending = Number(
      (
        await session.client.query<{ count: string }>(
          "SELECT count(*) FROM valopay_operations WHERE merchant_id=$1 AND owner=$2 AND status='pending'",
          [merchantId, session.owner || session.principal],
        )
      ).rows[0]!.count,
    );
    return { pending };
  }
  /** The caller's own entry in the lender, as its current role may act on it. Its receipt is not read, and its request
   * only to repeat it (`withRequest`). */
  async function operationEntry(
    ctx: StoreContext,
    merchantId: string,
    id: string,
    withRequest = false,
  ) {
    const session = sessionFor(ctx);
    await readMerchant(ctx, merchantId, "none");
    const row = (
      await session.client.query<EntryRow>(
        `SELECT id,actor,role,status,request_key,${PURGED_REQUEST} AS purged${withRequest ? ",request" : ""} FROM valopay_operations WHERE id=$1 AND merchant_id=$2 AND owner=$3`,
        [id, merchantId, session.owner || session.principal],
      )
    ).rows[0];
    if (!row)
      fail(
        "Request not found. It may belong to another lender, or to another person.",
        404,
      );
    if (row.actor !== ctx.actor || row.role !== ctx.role) fail(sentWithAnotherRole(ctx.accessMode), 403);
    if (row.purged)
      fail(
        "The details of this request were deleted under the lender’s retention policy, so it cannot run again. Request history keeps its record.",
        410,
      );
    return row;
  }
  /** An entry with its request opened, to repeat it. The receipt is not opened: a retry replays the answer saved for
   * the request. A request that cannot be opened is refused naming the entry's state, so the answer never says nothing
   * was saved for a request that was. */
  async function readOperation(
    ctx: StoreContext,
    merchantId: string,
    id: string,
  ) {
    const {
      purged: _purged,
      request,
      ...entry
    } = await operationEntry(ctx, merchantId, id, true);
    try {
      return {
        ...entry,
        request: (await revealStored(request, {
          lender: merchantId,
          record: id,
          field: "request",
        })) as StoredRequest,
      };
    } catch (error) {
      throw markOperationState(error, entry.status as OperationState);
    }
  }
  /**
   * Where a keyed write's answer is kept for its repeats. A journaled request's is
   * kept under its journal entry's own id: the entry holds one person's request
   * on one route, so the same key used on another route, or by a colleague,
   * never answers it or leaves its entry stranded. A write the journal does not
   * record (a demo persona switch) keeps it under its key in a name of its own.
   * `earlier` is where an earlier build kept every answer, under the key alone
   * (with the connected workspace's prefix): it is read, never written, so a
   * request saved before still replays.
   */
  function receiptOf(
    req: Request,
    merchantId: string,
    key: string,
    kind: "workspace" | "connected" | "persona",
  ) {
    const earlier = digest(
      `${kind === "connected" ? "connected:" : ""}${merchantId}:${key}`,
    );
    const entry = requestOperations.get(req)?.id;
    return {
      id:
        entry ??
        (kind === "persona" ? digest(`persona:${merchantId}:${key}`) : earlier),
      earlier,
    };
  }
  /** Every place a journal entry's answer may be kept: its own id, then the key alone as earlier builds kept it. */
  const receiptIds = (merchantId: string, key: string, entryId: string) => [
    entryId,
    digest(`${merchantId}:${key}`),
    digest(`connected:${merchantId}:${key}`),
  ];
  /** Whether an answer is stored for this entry's request. An entry that is not completed but has one belongs to a
   * write saved outside the journal, before it existed: that request was saved, so its entry is never cancelled. */
  async function receiptStored(
    client: PoolClient,
    merchantId: string,
    key: string,
    entryId: string,
  ): Promise<boolean> {
    return (
      (
        await client.query(
          "SELECT 1 FROM valopay_idempotency WHERE merchant_id=$1 AND id=ANY($2::text[])",
          [merchantId, receiptIds(merchantId, key, entryId)],
        )
      ).rows.length > 0
    );
  }
  async function cancelOperation(
    ctx: StoreContext,
    merchantId: string,
    id: string,
  ) {
    const session = sessionFor(ctx);
    await readMerchant(ctx, merchantId, "update");
    const row = await operationEntry(ctx, merchantId, id);
    if (row.status === "completed")
      fail(
        "This request has already completed. Reload Request history to see its saved result.",
        409,
      );
    if (
      await receiptStored(session.client, merchantId, row.request_key, row.id)
    )
      fail(
        "This request already has a saved result. Check the original request to see it.",
        409,
      );
    await session.client.query(
      "UPDATE valopay_operations SET status='cancelled',updated_at=$4 WHERE id=$1 AND merchant_id=$2 AND owner=$3 AND status='pending'",
      [id, merchantId, session.owner || session.principal, ctx.now],
    );
    return {
      message:
        "Valo Pay confirmed this request had not completed, and cancelled it. It cannot run again.",
    };
  }
  /** Resolve only this person's exact key and original role, without returning its private request body. */
  async function lookupOwnOperation(
    ctx: StoreContext,
    merchantId: string,
    input: { key: string; method: "POST" | "PATCH"; path: string },
  ) {
    const session = sessionFor(ctx);
    await readMerchant(ctx, merchantId, "none");
    const owner = session.owner || session.principal,
      id = digest(`operation:${merchantId}:${owner}:${input.key}`);
    const query = OPERATION_LIST.replace(
      "WHERE merchant_id=$1 AND owner=$2 ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET $3",
      "WHERE merchant_id=$1 AND owner=$2 AND id=$3 AND actor=$4 AND role=$5",
    );
    const row = (
      await session.client.query<OperationListRow>(query, [
        merchantId,
        owner,
        id,
        ctx.actor,
        ctx.role,
      ])
    ).rows[0];
    return { operation: row ? operationView(row) : null };
  }
  /** Fence a key even when its original request has not arrived yet. Absence alone is never permission to resubmit.
   * The journal-creation lock orders this fence against prepareOperation; the lender lock then waits for any write
   * already running. Both locks last through commit. A delayed request sees the terminal entry and cannot execute. */
  async function cancelOwnOperation(
    ctx: StoreContext,
    merchantId: string,
    input: { key: string; method: "POST" | "PATCH"; path: string },
  ) {
    const session = sessionFor(ctx);
    await readMerchant(ctx, merchantId, "none");
    if (ctx.role === "Read-only")
      fail(onlyRoles(["Admin", "Operations", "Finance", "Compliance reviewer"], "cancel requests", ctx.accessMode), 403);
    const owner = session.owner || session.principal,
      id = digest(`operation:${merchantId}:${owner}:${input.key}`);
    await session.client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('valopay.operations:' || $1 || ':' || $2, 0))",
      [merchantId, owner],
    );
    await readMerchant(ctx, merchantId, "update");
    const found = (
      await session.client.query(
        "SELECT id FROM valopay_operations WHERE id=$1 AND merchant_id=$2 AND owner=$3",
        [id, merchantId, owner],
      )
    ).rows[0];
    if (found) return cancelOperation(ctx, merchantId, id);
    if (await receiptStored(session.client, merchantId, input.key, id))
      fail(
        "This request already has a saved result. Check the original request to see it.",
        409,
      );
    const fence = {
      method: input.method,
      path: input.path,
      body: null,
      cancelledBeforeReceipt: true,
    };
    await session.client.query(
      `INSERT INTO valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Cancelled interrupted submission','cancelled',$9,$9)`,
      [
        id,
        merchantId,
        owner,
        ctx.actor,
        ctx.role,
        input.key,
        requestFingerprint(fence),
        await protectStored(fence, {
          lender: merchantId,
          record: id,
          field: "request",
        }),
        ctx.now,
      ],
    );
    return {
      message:
        "Valo Pay cancelled this request. Even if the original arrives later, it will not run. You can now send the change again.",
    };
  }
  /**
   * After a request bound to a journal entry was refused or failed, closes the
   * entry when it may be closed, and resolves to its state afterwards (undefined
   * when there is no entry). Runs in its own transaction, after the request's own
   * transaction ended. `close` says why it may close: a definitive refusal (a 4xx
   * the same request would receive again, `refused`) closes it whatever else is
   * running, and an attempt already past its checks is then refused at
   * completeOperation; a failure that saved nothing (`unsaved`), of the attempt
   * that created the entry, closes it only while no other attempt holds it
   * (holdOperation), so a repeat's failure never cancels the request its original
   * attempt is still running. A closed entry neither waits for confirmation nor
   * counts towards the pending limit, and its key cannot run again. Without
   * `close`, the state is only read, for the answer to say. An entry an earlier
   * attempt completed stays `completed`; one cancelled meanwhile (by another
   * attempt's refusal, or from Operations) is `cancelled`; an entry held by an
   * attempt running it is `running`. As in cancelOperation, an entry whose
   * request has a stored answer (a write saved before the journal existed) stays
   * pending, and is `completed` for the answer: that request was saved.
   */
  async function rejectOperation(
    req: Request,
    bound: { id: string; merchantId: string },
    rejection: { status: number; message: string },
    close: "refused" | "unsaved" | undefined,
  ): Promise<OperationState | undefined> {
    const guard = await checkOut(() => pool.connect()),
      client = guard.client;
    try {
      await client.query(beginStatement(databaseLimits().request));
      if (runtimeIsolationEnabled()) {
        const verified = getAuth(req) as unknown as VerifiedClerkSession;
        await bindRuntimeIdentity(client, {
          organizationId: verified.orgId || "",
          userId: verified.userId || "",
        });
      }
      // Held by this transaction when no attempt is running the request; kept until it ends, so none starts meanwhile.
      const idle =
        (
          await client.query<{ held: boolean }>(
            `SELECT pg_try_advisory_xact_lock(${OPERATION_LOCK}) AS held`,
            [bound.id],
          )
        ).rows[0]?.held === true;
      // The row lock orders this against an attempt completing the entry: whichever commits first decides.
      const entry = (
        await client.query<{ status: string; request_key: string }>(
          "SELECT status,request_key FROM valopay_operations WHERE id=$1 AND merchant_id=$2 FOR UPDATE",
          [bound.id, bound.merchantId],
        )
      ).rows[0];
      let state = entry?.status as OperationState | undefined;
      if (entry?.status === "pending") {
        if (
          await receiptStored(
            client,
            bound.merchantId,
            entry.request_key,
            bound.id,
          )
        )
          state = "completed";
        else if (close === "refused" || (close === "unsaved" && idle)) {
          const receipt = await protectStored(
            { rejected: rejection },
            { lender: bound.merchantId, record: bound.id, field: "receipt" },
          );
          await client.query(
            "UPDATE valopay_operations SET status='cancelled',receipt=$3,updated_at=now() WHERE id=$1 AND merchant_id=$2 AND status='pending'",
            [bound.id, bound.merchantId, receipt],
          );
          state = "cancelled";
        } else if (!idle) state = "running";
      }
      const committed = await client.query("COMMIT");
      return committed.command === "COMMIT" ? state : undefined;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* the transaction is already closed */
      }
      throw error;
    } finally {
      guard.release();
    }
  }
  /**
   * What the journal keeps of a completed request's answer: a reference to the
   * record it saved, the only part Operations reads (its "Open saved result"
   * link). The whole answer is stored once in valopay_idempotency, under the
   * request's journal entry (receiptOf), and that copy is what a retried key or
   * a retry from Operations replays. A daily close answers with its whole record, about
   * 100 KB for a pilot-scale lender, and used to be stored in both tables.
   * Entries completed earlier keep their whole answer until retention removes it.
   * The reference names only the saved record's ID and kind, so it is stored
   * unsealed: sealed, Operations could not read it without the key service.
   */
  /** A journal receipt that is only such a reference, which is never sealed. */
  function isJournalReference(value: unknown): boolean {
    return (
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every(
        (key) => key === "record" || key === "id" || key === "kind",
      )
    );
  }
  function journalReceipt(response: unknown): {
    id?: string;
    kind?: string;
    record?: { id: string; kind?: string };
  } {
    const reference = (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
      const { id, kind } = value as { id?: unknown; kind?: unknown };
      return typeof id === "string"
        ? { id, ...(typeof kind === "string" ? { kind } : {}) }
        : undefined;
    };
    const record = reference(
        (response as { record?: unknown } | null | undefined)?.record,
      ),
      own = reference(response);
    // An export job's answer names the kind of record it exports: the record it saved is the export.
    const exported =
      own &&
      typeof (response as { downloadUrl?: unknown }).downloadUrl === "string";
    return {
      ...(record ? { record } : {}),
      ...(exported ? { ...own, kind: "exports" } : own),
    };
  }
  /** Receipt and domain writes commit together. A process crash cannot leave a
   * completed journal entry without the corresponding business write.
   *
   * A cancelled entry never completes. This guard is what makes cancellation
   * final: an attempt already past its checks when a retry's refusal (or
   * Cancel if unfinished) cancelled its entry is refused here and rolls back,
   * so an answer that says `operation: "cancelled"` proves that nothing sent
   * with the key was saved. Every journaled write must commit through this
   * function for that to hold. */
  async function completeOperation(ctx: StoreContext, receipt: unknown) {
    const session = sessionFor(ctx);
    if (!session.operationId) return;
    const merchantId = boundMerchant(session),
      owner = session.owner || session.principal;
    const result = await session.client.query(
      `UPDATE valopay_operations SET status='completed',receipt=$5,updated_at=$6
    WHERE id=$1 AND merchant_id=$2 AND owner=$3 AND actor=$4 AND status<>'cancelled'`,
      [
        session.operationId,
        merchantId,
        owner,
        ctx.actor,
        journalReceipt(receipt),
        ctx.now,
      ],
    );
    if (rowsAffected(result)) return;
    const current = (
      await session.client.query<{ status: string }>(
        "SELECT status FROM valopay_operations WHERE id=$1 AND merchant_id=$2 AND owner=$3",
        [session.operationId, merchantId, owner],
      )
    ).rows[0];
    if (current?.status === "cancelled")
      fail(
        "This request was cancelled before it completed. Nothing was saved, and it cannot run again.",
        409,
      );
    fail(
      "This request is no longer waiting to be saved. Reload Request history to see where it stands.",
      409,
    );
  }

  /** The stored answer for an idempotency key, when the request was already made: kept under `id` (receiptOf), or
   * under `earlier`, where an earlier build kept it. */
  async function findIdempotency(
    context: StoreContext,
    id: string,
    earlier?: string,
  ) {
    const session = sessionFor(context);
    const merchantId = boundMerchant(session);
    const found = (
      await session.client.query<{
        id: string;
        request_hash: string;
        response: unknown;
      }>(
        `SELECT i.id,i.request_hash,i.response FROM valopay_idempotency i JOIN valopay_merchants m ON m.id=i.merchant_id
     JOIN valopay_workspaces w ON w.id=m.workspace_id
     WHERE i.id=ANY($1::text[]) AND i.merchant_id=$2 AND m.workspace_id=$3 AND w.id=$3 AND w.principal_hash=$4
     ORDER BY i.id=$5 DESC LIMIT 1`,
        [
          earlier === undefined || earlier === id ? [id] : [id, earlier],
          merchantId,
          session.workspace.id,
          session.principal,
          id,
        ],
      )
    ).rows[0];
    if (objectField(found?.response, "purged"))
      fail(
        "This request has already completed, and its saved details have since been deleted. It cannot run again.",
        410,
      );
    return found
      ? {
          request_hash: found.request_hash,
          response: await revealStored(found.response, {
            lender: merchantId,
            record: found.id,
            field: "response",
          }),
        }
      : undefined;
  }
  /**
   * A keyed write's stored answer before its lender is loaded: the transaction
   * is bound to the lender without its lock (the workspace and, for staff, the
   * person's lender access are checked as for any load), so a repeat of a saved
   * request is answered without loading the lender or waiting for it. A caller
   * that finds nothing loads the lender and looks again: an attempt that
   * finished meanwhile is visible once the journal entry is held.
   */
  async function findStoredAnswer(
    context: StoreContext,
    merchantId: string,
    id: string,
    earlier?: string,
  ) {
    await readMerchant(context, merchantId, "none");
    return findIdempotency(context, id, earlier);
  }
  /** Stores the answer where receiptOf keeps it (`id`), with the request's fingerprint, so a replay with different input is refused. */
  async function saveIdempotency(
    context: StoreContext,
    id: string,
    requestHash: string,
    response: unknown,
  ) {
    const session = sessionFor(context);
    const merchantId = lockedMerchant(session);
    const owned = await session.client.query(scopedMerchantQuery(), [
      merchantId,
      session.workspace.id,
      session.principal,
    ]);
    if (!owned.rows[0]) fail(LENDER_NOT_FOUND, 404);
    try {
      const inserted = await session.client.query(
        `INSERT INTO valopay_idempotency(id,merchant_id,request_hash,response)
       SELECT $1,$2,$3,$4 WHERE EXISTS (
         SELECT 1 FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
         WHERE m.id=$2 AND m.workspace_id=$5 AND w.id=$5 AND w.principal_hash=$6)`,
        [
          id,
          merchantId,
          requestHash,
          await protectStored(response, {
            lender: merchantId,
            record: id,
            field: "response",
          }),
          session.workspace.id,
          session.principal,
        ],
      );
      if (!rowsAffected(inserted))
        fail(LENDER_NOT_FOUND, 404);
      await completeOperation(context, response);
    } catch (error) {
      if (objectField(error, "code") === "23505")
        conflict(
          "This request is already being saved. Wait a moment, then check the original request.",
        );
      throw error;
    }
  }
  return {
    PURGED_REQUEST,
    prepareOperation,
    holdOperation,
    listOperations,
    countPendingOperations,
    readOperation,
    receiptOf,
    receiptIds,
    cancelOperation,
    lookupOwnOperation,
    cancelOwnOperation,
    rejectOperation,
    isJournalReference,
    journalReceipt,
    completeOperation,
    findIdempotency,
    findStoredAnswer,
    saveIdempotency,
  };
}
