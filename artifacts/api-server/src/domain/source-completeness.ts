import { sourceManifestInputSchema, businessDateSchema, sourceBatchQualitySchema, sameJson, legacyCollatedCompare, otherCurrenciesText, changedText, counted, dayText, nairaText, type SourceManifestInput } from "@workspace/valo-pay-1-schema";
import { roleRefusal } from "./validation";
import type { Context, DomainState, ValopayRecord } from "./types";
import { makeRecord, recordsOf } from "./records";
import { assertRecordVersion } from "../lib/edit-versions";
import { canonicalDigest } from "../lib/digests";

// File IDs and the basis digest are stored in declarations and closes. The basis is built from fields a batch or
// profile may lack, and this form writes a missing one as null, as those stored digests do.
const hash = (value: unknown) => canonicalDigest(value, "legacy-code-unit-null");
const refuse = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
/** Dates refer to the source's business day, never its arrival or upload time. */
export const watBusinessDate = (iso: string) => new Date(Date.parse(iso) + 3600000).toISOString().slice(0, 10);
const identity = (file: {source: string; kind: string; sourceBatchId: string}) => [file.source, file.kind, file.sourceBatchId];
export const sourceFileId = (businessDate: string, file: {source: string; kind: string; sourceBatchId: string}) => hash([businessDate, ...identity(file)]);
export function latestSourceManifest(state: DomainState, businessDate: string) { return recordsOf(state, "source-manifests").filter(r => r.data.businessDate === businessDate).sort((a,b) => Number(b.data.revision)-Number(a.data.revision))[0]; }
export function saveSourceManifest(state: DomainState, ctx: Context, raw: SourceManifestInput) {
  if (!["Admin", "Operations", "Finance"].includes(ctx.role)) refuse(roleRefusal(ctx, ["Admin", "Operations", "Finance"], "declare the expected files"), 403);
  const input = sourceManifestInputSchema.parse(raw), previous = latestSourceManifest(state, input.businessDate);
  if (previous) { if (previous.id !== input.previousManifestId || !input.expectedUpdatedAt) refuse(changedText("list of expected files"), 409); assertRecordVersion(previous, input.expectedUpdatedAt); }
  else if (input.previousManifestId || input.expectedUpdatedAt) refuse("The earlier list of expected files for this business date was not found. Reload the page and declare the files again.", 409);
  const files = input.files.map(file => ({ ...file, id: sourceFileId(input.businessDate, file) }));
  if (new Set(files.map(file => file.id)).size !== files.length) refuse("Declare each file once for this business date.");
  for (const file of files) {
    if (file.kind === "customers" && file.expectedAmountKobo !== 0) refuse("Customer files have no amount. Declare a total of ₦0.");
    if (state.records.some(r => r.kind === "source-manifests" && r.data.businessDate !== input.businessDate && r.data.files?.some((other: any) => sameJson(identity(other), identity(file))))) refuse("This source batch ID is already declared for another business date. Use that date, or a different source batch ID.", 409);
    const batch = state.records.find(r => r.kind === "import-batches" && sameJson(identity(r.data as any), identity(file)));
    if (batch?.data.businessDate && batch.data.businessDate !== input.businessDate) refuse("A saved file belongs to another business date. The time it arrived does not move it to this one.", 409);
  }
  return makeRecord(state, "source-manifests", { name: `Expected files · ${dayText(input.businessDate)}`, status: "declared", createdAt: ctx.now, data: { businessDate: input.businessDate, timezone: "Africa/Lagos", files, noFilesExpected: input.noFilesExpected, reason: input.reason, evidence: input.evidence, revision: Number(previous?.data.revision || 0)+1, previousManifestId: previous?.id || null, declaredBy: ctx.actor, declaredAt: ctx.now, synthetic: true } });
}
/** Optional slot selection is checked against the lender's current declaration. */
export function assertSourceExpectation(state: DomainState, input: { businessDate?: string; sourceExpectationId?: string; source: string; sourceBatchId: string; kind: string }) {
  if (input.sourceExpectationId && (!input.businessDate || !latestSourceManifest(state, input.businessDate)?.data.files?.some((file: any) => file.id === input.sourceExpectationId && file.id === sourceFileId(input.businessDate!, input)))) refuse("The chosen expected file no longer matches this lender, business date or source batch ID. Reload the page and choose it again.", 409);
  for (const manifest of state.records.filter(r => r.kind === "source-manifests")) if (manifest.data.businessDate !== input.businessDate && manifest.data.files?.some((file: any) => sameJson(identity(file), identity(input)))) refuse("This source batch ID is declared for another business date. Choose that date before you save.", 409);
}
export interface SourceCompletenessIssue { id: string; label: string; detail: string; }
/** Original committed totals remain authoritative after raw-file retention or an approved correction. */
export function sourceCompleteness(state: DomainState, rawDate: string) {
  const businessDate = businessDateSchema.parse(rawDate), manifest = latestSourceManifest(state, businessDate), issues: SourceCompletenessIssue[] = [];
  const add = (id: string, label: string, detail: string) => issues.push({ id: `source:${id}`, label, detail });
  if (!manifest) add("declaration", "Expected files have not been declared", "Declare the expected files and their totals for this business date. Until you do, the day’s files cannot count as complete.");
  else if (manifest.data.noFilesExpected) add("excluded", "No files expected for this date", "A Finance team member must accept this and record evidence for it. Sample records already saved do not show that the day’s files are complete.");
  const files = (manifest?.data.files || []).map((file: any) => {
    const batch = state.records.find(r => r.kind === "import-batches" && sameJson(identity(r.data as any), identity(file))), problems: string[] = [], shown: string[] = [];
    // `problems` stays in the words the basis digest of every recorded close was taken over, so an unchanged day still
    // matches its close; `shown` says the same in today's words, for the issue a person reads.
    const problem = (recorded: string, words: string) => { problems.push(recorded); shown.push(words); };
    const quality = batch?.status === "committed" ? sourceBatchQualitySchema.safeParse(batch.data.sourceQuality) : undefined;
    if (!batch) problem("The expected file has not been saved.", "The expected file has not been saved.");
    else {
      if (batch.data.businessDate !== businessDate) {
        if (batch.data.businessDate) problem(`This file is assigned to ${batch.data.businessDate}, not this business date.`, `This file is for ${dayText(batch.data.businessDate)}, not this business date.`);
        else problem("This older batch has no declared business date. Its upload time cannot establish the covered date.", "This older batch has no business date, and its upload time does not show which day it covers. Declare its business date.");
      }
      if (batch.data.sourceExpectationId && batch.data.sourceExpectationId !== file.id) problem("The saved expectation link does not match this file declaration.", "This file is linked to a different expected file. Check the list of expected files.");
      if (batch.status !== "committed") problem("The source file has not been committed.", "The file has not been imported.");
      else if (!quality?.success) problem("The original committed source totals are unavailable.", "The totals the file was imported with are not available.");
      else {
        if (quality.data.status !== "checked") problem("The committed source checks still need review.", "The imported file’s checks still need review.");
        if (quality.data.sourceRows !== file.expectedRows) problem(`Declared ${file.expectedRows} rows; received ${quality.data.sourceRows}.`, `Declared ${counted(file.expectedRows, "row")}; received ${counted(Number(quality.data.sourceRows), "row")}.`);
        if (quality.data.sourceAmountKobo !== file.expectedAmountKobo) problem(`Declared ${file.expectedAmountKobo} kobo; received ${quality.data.sourceAmountKobo ?? "an unavailable total"}.`, `Declared total ${nairaText(file.expectedAmountKobo)}; received ${quality.data.sourceAmountKobo === undefined || quality.data.sourceAmountKobo === null ? "no total" : nairaText(quality.data.sourceAmountKobo)}.`);
        // The declared total is in naira and the received one sums the naira rows only; money in another currency is compared with nothing.
        const other = quality.data.sourceOtherCurrencies;
        if (other) problem(`The declared total is in naira, so it is compared with the naira rows only; this file also has ${otherCurrenciesText(other)} in ${Object.keys(other).length === 1 ? "another currency" : "other currencies"}, which no declared total covers.`, `The declared total is in naira, so it is compared with the naira rows only. This file also has ${otherCurrenciesText(other)} in ${Object.keys(other).length === 1 ? "another currency" : "other currencies"}, which no declared total covers.`);
        if (quality.data.invalidRows || quality.data.conflictRows) problem("Invalid or conflicting source rows remain.", "Some rows are still not valid or conflict with each other. Correct them in the import batch.");
      }
    }
    if (problems.length) add(file.id, `File incomplete · ${file.sourceBatchId}`, shown.join(" "));
    return { ...file, batchId: batch?.id || null, batchStatus: batch?.status || "missing", businessDate: batch?.data.businessDate || null, receivedRows: quality?.success ? quality.data.sourceRows : null, receivedAmountKobo: quality?.success ? quality.data.sourceAmountKobo : null, ...(quality?.success && quality.data.sourceOtherCurrencies ? { receivedOtherCurrencies: quality.data.sourceOtherCurrencies } : {}), status: problems.length ? "incomplete" : "complete", problems };
  });
  // A profile whose first delivery is expected after this business date has nothing to declare for it yet.
  const activeProfiles = state.records.filter(r => r.kind === "source-profiles" && r.status === "active" && (!r.data.firstExpectedAt || watBusinessDate(r.data.firstExpectedAt) <= businessDate)).map(r => ({id:r.id,source:r.data.source,kind:r.data.kind}));
  for (const profile of activeProfiles) if (!files.some((file:any) => file.source === profile.source && file.kind === profile.kind)) add(`profile:${profile.id}`, `No expected file for ${profile.source}`, "This active source profile expects a file by this business date, but the expected files do not include one. Add it, or have Finance accept, with evidence, that it is not expected.");
  const undeclared = state.records.filter(r => r.kind === "import-batches" && r.data.businessDate === businessDate && !files.some((file:any) => sameJson(identity(file), identity(r.data as any)))).map(r => ({id:r.id,name:r.name,status:r.status,source:r.data.source,sourceBatchId:r.data.sourceBatchId,kind:r.data.kind}));
  for (const batch of undeclared) add(`batch:${batch.id}`, `Unexpected file · ${batch.sourceBatchId}`, "This batch is dated for this business date, but it is not one of the expected files. Add it to the expected files, or check its date.");
  const basis = { businessDate, manifest: manifest ? {id:manifest.id,updatedAt:manifest.updatedAt,data:manifest.data} : null, files, activeProfiles:activeProfiles.sort((a,b)=>legacyCollatedCompare(a.id,b.id)), undeclared:undeclared.sort((a,b)=>legacyCollatedCompare(a.id,b.id)) };
  return { ...basis, status: issues.length ? "incomplete" : "complete", issues, basisDigest: hash(basis), expectedFiles: files.length, completeFiles: files.filter((file:any)=>file.status === "complete").length };
}
