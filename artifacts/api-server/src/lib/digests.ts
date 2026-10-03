import { createHash } from "node:crypto";
import { canonicalJson, type CanonicalJsonForm } from "@workspace/valo-pay-1-schema";

/**
 * Every digest the API stores or compares across requests, and the canonical
 * JSON form it is written in (lib/valo-pay-1-schema/src/canonical-json.ts). A
 * digest that is stored and computed again later keeps the form it was first
 * written in, so evidence saved by an earlier build still verifies:
 *
 * - the audit chain (entry hash and change digest) and the request
 *   fingerprints (idempotency receipts, the operations journal, lender
 *   onboarding, connected actions):
 *   `legacy-en-us-null`, through this module;
 * - retention policy and hold revisions, retention candidate and preview
 *   digests, import-correction impact, preview and proposal digests, work-item
 *   source digests and import row fingerprints: `legacy-en-us-replacer`;
 * - source file IDs and the source completeness basis: `legacy-code-unit-null`;
 * - connected cash evidence hashes and connected credit snapshots and IDs:
 *   `legacy-en-us-omit`;
 * - retry-decision fingerprints and close review input and snapshot digests:
 *   `canonical`, whose text is byte for byte what their earlier helpers wrote
 *   for any value read back from the database;
 * - a retained request payload's retention digest (its request fingerprint,
 *   key, outcome and version): `canonical`; runs prepared before it hold the
 *   earlier digest, of the stored request and receipt, in `legacy-en-us-null`,
 *   which approving or executing such a run computes again.
 *
 * Digests of bytes (export checksums, recovery backups) and of plain strings
 * (record and journal IDs, principals) involve no JSON form. A Paystack test
 * event's payload digest is `JSON.stringify` of the event the parser builds,
 * whose key order the parser fixes.
 */

/** SHA-256 of a string, as lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** SHA-256 of a value's canonical JSON in the named form: `canonical` unless a stored digest needs a legacy form. */
export function canonicalDigest(value: unknown, form: CanonicalJsonForm = "canonical"): string {
  return sha256Hex(canonicalJson(value, form));
}

/** The form of every audit and request digest: each stored chain and journal fingerprint was computed with it. */
const RECORDED_FORM: CanonicalJsonForm = "legacy-en-us-null";

/**
 * A request's fingerprint, stored beside its idempotency receipt or journal
 * entry: a replay with the same key must send the same request, and is
 * compared with this.
 */
export function requestFingerprint(request: unknown): string {
  return canonicalDigest(request, RECORDED_FORM);
}

/** What an audit entry commits to; its hash covers exactly these fields. */
export interface AuditEntryBody {
  sequence: number;
  actor: string;
  action: string;
  objectId: string;
  summary: string;
  changeDigest: string;
  previousHash: string;
  timestamp: string;
}
/** An audit record's data: the body and its hash. */
export type AuditEntryData = AuditEntryBody & { hash: string };

/** The chain hash of an audit entry's body. */
export function auditEntryHash(body: object): string {
  return canonicalDigest(body, RECORDED_FORM);
}

/**
 * The one audit-entry builder: the data of the entry that follows
 * `previousHash` (GENESIS for the first), with the digest of what changed and
 * the chain hash. The repository and the export worker each find the chain's
 * head their own way and pass it in.
 */
export function auditEntryData(entry: {
  sequence: number; actor: string; action: string; objectId: string; summary: string;
  changes?: unknown; previousHash?: string; timestamp: string;
}): AuditEntryData {
  const body: AuditEntryBody = {
    sequence: entry.sequence, actor: entry.actor, action: entry.action, objectId: entry.objectId, summary: entry.summary,
    changeDigest: canonicalDigest(entry.changes ?? {}, RECORDED_FORM), previousHash: entry.previousHash ?? "GENESIS", timestamp: entry.timestamp,
  };
  return { ...body, hash: auditEntryHash(body) };
}

/** A place in a lender's audit chain: an entry's sequence and hash, or sequence 0 and GENESIS before the first entry. */
export interface AuditPoint { sequence: number; hash: string }
export const AUDIT_GENESIS: Readonly<AuditPoint> = Object.freeze({ sequence: 0, hash: "GENESIS" });

/**
 * An entry's stored sequence when it is one the chain can hold, a whole number
 * from 1, else undefined: null, text (even the text of a number), a fraction,
 * zero or a missing key marks a damaged entry, which can never be the head.
 */
export function chainSequence(sequence: unknown): number | undefined {
  return Number.isSafeInteger(sequence) && (sequence as number) >= 1 ? sequence as number : undefined;
}

/**
 * Walks audit entries in sequence order from `from` (the chain's start unless
 * given): valid when every entry's sequence follows the one before, its
 * previous hash is that entry's hash and its own hash is its body's. The
 * order is the same whatever a stored sequence holds: whole-number sequences
 * by value, then every other entry, so a damaged entry is itself a break
 * where the walk reaches it, after every whole-number entry, and the entries
 * of one sequence stay side by side. A sequence two entries claim (a fork, as
 * two writers that each took the next sequence leave) breaks the chain before
 * it: neither entry is verified. Returns the count, the entries before `from`
 * included, the hash where the walk ended, and the last place it verified
 * with its entry, which is always before the first entry that breaks the
 * chain.
 */
export function walkAuditChain<E extends { data: Record<string, any> }>(entries: ReadonlyArray<E>, from: AuditPoint = AUDIT_GENESIS): { valid: boolean; count: number; headHash: string; verified: AuditPoint; entry?: E } {
  // Compared with < and >, never subtracted: every damaged entry has the same place, so the order is consistent.
  const chain = entries.map((entry) => ({ entry, place: chainSequence(entry.data.sequence) ?? Infinity }))
    .sort((a, b) => a.place < b.place ? -1 : a.place > b.place ? 1 : 0);
  let hash = from.hash, valid = true, sequence = from.sequence, entry: E | undefined;
  for (const [index, { entry: next }] of chain.entries()) {
    const { hash: recorded, ...body } = next.data;
    if (body.sequence !== sequence + 1 || chain[index + 1]?.place === body.sequence || body.previousHash !== hash || auditEntryHash(body) !== recorded) { valid = false; break; }
    sequence += 1; hash = String(recorded); entry = next;
  }
  return { valid, count: from.sequence + chain.length, headHash: hash, verified: { sequence, hash }, ...(entry ? { entry } : {}) };
}

/**
 * Walks a lender's audit entries in sequence order: valid when every entry's
 * sequence, previous hash and hash agree. Returns the count and the head hash.
 */
export function verifyAuditChain(entries: ReadonlyArray<{ data: Record<string, any> }>): { valid: boolean; count: number; headHash: string } {
  const { valid, count, headHash } = walkAuditChain(entries);
  return { valid, count, headHash };
}
