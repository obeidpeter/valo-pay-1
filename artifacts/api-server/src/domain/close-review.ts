import { counted, dayText, demoRolesNote, hasFeeSchedule, moneyText, notFoundText, otherCurrenciesText, valueLabel, prepareCloseReviewSchema, decideCloseReviewSchema, reassignCloseReviewSchema, closeReviewHistoryQuerySchema, legacyCollatedCompare, sameJson, type PrepareCloseReviewInput, type DecideCloseReviewInput, type ReassignCloseReviewInput, type CloseReviewHistoryQuery, type PilotProgressStep } from "@workspace/valopay-schema";
import type { Context, DomainState, ValopayRecord } from "./types";
import { makeRecord, touch } from "./records";
import { assertRecordVersion } from "../lib/edit-versions";
import { sourceCompleteness, watBusinessDate } from "./source-completeness";
import { currencyOf } from "./reconciliation";
import { canonicalDigest } from "../lib/digests";
import { roleRefusal } from "./validation";

function refuse(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
// Canonical form: for a record read back from the database it is the text the earlier code-unit helper wrote, so stored
// input and snapshot digests still match, and a close's own in-memory records now hash as they will be stored.
const digest = (value: unknown) => canonicalDigest(value);
const principal = (ctx: Context & { principalId?: string }) => ctx.principalId || (ctx.actor.startsWith("Sandbox ") ? "unidentified-demo-person" : ctx.actor);
const open = (record: ValopayRecord) => !["resolved", "closed"].includes(record.status);
const newest = (records: ValopayRecord[]) => [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || Number(b.data.reviewNumber || b.data.reviewBasis?.sequence || 0) - Number(a.data.reviewNumber || a.data.reviewBasis?.sequence || 0) || b.id.localeCompare(a.id));
const ofKind = (state: DomainState, kind: string) => state.records.filter(r => r.kind === kind);

// A close's inputs exclude UI preferences, audit bookkeeping, exports and review
// records. Revision timestamps are excluded because the store advances them after
// the domain transaction. Financial values, statuses and source/evidence content
// remain in the digest, including additions, removals and case corrections.
const basisKinds = new Set(["customers", "mandates", "due-items", "observations", "payments", "allocations", "exceptions", "settlement-batches", "attempts", "refunds", "adjustments", "policies", "templates", "retry-decisions"]);
export function closeReviewBasis(state: DomainState) {
  const approvedCorrections = ofKind(state, "import-correction-events").filter(r => r.data.action === "approve");
  const proposals = ofKind(state, "import-corrections").filter(r => approvedCorrections.some(event => event.data.proposalId === r.id));
  return digest({ merchantId: state.merchant.id, records: [...state.records.filter(r => basisKinds.has(r.kind)), ...approvedCorrections, ...proposals].map(({ updatedAt: _, ...record }) => record).sort((a, b) => legacyCollatedCompare(a.id, b.id)) });
}
/**
 * The input digest of a state a read does not change, computed the first time
 * it is asked for: a read makes one and passes it to every currency check it
 * makes, so it pays for the digest once however many closes and reviews it
 * checks. It lives only as long as that read.
 */
export function closeReviewBasisOnce(state: DomainState): () => string {
  let basis: string | undefined;
  return () => (basis ??= closeReviewBasis(state));
}
const pendingFinancialCorrections = (state: DomainState) => {
  const decided = new Set(ofKind(state, "import-correction-events").filter(event => ["approve", "reject", "withdraw"].includes(String(event.data.action))).map(event => event.data.proposalId));
  return ofKind(state, "import-corrections").filter(record => record.data.preview?.financial && !decided.has(record.id));
};
export interface CloseReviewIssue { id: string; label: string; detail: string; unresolved: boolean; }
export function bindCloseReviewBasis(state: DomainState, close: ValopayRecord) {
  const completeness = sourceCompleteness(state, close.data.sourceBusinessDate || watBusinessDate(close.data.closedAt || close.createdAt));
  close.data.reviewBasis = {
    version: 1,
    sequence: close.data.reviewBasis?.sequence || Math.max(0, ...ofKind(state, "closes").filter(record => record.id !== close.id).map(record => Number(record.data.reviewBasis?.sequence || 0))) + 1,
    inputDigest: closeReviewBasis(state),
    sourceCompleteness: completeness,
    // Each amount with the currency of its minor units when that is not naira, as the record names it.
    unresolved: state.records.filter(r => (r.kind === "exceptions" && open(r)) || (r.kind === "observations" && r.status !== "resolved") || (r.kind === "payments" && ["partial", "overpaid"].includes(r.status))).map(r => ({ id: r.id, kind: r.kind, name: r.name, reference: r.reference, status: r.status, amountKobo: r.amountKobo, ...(currencyOf(r) !== "NGN" ? { currency: currencyOf(r) } : {}) })),
  };
  return close;
}
export function closeReviewIssues(close: ValopayRecord): CloseReviewIssue[] {
  const report = close.data.report || {}, issues: CloseReviewIssue[] = [];
  // Each batch in its own currency (a close before currencies were kept lists naira batches only); fees are checked in naira alone.
  for (const batch of report.variances?.batches || []) issues.push({ id: `variance:${batch.batchId}`, label: `Settlement difference · ${batch.reference || batch.batchId}`, detail: `${hasFeeSchedule(batch.currency || "NGN") ? `Fee difference: ${moneyText(Number(batch.feeVarianceKobo || 0), batch.currency || "NGN")}.` : `Fees not checked: there is no fee schedule for ${batch.currency}. Amount after fees: ${moneyText(Number(batch.netKobo || 0), batch.currency)}.`} Compare the provider and statement totals.`, unresolved: false });
  if (report.variances?.count && !report.variances.batches?.length) issues.push({ id: "settlement-variance", label: "Settlement differences", detail: `${counted(Number(report.variances.count), "difference was", "differences were")} recorded.`, unresolved: false });
  for (const mismatch of report.positionRebuild?.mismatches || []) issues.push({ id: `position:${mismatch.dueItemId}`, label: `Outstanding balance difference · ${mismatch.reference || mismatch.dueItemId}`, detail: `Saved outstanding balance ${moneyText(mismatch.storedOutstandingKobo, 'NGN')}; recalculated from payments ${moneyText(mismatch.rebuiltOutstandingKobo, 'NGN')}.`, unresolved: false });
  for (const [key, label] of [["unallocated", "Unallocated payments"], ["proposed", "Payment matches awaiting confirmation"], ["possibleDuplicates", "Possible duplicate payments"]]) {
    // The kobo is naira only; money in another currency is named beside it, in its own currency.
    const elsewhere = Object.keys(report[key]?.otherCurrencies ?? {}).length ? ` and ${otherCurrenciesText(report[key].otherCurrencies)}` : "";
    if (Number(report[key]?.count) > 0) issues.push({ id: key, label, detail: `${counted(Number(report[key].count), "item")} totalling ${moneyText(Number(report[key].kobo || 0), 'NGN')}${elsewhere} ${Number(report[key].count) === 1 ? "remains" : "remain"} at this close.`, unresolved: true });
  }
  for (const item of close.data.reviewBasis?.unresolved || []) issues.push({ id: `item:${item.id}`, label: `${item.kind === "exceptions" ? "Open exception" : item.kind === "payments" ? "Unallocated payment amount" : "Unresolved payment evidence"} · ${item.name || item.reference}`, detail: `${[item.reference, valueLabel(item.status)].filter(Boolean).join(' · ')}. Record the owner, next step and why the item may remain open.`, unresolved: true });
  for (const issue of close.data.reviewBasis?.sourceCompleteness?.issues || []) issues.push({ ...issue, unresolved: true });
  return issues;
}
function latestClose(state: DomainState) { return newest(ofKind(state, "closes"))[0]; }
const closeBusinessDate = (close: ValopayRecord): string | undefined => close.data.reviewBasis?.sourceCompleteness?.businessDate;
/** The newest close of one business date: each missed date's catch-up close is reviewed on its own. */
function latestCloseOf(state: DomainState, businessDate: string | undefined) { return newest(ofKind(state, "closes").filter(record => closeBusinessDate(record) === businessDate))[0]; }
/** The summary loadState keeps of a close more than seven days older than the newest close: closeSummarySql's, which
 * this mirrors and must match. The close without its operational and metrics parts, and of its report only the
 * unallocated and exception totals. */
export function summariseLoadedClose(close: ValopayRecord): ValopayRecord {
  const { report, operational: _operational, metrics: _metrics, ...kept } = close.data;
  return { ...close, data: "report" in close.data ? { ...kept, report: { unallocated: report?.unallocated ?? null, exceptions: report?.exceptions ?? null } } : kept };
}
/**
 * Whether a review is current: its close is the latest of its business date, its inputs are unchanged and it is the
 * review's intact snapshot. A read of the whole lender (`summaries`) may hold a close as its summary: that summary
 * must then be the snapshot's. Closes never change once recorded (saveState refuses), so such a read gives the answer
 * of the decision, which loads the close whole and compares all of it. The snapshot's own digest is checked first,
 * and only a snapshot with data is summarised, so a damaged snapshot reads as stale and never fails the read.
 */
export function reviewIsCurrent(state: DomainState, review: ValopayRecord, basis = closeReviewBasisOnce(state), summaries = false) {
  const close = ofKind(state, "closes").find(r => r.id === review.data.closeId), snapshot = review.data.snapshot;
  const snapshotOf = (record: ValopayRecord) => review.data.snapshotDigest === digest(record) || summaries && typeof snapshot?.data === "object" && snapshot.data !== null && sameJson(summariseLoadedClose(snapshot), record);
  return Boolean(close && !closeReviewCurrentProblem(state, close, basis) && review.data.inputDigest === close.data.reviewBasis.inputDigest && review.data.snapshotDigest === digest(snapshot) && snapshotOf(close));
}
export function closeReviewCurrentProblem(state: DomainState, close: ValopayRecord, basis = closeReviewBasisOnce(state)): string | null {
  if (!close.data.reviewBasis?.inputDigest) return "This close was recorded before close reviews were available. Run a new daily close, then prepare the review.";
  if (latestCloseOf(state, closeBusinessDate(close))?.id !== close.id) return "A newer close exists for this business date. Review the latest close; this evidence remains available for the historical record.";
  if (pendingFinancialCorrections(state).length) return "Import corrections to instalments are waiting for a decision. Resolve them before you prepare, approve or export the current close.";
  if (close.data.reviewBasis.inputDigest !== basis()) return "Records changed after this close. Run a new daily close and prepare a new review. The earlier close stays as it was.";
  const sources = close.data.reviewBasis.sourceCompleteness;
  if (!sources?.basisDigest) return "This close does not show whether the day’s source files were complete. Declare the expected files, then run a new daily close.";
  if (sources.basisDigest !== sourceCompleteness(state, sources.businessDate).basisDigest) return "The expected files, or the files delivered, changed after this close. Run a new daily close and prepare a new review. The earlier close stays as it was.";
  return null;
}
export function prepareCloseReview(state: DomainState, ctx: Context, value: PrepareCloseReviewInput, reviewers: Array<{ actor: string; role: string }>) {
  if (!["Admin", "Operations", "Finance"].includes(ctx.role)) refuse(roleRefusal(ctx, ["Admin", "Operations", "Finance"], "prepare a close for review"), 403);
  const input = prepareCloseReviewSchema.parse(value);
  const close = ofKind(state, "closes").find(r => r.id === input.closeId);
  if (!close) refuse(notFoundText("daily close"), 404);
  assertRecordVersion(close, input.expectedUpdatedAt);
  const problem = closeReviewCurrentProblem(state, close);
  if (problem) refuse(problem, 409);
  if (!reviewers.some(r => r.actor === input.reviewer && r.role === "Finance")) refuse("Choose an active Finance reviewer with access to this lender.", 403);
  if (input.reviewer === ctx.actor) refuse("Choose a different person to review the close. The preparer cannot approve their own work.", 403);
  if (ofKind(state, "close-reviews").some(r => r.data.closeId === close.id && ["awaiting_review", "approved"].includes(r.status))) refuse("This close already has a submitted or approved review. Open that review instead.", 409);
  const issues = closeReviewIssues(close), responses = new Map(input.discrepancyResponses.map(r => [r.issueId, r.explanation]));
  if (responses.size !== input.discrepancyResponses.length || responses.size !== issues.length || issues.some(issue => !responses.has(issue.id))) refuse("Explain every listed difference and unresolved item. Reload the page if the list has changed.");
  if (issues.some(issue => issue.unresolved) && input.unresolvedAcceptance.length < 10) refuse("Record why the unresolved items may remain open, with their owners and next steps.");
  const review = makeRecord(state, "close-reviews", { name: `Close review · ${close.name}`, status: "awaiting_review", createdAt: ctx.now, data: {
    closeId: close.id, reviewNumber: ofKind(state, "close-reviews").filter(record => record.data.closeId === close.id).length + 1, preparedBy: ctx.actor, preparedPrincipal: principal(ctx), preparedAt: ctx.now, reviewer: input.reviewer,
    snapshot: structuredClone(close), snapshotDigest: digest(close), inputDigest: close.data.reviewBasis.inputDigest,
    preparationNote: input.preparationNote, discrepancyResponses: input.discrepancyResponses, unresolvedAcceptance: input.unresolvedAcceptance,
  } });
  makeRecord(state, "close-review-events", { name: "Close prepared for independent Finance review", status: "recorded", createdAt: ctx.now, data: { reviewId: review.id, closeId: close.id, action: "prepared", actor: ctx.actor, reviewer: input.reviewer, snapshotDigest: review.data.snapshotDigest } });
  return review;
}
export function decideCloseReview(state: DomainState, ctx: Context, id: string, value: DecideCloseReviewInput) {
  const input = decideCloseReviewSchema.parse(value), review = ofKind(state, "close-reviews").find(r => r.id === id);
  if (!review) refuse(notFoundText("close review"), 404);
  assertRecordVersion(review, input.expectedUpdatedAt);
  if (review.status !== "awaiting_review") refuse("This review already has a decision. Reload the page to see it.", 409);
  if (ctx.role !== "Finance" || ctx.actor !== review.data.reviewer) refuse("Only the named Finance reviewer can decide this review.", 403);
  if (principal(ctx) === review.data.preparedPrincipal || ctx.actor === review.data.preparedBy) refuse(`A different person must review this close.${demoRolesNote(ctx.accessMode)}`, 403);
  if (input.action === "approve" && !reviewIsCurrent(state, review)) refuse("This close is no longer current. Run a new daily close and prepare a new review. The earlier close stays as it was.", 409);
  if (input.action === "approve") {
    if (pendingFinancialCorrections(state).length) refuse("Resolve the import corrections to instalments before you approve this close. Return the review for changes if needed.", 409);
    const sourceIssues = review.data.snapshot.data.reviewBasis.sourceCompleteness.issues || [];
    const accepted = new Set(input.sourceExceptions.map(item => item.issueId));
    if (accepted.size !== input.sourceExceptions.length || accepted.size !== sourceIssues.length || sourceIssues.some((issue:any) => !accepted.has(issue.id))) refuse("Accept each missing or incomplete source file with its own reason and evidence, or return the close for changes.");
  } else if (input.sourceExceptions.length) refuse("You can accept missing source files only when you approve. Remove those acceptances before you return the review.");
  review.status = input.action === "approve" ? "approved" : "changes_requested";
  Object.assign(review.data, { decidedBy: ctx.actor, decidedPrincipal: principal(ctx), decidedAt: ctx.now, decisionNote: input.note, sourceExceptions: input.sourceExceptions });
  touch(review, ctx.now);
  makeRecord(state, "close-review-events", { name: input.action === "approve" ? "Finance approved this close" : "Finance requested changes", status: "recorded", createdAt: ctx.now, data: { reviewId: review.id, closeId: review.data.closeId, action: input.action, actor: ctx.actor, note: input.note, snapshotDigest: review.data.snapshotDigest } });
  return review;
}
export function closeReviewList(state: DomainState) {
  const reviews = newest(ofKind(state, "close-reviews")), basis = closeReviewBasisOnce(state);
  return { closes: newest(ofKind(state, "closes")).slice(0, 25).map(close => ({ close, issues: closeReviewIssues(close), problem: closeReviewCurrentProblem(state, close, basis), pendingFinancialCorrections: pendingFinancialCorrections(state).length, reviews: reviews.filter(r => r.data.closeId === close.id).map(review => ({ ...review, current: reviewIsCurrent(state, review, basis) })) })), total: ofKind(state, "closes").length };
}
/** History paging never needs the large report or each review's frozen snapshot. */
export function closeReviewHistory(state: DomainState, value: Partial<CloseReviewHistoryQuery> = {}) {
  const query = closeReviewHistoryQuerySchema.parse(value), all = newest(ofKind(state, "closes")), reviews = newest(ofKind(state, "close-reviews"));
  const byClose = new Map<string, ValopayRecord[]>();
  for (const review of reviews) { const key = String(review.data.closeId), group = byClose.get(key) || []; group.push(review); byClose.set(key, group); }
  const search = query.search.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const matches = all.filter(close => [close.name, close.reference, close.createdAt, closeBusinessDate(close) || "", ...(byClose.get(close.id) || []).flatMap(review => [review.data.preparedBy, review.data.reviewer, review.status])].join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().includes(search));
  const offset = Math.min(query.offset, Math.max(0, Math.ceil(matches.length / query.limit) - 1) * query.limit);
  return { closes: matches.slice(offset, offset + query.limit).map(close => ({ id: close.id, name: close.name, reference: close.reference, createdAt: close.createdAt, businessDate: closeBusinessDate(close) || null, reviewStatus: byClose.get(close.id)?.[0]?.status || null, latest: close.id === all[0]?.id })), total: matches.length, offset, limit: query.limit };
}
/** The caller supplies the complete, lender-scoped close read in the same transaction. */
export function closeReviewDetail(state: DomainState, id: string) {
  const close = ofKind(state, "closes").find(record => record.id === id);
  if (!close) refuse(notFoundText("daily close"), 404);
  const basis = closeReviewBasisOnce(state), reviews = newest(ofKind(state, "close-reviews").filter(review => review.data.closeId === id));
  return { entry: { close, issues: closeReviewIssues(close), problem: closeReviewCurrentProblem(state, close, basis), pendingFinancialCorrections: pendingFinancialCorrections(state).length, reviews: reviews.map(review => ({ ...review, current: reviewIsCurrent(state, review, basis) })) }, events: newest(ofKind(state, "close-review-events").filter(event => event.data.closeId === id)), pendingCorrections: pendingFinancialCorrections(state).map(record => ({ id: record.id, batchId: String(record.data.batchId || record.data.preview?.batchId), name: record.name })) };
}
/** Reassignment changes only the pending assignee; the original snapshot and every event remain available. */
export function reassignCloseReview(state: DomainState, ctx: Context, id: string, value: ReassignCloseReviewInput, reviewers: Array<{ actor: string; role: string }>) {
  if (ctx.role !== "Admin") refuse(roleRefusal(ctx, ["Admin"], "reassign a close review"), 403);
  const input = reassignCloseReviewSchema.parse(value), review = ofKind(state, "close-reviews").find(record => record.id === id);
  if (!review) refuse(notFoundText("close review"), 404);
  assertRecordVersion(review, input.expectedUpdatedAt);
  if (review.status !== "awaiting_review") refuse("Only a review waiting for a decision can be reassigned. The recorded decision is unchanged.", 409);
  if (!reviewers.some(person => person.actor === input.reviewer && person.role === "Finance")) refuse("Choose an active Finance reviewer with access to this lender.", 403);
  if (input.reviewer === review.data.reviewer) refuse("Choose a different Finance reviewer.", 409);
  if (input.reviewer === review.data.preparedBy || input.reviewer.startsWith("Sandbox ")) refuse(`Choose a team member who did not prepare this close.${demoRolesNote(ctx.accessMode)}`, 403);
  const previousReviewer = review.data.reviewer;
  review.data.reviewer = input.reviewer;
  touch(review, ctx.now);
  makeRecord(state, "close-review-events", { name: "An Admin reassigned the close review", status: "recorded", createdAt: ctx.now, data: { reviewId: review.id, closeId: review.data.closeId, action: "reassign", actor: ctx.actor, previousReviewer, reviewer: input.reviewer, note: input.reason, snapshotDigest: review.data.snapshotDigest } });
  return review;
}
export function reviewedCloseEvidence(state: DomainState, id: string, requireCurrent = false) {
  const review = ofKind(state, 'close-reviews').find(r => r.id === id);
  if (!review) refuse(notFoundText("close review"), 404);
  if (review.status !== 'approved') refuse('Choose an approved close review for this lender.', 409);
  if (!review.data.snapshot || digest(review.data.snapshot) !== review.data.snapshotDigest) refuse('The saved copy of this reviewed close has changed, so it cannot be exported. Ask the Valo Pay team to check it.', 409);
  if (requireCurrent && !reviewIsCurrent(state, review)) refuse('This review is no longer current. Prepare and approve the latest close before exporting its evidence.', 409);
  return structuredClone(review);
}
export function pilotProgress(state: DomainState, accessMode = "sandbox") {
  const customers = ofKind(state, "customers"), batches = ofKind(state, "import-batches"), committed = batches.filter(r => r.status === "committed");
  const payments = ofKind(state, "payments"), allocations = ofKind(state, "allocations"), observations = ofKind(state, "observations");
  const unsettled = payments.filter(r => ["unallocated", "proposed", "possible_duplicate", "partial", "overpaid"].includes(r.status));
  const pendingAllocations = allocations.filter(r => r.status === "proposed"), confirmed = allocations.filter(r => r.status === "confirmed");
  const unresolvedObservations = observations.filter(r => r.status !== "resolved");
  const cases = ofKind(state, "exceptions"), openCases = cases.filter(open), unowned = openCases.filter(r => !r.data.case?.assignee), resolved = cases.filter(r => !open(r));
  const close = latestClose(state), reviews = newest(ofKind(state, "close-reviews")), basis = closeReviewBasisOnce(state), currentReview = reviews.find(r => r.data.closeId === close?.id && reviewIsCurrent(state, r, basis)), approved = currentReview?.status === "approved" ? currentReview : undefined;
  const readyExports = ofKind(state, "exports").filter(r => r.status === "ready" && !!r.data.checksum && !r.data.fileDeletedAt);
  // Root export integration stamps the immutable review ID and digest on the
  // receipt. Timestamp proximity or a customer pack is never enough evidence.
  const reviewedExports = approved ? readyExports.filter(r => r.data.closeReviewId === approved.id && r.data.closeSnapshotDigest === approved.data.snapshotDigest) : [];
  const reconciled = confirmed.length > 0 && !unsettled.length && !pendingAllocations.length && !unresolvedObservations.length;
  const steps: PilotProgressStep[] = [
    { id: "onboard", name: "Onboard a lender", href: "/team", state: state.merchant.name?.trim() ? "completed" : "not_started", evidence: [state.merchant.name || "No lender selected", "Sample data only. Live payments and bank connections are switched off."], missing: state.merchant.name?.trim() ? [] : ["Name and create the lender."] },
    { id: "ingest", name: "Import records", href: "/imports", state: batches.some(r => r.status === "needs_correction") ? "blocked" : committed.length && customers.length ? "completed" : batches.length ? "in_progress" : "not_started", evidence: [`${counted(committed.length, "imported batch", "imported batches")}; ${counted(customers.length, "customer record")}.`], missing: [...(!committed.length ? ["Save, check and import a batch."] : []), ...(!customers.length ? ["Import the sample customer records."] : []), ...(batches.some(r => r.status === "needs_correction") ? ["Correct the saved batches that have rows with errors."] : [])] },
    { id: "reconcile", name: "Reconcile payments", href: "/reconciliation", state: reconciled ? "completed" : pendingAllocations.length ? "awaiting_review" : payments.length || observations.length ? "in_progress" : "not_started", evidence: [`${counted(confirmed.length, "confirmed allocation")}; ${counted(payments.length, "payment record")}.`, `${counted(unsettled.length, "payment needs", "payments need")} a match; ${counted(unresolvedObservations.length, "evidence record remains", "evidence records remain")} unresolved.`], missing: [...(!confirmed.length ? ["Confirm at least one payment allocation against an instalment."] : []), ...(pendingAllocations.length ? ["Finance must confirm or reject the proposed matches."] : []), ...(unsettled.length || unresolvedObservations.length ? ["Resolve the remaining payment and evidence records."] : [])] },
    { id: "resolve", name: "Resolve exceptions", href: "/exceptions", state: unowned.length ? "blocked" : openCases.length ? "in_progress" : resolved.length || reconciled ? "completed" : "not_started", evidence: [`${counted(resolved.length, "exception")} resolved; ${openCases.length} open; ${unowned.length} with no owner.`], missing: openCases.length ? [`Resolve ${counted(openCases.length, "open exception")}. A handover alone does not resolve an exception.`] : !resolved.length && !reconciled ? ["Reconcile the imported payments before you conclude there are no exceptions."] : [] },
    { id: "close", name: "Review the close", href: "/close-review", state: approved ? "completed" : close && closeReviewCurrentProblem(state, close, basis) ? "blocked" : currentReview?.status === "awaiting_review" ? "awaiting_review" : close ? "in_progress" : "not_started", evidence: close ? [close.name, approved ? `Approved by ${approved.data.decidedBy} on ${dayText(approved.data.decidedAt)}.` : "A recorded close is not yet an approved close."] : [], missing: approved ? [] : close ? [closeReviewCurrentProblem(state, close, basis) || (currentReview?.status === "awaiting_review" ? "The named Finance reviewer must record a decision." : "Prepare this close with explanations, and name a different Finance team member to review it.")] : ["Run a daily close after reconciling and handling the exceptions."] },
    { id: "export", name: "Export evidence", href: "/close-review", state: reviewedExports.length ? "completed" : readyExports.length ? "blocked" : approved ? "in_progress" : "not_started", evidence: [`${counted(reviewedExports.length, "ready export contains", "ready exports contain")} the current approved close.`], missing: reviewedExports.length ? [] : [approved ? "Export the evidence for this approved close and wait until the export is ready." : "Approve the current close before you export its evidence."] },
  ];
  return { lender: state.merchant, syntheticOnly: true, access: { mode: accessMode, state: accessMode === "staff" ? "configured" : "not_configured", message: accessMode === "staff" ? "Staff sign-in is switched on for this lender’s sample data. Using real data needs separate acceptance testing." : "Staff sign-in is not switched on. Progress made with demo roles is not independent staff approval, and it does not show readiness for real data." }, steps };
}
