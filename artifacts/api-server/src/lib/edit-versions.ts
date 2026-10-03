import { createHash } from "node:crypto";
import { canonicalJson } from "@workspace/valo-pay-1-schema";
import type { DomainState, ValopayRecord } from "../domain/types";

// Only editable preferences participate. A scheduler heartbeat/cursor must not
// invalidate a form whose preferences have not changed.
const preferenceKeys = ["executionStart", "executionEnd", "authorisationMode", "contactRoute", "minimumTicketKobo", "defaultOwner", "policyChangeRequiresConsent", "unallocatedAlertThreshold", "notificationCostAlertKobo", "closeTime", "scheduledCloseEnabled"] as const;
export function settingsRevision(settings: Record<string, any>): string {
  return createHash("sha256").update(JSON.stringify(preferenceKeys.map(key => [key, settings[key] ?? null]))).digest("hex");
}
/**
 * A record's data after an edit: the stored fields with the edit's merged over
 * them, as a merge patch reads it, so a field the edit sends as null is removed.
 * That is how an edit clears an optional field; a field it leaves out keeps
 * its value.
 */
export function mergeData(stored: Record<string, unknown>, edit: Record<string, unknown> | undefined): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...stored, ...edit };
  for (const [key, value] of Object.entries(edit ?? {})) if (value === null) delete merged[key];
  return merged;
}
function stale(message: string): never { throw Object.assign(new Error(message), { status: 409 }); }
export function assertRecordVersion(record: ValopayRecord, expectedUpdatedAt: string | undefined): void {
  if (expectedUpdatedAt === undefined) return;
  if (!Number.isFinite(Date.parse(expectedUpdatedAt))) throw Object.assign(new Error("This form is out of date. Reload the page and try again."), { status: 400 });
  if (Date.parse(record.updatedAt) !== Date.parse(expectedUpdatedAt)) stale("This record changed after you opened it, so your changes were not saved. Reload the page and try again.");
}
export function assertSettingsVersion(settings: Record<string, any>, expectedRevision: string | undefined): void {
  if (expectedRevision !== undefined && expectedRevision !== settingsRevision(settings)) stale("These settings changed after you opened them, so your changes were not saved. Reload the page and try again.");
}

/**
 * Whether a record's content differs from the JSON it was loaded as: the one
 * rule a save uses to decide what to write, check and version. Identical JSON
 * costs one comparison; otherwise the canonical forms decide, so a record
 * whose keys were only reordered (PostgreSQL stores the same value either
 * way) is unchanged: it is not written, gets no new version and cannot trip
 * an evidence record's immutability check.
 */
export function recordChanged(loaded: string, record: ValopayRecord): boolean {
  const json = JSON.stringify(record);
  if (loaded === json) return false;
  // Reordered keys give text of the same length, so a different length is a change without canonicalising anything.
  return loaded.length !== json.length || canonicalJson(JSON.parse(loaded)) !== canonicalJson(record);
}
/** A changed record's next version: strictly after the one it was loaded with, and never before the transaction's clock. */
export function nextRecordVersion(record: ValopayRecord, loadedUpdatedAt: string, now: string): string {
  return new Date(Math.max(Date.parse(now), Date.parse(record.updatedAt), Date.parse(loadedUpdatedAt) + 1)).toISOString();
}
/** All changed mutable records get a strictly newer revision, even when two
 * actions share a millisecond or a transaction waited for an earlier writer.
 * The repository applies the same two rules to its loaded snapshot; the pure
 * tests and the console's in-memory API call this with the state before. */
export function advanceRecordVersions(before: DomainState, after: DomainState, now: string): void {
  const originals = new Map(before.records.map(record => [record.id, record]));
  for (const record of after.records) {
    const original = originals.get(record.id);
    if (!original || !recordChanged(JSON.stringify(original), record)) continue;
    record.updatedAt = nextRecordVersion(record, original.updatedAt, now);
  }
}
