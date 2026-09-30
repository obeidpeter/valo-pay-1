/** Owns transactions, locks and the private context-to-session map. Feature factories receive internal capabilities only; the public facade never exports them. */
import {
  sha256Hex,
  canonicalDigest,
  auditEntryData,
  verifyAuditChain,
  walkAuditChain,
  chainSequence,
  AUDIT_GENESIS,
} from "../digests";
import type { Context, DomainState, ValopayRecord } from "../../domain/types";
import { recordChanged, nextRecordVersion } from "../edit-versions";
import type { Request, Response } from "express";
import { pool, poolSize, type PoolClient } from "@workspace/db";
import { createLenderGate } from "../lender-gate";
import { LENDER_NOT_FOUND, UNKNOWN_DEMO_ROLE } from "../refusal-words";
import {
  beginStatement,
  checkOut,
  databaseLimits,
  failedTransaction,
  DatabaseLimitError,
  type Checkout,
} from "../database-limits";
import { signedInUser, staffMode, verifyStaff } from "../staff-access";
import { getAuth } from "@clerk/express";
import {
  createSandboxCreationLimits,
  creationRefusalMessage,
  WORKSPACE_CREATION_RETRY_AFTER_SECONDS,
} from "../creation-limit";
import {
  readSandboxCookie,
  sandboxPrincipal,
  secureRequest,
  writeSandboxCookie,
} from "../sandbox-cookie";
import { randomBytes, randomUUID } from "node:crypto";
import {
  protectStored,
  revealStored,
  protectRecordData,
  revealRecordsData,
  payloadEncryptionKey,
  isProtectedPayload,
  PROTECTED_IMPORT_FIELDS,
  type ProtectedImportField,
} from "../protected-payloads";
import {
  closeTimeOf,
  nextCloseInstant,
  sameJson,
} from "@workspace/valopay-schema";
import { databaseMoney } from "../database-money";
import { markRolledBack } from "../transaction-outcome";
import type { VerifiedClerkSession } from "../pilot-access";
import {
  bindRuntimeIdentity,
  bindRuntimeService,
  runtimeIsolationEnabled,
  runtimeServiceRead,
} from "../runtime-isolation";
import { rememberSandbox } from "../request-limits";
import type { AuditVerification } from "../../domain/alerts";
import { watDate } from "../../domain/calendar";
import { assertFinalState } from "../../domain/final-state-integrity";
import {
  financialProjectionSchema,
  syncFinancialProjection,
} from "../financial-projection";
import { seedMerchant } from "../valopay-seed";
import { nextCloseRetry, type CloseRetry } from "../../domain/close";
import { recordsOf } from "../../domain/records";
import type {
  StateSnapshot,
  StoreContext,
  Session,
  RecordRow,
  OperationRow,
  MerchantLock,
  WorkspaceAccess,
  SweptExportFile,
  WorkspaceRow,
  StaffRow,
  MerchantRow,
  ChainPoint,
  AuditChain,
} from "./types";
import type { SweepLog } from "./export-cleanup";
import { createJournalRepository } from "./journal";
import { createTeamAccessRepository } from "./team-access";
import { createPayloadRewrapRepository } from "./payload-rewrap";
import { createReadModelsRepository } from "./read-models";
import { createRetentionRepository } from "./retention";
import { createExportCleanupRepository } from "./export-cleanup";
import { createReadinessRepository } from "./readiness";

/** The demo persona roles, the same list as the shared schema's. */
export const roles = [
  "Admin",
  "Operations",
  "Finance",
  "Compliance reviewer",
  "Read-only",
];
/** SHA-256 of a string, as hex. */
export const digest = sha256Hex;
const snapshotOf = (state: DomainState): StateSnapshot => ({
  merchant: JSON.stringify(state.merchant),
  settings: JSON.stringify(state.settings),
  records: new Map(
    state.records.map((record) => [record.id, JSON.stringify(record)]),
  ),
});
/**
 * One JSON pass: the records added or changed since the lender was loaded,
 * and the IDs left untouched. Only a record whose JSON differs is compared in
 * canonical form (recordChanged), so a reordering of keys is not a change.
 */
function changesSince(
  snapshot: StateSnapshot,
  state: DomainState,
): { changed: ValopayRecord[]; unchanged: Set<string> } {
  const changed: ValopayRecord[] = [],
    unchanged = new Set<string>();
  for (const record of state.records) {
    const loaded = snapshot.records.get(record.id);
    if (loaded !== undefined && !recordChanged(loaded, record))
      unchanged.add(record.id);
    else changed.push(record);
  }
  return { changed, unchanged };
}
/** Every changed stored record gets a strictly newer version, even when two actions share a millisecond. */
function advanceChanged(
  snapshot: StateSnapshot,
  changed: ValopayRecord[],
  now: string,
): void {
  for (const record of changed) {
    const original = snapshot.records.get(record.id);
    if (original === undefined) continue;
    record.updatedAt = nextRecordVersion(
      record,
      (JSON.parse(original) as ValopayRecord).updatedAt,
      now,
    );
  }
}
const sessions = new WeakMap<StoreContext, Session>();
export const requestOperations = new WeakMap<
  Request,
  { id: string; merchantId: string; created: boolean }
>();
/** Binds a request to its journal entry; `created` says this attempt created the entry (prepareOperation). */
export function bindOperation(
  req: Request,
  id: string,
  merchantId: string,
  created = false,
) {
  requestOperations.set(req, { id, merchantId, created });
}
/** The journal entry the recovery middleware bound to this request, if any. */
export function boundOperation(req: Request) {
  return requestOperations.get(req);
}
const databaseConflictCodes = new Set(["23503", "23505", "23514", "P0001"]);
/**
 * Connection fairness, per tenant and per lender: one tenant's requests for
 * its lenders hold at most a third of this process's connections, and those
 * for one of its lenders at most half of that (at least one each), so neither
 * a busy lender nor a busy sandbox with its own lenders can take the pool from
 * everyone else. A request past either share waits, without a connection, for
 * up to the lock limit in all.
 */
export const tenantConnections = Math.max(1, Math.floor(poolSize / 3));
export const lenderConnections = Math.max(1, Math.ceil(tenantConnections / 2));
const tenantGate = createLenderGate({
  capacity: tenantConnections,
  waitMs: () => databaseLimits().request.lockMs,
});
const lenderGate = createLenderGate({
  capacity: lenderConnections,
  waitMs: () => databaseLimits().request.lockMs,
});
/**
 * The gate lanes of the lender a request names: every lender-scoped route
 * carries it as the merchantId query value. The value is read before anything
 * is authorised, so the lanes are the caller's own (the staff organisation, or
 * the sandbox principal) and its lender's: a caller that names another
 * tenant's lender only queues behind its own requests, never that tenant's.
 */
function gatedLanes(
  req: Request,
  principal: string,
): { tenant: string; lender: string } | undefined {
  const lender = (req.query as Record<string, unknown> | undefined)?.merchantId;
  if (typeof lender !== "string" || lender.length < 1 || lender.length > 100)
    return undefined;
  const caller = staffMode()
    ? `org:${getAuth(req).orgId || ""}`
    : `principal:${principal}`;
  return { tenant: caller, lender: `${caller}\u0000${lender}` };
}
/** Enters a request's lender lane, then its tenant's, within one wait: a request waiting for its tenant holds no other lender's place. */
async function enterGate(
  lanes: { tenant: string; lender: string },
  write: boolean,
): Promise<() => void> {
  const deadline = Date.now() + databaseLimits().request.lockMs;
  const leaveLender = await lenderGate.enter(lanes.lender, write);
  try {
    const leaveTenant = await tenantGate.enter(
      lanes.tenant,
      write,
      Math.max(1, deadline - Date.now()),
    );
    return () => {
      leaveTenant();
      leaveLender();
    };
  } catch (error) {
    leaveLender();
    throw error;
  }
}

/** Throws an error carrying the HTTP status the error handler answers with (400 unless given). */
export function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
export const conflict = (
  message = "This change conflicts with the lender’s latest records. Reload the page and try again.",
): never => fail(message, 409);
/** Anonymous sandboxes expire after this many days without a change; the cookie carries the same lifetime. */
export const ANONYMOUS_WORKSPACE_DAYS = 30;
/** Lenders a sandbox workspace can hold, the two samples included, so one visitor cannot fill the scheduler's queue. */
export const SANDBOX_LENDER_LIMIT = 5;
/** How many expired sandboxes one bootstrap removes, so a request never pays for a large backlog. */
const SWEEP_BATCH = 5;
/** Automatic deletion is opt-in so importing the application cannot remove existing workspaces. */
export const expiredWorkspaceCleanupEnabled = (value: string | undefined) =>
  value === "on";
/** Actor prefix for platform-initiated changes (the seed, the scheduled close); the expiry sweep does not count them as sandbox activity. */
export const SYSTEM_ACTOR_PREFIX = "System · ";
/** A UTC ISO instant as the platform writes it; guards the timestamptz cast on the stored close cursor. */
const ISO_INSTANT_PATTERN =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$";
const sandboxCreation = createSandboxCreationLimits();

function principalFor(req: Request, res: Response) {
  const userId = signedInUser(req);
  if (staffMode() && !userId)
    fail(
      "Sign in with your pilot staff account. Anonymous access is unavailable in this environment.",
      401,
    );
  if (userId)
    return {
      principal: digest(`clerk:${userId}`),
      authenticated: true,
      address: req.ip,
    };
  // A request with two different sandbox tokens is refused here, before anything is read (sandbox-cookie.ts).
  const secure = secureRequest(req),
    cookie = readSandboxCookie(req.headers.cookie, secure);
  const token = cookie.token ?? randomBytes(32).toString("hex");
  // The cookie slides: an active sandbox keeps its 30 days from the last visit, matching the expiry sweep below.
  writeSandboxCookie(
    res,
    cookie,
    token,
    secure,
    ANONYMOUS_WORKSPACE_DAYS * 86400000,
  );
  return {
    principal: sandboxPrincipal(token),
    authenticated: false,
    address: req.ip,
  };
}

export function sessionFor(context: StoreContext): Session {
  const session = sessions.get(context);
  if (!session || !session.active)
    fail("This request can no longer change the lender. Try again.", 409);
  return session;
}
/** Whether this request's own transaction verified the restricted database: the readiness page reports this, never the configuration alone. */
export function runtimeIsolationVerified(context: StoreContext): boolean {
  return sessionFor(context).isolationVerified === true;
}
export function systemWorkspaceMatches(
  context: StoreContext,
  workspaceId: string,
): boolean {
  return (
    context.actor.startsWith(SYSTEM_ACTOR_PREFIX) &&
    sessionFor(context).workspace.id === workspaceId
  );
}
export async function verifyWorkspaceEncryption(context: StoreContext) {
  const session = teamAdmin(context);
  if (!payloadEncryptionKey())
    fail(
      "Configure managed payload encryption before running this check.",
      503,
    );
  const scope = {
      lender: session.workspace.id,
      record: randomUUID(),
      field: "synthetic-key-check",
    },
    value = { synthetic: true, nonce: randomUUID() };
  const sealed = await protectStored(value, scope),
    opened = await revealStored(sealed, scope);
  if (!sameJson(value, opened)) fail("The encryption check failed.", 503);
  await staffEvent(
    session.client,
    session.workspace.id,
    context.actor,
    "encryption.verified",
    "workspace",
    { synthetic: true, checkedAt: context.now },
  );
  return {
    message:
      "Managed encryption and decryption succeeded for a synthetic payload.",
    checkedAt: context.now,
    verified: true,
  };
}
/** Bounded, repeatable protection of legacy payloads. Metadata and request
 * fingerprints remain stable; no recovery key is erased or reused. */
export async function protectWorkspacePayloads(context: StoreContext) {
  const session = teamAdmin(context);
  if (!payloadEncryptionKey())
    fail("Configure managed payload encryption first.", 503);
  // One record per request bounds managed-key calls and keeps progress restartable.
  const batch = 1;
  let protectedCount = 0;
  const imports = (
    await session.client.query<RecordRow>(
      `SELECT r.* FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id WHERE m.workspace_id=$1 AND r.kind='import-batches' AND (r.data ? 'csv' AND NOT (jsonb_typeof(r.data->'csv')='object' AND r.data->'csv' ? 'protectedPayload')) ORDER BY r.id LIMIT $2 FOR UPDATE OF r`,
      [session.workspace.id, batch],
    )
  ).rows;
  for (const row of imports) {
    await session.client.query(
      "UPDATE valopay_records SET data=$3 WHERE id=$1 AND merchant_id=$2",
      [row.id, row.merchant_id, await protectRecordData(rowToRecord(row))],
    );
    protectedCount++;
  }
  const operations = (
    await session.client.query<OperationRow>(
      `SELECT o.* FROM valopay_operations o JOIN valopay_merchants m ON m.id=o.merchant_id WHERE m.workspace_id=$1 AND ((NOT(o.request ? 'protectedPayload') AND NOT(o.request ? 'purged')) OR (o.receipt IS NOT NULL AND NOT(o.receipt ? 'protectedPayload') AND NOT(o.receipt ? 'purged') AND CASE WHEN jsonb_typeof(o.receipt)='object' THEN o.receipt-'record'-'id'-'kind'<>'{}'::jsonb ELSE true END)) ORDER BY o.id LIMIT $2 FOR UPDATE OF o`,
      [session.workspace.id, batch],
    )
  ).rows;
  for (const row of operations) {
    if (protectedCount) break;
    const scope = { lender: row.merchant_id, record: row.id };
    const request = isProtectedPayload(row.request)
      ? row.request
      : await protectStored(row.request, { ...scope, field: "request" });
    const receipt =
      row.receipt === null ||
      isProtectedPayload(row.receipt) ||
      isJournalReference(row.receipt)
        ? row.receipt
        : await protectStored(row.receipt, { ...scope, field: "receipt" });
    await session.client.query(
      "UPDATE valopay_operations SET request=$3,receipt=$4 WHERE id=$1 AND merchant_id=$2",
      [row.id, row.merchant_id, request, receipt],
    );
    protectedCount++;
  }
  const receipts = (
    await session.client.query<{
      id: string;
      merchant_id: string;
      response: unknown;
    }>(
      `SELECT i.* FROM valopay_idempotency i JOIN valopay_merchants m ON m.id=i.merchant_id WHERE m.workspace_id=$1 AND NOT(i.response ? 'protectedPayload') AND NOT(i.response ? 'purged') ORDER BY i.id LIMIT $2 FOR UPDATE OF i`,
      [session.workspace.id, batch],
    )
  ).rows;
  for (const row of receipts) {
    if (protectedCount) break;
    await session.client.query(
      "UPDATE valopay_idempotency SET response=$3 WHERE id=$1 AND merchant_id=$2",
      [
        row.id,
        row.merchant_id,
        await protectStored(row.response, {
          lender: row.merchant_id,
          record: row.id,
          field: "response",
        }),
      ],
    );
    protectedCount++;
  }
  await staffEvent(
    session.client,
    session.workspace.id,
    context.actor,
    "encryption.protected",
    "workspace",
    { protectedCount, at: context.now },
  );
  return {
    message: protectedCount
      ? "Protected another batch of stored payloads. Run again until no payloads remain."
      : "No unprotected import or recovery payloads remain in this workspace.",
    protectedCount,
    mayHaveMore: protectedCount > 0,
  };
}
export function rowsAffected(result: { rowCount: number | null }): boolean {
  return (result.rowCount || 0) === 1;
}
export function rowToRecord(row: RecordRow): ValopayRecord {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    reference: row.reference,
    amountKobo: databaseMoney(row.amount_kobo),
    customerId: row.customer_id,
    data: row.data,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
export function scopedMerchantQuery(lock: MerchantLock = "none") {
  return `SELECT m.id,m.info,m.settings FROM valopay_merchants m
    JOIN valopay_workspaces w ON w.id=m.workspace_id
    WHERE m.id=$1 AND m.workspace_id=$2 AND w.id=$2 AND w.principal_hash=$3${lock === "update" ? " FOR UPDATE OF m" : lock === "share" ? " FOR SHARE OF m" : ""}`;
}

/**
 * The workspace's own lock, taken before its row: shared by ordinary work,
 * exclusive for a team, lender-access, invitation or persona change.
 * PostgreSQL grants advisory locks in arrival order, so a request that arrives
 * while a change waits queues behind it; a row share lock is granted past a
 * waiting exclusive one, so steady polling could hold a revocation off for
 * ever. The wait is the transaction's own lock limit (database-limits.ts):
 * past it a change answers 503 and nothing changed, and a request queued
 * behind a change that holds the lock too long is turned away the same way.
 * The key's prefix keeps it apart from the principal's bootstrap lock.
 */
export async function lockWorkspace(
  client: PoolClient,
  workspaceId: string,
  mode: "shared" | "exclusive",
  write: boolean,
): Promise<void> {
  try {
    await client.query(
      `SELECT ${mode === "exclusive" ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared"}(hashtextextended('valopay.workspace:' || $1, 0))`,
      [workspaceId],
    );
  } catch (error) {
    if ((error as { code?: unknown }).code !== "55P03") throw error;
    throw markRolledBack(
      new DatabaseLimitError(
        mode === "exclusive" ? "workspace_busy" : "workspace_changing",
        { write, cause: error },
      ),
    );
  }
}

/** Persona, team, lender-access and invitation changes take the workspace
 * lock exclusively (lockWorkspace). Ordinary work shares it, fixing the
 * persona and memberships for the transaction while lender locks serialize
 * mutations; a change waits only for the work already running, and work that
 * arrives meanwhile waits behind the change. The workspace row is still locked
 * after it (shared or exclusive), so the expiry sweep skips busy workspaces.
 * Only first-visit bootstrap needs the principal advisory lock. Every
 * transaction is bounded (database-limits.ts): a lock wait, a statement and
 * idle time each have a limit, and a tenant holds at most a third of the pool
 * (one of its lenders half of that), so a busy lender or a busy sandbox turns
 * its own requests away with a 503 instead of taking every connection.
 *
 * A read answers from one snapshot (REPEATABLE READ): it takes no lender lock,
 * so it never waits for a lender's writes and sees the state before any write
 * still running, and all its statements see the same state. Its identity
 * checks are those of a write (the workspace lock and row, the membership
 * locked for share, which refuses a request whose access changed while it
 * waited), after which the transaction is read only. A first visit creates its
 * sandbox in a read-committed transaction instead, as a write does. */
export async function inWorkspace<T>(
  req: Request,
  res: Response,
  fn: (context: StoreContext) => Promise<T>,
  access: WorkspaceAccess = "write",
): Promise<T> {
  const identity = principalFor(req, res);
  const write = access !== "read",
    lanes = gatedLanes(req, identity.principal);
  const leave = lanes ? await enterGate(lanes, write) : undefined;
  let guard: Checkout<PoolClient> | undefined;
  let context: StoreContext | undefined,
    committing = false,
    isolationVerified = false,
    snapshotRead = access === "read";
  // Export files of sandboxes this bootstrap swept, and of those, the ones whose deletion committed (removeSweptExportFiles).
  let swept: SweptExportFile[] = [],
    sweptAndCommitted: SweptExportFile[] = [];
  try {
    guard = await checkOut(() => pool.connect(), write);
    const client = guard.client;
    const exclusive = access === "persona" || access === "team",
      lockMode = exclusive ? "exclusive" : "shared";
    const workspaceQuery = `SELECT id,principal_hash,role FROM valopay_workspaces WHERE principal_hash=$1 AND id=$2 FOR ${exclusive ? "UPDATE" : "SHARE"}`;
    /** The principal's sandbox, found without a lock and then locked; one removed meanwhile (the expiry sweep) is created afresh. */
    const lockedSandbox = async (): Promise<WorkspaceRow | undefined> => {
      const found = (
        await client.query<{ id: string }>(
          "SELECT id FROM valopay_workspaces WHERE principal_hash=$1",
          [identity.principal],
        )
      ).rows[0];
      if (!found) return undefined;
      await lockWorkspace(client, found.id, lockMode, write);
      return (
        await client.query<WorkspaceRow>(workspaceQuery, [
          identity.principal,
          found.id,
        ])
      ).rows[0];
    };
    let now = "";
    let workspace: WorkspaceRow | undefined;
    let staff: StaffRow | undefined;
    let auth: VerifiedClerkSession | undefined;
    for (let attempt = 1; ; attempt += 1) {
      await client.query(
        beginStatement(
          databaseLimits().request,
          snapshotRead ? "ISOLATION LEVEL REPEATABLE READ" : undefined,
        ),
      );
      if (runtimeIsolationEnabled()) {
        const verified = getAuth(req) as unknown as VerifiedClerkSession;
        isolationVerified = await bindRuntimeIdentity(client, {
          organizationId: verified.orgId || "",
          userId: verified.userId || "",
        });
      }
      // Single source of time: the database clock, read once per transaction.
      now = (
        await client.query<{ now: Date }>("SELECT now() AS now")
      ).rows[0]!.now.toISOString();
      if (staffMode()) {
        auth = getAuth(req) as unknown as VerifiedClerkSession;
        if (access === "persona")
          fail(
            "Staff roles are assigned by an administrator. Demo role switching is unavailable.",
            403,
          );
        // Lock the organisation before its membership, consistently with team
        // changes. A revocation waits for in-flight work and blocks later work.
        const found = (
          await client.query<{ id: string }>(
            "SELECT w.id FROM valopay_workspaces w JOIN valopay_teams t ON t.workspace_id=w.id WHERE t.organization_id=$1",
            [auth.orgId || ""],
          )
        ).rows[0];
        if (!found)
          fail(
            "This organisation has not been provisioned for the pilot.",
            403,
          );
        await lockWorkspace(client, found.id, lockMode, write);
        workspace = (
          await client.query<WorkspaceRow>(
            `SELECT w.id,w.principal_hash,w.role FROM valopay_workspaces w JOIN valopay_teams t ON t.workspace_id=w.id WHERE t.organization_id=$1 AND w.id=$2 FOR ${access === "team" ? "UPDATE" : "SHARE"} OF w`,
            [auth.orgId || "", found.id],
          )
        ).rows[0];
        if (!workspace)
          fail(
            "This organisation has not been provisioned for the pilot.",
            403,
          );
        try {
          staff = (
            await client.query<StaffRow>(
              "SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
              [workspace.id, auth.userId],
            )
          ).rows[0];
        } catch (error) {
          if ((error as { code?: unknown }).code !== "40001") throw error;
          // A read whose membership a team change altered while it waited behind it. Under runtime isolation it is
          // refused, as it always was; otherwise it starts again, once, on a fresh snapshot, and so meets the change
          // as a read-committed read did.
          if (snapshotRead && attempt === 1 && !runtimeIsolationEnabled()) {
            await client.query("ROLLBACK");
            continue;
          }
          fail(
            "Your access changed while this request was waiting. Refresh and try again.",
            409,
          );
        }
        if (!staff)
          fail(
            "An active staff membership is required. Accept an invitation or contact your administrator.",
            403,
          );
        now = (
          await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")
        ).rows[0]!.now.toISOString();
        verifyStaff(
          auth,
          staffProvision(staff, auth.orgId!),
          access !== "read",
          now,
        );
        break;
      }
      try {
        workspace = await lockedSandbox();
      } catch (error) {
        // A read that waited behind a persona change finds its sandbox's row changed since its snapshot: it starts again, once, on a fresh one.
        if (!(
          snapshotRead &&
          attempt === 1 &&
          (error as { code?: unknown }).code === "40001"
        ))
          throw error;
        await client.query("ROLLBACK");
        continue;
      }
      // A snapshot taken before another first visit committed the same sandbox could not see it.
      if (!workspace && snapshotRead) {
        await client.query("ROLLBACK");
        snapshotRead = false;
        continue;
      }
      break;
    }
    if (!workspace && !staffMode()) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [identity.principal],
      );
      // Another first visit may have finished seeding while we waited.
      workspace = await lockedSandbox();
    }
    if (!workspace) {
      // A new anonymous sandbox seeds two lenders; creation is bounded per client network, per IPv6 /48 and per process on top of the request limit.
      const refused = identity.authenticated
        ? undefined
        : sandboxCreation.take(identity.address);
      if (refused)
        throw Object.assign(new Error(creationRefusalMessage(refused)), {
          status: 429,
          retryAfterSeconds: WORKSPACE_CREATION_RETRY_AFTER_SECONDS,
        });
      const inserted = (
        await client.query<WorkspaceRow>(
          `INSERT INTO valopay_workspaces(id,principal_hash,role) VALUES($1,$2,'Admin')
         ON CONFLICT (principal_hash) DO NOTHING RETURNING id,principal_hash,role`,
          [randomUUID(), identity.principal],
        )
      ).rows[0];
      // No other transaction can see the new row before this one commits, so its lock never waits.
      if (inserted) await lockWorkspace(client, inserted.id, lockMode, write);
      workspace = inserted || (await lockedSandbox());
      if (!workspace)
        throw new Error("Workspace bootstrap could not be completed.");
      if (inserted) {
        await seedWorkspace(
          client,
          workspace,
          identity.principal,
          !identity.authenticated,
          now,
        );
        // When explicitly enabled, each new anonymous sandbox pays for a few expired ones without a scheduler.
        // The sweep runs inside a savepoint: one that is slow, meets a lock or deadlocks is undone and left to
        // a later bootstrap, and never fails this visitor's.
        if (
          !identity.authenticated &&
          expiredWorkspaceCleanupEnabled(
            process.env["VALOPAY_EXPIRED_WORKSPACE_CLEANUP"],
          )
        ) {
          await client.query("SAVEPOINT expired_workspace_sweep");
          try {
            const { files } = await sweepExpiredWorkspaces(client, SWEEP_BATCH);
            await client.query("RELEASE SAVEPOINT expired_workspace_sweep");
            swept = files;
          } catch (error) {
            try {
              await client.query(
                "ROLLBACK TO SAVEPOINT expired_workspace_sweep",
              );
            } catch {
              throw error;
            }
            (req as { log?: SweepLog }).log?.warn?.(
              { event: "workspace.sweep_failed", err: error },
              "Expired sandboxes were left for a later sweep",
            );
          }
        }
      }
    }
    context = Object.freeze({
      authenticated: identity.authenticated,
      role: staff?.role || workspace.role,
      principalId: identity.principal,
      actor: staff ? `Clerk:${staff.user_id}` : `Sandbox ${workspace.role}`,
      now,
      accessMode: staff ? "staff" : "sandbox",
    });
    sessions.set(context, {
      client,
      workspace,
      principal: workspace.principal_hash,
      owner: identity.principal,
      active: true,
      access,
      operationId: requestOperations.get(req)?.id,
      userId: staff?.user_id,
      organizationId: auth?.orgId || undefined,
      isolationVerified,
      snapshotRead,
    });
    // Every identity check has passed: from here a read cannot write.
    if (snapshotRead) await client.query("SET TRANSACTION READ ONLY");
    const result = await fn(context);
    committing = true;
    const committed = await client.query("COMMIT");
    // PostgreSQL accepts COMMIT after a caught statement error by returning
    // ROLLBACK.  Do not let a caller that swallowed that error observe success.
    if (committed.command !== "COMMIT")
      throw markRolledBack(
        new Error("The workspace transaction was rolled back."),
      );
    sweptAndCommitted = swept;
    // The sandbox exists now: requests that name it are limited as it, not as their network (request-limits.ts).
    if (!staff && !identity.authenticated) rememberSandbox(identity.principal);
    return result;
  } catch (error) {
    if (guard)
      try {
        await guard.client.query("ROLLBACK");
      } catch {
        /* transaction is already closed */
      }
    // A limit reached before COMMIT is a 503 that says nothing was saved; a connection lost during COMMIT stays unconfirmed.
    const failed = failedTransaction(error, {
      committing,
      lost: guard?.lost(),
      write,
    });
    if (failed !== error) throw failed;
    // Before COMMIT was sent nothing was saved; a failed COMMIT's outcome is unknown.
    if (!committing) markRolledBack(error);
    if (
      databaseConflictCodes.has(
        (error as { code?: string } | undefined)?.code || "",
      )
    ) {
      conflict("Operation conflicts with the current lender state.");
    }
    throw error;
  } finally {
    if (context) {
      const session = sessions.get(context);
      if (session) {
        session.active = false;
        session.snapshot = undefined;
        session.summarised = undefined;
        session.auditChain = undefined;
        session.auditCheck = undefined;
        session.lockedMerchantId = undefined;
      }
    }
    guard?.release();
    leave?.();
    // Private storage, with the connection and the lender share already given back; it never fails this request.
    if (sweptAndCommitted.length)
      await removeSweptExportFiles(
        sweptAndCommitted,
        (req as { log?: SweepLog }).log,
      );
  }
}

/** List is explicitly constrained by the server-derived workspace principal. */
export async function listMerchants(context: StoreContext) {
  const session = sessionFor(context);
  return (
    await session.client.query<{ info: DomainState["merchant"] }>(
      `SELECT m.info FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
     WHERE m.workspace_id=$1 AND w.id=$1 AND w.principal_hash=$2
       AND ($3::boolean OR EXISTS (SELECT 1 FROM valopay_staff_lender_access grant_row JOIN valopay_staff_memberships member ON member.id=grant_row.membership_id WHERE grant_row.merchant_id=m.id AND member.workspace_id=$1 AND member.user_id=$4 AND member.status='active' AND member.expires_at>clock_timestamp())) ORDER BY m.id`,
      [
        session.workspace.id,
        session.principal,
        context.accessMode !== "staff" || context.role === "Admin",
        session.userId || "",
      ],
    )
  ).rows.map((row) => row.info);
}

/**
 * Lock membership before loading records.  A context becomes bound to one
 * merchant, preventing a confused caller from switching tenant mid-operation.
 * A mutation takes the exclusive row lock that serializes validation, allocations,
 * idempotency and audit sequencing. A read takes none: its snapshot is one
 * consistent state, so it never waits for a mutation (inWorkspace); a share
 * lock remains for a read in a read-committed transaction (a first visit's).
 * The journal's own reads take none. A journaled write holds its entry before
 * it waits for the lender (holdOperation).
 */
export async function readMerchant(
  context: StoreContext,
  merchantId: string,
  lock: MerchantLock = "share",
): Promise<MerchantRow> {
  const session = sessionFor(context);
  if (session.access === "read" && lock === "update")
    conflict("A read transaction cannot acquire a lender write lock.");
  if (session.lockedMerchantId && session.lockedMerchantId !== merchantId)
    conflict("A transaction may operate on only one lender.");
  if (session.operationId && lock === "update") await holdOperation(session);
  const merchant = (
    await session.client.query<MerchantRow>(
      scopedMerchantQuery(
        lock === "share" &&
          (session.snapshotRead ||
            (runtimeIsolationEnabled() && context.role === "Read-only"))
          ? "none"
          : lock,
      ),
      [merchantId, session.workspace.id, session.principal],
    )
  ).rows[0];
  if (!merchant) fail(LENDER_NOT_FOUND, 404);
  if (context.accessMode === "staff" && context.role !== "Admin") {
    const grant = (
      await session.client.query(
        `SELECT 1 FROM valopay_staff_lender_access grant_row JOIN valopay_staff_memberships member ON member.id=grant_row.membership_id WHERE grant_row.merchant_id=$1 AND member.workspace_id=$2 AND member.user_id=$3 AND member.status='active' AND member.expires_at>clock_timestamp()`,
        [merchantId, session.workspace.id, session.userId],
      )
    ).rows[0];
    if (!grant)
      fail(
        "You do not have access to this lender. Choose another lender, or ask an Admin for access.",
        404,
      );
  }
  if (session.operationId && lock === "update") {
    const operation = (
      await session.client.query<
        Pick<OperationRow, "actor" | "role" | "status">
      >(
        "SELECT actor,role,status FROM valopay_operations WHERE id=$1 AND merchant_id=$2 AND owner=$3",
        [session.operationId, merchantId, session.owner || session.principal],
      )
    ).rows[0];
    if (
      !operation ||
      operation.actor !== context.actor ||
      operation.role !== context.role ||
      operation.status === "cancelled"
    )
      fail(
        "This request was cancelled, or your access has changed. Reload Request history to check it.",
        409,
      );
  }
  session.lockedMerchantId = merchantId;
  if (merchant.info.id !== merchantId)
    conflict("Lender identity does not match its stored scope.");
  return merchant;
}

/**
 * A daily close as the domain reads earlier closes: its summary and the
 * unallocated and exception totals, without the full REC-07 arrays. The stored
 * close is decompressed once (`|| '{}'` makes an in-memory copy of a close's
 * data object), not once for each part taken from it: for a year of closes
 * that is about a quarter of the time. `summariseLoadedClose`
 * (domain/close-review.ts) writes the same summary of a whole close, so My
 * work can compare a pending review's snapshot with a close loaded this way:
 * change both together.
 */
export const closeSummarySql =
  "(SELECT (s.d - 'report' - 'operational' - 'metrics') || CASE WHEN s.d ? 'report' THEN jsonb_build_object('report',jsonb_build_object('unallocated',s.d#>'{report,unallocated}','exceptions',s.d#>'{report,exceptions}')) ELSE '{}'::jsonb END FROM (SELECT r.data || '{}'::jsonb AS d OFFSET 0) s)";
/** Closes this recent stay whole in a load; the latest close, which a Finance review hashes, is always among them. */
const FULL_CLOSE_DAYS = 7;
function chainPoint(value: unknown): ChainPoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { sequence, hash, at } = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(sequence) ||
    (sequence as number) < 0 ||
    typeof hash !== "string" ||
    !hash
  )
    return undefined;
  if (
    at !== undefined &&
    (typeof at !== "string" || !Number.isFinite(Date.parse(at)))
  )
    return undefined;
  return {
    sequence: sequence as number,
    hash,
    ...(at === undefined ? {} : { at }),
  };
}
/** The stored chain position, or undefined for a lender that has none yet (created before it was kept) or a state built in memory. */
function storedChain(
  settings: DomainState["settings"],
): AuditChain | undefined {
  const head = chainPoint(settings.auditChain),
    verified = chainPoint(settings.auditChain?.verified);
  if (!head || !verified || verified.sequence > head.sequence) return undefined;
  // A break is kept as a check records it, at the entry after the verified one.
  const broken = settings.auditChain.broken?.sequence === verified.sequence + 1,
    walkedAt = settings.auditChain.walkedAt;
  return {
    ...head,
    verified,
    ...(broken ? { broken: { sequence: verified.sequence + 1 } } : {}),
    ...(typeof walkedAt === "string" && Number.isFinite(Date.parse(walkedAt))
      ? { walkedAt }
      : {}),
  };
}
/**
 * An entry's sequence when it is a whole number from 1, as chainSequence
 * reads it, else NULL: the sequence of a damaged entry (text, null, a
 * fraction) is never cast. The entry is `r`.
 */
export const chainSequenceSql = `CASE WHEN jsonb_typeof(r.data->'sequence')='number' THEN CASE WHEN (r.data->>'sequence')::numeric BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
  AND trunc((r.data->>'sequence')::numeric)=(r.data->>'sequence')::numeric THEN (r.data->>'sequence')::numeric END END`;
/**
 * How much earlier than the verified entry a later entry may be stamped. An
 * entry carries its transaction's start time, and a transaction appends only
 * once it holds the lender, after waits each bounded by the lock limit.
 */
const CHAIN_MARGIN_MINUTES = 5;
/**
 * Reads the lender's audit entries after the verified entry, or after the head
 * while the lender keeps a break (all of them with `full`, or for a lender
 * with no stored position), and walks them from there. The head is the last
 * entry by sequence, whoever wrote it: the export worker and an earlier build
 * append without moving the stored head. A stored head further on than any
 * entry means entries went missing: the chain is broken and that sequence is
 * never issued again. Each read also takes in the entries of its time range
 * whose sequence is not a whole number, whatever that holds (only a whole
 * number can be the head), and the walk finds each one a break.
 *
 * The verified entry it returns, which the next entry appended records, is
 * always before the first entry that breaks the chain: a changed entry, a
 * missing one, a sequence two entries claim (a fork) or a damaged one; and
 * the break is recorded with it. While the lender keeps a break, a check
 * reads only the entries after the head, still following what other writers
 * appended, so the overview's alert stays on at the recorded entry after any
 * later write, and a save or an overview costs what it costs on a valid
 * chain however many entries follow the break. Only the walk of the whole
 * chain (`full`, verify_audit's and the daily check's) reads every entry
 * again: it records the break it finds, or none once the chain is valid again,
 * and `walkedAt`, the database's time as it began reading: before the
 * snapshot of verify_audit's read, and after that of the daily check's, which
 * its transaction took with its first statement (checkAuditChainDaily).
 */
async function readAuditChain(
  session: Session,
  merchantId: string,
  settings: DomainState["settings"],
  full = false,
) {
  const stored = storedChain(settings),
    known = full ? undefined : stored?.broken;
  const walkedAt = full
    ? (
        await session.client.query<{ at: Date }>(
          "SELECT statement_timestamp() AS at",
        )
      ).rows[0]!.at.toISOString()
    : stored?.walkedAt;
  const stamp = walkedAt ? { walkedAt } : {};
  const storedHead: ChainPoint | undefined = stored && {
    sequence: stored.sequence,
    hash: stored.hash,
    ...(stored.at ? { at: stored.at } : {}),
  };
  const from: ChainPoint =
    full || !stored ? AUDIT_GENESIS : known ? storedHead! : stored.verified;
  const rows = (
    await session.client.query<{
      id: string;
      data: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT r.id,r.data,r.created_at ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='audit'
       AND ($4::timestamptz IS NULL OR r.created_at >= $4::timestamptz - make_interval(mins => ${CHAIN_MARGIN_MINUTES}))
       AND ($5::bigint = 0 OR COALESCE(${chainSequenceSql} > $5::bigint, true))
     ORDER BY r.created_at,r.id`,
      [
        merchantId,
        session.workspace.id,
        session.principal,
        from.sequence ? (from.at ?? null) : null,
        from.sequence,
      ],
    )
  ).rows;
  const walk = walkAuditChain(rows, from);
  let head: ChainPoint = from,
    valid = walk.valid;
  for (const row of rows) {
    const sequence = chainSequence(row.data.sequence);
    if (sequence !== undefined && sequence > head.sequence)
      head = {
        sequence,
        hash: String(row.data.hash),
        at: row.created_at.toISOString(),
      };
  }
  if (storedHead && storedHead.sequence > head.sequence) {
    head = storedHead;
    valid = false;
  }
  if (known)
    return {
      chain: {
        ...head,
        verified: stored!.verified,
        broken: known,
        ...stamp,
      } as AuditChain,
      verification: {
        valid: false,
        count: walk.count,
        headHash: walk.headHash,
      },
    };
  const verified: ChainPoint = walk.entry
    ? { ...walk.verified, at: walk.entry.created_at.toISOString() }
    : from;
  return {
    chain: {
      ...head,
      verified,
      ...(valid ? {} : { broken: { sequence: verified.sequence + 1 } }),
      ...stamp,
    } as AuditChain,
    verification: { valid, count: walk.count, headHash: walk.headHash },
  };
}

export async function loadState(
  context: StoreContext,
  merchantId: string,
  lock: Exclude<MerchantLock, "none"> = "update",
  options: {
    wholeCloses?: number;
    wholeCloseIds?: string[];
    closeReviewIds?: string[];
  } = {},
): Promise<DomainState> {
  const session = sessionFor(context);
  const merchant = await readMerchant(context, merchantId, lock);
  // Every load has earlier closes as summaries: each stored report is about
  // 100 KB, and a year of them used to be reloaded with every request. The
  // latest week's stay whole, and `wholeCloses` more of the newest for a view
  // that shows them. The full reports stay in PostgreSQL (the close history
  // opens one); saveState refuses to change them. The audit chain is never
  // loaded: a write continues it from the head in the lender's settings.
  const whole = Math.max(0, Math.floor(options.wholeCloses ?? 0));
  if (
    (options.wholeCloseIds?.length ?? 0) > 1 ||
    (options.closeReviewIds?.length ?? 0) > 1
  )
    fail("Open one historical close at a time.", 400);
  const rows = (
    await session.client.query<RecordRow & { summarised: boolean }>(
      `WITH recent AS (SELECT least(max(created_at) - make_interval(days => $4), CASE WHEN $5::int > 0 THEN
         (SELECT created_at FROM valopay_records WHERE merchant_id=$1 AND kind='closes' ORDER BY created_at DESC OFFSET $5::int - 1 LIMIT 1) END) AS cutoff
       FROM valopay_records WHERE merchant_id=$1 AND kind='closes'),
     loaded AS (SELECT r.*, (r.kind='closes' AND r.created_at < recent.cutoff AND NOT (r.id=ANY($6::text[]) OR r.id IN
       (SELECT data->>'closeId' FROM valopay_records WHERE merchant_id=$1 AND kind='close-reviews' AND id=ANY($7::text[])))) AS summarised
       FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id
       JOIN valopay_workspaces w ON w.id=m.workspace_id CROSS JOIN recent
       WHERE r.merchant_id=$1 AND m.workspace_id=$2 AND w.id=$2 AND w.principal_hash=$3 AND r.kind<>'audit')
     SELECT r.id,r.merchant_id,r.kind,r.name,r.status,r.reference,r.amount_kobo,r.customer_id,
       CASE WHEN r.summarised THEN ${closeSummarySql} ELSE r.data END AS data,r.created_at,r.updated_at,r.summarised
     FROM loaded r ORDER BY r.created_at,r.id`,
      [
        merchantId,
        session.workspace.id,
        session.principal,
        FULL_CLOSE_DAYS,
        whole,
        options.wholeCloseIds ?? [],
        options.closeReviewIds ?? [],
      ],
    )
  ).rows;
  // Protected source rows stay sealed: only the views that show or use them open them (revealImportPayloads).
  const state: DomainState = {
    merchant: merchant.info,
    settings: merchant.settings,
    records: rows.map(rowToRecord),
  };
  if (state.merchant.id !== merchantId)
    conflict("Lender identity does not match its stored scope.");
  // A write verifies the entries appended since the last verified one (usually the previous write's), or since the
  // head once the lender keeps a break, and takes the head from them, so an entry written without moving the stored
  // head is followed, never forked. The position is kept aside until an entry is appended: the lender's settings stay
  // as a read sees them.
  const checked =
    lock === "update"
      ? await readAuditChain(session, merchantId, state.settings)
      : undefined;
  session.auditChain = checked?.chain;
  // The write records a break it found with its entry, so the lender keeps it once the write commits.
  session.auditCheck = checked && {
    ...checked.verification,
    verifiedSequence: checked.chain.verified.sequence,
    kept: !checked.verification.valid,
  };
  // A shared load is read-only, even in an otherwise write-capable context.
  // Avoid serialising the entire history just to serve a dashboard or export lookup.
  session.snapshot = lock === "update" ? snapshotOf(state) : undefined;
  session.summarised =
    lock === "update"
      ? new Set(rows.filter((row) => row.summarised).map((row) => row.id))
      : undefined;
  return state;
}

/**
 * The overview's view of the audit chain, from the same snapshot as its load:
 * the entries after the last verified one checked (incrementally, as each
 * write checks them, and from the head while the lender keeps a break), and
 * the eight most recent entries, newest first. A read stores nothing: a break
 * it finds is kept only once a completed write, verify_audit or the daily
 * check records it, and until then it clears if the chain is repaired.
 */
export async function auditOverview(context: StoreContext, state: DomainState) {
  const session = sessionFor(context),
    merchantId = state.merchant.id;
  if (session.lockedMerchantId !== merchantId)
    conflict("Load this lender before reading its audit log.");
  const { chain, verification } = await readAuditChain(
    session,
    merchantId,
    state.settings,
  );
  const recent = (
    await session.client.query<RecordRow>(
      `SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='audit' ORDER BY r.created_at DESC,r.id LIMIT 8`,
      [merchantId, session.workspace.id, session.principal],
    )
  ).rows.map(rowToRecord);
  // The alert names the entry after the last verified one: the break the lender keeps, or the one this check found.
  return {
    verification: {
      ...verification,
      verifiedSequence: chain.verified.sequence,
      kept: Boolean(storedChain(state.settings)?.broken),
    },
    recent,
  };
}

/**
 * The lender's audit chain as this write checked it when it loaded the lender
 * (loadState), for a daily close's alerts: a break it found is recorded with
 * the write's entry, so the lender keeps it once the write commits.
 */
export function writeAuditCheck(
  context: StoreContext,
  state: DomainState,
): AuditVerification | undefined {
  const session = sessionFor(context);
  return session.lockedMerchantId === state.merchant.id
    ? session.auditCheck
    : undefined;
}

/**
 * The whole audit chain verified from its first entry (verify_audit): the
 * lender's position records how far it held and the break it found, or none
 * once the chain is valid again (readAuditChain), and the entry verify_audit
 * appends stores it. So a break found here, however early in the chain, is
 * what the overview reports from then on, and only a walk of the whole chain,
 * this or the daily check (checkAuditChainDaily), clears it.
 */
export async function verifyAuditTrail(
  context: StoreContext,
  state: DomainState,
) {
  const session = sessionFor(context),
    merchantId = lockedMerchant(session);
  if (state.merchant.id !== merchantId)
    conflict("Load this lender before checking its audit log.");
  const { chain, verification } = await readAuditChain(
    session,
    merchantId,
    state.settings,
    true,
  );
  session.auditChain = chain;
  return verification;
}

/** Whether the daily check of the lender's whole audit chain is still to run on the WAT day of `now` (settings.dailyAuditCheckAt). */
export function dailyAuditCheckDue(
  settings: DomainState["settings"],
  now: string,
): boolean {
  const at =
    typeof settings.dailyAuditCheckAt === "string"
      ? Date.parse(settings.dailyAuditCheckAt)
      : Number.NaN;
  return !Number.isFinite(at) || watDate(at) !== watDate(Date.parse(now));
}

/** What the daily check found: the chain valid or not, its entries, the last verified entry, the entry it stopped at, and whether it cleared a recorded break. */
export interface DailyAuditCheck {
  valid: boolean;
  entries: number;
  verifiedSequence: number;
  brokenAt?: number;
  cleared: boolean;
  walkMs: number;
}

/**
 * The daily check of a lender's whole audit chain, which the background
 * worker runs once the lender's first daily close of each WAT day has
 * committed (close-scheduler.ts). It walks every entry from the first, as
 * verify_audit does, on one snapshot that takes no lock, so no write waits
 * for the walk. Then, holding the lender for a moment, it checks the entries
 * appended since from where the walk verified to (readAuditChain, as a write
 * does) and stores what it found as verify_audit does: the last verified
 * entry and the break, or none once the chain is valid again, which clears a
 * recorded break. What is newer than the walk stays: the result of a walk of
 * the whole chain that began reading after this one did (verify_audit's, by
 * `walkedAt`), and a break a write recorded after the snapshot at an entry
 * the walk read intact. `dailyAuditCheckAt` records the check, and undefined
 * means none ran: the day's check had already run, or the lender is gone.
 */
export async function checkAuditChainDaily(
  merchantId: string,
): Promise<DailyAuditCheck | undefined> {
  const started = Date.now();
  const walked = await lenderTransaction(
    merchantId,
    false,
    async (session, settings, now) => {
      if (!dailyAuditCheckDue(settings, now)) return undefined;
      return {
        ...(await readAuditChain(session, merchantId, settings, true)),
        recorded: storedChain(settings)?.broken?.sequence,
      };
    },
  );
  if (!walked) return undefined;
  const walkMs = Date.now() - started;
  return lenderTransaction(merchantId, true, async (session, settings, now) => {
    if (!dailyAuditCheckDue(settings, now)) return undefined;
    const stored = storedChain(settings),
      found = walked.chain;
    const newer =
      (stored?.walkedAt !== undefined &&
        Date.parse(stored.walkedAt) > Date.parse(found.walkedAt!)) ||
      (stored?.broken &&
        stored.broken.sequence !== walked.recorded &&
        stored.broken.sequence <= found.verified.sequence);
    let chain = stored!;
    if (!newer) {
      // The later head of the two, so an entry missing since the snapshot is still a break and its sequence never issued again.
      const { sequence, hash, at } =
        stored && stored.sequence > found.sequence ? stored : found;
      ({ chain } = await readAuditChain(session, merchantId, {
        auditChain: {
          sequence,
          hash,
          at,
          verified: found.verified,
          ...(found.broken ? { broken: found.broken } : {}),
          walkedAt: found.walkedAt,
        },
      }));
    }
    await session.client.query(
      "UPDATE valopay_merchants SET settings = settings || jsonb_build_object('auditChain', $2::jsonb, 'dailyAuditCheckAt', $3::text) WHERE id=$1",
      [merchantId, JSON.stringify(chain), now],
    );
    return {
      valid: !chain.broken,
      entries: walked.verification.count,
      verifiedSequence: chain.verified.sequence,
      ...(chain.broken ? { brokenAt: chain.broken.sequence } : {}),
      cleared: Boolean(stored?.broken && !chain.broken),
      walkMs,
    };
  });
}

/**
 * One system transaction on a lender for a background job, with the system
 * limits and, under runtime isolation, the service identity. With `lock` it
 * holds the lender until it commits, waiting up to the lock limit for a write
 * that holds it; without, it reads one snapshot and takes no lock. Undefined
 * when the lender no longer exists.
 */
async function lenderTransaction<T>(
  merchantId: string,
  lock: boolean,
  fn: (
    session: Session,
    settings: DomainState["settings"],
    now: string,
  ) => Promise<T>,
): Promise<T | undefined> {
  const guard = await checkOut(() => pool.connect()),
    client = guard.client;
  let committing = false;
  try {
    await client.query(
      beginStatement(
        databaseLimits().system,
        lock ? undefined : "ISOLATION LEVEL REPEATABLE READ",
      ),
    );
    await bindRuntimeService(client);
    const scope = (
      await client.query<{
        workspace_id: string;
        principal_hash: string;
        role: string;
        settings: DomainState["settings"] | null;
        now: Date;
      }>(
        `SELECT m.workspace_id,w.principal_hash,w.role,m.settings,now() AS now FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
       WHERE m.id=$1${lock ? " FOR UPDATE OF m" : ""}`,
        [merchantId],
      )
    ).rows[0];
    if (!scope) {
      await client.query("ROLLBACK");
      return undefined;
    }
    const session: Session = {
      client,
      workspace: {
        id: scope.workspace_id,
        principal_hash: scope.principal_hash,
        role: scope.role,
      },
      principal: scope.principal_hash,
      active: true,
      access: lock ? "write" : "read",
    };
    const result = await fn(
      session,
      scope.settings ?? {},
      scope.now.toISOString(),
    );
    committing = true;
    const committed = await client.query("COMMIT");
    if (committed.command !== "COMMIT")
      throw new Error("The system transaction was rolled back.");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* transaction is already closed */
    }
    throw failedTransaction(error, {
      committing,
      lost: guard.lost(),
      write: lock,
    });
  } finally {
    guard.release();
  }
}

/**
 * Opens the protected source rows (original CSV and validation check) of this
 * lender's import batches that `select` names, at most four key-service calls
 * at a time, and returns how many batches it opened. A full-state load keeps
 * them sealed, so overviews, saves, the scheduled close and Paystack test
 * deliveries never need the key service to open them (a keyed save still seals
 * its journal entry, and a batch save its rows). Only a view that shows or
 * uses raw source rows calls this, and in a write it must call it before the
 * domain changes the batch: the opened form becomes the batch's loaded form,
 * so an opened but unchanged batch is not written back and the immutability
 * checks compare like with like. A field already open costs nothing.
 */
export async function revealImportPayloads(
  context: StoreContext,
  state: DomainState,
  select: (record: ValopayRecord) => boolean,
  fields: readonly ProtectedImportField[] = PROTECTED_IMPORT_FIELDS,
): Promise<number> {
  const session = sessionFor(context);
  if (
    !session.lockedMerchantId ||
    session.lockedMerchantId !== state.merchant.id
  )
    conflict("Load this lender before opening its source rows.");
  const targets = state.records.filter(
    (record) =>
      record.kind === "import-batches" &&
      record.merchantId === session.lockedMerchantId &&
      fields.some((field) => isProtectedPayload(record.data[field])) &&
      select(record),
  );
  if (!targets.length) return 0;
  const snapshot = session.snapshot;
  if (
    snapshot &&
    targets.some(
      (record) => snapshot.records.get(record.id) !== JSON.stringify(record),
    )
  )
    throw new Error(
      "Protected source rows must be opened before the batch changes.",
    );
  const opened = await revealRecordsData(targets, fields);
  targets.forEach((record, index) => {
    record.data = opened[index]!.data;
    snapshot?.records.set(record.id, JSON.stringify(record));
  });
  return targets.length;
}

/**
 * After a mutation and before its response is built: every changed record
 * gets a strictly newer version, so the response carries it, and the audit
 * entry receives digests of exactly the records the request added or changed,
 * before and after, with the lender's settings. Unchanged records are never
 * canonicalised; before this, every save hashed the whole lender twice.
 */
export function settleChanges(
  context: StoreContext,
  state: DomainState,
): { beforeDigest: string; afterDigest: string; changedRecords: number } {
  const session = sessionFor(context);
  lockedMerchant(session);
  const snapshot = session.snapshot!;
  const { changed } = changesSince(snapshot, state);
  advanceChanged(snapshot, changed, context.now);
  const byId = (a: ValopayRecord, b: ValopayRecord) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const previous = changed
    .filter((record) => snapshot.records.has(record.id))
    .map(
      (record) => JSON.parse(snapshot.records.get(record.id)!) as ValopayRecord,
    )
    .sort(byId);
  return {
    // In the audit entry's form: they are committed to by its change digest.
    beforeDigest: canonicalDigest(
      {
        merchant: JSON.parse(snapshot.merchant),
        settings: JSON.parse(snapshot.settings),
        records: previous,
      },
      "legacy-en-us-null",
    ),
    afterDigest: canonicalDigest(
      {
        merchant: state.merchant,
        settings: state.settings,
        records: [...changed].sort(byId),
      },
      "legacy-en-us-null",
    ),
    changedRecords: changed.length,
  };
}

/** Records this write transaction added since it loaded the lender. */
export function addedRecords(
  context: StoreContext,
  state: DomainState,
): ValopayRecord[] {
  const session = sessionFor(context);
  lockedMerchant(session);
  return state.records.filter(
    (record) => !session.snapshot!.records.has(record.id),
  );
}

/**
 * The record a write's audit entry is about, of those its route can vouch for:
 * the one its path names; else the one its parsed body names, when the write
 * added or changed it or answers with it; else the one its answer names
 * (`record.id`, or `id`), when the lender has it; else `fallback`. An id a
 * client wrote that the write did not act on is never the object.
 */
export function auditObject(
  context: StoreContext,
  state: DomainState,
  names: { path?: unknown; body?: string; answer?: unknown },
  fallback: string,
): string {
  const session = sessionFor(context);
  lockedMerchant(session);
  if (typeof names.path === "string" && names.path) return names.path;
  const shown = names.answer as
    { id?: unknown; record?: { id?: unknown } } | null | undefined;
  const answered =
    typeof shown?.record?.id === "string"
      ? shown.record.id
      : typeof shown?.id === "string"
        ? shown.id
        : undefined;
  const byId = (id: string) => state.records.find((record) => record.id === id);
  if (names.body) {
    const named = byId(names.body),
      loaded = session.snapshot!.records.get(names.body);
    if (
      named &&
      (names.body === answered ||
        loaded === undefined ||
        recordChanged(loaded, named))
    )
      return names.body;
  }
  return answered && byId(answered) ? answered : fallback;
}
/** Switches the workspace's demo persona. */
export async function changeRole(context: StoreContext, role: string) {
  const session = sessionFor(context);
  if (context.accessMode === "staff")
    fail("Staff cannot switch demo personas.", 403);
  if (session.access !== "persona")
    conflict("A persona change requires an exclusive workspace transaction.");
  if (!roles.includes(role)) fail(UNKNOWN_DEMO_ROLE);
  const result = await session.client.query(
    "UPDATE valopay_workspaces SET role=$3 WHERE id=$1 AND principal_hash=$2",
    [session.workspace.id, session.principal, role],
  );
  if (!rowsAffected(result))
    fail("Your workspace was not found. Reload the page to open it again.", 404);
  session.workspace.role = role;
}

export function lockedMerchant(session: Session): string {
  if (session.access === "read")
    fail("A read transaction cannot write lender data.", 409);
  if (!session.lockedMerchantId || !session.snapshot)
    fail("Load a lender before using this repository operation.", 409);
  return session.lockedMerchantId;
}
/** The lender a write transaction is bound to, loaded or not: the journal's own reads and writes need no lender lock. */
export function boundMerchant(session: Session): string {
  if (session.access === "read")
    fail("A read transaction cannot write lender data.", 409);
  if (!session.lockedMerchantId)
    fail("Load a lender before using this repository operation.", 409);
  return session.lockedMerchantId;
}
/** How many records one of saveState's write statements carries. */
const WRITE_BATCH = 500;
const recordsetColumns =
  "id text,kind text,name text,status text,reference text,amount_kobo bigint,customer_id text,data jsonb,created_at timestamptz,updated_at timestamptz";
/** Persist only a checked diff against the repository-owned snapshot. */
export async function saveState(
  context: StoreContext,
  state: DomainState,
): Promise<void> {
  const session = sessionFor(context);
  const merchantId = lockedMerchant(session);
  const snapshot = session.snapshot!;
  const { changed, unchanged } = changesSince(snapshot, state);
  // A summarised close would overwrite its full stored report; closes are evidence and never change.
  if (changed.some((record) => session.summarised?.has(record.id)))
    conflict("Saved evidence cannot be changed. Reload the page and try again.");
  advanceChanged(snapshot, changed, context.now);
  // An unchanged record is its own "before": identical JSON is identical content.
  const current = new Map(state.records.map((record) => [record.id, record]));
  const before: DomainState = {
    merchant: JSON.parse(snapshot.merchant),
    settings: JSON.parse(snapshot.settings),
    records: [...snapshot.records].map(([id, json]) =>
      unchanged.has(id)
        ? current.get(id)!
        : (JSON.parse(json) as ValopayRecord),
    ),
  };
  assertFinalState(before, state, merchantId, context.now, unchanged);
  const owned = await session.client.query(scopedMerchantQuery(), [
    merchantId,
    session.workspace.id,
    session.principal,
  ]);
  if (!owned.rows[0]) fail(LENDER_NOT_FOUND, 404);
  // Explicit synthetic staging dual-write only. A typed failure rolls back the
  // same transaction as the v1 write; no migration runs here or on startup.
  const projectionMode = process.env.VALOPAY_FINANCIAL_PROJECTION || "off";
  if (!["off", "staging"].includes(projectionMode))
    throw new Error("VALOPAY_FINANCIAL_PROJECTION must be off or staging.");
  if (projectionMode === "staging") {
    await syncFinancialProjection(
      session.client,
      financialProjectionSchema(
        process.env.VALOPAY_FINANCIAL_PROJECTION_SCHEMA || "",
      ),
      session.workspace.id,
      state,
    );
  }
  const sorted = [...changed].sort((a, b) => {
    const priority = (record: ValopayRecord) =>
      record.kind === "allocations"
        ? record.status === "confirmed"
          ? 3
          : 0
        : record.kind === "audit"
          ? 4
          : 1;
    return priority(a) - priority(b);
  });
  const rows: Array<Record<string, unknown> & { existing: boolean }> = [];
  for (const record of sorted)
    rows.push({
      existing: snapshot.records.has(record.id),
      id: record.id,
      kind: record.kind,
      name: record.name,
      status: record.status,
      reference: record.reference,
      amount_kobo: record.amountKobo,
      customer_id: record.customerId,
      data: await protectRecordData(record),
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    });
  // A run of updates, or of inserts, in the order above is one statement (up to WRITE_BATCH records): a month-end
  // close changes thousands of records, each once its own statement. The order still puts an update that frees a
  // unique value before the insert that takes it.
  for (let start = 0; start < rows.length;) {
    const existing = rows[start]!.existing;
    let end = start + 1;
    while (
      end < rows.length &&
      end - start < WRITE_BATCH &&
      rows[end]!.existing === existing
    )
      end += 1;
    const batch = rows
      .slice(start, end)
      .map(({ existing: _existing, ...row }) => row);
    const result = await session.client.query(
      existing
        ? `UPDATE valopay_records r SET name=v.name,status=v.status,reference=v.reference,amount_kobo=v.amount_kobo,customer_id=v.customer_id,data=v.data,updated_at=v.updated_at
         FROM jsonb_to_recordset($1::jsonb) AS v(${recordsetColumns})
         WHERE r.id=v.id AND r.merchant_id=$2 AND r.kind=v.kind AND r.created_at=v.created_at AND EXISTS (
           SELECT 1 FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
           WHERE m.id=$2 AND m.workspace_id=$3 AND w.id=$3 AND w.principal_hash=$4)`
        : `INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
         SELECT v.id,$2,v.kind,v.name,v.status,v.reference,v.amount_kobo,v.customer_id,v.data,v.created_at,v.updated_at
         FROM jsonb_to_recordset($1::jsonb) AS v(${recordsetColumns}) WHERE EXISTS (
           SELECT 1 FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
           WHERE m.id=$2 AND m.workspace_id=$3 AND w.id=$3 AND w.principal_hash=$4)`,
      [
        JSON.stringify(batch),
        merchantId,
        session.workspace.id,
        session.principal,
      ],
    );
    if ((result.rowCount || 0) !== batch.length) {
      if (existing)
        conflict(
          "Another change saved this record at the same moment. Reload the page and try again.",
        );
      fail(LENDER_NOT_FOUND, 404);
    }
    start = end;
  }
  const merchantUpdate = await session.client.query(
    `UPDATE valopay_merchants m SET info=$4,settings=$5 WHERE m.id=$1 AND m.workspace_id=$2 AND EXISTS
      (SELECT 1 FROM valopay_workspaces w WHERE w.id=$2 AND w.principal_hash=$3)`,
    [
      merchantId,
      session.workspace.id,
      session.principal,
      state.merchant,
      state.settings,
    ],
  );
  if (!rowsAffected(merchantUpdate))
    fail(LENDER_NOT_FOUND, 404);
  // A subsequent repository save in this transaction validates against what
  // was just written, never a caller-supplied "previous" array.
  for (const record of changed)
    snapshot.records.set(record.id, JSON.stringify(record));
  snapshot.merchant = JSON.stringify(state.merchant);
  snapshot.settings = JSON.stringify(state.settings);
}

async function seedWorkspace(
  client: PoolClient,
  workspace: WorkspaceRow,
  principal: string,
  anonymous: boolean,
  now: string,
) {
  for (const smaller of [false, true]) {
    const state = seedMerchant(randomUUID(), smaller);
    state.settings.anonymousWorkspace = anonymous;
    // REC-01: the first scheduled close is the next configured time after creation, from the database clock.
    state.settings.nextCloseAt = nextCloseInstant(
      now,
      closeTimeOf(state.settings),
    );
    // Before the lender row is written, so its settings carry the audit chain's head.
    appendAudit(
      state,
      { actor: `${SYSTEM_ACTOR_PREFIX}sandbox seed`, role: "Admin", now },
      "sandbox.created",
      "workspace",
      "Created an isolated synthetic lender. Not live evidence.",
    );
    const merchant = await client.query(
      `INSERT INTO valopay_merchants(id,workspace_id,info,settings)
       SELECT $1,$2,$3,$4 WHERE EXISTS (SELECT 1 FROM valopay_workspaces WHERE id=$2 AND principal_hash=$5)`,
      [
        state.merchant.id,
        workspace.id,
        state.merchant,
        state.settings,
        principal,
      ],
    );
    if (!rowsAffected(merchant))
      throw new Error("Workspace seed ownership check failed.");
    assertFinalState(
      { merchant: structuredClone(state.merchant), settings: {}, records: [] },
      state,
      state.merchant.id,
    );
    for (const record of state.records) {
      const inserted = await client.query(
        `INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11 WHERE EXISTS (
           SELECT 1 FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
           WHERE m.id=$2 AND m.workspace_id=$12 AND w.id=$12 AND w.principal_hash=$13)`,
        [
          record.id,
          record.merchantId,
          record.kind,
          record.name,
          record.status,
          record.reference,
          record.amountKobo,
          record.customerId,
          record.data,
          record.createdAt,
          record.updatedAt,
          workspace.id,
          principal,
        ],
      );
      if (!rowsAffected(inserted))
        throw new Error("Workspace seed record ownership check failed.");
    }
  }
}

/**
 * A system transaction scoped to one merchant, for the scheduled close.  The
 * scope is the merchant's own workspace and principal, so every repository
 * query keeps its tenant predicate.  The merchant row is taken with SKIP
 * LOCKED: two instances never close the same lender at once and a request in
 * flight is never queued behind the scheduler.  Returns undefined when the
 * merchant is locked elsewhere or no longer exists.  It carries the system
 * limits (database-limits.ts) and is not gated: SKIP LOCKED already keeps it
 * from waiting on a busy lender.
 */
export async function inMerchantAsSystem<T>(
  merchantId: string,
  actor: string,
  fn: (context: StoreContext) => Promise<T>,
): Promise<T | undefined> {
  if (!actor.startsWith(SYSTEM_ACTOR_PREFIX))
    throw new Error("A system transaction needs a system actor.");
  const guard = await checkOut(() => pool.connect()),
    client = guard.client;
  let context: StoreContext | undefined,
    committing = false;
  try {
    await client.query(beginStatement(databaseLimits().system));
    await bindRuntimeService(client);
    const scope = (
      await client.query<{
        id: string;
        workspace_id: string;
        principal_hash: string;
        role: string;
      }>(
        `SELECT m.id,m.workspace_id,w.principal_hash,w.role FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
       WHERE m.id=$1 FOR UPDATE OF m SKIP LOCKED`,
        [merchantId],
      )
    ).rows[0];
    if (!scope) {
      await client.query("ROLLBACK");
      return undefined;
    }
    const now = (
      await client.query<{ now: Date }>("SELECT now() AS now")
    ).rows[0]!.now.toISOString();
    context = Object.freeze({
      authenticated: true,
      role: "Operations",
      actor,
      now,
    });
    sessions.set(context, {
      client,
      workspace: {
        id: scope.workspace_id,
        principal_hash: scope.principal_hash,
        role: scope.role,
      },
      principal: scope.principal_hash,
      active: true,
      access: "write",
    });
    const result = await fn(context);
    committing = true;
    const committed = await client.query("COMMIT");
    if (committed.command !== "COMMIT")
      throw new Error("The system transaction was rolled back.");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* transaction is already closed */
    }
    throw failedTransaction(error, {
      committing,
      lost: guard.lost(),
      write: true,
    });
  } finally {
    if (context) {
      const session = sessions.get(context);
      if (session) {
        session.active = false;
        session.snapshot = undefined;
        session.summarised = undefined;
        session.auditChain = undefined;
        session.auditCheck = undefined;
        session.lockedMerchantId = undefined;
      }
    }
    guard.release();
  }
}

/**
 * Whether a lender exists in a workspace, read without its lock: when
 * inMerchantAsSystem finds no row to lock, this tells a lender busy elsewhere
 * from one that is not there.  A plain read with the system limits; under
 * runtime isolation it runs as the service member, as the lock does.
 */
export async function merchantInWorkspace(
  merchantId: string,
  workspaceId: string,
): Promise<boolean> {
  return runtimeServiceRead(async (client) =>
    Boolean(
      (
        await client.query(
          "SELECT 1 FROM valopay_merchants WHERE id=$1 AND workspace_id=$2",
          [merchantId, workspaceId],
        )
      ).rows[0],
    ),
  );
}

/**
 * The next lenders whose scheduled close is due, in a fair order: staff and
 * signed-in lenders before anonymous sandboxes; lenders waiting to retry a
 * failed attempt after the rest; one lender per workspace per turn, so one
 * workspace's many lenders never hold another's back; then the earliest
 * time.  A lender waiting for its retry time is not due.  Each says whether
 * it is a public anonymous sandbox (settings.anonymousWorkspace, set only when
 * a visitor's sandbox is seeded with a lender or creates one), whose failed
 * close a pass counts apart.  `exclude` leaves out lenders a pass has already
 * dealt with; `only` limits the read to the lenders named (tests and operator
 * tooling).  A plain read with the system limits (runtimeServiceRead binds
 * the service identity only under runtime isolation): the caller re-checks
 * under the merchant lock before closing.
 */
export async function dueScheduledCloses(
  limit: number,
  options: { exclude?: readonly string[]; only?: readonly string[] } = {},
): Promise<Array<{ id: string; publicSandbox: boolean }>> {
  return runtimeServiceRead(async (client) =>
    (
      await client.query<{ id: string; anonymous: boolean }>(
        `WITH ready AS (
       SELECT m.id, m.workspace_id,
         (CASE WHEN m.settings->>'nextCloseAt' ~ $2 THEN (m.settings->>'nextCloseAt')::timestamptz END) AS due_at,
         -- A retry counts only for the pending time and when well formed, as closeRetryOf reads it.
         CASE WHEN m.settings->'closeRetry'->>'cursor' = m.settings->>'nextCloseAt' AND m.settings->'closeRetry'->>'failures' ~ '^[1-9][0-9]{0,5}$' AND m.settings->'closeRetry'->>'retryAt' ~ $2
              THEN (m.settings->'closeRetry'->>'failures')::int ELSE 0 END AS failures,
         CASE WHEN m.settings->'closeRetry'->>'cursor' = m.settings->>'nextCloseAt' AND m.settings->'closeRetry'->>'failures' ~ '^[1-9][0-9]{0,5}$' AND m.settings->'closeRetry'->>'retryAt' ~ $2
              THEN (m.settings->'closeRetry'->>'retryAt')::timestamptz END AS retry_at,
         COALESCE(m.settings->>'anonymousWorkspace', 'false') = 'true' AS anonymous
       FROM valopay_merchants m
       WHERE COALESCE(m.settings->>'scheduledCloseEnabled','true') <> 'false'
         AND NOT (m.id = ANY($3::text[])) AND ($4::text[] IS NULL OR m.id = ANY($4::text[]))
     ), due AS (
       SELECT * FROM ready WHERE due_at <= now() AND (retry_at IS NULL OR retry_at <= now())
     ), ranked AS (
       SELECT id, anonymous, failures, due_at, row_number() OVER (PARTITION BY workspace_id ORDER BY failures > 0, due_at, id) AS turn FROM due
     )
     SELECT id, anonymous FROM ranked ORDER BY anonymous, failures > 0, turn, due_at, id LIMIT $1`,
        [
          limit,
          ISO_INSTANT_PATTERN,
          [...(options.exclude ?? [])],
          options.only ? [...options.only] : null,
        ],
      )
    ).rows.map((row) => ({ id: row.id, publicSandbox: row.anonymous })),
  );
}

/** Lenders still owed a scheduled close, counted without naming any: every lender but public anonymous sandboxes, whose own counts are apart. */
export interface OwedCloses {
  overdue: number;
  failing: number;
  publicSandboxes: { overdue: number; failing: number };
}

/**
 * What the scheduled close still owes, counted without naming a lender: the
 * lenders whose automatic close is on and whose pending close is more than
 * `lateAfterMinutes` past its time (missed, as the close_missed alert reads
 * it), and those with a failed scheduled attempt recorded at their pending
 * time (settings.closeRetry, as closeRetryOf reads it), which only a close of
 * that lender, or a change to its schedule, ends.  Public anonymous sandboxes
 * (settings.anonymousWorkspace, a visitor's synthetic lenders, whose own data
 * can make a close fail) are counted apart, in publicSandboxes.  Durable facts
 * on the database clock, so no other lender's close clears them and a
 * restarted process reads them again.  `only` limits the count to the lenders
 * named (tests and operator tooling).  A plain read with the system limits,
 * as dueScheduledCloses is.
 */
export async function scheduledCloseBacklog(
  lateAfterMinutes: number,
  options: { only?: readonly string[] } = {},
): Promise<OwedCloses> {
  return runtimeServiceRead(async (client) => {
    const row = (
      await client.query<{
        overdue: number;
        failing: number;
        sandboxes_overdue: number;
        sandboxes_failing: number;
      }>(
        `SELECT count(*) FILTER (WHERE NOT anonymous AND late)::int AS overdue, count(*) FILTER (WHERE NOT anonymous AND failing)::int AS failing,
              count(*) FILTER (WHERE anonymous AND late)::int AS sandboxes_overdue, count(*) FILTER (WHERE anonymous AND failing)::int AS sandboxes_failing
       FROM (SELECT
         floor(extract(epoch FROM now() - CASE WHEN m.settings->>'nextCloseAt' ~ $1 THEN (m.settings->>'nextCloseAt')::timestamptz END) / 60) > $2 AS late,
         m.settings->>'nextCloseAt' ~ $1 AND m.settings->'closeRetry'->>'cursor' = m.settings->>'nextCloseAt'
           AND m.settings->'closeRetry'->>'failures' ~ '^[1-9][0-9]{0,5}$' AND m.settings->'closeRetry'->>'retryAt' ~ $1 AS failing,
         COALESCE(m.settings->>'anonymousWorkspace', 'false') = 'true' AS anonymous
         FROM valopay_merchants m
         WHERE COALESCE(m.settings->>'scheduledCloseEnabled','true') <> 'false' AND ($3::text[] IS NULL OR m.id = ANY($3::text[]))) lenders`,
        [
          ISO_INSTANT_PATTERN,
          lateAfterMinutes,
          options.only ? [...options.only] : null,
        ],
      )
    ).rows[0];
    return {
      overdue: row?.overdue ?? 0,
      failing: row?.failing ?? 0,
      publicSandboxes: {
        overdue: row?.sandboxes_overdue ?? 0,
        failing: row?.sandboxes_failing ?? 0,
      },
    };
  });
}

/**
 * Records a failed scheduled attempt on the lender (settings.closeRetry): one
 * more failure at its pending close time and when to try again, from the
 * database clock.  Its own small service transaction, after the failed close
 * rolled back; the row is taken with SKIP LOCKED, so a request or another
 * instance holding the lender is never waited for.  Returns undefined when
 * nothing was recorded: the lender is gone or locked, or its close is no
 * longer pending because someone closed it meanwhile.  The error text is never
 * stored, because the lender's settings are shown to its users.
 */
export async function recordScheduledCloseFailure(
  merchantId: string,
): Promise<CloseRetry | undefined> {
  return runtimeServiceRead(async (client) => {
    const row = (
      await client.query<{ settings: Record<string, unknown>; now: Date }>(
        "SELECT settings, now() AS now FROM valopay_merchants WHERE id=$1 FOR UPDATE SKIP LOCKED",
        [merchantId],
      )
    ).rows[0];
    const retry = row
      ? nextCloseRetry(row.settings, row.now.toISOString())
      : null;
    if (!retry) return undefined;
    const updated = await client.query(
      "UPDATE valopay_merchants SET settings = settings || jsonb_build_object('closeRetry', $2::jsonb) WHERE id=$1",
      [merchantId, JSON.stringify(retry)],
    );
    return rowsAffected(updated) ? retry : undefined;
  });
}

/**
 * Whether nobody has changed this context's workspace for `days`: it is older
 * than that and no audit entry by a person was written within it.  The same
 * definition of activity as the expiry sweep, so the scheduled close's own
 * entries never count.
 */
export async function sandboxInactiveFor(
  context: StoreContext,
  days: number,
): Promise<boolean> {
  const session = sessionFor(context);
  return (
    (
      await session.client.query<{ idle: boolean }>(
        `SELECT (w.created_at < now() - make_interval(days => $2)) AND NOT EXISTS (
       SELECT 1 FROM valopay_merchants m JOIN valopay_records r ON r.merchant_id=m.id
       WHERE m.workspace_id=w.id AND r.kind='audit' AND r.created_at >= now() - make_interval(days => $2)
         AND COALESCE(r.data->>'actor','') NOT LIKE $3) AS idle
     FROM valopay_workspaces w WHERE w.id=$1`,
        [session.workspace.id, days, `${SYSTEM_ACTOR_PREFIX}%`],
      )
    ).rows[0]?.idle === true
  );
}

/**
 * Merchants created before the scheduler existed carry no cursor.  Each gets
 * the next configured time after the database clock, without a close, so the
 * first scheduled close comes at its time rather than at the next tick.
 */
export async function initialiseCloseCursors(): Promise<number> {
  return runtimeServiceRead(async (client) => {
    if (runtimeIsolationEnabled()) {
      const rows = (
        await client.query<{
          id: string;
          settings: Record<string, unknown>;
          now: Date;
        }>(
          "SELECT m.id,m.settings,now() AS now FROM valopay_merchants m WHERE m.settings->>'nextCloseAt' IS NULL FOR UPDATE",
          [],
        )
      ).rows;
      for (const row of rows)
        await client.query(
          "UPDATE valopay_merchants SET settings=settings || jsonb_build_object('nextCloseAt',$2::text) WHERE id=$1 AND settings->>'nextCloseAt' IS NULL",
          [
            row.id,
            nextCloseInstant(row.now.toISOString(), closeTimeOf(row.settings)),
          ],
        );
      return rows.length;
    }
    const rows = (
      await client.query<{
        id: string;
        settings: Record<string, unknown>;
        now: Date;
      }>(
        "SELECT m.id,m.settings,now() AS now FROM valopay_merchants m WHERE m.settings->>'nextCloseAt' IS NULL",
      )
    ).rows;
    if (!rows.length) return 0;
    const updated = await client.query(
      `UPDATE valopay_merchants m SET settings = m.settings || jsonb_build_object('nextCloseAt', v.next_at)
       FROM (SELECT unnest($1::text[]) AS id, unnest($2::text[]) AS next_at) v
       WHERE m.id = v.id AND m.settings->>'nextCloseAt' IS NULL`,
      [
        rows.map((row) => row.id),
        rows.map((row) =>
          nextCloseInstant(row.now.toISOString(), closeTimeOf(row.settings)),
        ),
      ],
    );
    return updated.rowCount || 0;
  });
}

/**
 * Appends a hash-chained audit entry for an action to the lender's state and
 * moves the chain's head in its settings. A lender loaded for a write
 * continues from where its load found the chain (loadState); a state built in
 * memory (a new lender's seed, a test) from its stored head or its own entries.
 */
export function appendAudit(
  state: DomainState,
  ctx: Context,
  action: string,
  objectId: string,
  summary: string,
  changes?: unknown,
): ValopayRecord {
  const session = sessions.get(ctx as StoreContext),
    loaded =
      session?.active && session.lockedMerchantId === state.merchant.id
        ? session.auditChain
        : undefined;
  let head = loaded ?? storedChain(state.settings);
  if (!head) {
    // One pass for the chain's length and head; it is not sorted here.
    let length = 0,
      previous: ValopayRecord | undefined;
    for (const record of state.records) {
      if (record.kind !== "audit") continue;
      length += 1;
      if (
        !previous ||
        Number(record.data.sequence || 0) >= Number(previous.data.sequence || 0)
      )
        previous = record;
    }
    head = {
      sequence: length,
      hash: previous?.data.hash ?? AUDIT_GENESIS.hash,
      verified: AUDIT_GENESIS,
    };
  }
  const data = auditEntryData({
    sequence: head.sequence + 1,
    actor: ctx.actor,
    action,
    objectId,
    summary,
    changes,
    previousHash: head.hash,
    timestamp: ctx.now,
  });
  const record: ValopayRecord = {
    id: randomUUID(),
    merchantId: state.merchant.id,
    kind: "audit",
    name: action,
    status: "recorded",
    reference: "",
    amountKobo: 0,
    customerId:
      state.records.find((item) => item.id === objectId)?.customerId || "",
    createdAt: ctx.now,
    updatedAt: ctx.now,
    data,
  };
  state.records.push(record);
  const chain: AuditChain = {
    sequence: data.sequence,
    hash: data.hash,
    at: ctx.now,
    verified: head.verified,
    ...(head.broken ? { broken: head.broken } : {}),
    ...(head.walkedAt ? { walkedAt: head.walkedAt } : {}),
  };
  state.settings.auditChain = chain;
  if (loaded) session!.auditChain = chain;
  return record;
}
/** Walks the chain of the entries in a state that holds them all (an export's): valid when every entry's sequence, previous hash and digest agree; returns the count and the head hash. */
export function verifyAudit(state: DomainState) {
  return verifyAuditChain(recordsOf(state, "audit"));
}
// Compose once after core constants are initialised; modules import core signatures only, never its runtime.
export const {
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
} = createJournalRepository({
  sessionFor,
  readMerchant,
  digest,
  fail,
  requestOperations,
  boundMerchant,
  rowsAffected,
  lockedMerchant,
  scopedMerchantQuery,
  conflict,
});
export const {
  staffProvision,
  caseAssignees,
  staffDirectory,
  viewerScope,
  teamAdmin,
  staffEvent,
  inviteStaff,
  approveInvitation,
  updateStaff,
  approveStaffChange,
  declineStaffChange,
  updateStaffLenders,
  revokeInvitation,
  acceptStaffInvitation,
  operatorTransaction,
  provisionStaffWorkspace,
  addStaffAdministrator,
  renewStaffAdministrator,
  createPilotLender,
} = createTeamAccessRepository({
  sessionFor,
  roles,
  fail,
  listMerchants,
  digest,
  rowsAffected,
  lockWorkspace,
  SANDBOX_LENDER_LIMIT,
  loadState,
  appendAudit,
  saveState,
});
export const { rewrapProtectedPayloads } = createPayloadRewrapRepository({
  fail,
  operatorTransaction,
  rowsAffected,
});
export const {
  recordColumns,
  scopedRecordsFrom,
  scopedRecordsWhere,
  listRecords,
  listQueue,
  listReconciliation,
  listCloseHistory,
  getCloseDetail,
  loadReportsView,
  getCustomerHistory,
  loadCustomerView,
  loadSettingsView,
} = createReadModelsRepository({
  sessionFor,
  readMerchant,
  closeSummarySql,
  rowToRecord,
  fail,
});
export const { lifecycleInventory, executeLifecycleRun } =
  createRetentionRepository({
    PURGED_REQUEST,
    sessionFor,
    fail,
    lockedMerchant,
    receiptIds,
  });
export const {
  sweepExpiredWorkspaces,
  overrideSweptExportRemoval,
  removeSweptExportFiles,
  runExportCleanupPass,
  exportCleanupStatus,
  parkedExportFiles,
  requeueParkedExportFile,
  releaseParkedExportFile,
} = createExportCleanupRepository({
  ANONYMOUS_WORKSPACE_DAYS,
  SYSTEM_ACTOR_PREFIX,
  rowsAffected,
  fail,
});
export const {
  integrityGuards,
  guardMigrations,
  supersededGuards,
  pingDatabase,
  watchDatabase,
  closeDatabase,
} = createReadinessRepository();
