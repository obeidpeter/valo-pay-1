import { parse } from "csv-parse/sync";
import { counted, csvAmountToKobo, importFieldsOf, nairaText, notFoundText, otherCurrenciesText, sourceProfileInputSchema, type SourceProfileInput, type SourceBatchQuality } from "@workspace/valo-pay-1-schema";
import { roleRefusal } from "./validation";
import type { Context, DomainState, ValopayRecord } from "./types";
import { makeRecord, assertSourceOpened, recordsOf } from "./records";
import { assertRecordVersion } from "../lib/edit-versions";
import { sourceCompleteness, watBusinessDate } from "./source-completeness";

function refuse(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
const writer = (ctx: Context) => { if (!["Admin", "Operations", "Finance"].includes(ctx.role)) refuse(roleRefusal(ctx, ["Admin", "Operations", "Finance"], "change data source settings"), 403); };
const safeSum = (values: number[]) => {
  let result = 0n;
  for (const value of values) { if (!Number.isSafeInteger(value) || value < 0) throw new Error("An amount in this file is not valid. Correct the file and save it again."); result += BigInt(value); }
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The file’s total is larger than Valo Pay 1 supports. Split the file into smaller batches.");
  return Number(result);
};
/**
 * Amounts by the currency each names (none or a blank one is naira), never added across currencies: the naira total
 * and, only when there is some, each other currency's rows and total in its minor unit, by code.
 */
const byCurrency = (amounts: Array<{ currency: unknown; amount: number }>) => {
  const groups = new Map<string, number[]>();
  for (const { currency, amount } of amounts) {
    const code = String(currency || "").trim().toUpperCase() || "NGN";
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code)!.push(amount);
  }
  const other = [...groups].filter(([code]) => code !== "NGN").sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, values]) => [code, { count: values.length, amount: safeSum(values) }] as const);
  return { kobo: safeSum(groups.get("NGN") ?? []), other: other.length ? Object.fromEntries(other) : undefined };
};
/** Money in other currencies for a sentence: "USD 10.00 in another currency", "JPY 1,000 and USD 10.00 in other currencies". */
const elsewhereText = (other: Record<string, { amount: number }>) => `${otherCurrenciesText(other)} in ${Object.keys(other).length === 1 ? "another currency" : "other currencies"}`;

export function saveSourceProfile(state: DomainState, ctx: Context, raw: SourceProfileInput, id?: string) {
  writer(ctx);
  const input = sourceProfileInputSchema.parse(raw);
  if (Object.entries(input.mapping).some(([key, value]) => ["__proto__", "constructor", "prototype"].includes(key) || ["__proto__", "constructor", "prototype"].includes(value))) refuse("One of these column names cannot be used. Rename the column and try again.");
  const old = id ? state.records.find(r => r.kind === "source-profiles" && r.id === id) : undefined;
  if (id && !old) refuse(notFoundText("source profile"), 404);
  if (old) {
    if (!input.expectedUpdatedAt) refuse("Reload the page before you change this source profile.", 409);
    assertRecordVersion(old, input.expectedUpdatedAt);
    if (old.data.source !== input.source || old.data.kind !== input.kind) refuse("Add a separate source profile for a different data source or record type.");
  }
  if (state.records.some(r => r.kind === "source-profiles" && r.id !== id && r.data.source === input.source && r.data.kind === input.kind)) refuse("This source and record type already have a profile. Edit the existing profile.", 409);
  const record = old || makeRecord(state, "source-profiles", { createdAt: ctx.now });
  record.name = input.name; record.status = input.status;
  const { expectedUpdatedAt: _version, name: _name, status: _status, ...settings } = input;
  record.data = { ...settings, synthetic: true, changedBy: ctx.actor };
  return record;
}

/** Every row is summed with integer arithmetic; invalid or excessive totals cannot masquerade as zero. */
export function batchSourceQuality(state: DomainState, batch: ValopayRecord): SourceBatchQuality {
  assertSourceOpened(batch, ["csv", "check"]);
  const profile = recordsOf(state, "source-profiles").find(r => r.status === "active" && r.data.source === batch.data.source && r.data.kind === batch.data.kind);
  const check = batch.data.check || {}, issues: string[] = [];
  const quality: SourceBatchQuality = { profileId: profile?.id || null, profileVersion: profile?.updatedAt || null,
    sourceRows: 0, sourceAmountKobo: null, importedRows: 0, importedAmountKobo: null,
    duplicateRows: Number(check.skipped || 0), conflictRows: 0, invalidRows: Number(check.invalid || 0), status: "checked", issues };
  quality.conflictRows = (check.rows || []).filter((r: { status: string; message: string }) => r.status === "invalid" && /source row ID was already|reference belongs/.test(r.message)).length;
  try {
    const rows = parse(batch.data.csv, { columns: true, skip_empty_lines: true, trim: true, bom: true, max_record_size: 20000 }) as Record<string, string>[];
    quality.sourceRows = rows.length;
    const columns = Object.keys(rows[0] || {});
    const field = (column: string) => Object.hasOwn(batch.data.mapping || {}, column) ? batch.data.mapping[column] : column;
    // As in the import, only a kind with a currency field (payment evidence) reads a row's currency.
    const ownCurrency = importFieldsOf(batch.data.kind).includes("currency");
    const amountColumn = columns.find(column => ["amount", "amountKobo"].includes(field(column))), currencyColumn = ownCurrency ? columns.find(column => field(column) === "currency") : undefined;
    // As in the import, a customer row's amount is optional: a blank one counts for nothing, and a row's amount is read in its own currency's units.
    if (amountColumn) {
      const source = byCurrency(rows.map(row => {
        const currency = currencyColumn ? row[currencyColumn] : undefined;
        return { currency, amount: batch.data.kind === "customers" && !row[amountColumn]?.trim() ? 0 : csvAmountToKobo(row[amountColumn] || "", batch.data.amountUnit, currency, batch.data.kind) };
      }));
      quality.sourceAmountKobo = source.kobo;
      if (source.other) quality.sourceOtherCurrencies = source.other;
    }
    else if (batch.data.kind === "customers") quality.sourceAmountKobo = 0;
    else issues.push("Map an amount column to compare the file’s total with what was imported.");
    const imported = state.records.filter(r => r.kind === batch.data.kind && r.data.importIdentity?.batchId === batch.id);
    quality.importedRows = imported.length;
    const saved = byCurrency(imported.map(r => ({ currency: ownCurrency ? r.data.currency : undefined, amount: r.amountKobo })));
    quality.importedAmountKobo = saved.kobo;
    if (saved.other) quality.importedOtherCurrencies = saved.other;
    if (profile) {
      if (profile.data.expectedRows != null && profile.data.expectedRows !== rows.length) issues.push(`Expected ${counted(profile.data.expectedRows, "row")}; this batch has ${counted(rows.length, "row")}.`);
      if (profile.data.expectedAmountKobo != null && profile.data.expectedAmountKobo !== quality.sourceAmountKobo) issues.push(`The file’s total (${quality.sourceAmountKobo === undefined || quality.sourceAmountKobo === null ? "none" : nairaText(quality.sourceAmountKobo)}) does not match the source profile’s expected total (${nairaText(Number(profile.data.expectedAmountKobo))}). Check the file, or update the profile.`);
      // The expected amount is in naira: rows in another currency are compared with nothing, so the batch says so.
      if (profile.data.expectedAmountKobo != null && quality.sourceOtherCurrencies) issues.push(`The source profile’s expected total is in naira, so it is compared with the naira rows only. This batch also has ${elsewhereText(quality.sourceOtherCurrencies)}, which it does not cover.`);
      if (profile.data.identityColumn !== batch.data.identityColumn || profile.data.amountUnit !== batch.data.amountUnit || JSON.stringify(Object.entries(profile.data.mapping || {}).sort()) !== JSON.stringify(Object.entries(batch.data.mapping || {}).filter(([key, value]) => !(key === batch.data.identityColumn && value === "" && !Object.hasOwn(profile.data.mapping || {}, key))).sort())) issues.push("This batch uses a different column mapping, source row ID column or amount unit from its active source profile. Review the mapping, or update the profile first.");
    }
  } catch (error) { quality.status = "unavailable"; issues.push(error instanceof Error ? error.message : "The source totals could not be checked."); }
  if (quality.invalidRows) issues.push(`${counted(quality.invalidRows, "row still needs", "rows still need")} correcting.`);
  if (quality.status !== "unavailable" && issues.length) quality.status = "needs_review";
  return quality;
}

export function assertSourceBatchReady(state: DomainState, batch: ValopayRecord): SourceBatchQuality {
  const quality = batchSourceQuality(state, batch);
  if (quality.status !== "checked") refuse(`Resolve the file’s checks before you import this batch. ${quality.issues.join(" ")}`, 409);
  return quality;
}

/** A commit satisfies only the interval in which it arrived; later uploads cannot hide a missed interval. */
export function sourceDelivery(state: DomainState, profile: ValopayRecord, now: string) {
  const first = Date.parse(profile.data.firstExpectedAt), interval = profile.data.cadenceHours * 3600000;
  const grace = profile.data.graceMinutes * 60000, current = Date.parse(now);
  const deliveries = state.records.filter(r => r.kind === "import-batches" && r.status === "committed" && r.data.source === profile.data.source && r.data.kind === profile.data.kind && r.data.committedAt)
    .map(r => ({ id: r.id, at: Date.parse(r.data.committedAt) })).sort((a,b) => a.at - b.at);
  const deadlineIndex = Math.floor((current - first - grace) / interval);
  const fulfilled = new Set(deliveries.map(d => Math.max(0, Math.ceil((d.at - first - grace) / interval))).filter(i => i <= deadlineIndex));
  const due = Math.max(0, deadlineIndex + 1), missed = Math.max(0, due - fulfilled.size);
  const latest = deliveries.at(-1), latestIndex = Math.max(0, deadlineIndex + 1);
  return { status: profile.status === "paused" ? "paused" : missed ? "late" : latest ? "on_schedule" : "awaiting_first_delivery",
    missedDeliveries: profile.status === "paused" ? 0 : missed, nextExpectedAt: new Date(first + latestIndex * interval).toISOString(),
    lastCommittedAt: latest ? new Date(latest.at).toISOString() : null, lastBatchId: latest?.id || null };
}

export function sourceQuality(state: DomainState, now: string, businessDate = watBusinessDate(now)) {
  const profiles = state.records.filter(r => r.kind === "source-profiles").map(profile => ({ ...profile, delivery: sourceDelivery(state, profile, now) }));
  const batches = state.records.filter(r => r.kind === "import-batches").sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(batch => ({ id: batch.id, name: batch.name, source: String(batch.data.source || ""), sourceBatchId: String(batch.data.sourceBatchId || ""), kind: String(batch.data.kind || ""), status: batch.status, createdAt: batch.createdAt, quality: batch.status === "committed" && batch.data.sourceQuality ? batch.data.sourceQuality : batchSourceQuality(state, batch) }));
  return { profiles, batches, completeness: sourceCompleteness(state, businessDate), summary: { lateSources: profiles.filter(p => p.delivery.status === "late").length, duplicateRows: batches.reduce((n,b) => n + b.quality.duplicateRows, 0), conflictRows: batches.reduce((n,b) => n + b.quality.conflictRows, 0), batchesNeedingReview: batches.filter(b => b.quality.status !== "checked").length } };
}
