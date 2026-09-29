/** Internal repository types. Import through valopay-store; external access is rejected by the boundary check. */
import type { Context, DomainState, ValopayRecord } from "../../domain/types";
import type { PoolClient } from "@workspace/db";
import type { AuditVerification } from "../../domain/alerts";
import type { AuditPoint } from "../digests";

export type WorkspaceRow = { id: string; principal_hash: string; role: string };

/**
 * The lender as a write transaction loaded it, one JSON string per record.
 * A save serialises the lender once more and compares strings: whatever is
 * identical is untouched, so checks, versions, audit digests and writes look
 * only at what the request changed.
 */
export type StateSnapshot = {
  merchant: string;
  settings: string;
  records: Map<string, string>;
};

export type MerchantRow = {
  id: string;
  info: DomainState["merchant"];
  settings: DomainState["settings"];
};

export type RecordRow = {
  id: string;
  merchant_id: string;
  kind: string;
  name: string;
  status: string;
  reference: string;
  amount_kobo: string | number;
  customer_id: string;
  data: ValopayRecord["data"];
  created_at: Date;
  updated_at: Date;
};

export type Session = {
  client: PoolClient;
  workspace: WorkspaceRow;
  principal: string;
  active: boolean;
  access: WorkspaceAccess;
  lockedMerchantId?: string;
  snapshot?: StateSnapshot;
  summarised?: Set<string>;
  owner?: string;
  operationId?: string;
  userId?: string;
  organizationId?: string;
  /** This transaction passed the restricted-database self-check (runtime isolation). */
  isolationVerified?: boolean;
  /** A read on one REPEATABLE READ snapshot, read only once its identity checks passed: it takes no lender lock (inWorkspace). */
  snapshotRead?: boolean;
  /** Where the loaded lender's audit chain stands, as its write found it (loadState); appendAudit continues from it. */
  auditChain?: AuditChain;
  /** That check of the chain, which a daily close lists among its alerts (writeAuditCheck). */
  auditCheck?: AuditVerification;
};

/**
 * This is an opaque transaction capability.  Its database handle and locked
 * merchant are deliberately private to the composed repository; a route cannot construct a
 * useful context or issue an unscoped query.
 */
export interface StoreContext extends Context {
  readonly authenticated: boolean;
  readonly accessMode?: "sandbox" | "staff";
}

export interface StoredRequest {
  method: "POST" | "PATCH";
  path: string;
  body: unknown;
}

export type OperationRow = {
  id: string;
  merchant_id: string;
  owner: string;
  actor: string;
  role: string;
  request_key: string;
  request_hash: string;
  request: StoredRequest;
  label: string;
  status: string;
  receipt: unknown;
  created_at: Date;
  updated_at: Date;
};

export type StaffRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  display_name: string;
  role: string;
  status: "active" | "suspended" | "revoked";
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
};

/** Row lock a load takes on the merchant: exclusive for a mutation, shared for a read so reads never queue behind each other. */
export type MerchantLock = "update" | "share" | "none";

export type WorkspaceAccess = "read" | "write" | "persona" | "team";

/**
 * Where a lender's audit chain stands, kept in its settings (`auditChain`) as
 * the close cursor is: the head, which the next entry follows, `verified`,
 * the last entry read back from the database and verified, and `broken` once
 * a completed write, verify_audit or the daily check has recorded a break:
 * the entry it stopped at, the one after `verified` (a read such as the
 * overview stores nothing). `at` is an entry's creation time, and `walkedAt`
 * when the last walk of the whole chain that recorded its result began reading
 * (readAuditChain). The entries stay in valopay_records (kind `audit`) and are
 * not part of a loaded state: appendAudit needs only the head.
 */
export type ChainPoint = AuditPoint & { at?: string };

export type AuditChain = ChainPoint & {
  verified: ChainPoint;
  broken?: { sequence: number };
  walkedAt?: string;
};

/** An export file a swept sandbox's lender wrote to private storage: where it is and, once ready, its checksum. */
export interface SweptExportFile {
  merchantId: string;
  exportId: string;
  bucket: string;
  objectName: string;
  checksum?: string;
}
