import assert from "node:assert/strict";
import { seedMerchant } from "../src/lib/valopay-seed";
import { makeRecord } from "../src/domain/records";
import { advanceRecordVersions } from "../src/lib/edit-versions";
import { bindCloseReviewBasis, closeReviewBasis, closeReviewIssues, closeReviewCurrentProblem, closeReviewList, closeReviewHistory, closeReviewDetail, decideCloseReview, reassignCloseReview, pilotProgress, prepareCloseReview, reviewIsCurrent, summariseLoadedClose } from "../src/domain/close-review";
import { personalWorkItems } from "../src/domain/personal-work";
import type { Context, DomainState } from "../src/domain/types";

const ops = { actor: "Clerk:operator", principalId: "person-1", role: "Operations", now: "2026-09-22T10:00:00.000Z" };
const finance = { actor: "Clerk:finance", principalId: "person-2", role: "Finance", now: "2026-09-22T10:05:00.000Z" };
const reviewers = [finance];
function empty() { const state = seedMerchant("close-review-test", true); state.records = []; return state; }
function close(state: DomainState, at = ops.now) {
  const record = makeRecord(state, "closes" as string, { status: "completed", createdAt: at, name: "Synthetic close", data: { closedAt: at, summary: "Synthetic close checks", report: { variances: { count: 0, batches: [] }, positionRebuild: { mismatches: [] }, unallocated: { count: 0 }, proposed: { count: 0 }, possibleDuplicates: { count: 0 } } } });
  bindCloseReviewBasis(state, record); return record;
}
function prepareInput(record: ReturnType<typeof close>) { return { closeId: record.id, expectedUpdatedAt: record.updatedAt, reviewer: finance.actor, preparationNote: "Checked all synthetic source records.", discrepancyResponses: closeReviewIssues(record).map(issue => ({ issueId: issue.id, explanation: "Finance owns the follow-up and will investigate tomorrow." })), unresolvedAcceptance: "Finance owns the outstanding items and will inspect them tomorrow." }; }
const step = (state: DomainState, id: string) => pilotProgress(state).steps.find(s => s.id === id)!;

{
  const state = empty();
  assert.equal(step(state, "resolve").state, "not_started", "An empty lender must not appear to have completed exception handling.");
  makeRecord(state, "payments", { status: "unallocated", amountKobo: 10000 });
  assert.equal(step(state, "reconcile").state, "in_progress", "A payment record is not reconciliation evidence.");
  const first = close(state);
  assert.equal(step(state, "close").state, "in_progress", "A close without a Finance decision is not reviewed.");
  makeRecord(state, "exports", { status: "ready", data: { checksum: "a".repeat(64) } });
  assert.equal(step(state, "export").state, "blocked", "An unrelated ready export cannot satisfy reviewed evidence.");
  delete first.data.reviewBasis;
  assert.match(closeReviewCurrentProblem(state, first)!, /older close/);
}
{
  const state = empty(), first = close(state), snapshot = JSON.stringify(first), input = prepareInput(first);
  assert.throws(() => prepareCloseReview(state, { ...ops, role: "Read-only" }, input, reviewers), /role/);
  assert.throws(() => prepareCloseReview(state, ops, { ...input, closeId: "another-lender-close" }, reviewers), /not found/);
  assert.throws(() => prepareCloseReview(state, ops, { ...input, expectedUpdatedAt: "2026-09-21T10:00:00.000Z" }, reviewers), /changed/);
  assert.throws(() => prepareCloseReview(state, ops, { ...input, reviewer: "not-active" }, reviewers), /active Finance/);
  assert.throws(() => prepareCloseReview(state, ops, { ...input, preparationNote: "ok" }, reviewers));
  assert.throws(() => prepareCloseReview(state, ops, { ...input, fabricated: true } as any, reviewers));
  const review = prepareCloseReview(state, ops, input, reviewers), before = structuredClone(state);
  assert.equal(step(state, "close").state, "awaiting_review");
  assert.throws(() => prepareCloseReview(state, ops, input, reviewers), /already/);
  const decision = { action: "approve" as const, expectedUpdatedAt: review.updatedAt, note: "Independently checked and accepted this exact snapshot.", sourceExceptions: first.data.reviewBasis.sourceCompleteness.issues.map((issue:any)=>({issueId:issue.id,reason:"This synthetic rehearsal has no external source contract yet.",evidence:"Synthetic rehearsal scope, case TEST-1."})) };
  assert.throws(() => decideCloseReview(state, finance, review.id, {...decision,sourceExceptions:[]}), /explicitly accept every source/);
  assert.throws(() => decideCloseReview(state, { ...finance, actor: "Clerk:other" }, review.id, decision), /named Finance/);
  assert.throws(() => decideCloseReview(state, { ...finance, role: "Admin" }, review.id, decision), /named Finance/);
  assert.throws(() => decideCloseReview(state, { ...finance, principalId: ops.principalId }, review.id, decision), /different person/);
  decideCloseReview(state, finance, review.id, decision);
  advanceRecordVersions(before, state, finance.now);
  assert.equal(step(state, "close").state, "completed");
  assert.equal(review.status, "approved");
  assert.equal(review.data.decidedBy, finance.actor);
  assert.equal(JSON.stringify(first), snapshot, "Approval never edits the close snapshot.");
  assert.throws(() => decideCloseReview(state, finance, review.id, decision), /changed/);
  assert.throws(() => decideCloseReview(state, finance, review.id, { ...decision, expectedUpdatedAt: review.updatedAt }), /already has a decision/);
  const evidenceExport = makeRecord(state, "exports", { status: "ready", data: { checksum: "b".repeat(64), closeReviewId: review.id, closeSnapshotDigest: review.data.snapshotDigest } });
  assert.equal(step(state, "export").state, "completed");
  evidenceExport.data.fileDeletedAt = "2026-09-22T10:06:00.000Z";
  assert.equal(step(state, "export").state, "in_progress", "An expired export receipt cannot satisfy downloadable reviewed evidence.");
  assert.match(step(state, "export").missing[0]!, /Generate an evidence export/);
  delete evidenceExport.data.fileDeletedAt;
  makeRecord(state, "customers", { status: "active", name: "Later correction" });
  assert.equal(reviewIsCurrent(state, review), false);
  assert.equal(step(state, "close").state, "blocked");
  assert.equal(step(state, "export").state, "blocked", "Old approved exports cannot satisfy a changed current state.");
  assert.equal(review.status, "approved", "Historical approval stays immutable when inputs change.");
  assert.equal(JSON.stringify(first), snapshot);
  const next = close(state, "2026-09-22T11:00:00.000Z");
  const fresh = prepareCloseReview(state, { ...ops, now: next.createdAt }, prepareInput(next), reviewers);
  assert.equal(reviewIsCurrent(state, fresh), true);
  assert.equal(ofKind(state, "close-reviews").length, 2);
}
function ofKind(state: DomainState, kind: string) { return state.records.filter(r => r.kind === kind); }
{
  const state = empty();
  makeRecord(state, "exceptions", { status: "open", name: "Unidentified synthetic payment" });
  makeRecord(state, "observations", { status: "unresolved", name: "Source statement" });
  makeRecord(state, "payments", { status: "partial", amountKobo: 10000, data: { allocatedKobo: 2000 } });
  const record = close(state), input = prepareInput(record);
  assert.equal(closeReviewIssues(record).length, 4);
  assert.equal(step(state, "resolve").state, "blocked");
  assert.throws(() => prepareCloseReview(state, ops, { ...input, discrepancyResponses: [] }, reviewers), /Explain every/);
  assert.throws(() => prepareCloseReview(state, ops, { ...input, discrepancyResponses: [input.discrepancyResponses[0]!, input.discrepancyResponses[0]!] }, reviewers), /Explain every/);
  assert.throws(() => prepareCloseReview(state, ops, { ...input, unresolvedAcceptance: "" }, reviewers), /unresolved items/);
  const review = prepareCloseReview(state, ops, input, reviewers);
  // A later close makes an awaiting review stale without changing its immutable snapshot.
  close(state, "2026-09-22T11:00:00.000Z");
  assert.equal(reviewIsCurrent(state, review), false);
  assert.throws(() => decideCloseReview(state, finance, review.id, { action: "approve", expectedUpdatedAt: review.updatedAt, note: "Checked all recorded explanations." }), /no longer current/);
  decideCloseReview(state, finance, review.id, { action: "return", expectedUpdatedAt: review.updatedAt, note: "Run another close to include the new source records." });
  assert.equal(review.status, "changes_requested");
}
{
  const state = empty(), record = close(state), input = { ...prepareInput(record), reviewer: "Sandbox Finance" };
  const review = prepareCloseReview(state, { actor: "Sandbox Admin", role: "Admin", now: ops.now }, input, [{ actor: "Sandbox Finance", role: "Finance" }]);
  assert.throws(() => decideCloseReview(state, { actor: "Sandbox Finance", role: "Finance", now: finance.now }, review.id, { action: "approve", expectedUpdatedAt: review.updatedAt, note: "The same browser changed its demo persona." }), /different person/, "Missing principal metadata must fail closed for demo identity.");
}
{
  const state = empty();
  const payment = makeRecord(state, "payments", { status: "allocated", amountKobo: 10000, data: { allocatedKobo: 10000 } });
  makeRecord(state, "allocations", { status: "confirmed", amountKobo: 10000, data: { paymentId: payment.id } });
  assert.equal(step(state, "reconcile").state, "completed");
  assert.equal(step(state, "resolve").state, "completed", "A reconciled nonempty journey can have no exceptions.");
  const basis = closeReviewBasis(state), record = close(state), review = prepareCloseReview(state, ops, prepareInput(record), reviewers);
  payment.updatedAt = finance.now;
  assert.equal(closeReviewBasis(state), basis, "Transaction revision bookkeeping must not invalidate a just-created close.");
  makeRecord(state, "work-events", { status: "recorded" });
  assert.equal(reviewIsCurrent(state, review), true, "Work-queue acknowledgements do not change financial evidence.");
  review.data.snapshot!.data.summary = "tampered";
  assert.equal(reviewIsCurrent(state, review), false);
}
{
  // A read computes the input digest once, however many closes and reviews it checks (the 23 September audit): each
  // computation reads every basis record, so reads of one customer's name count them.
  const state = empty(), customer = makeRecord(state, "customers", { status: "active", name: "Counted customer" });
  let reads = 0;
  Object.defineProperty(customer, "name", { enumerable: true, configurable: true, get: () => { reads += 1; return "Counted customer"; } });
  // Four business dates' closes, each current and awaiting Finance; the latest was also returned once.
  const closes = ["2026-09-19T10:00:00.000Z", "2026-09-20T10:00:00.000Z", "2026-09-21T10:00:00.000Z", ops.now].map(at => close(state, at));
  const latest = closes.at(-1)!, returned = prepareCloseReview(state, ops, prepareInput(latest), reviewers);
  decideCloseReview(state, finance, returned.id, { action: "return", expectedUpdatedAt: returned.updatedAt, note: "Add the owner of the open items." });
  for (const record of closes) prepareCloseReview(state, ops, prepareInput(record), reviewers);
  reads = 0;
  assert.equal(pilotProgress(state).steps.find(s => s.id === "close")!.state, "awaiting_review");
  assert.equal(reads, 1, "pilot progress computes the input digest once");
  reads = 0;
  const list = closeReviewList(state);
  assert.deepEqual(list.closes.map(item => [item.problem, item.reviews.map(review => review.current)]), [[null, [true, true]], [null, [true]], [null, [true]], [null, [true]]]);
  assert.equal(reads, 1, "the close reviews list computes it once");
  reads = 0;
  const work = personalWorkItems(state, finance, [{ actor: finance.actor, name: "Finance", role: "Finance" }]);
  assert.deepEqual(work.map(item => item.reviewCurrent), [true, true, true, true]);
  assert.equal(reads, 1, "the work queue computes it once");
  // Nothing is kept between reads: a change is seen by the next one.
  customer.data.note = "Changed after the closes";
  assert.equal(closeReviewList(state).closes.every(item => item.problem?.startsWith("Records changed after this close")), true);
}
{
  const state = empty(), first = close(state), review = prepareCloseReview(state, ops, prepareInput(first), reviewers);
  decideCloseReview(state, finance, review.id, { action: "return", expectedUpdatedAt: review.updatedAt, note: "Retain this decision in the historical record." });
  for (let day = 1; day <= 31; day++) close(state, new Date(Date.parse(ops.now) + day * 86_400_000).toISOString());
  const history = closeReviewHistory(state);
  assert.equal(history.closes.length, 25);
  assert.equal(history.total, 32);
  assert.equal(history.closes.some(item => item.id === first.id), false);
  assert.equal(closeReviewHistory(state, { offset: 25 }).closes.some(item => item.id === first.id), true);
  assert.equal(closeReviewHistory(state, { search: finance.actor }).closes[0]!.id, first.id, "Reviewer search finds a close beyond the first page.");
  const detail = closeReviewDetail(state, first.id);
  assert.equal(detail.entry.reviews[0]!.data.decisionNote, "Retain this decision in the historical record.");
  assert.deepEqual(detail.entry.close.data.report, first.data.report);
  assert.equal(detail.events.length, 2);
  assert.throws(() => closeReviewDetail(state, "different-lender-close"), /not found/);
}
{
  const state = empty(), record = close(state), review = prepareCloseReview(state, ops, prepareInput(record), reviewers);
  const admin = { ...ops, actor: "Clerk:administrator", principalId: "person-admin", role: "Admin", now: finance.now }, replacement = { ...finance, actor: "Clerk:replacement", principalId: "person-3" };
  const input = { expectedUpdatedAt: review.updatedAt, reviewer: replacement.actor, reason: "The original reviewer is unavailable during leave." };
  const roster = [...reviewers, replacement, { ...ops, role: "Finance" }, { actor: "Sandbox Finance", role: "Finance" }];
  const snapshot = JSON.stringify(review.data.snapshot), digest = review.data.snapshotDigest;
  assert.throws(() => reassignCloseReview(state, finance, review.id, input, roster), /administrator/);
  assert.throws(() => reassignCloseReview(state, admin, "other-lender-review", input, roster), /not found/);
  assert.throws(() => reassignCloseReview(state, admin, review.id, { ...input, expectedUpdatedAt: "2026-09-21T10:00:00.000Z" }, roster), /changed/);
  assert.throws(() => reassignCloseReview(state, admin, review.id, input, reviewers), /active Finance/);
  assert.throws(() => reassignCloseReview(state, admin, review.id, { ...input, reviewer: finance.actor }, roster), /different Finance/);
  assert.throws(() => reassignCloseReview(state, admin, review.id, { ...input, reviewer: ops.actor }, roster), /different staff/);
  assert.throws(() => reassignCloseReview(state, admin, review.id, { ...input, reviewer: "Sandbox Finance" }, roster), /independent review/);
  reassignCloseReview(state, admin, review.id, input, roster);
  assert.equal(review.status, "awaiting_review");
  assert.equal(review.data.preparedBy, ops.actor);
  assert.equal(JSON.stringify(review.data.snapshot), snapshot);
  assert.equal(review.data.snapshotDigest, digest);
  assert.equal(closeReviewDetail(state, record.id).events[0]!.data.previousReviewer, finance.actor);
  assert.throws(() => decideCloseReview(state, finance, review.id, { action: "return", expectedUpdatedAt: review.updatedAt, note: "Original reviewer must no longer decide." }), /named Finance/);
  close(state, "2026-09-22T11:00:00.000Z");
  assert.throws(() => decideCloseReview(state, replacement, review.id, { action: "approve", expectedUpdatedAt: review.updatedAt, note: "Reassignment must never make old evidence current." }), /no longer current/);
  decideCloseReview(state, replacement, review.id, { action: "return", expectedUpdatedAt: review.updatedAt, note: "Prepare the newer evidence before an independent approval." });
  assert.throws(() => reassignCloseReview(state, admin, review.id, { ...input, expectedUpdatedAt: review.updatedAt }, roster), /pending review/);
}
{
  const state = empty(), record = close(state);
  const proposal = makeRecord(state, "import-corrections", { status: "proposed", name: "Correct receipt amount", data: { batchId: "batch-history", preview: { financial: true } as any } });
  makeRecord(state, "import-correction-events", { status: "recorded", data: { proposalId: proposal.id, action: "reassign" } as any });
  assert.equal(closeReviewDetail(state, record.id).entry.pendingFinancialCorrections, 1, "Reassignment is not a correction decision.");
  assert.equal(closeReviewDetail(state, record.id).pendingCorrections[0]!.batchId, "batch-history");
  makeRecord(state, "import-correction-events", { status: "recorded", data: { proposalId: proposal.id, action: "reject" } as any });
  assert.equal(closeReviewDetail(state, record.id).entry.pendingFinancialCorrections, 0);
}
{
  // A read of the whole lender holds a close more than a week older than the newest as its summary (closeSummarySql,
  // which summariseLoadedClose mirrors): it judges a review by what the summary keeps (review of PR #71). The decision
  // loads the close whole and still compares all of it.
  const state = empty(), record = close(state), review = prepareCloseReview(state, ops, prepareInput(record), reviewers);
  const summarised = { ...state, records: state.records.map(r => r.id === record.id ? summariseLoadedClose(r) : r) };
  assert.deepEqual(Object.keys(summariseLoadedClose(record).data.report), ["unallocated", "exceptions"]);
  assert.equal(summariseLoadedClose(record).data.report.exceptions, null, "a total the close does not hold is null, as in SQL");
  assert.equal(reviewIsCurrent(state, review), true);
  assert.equal(reviewIsCurrent(summarised, review), false, "the decision's check needs the whole close");
  assert.equal(reviewIsCurrent(summarised, review, undefined, true), true, "a read that may hold summaries compares what they keep");
  // A part of the snapshot the summary drops (a report detail) is caught only by the snapshot's own digest.
  const proposed = review.data.snapshot!.data.report.proposed;
  review.data.snapshot!.data.report.proposed = { count: 9, kobo: 900 };
  assert.equal(reviewIsCurrent(summarised, review, undefined, true), false, "the snapshot must still be intact where the summary does not look");
  review.data.snapshot!.data.report.proposed = proposed;
  assert.equal(reviewIsCurrent(summarised, review, undefined, true), true);
  review.data.snapshot!.data.summary = "tampered";
  assert.equal(reviewIsCurrent(summarised, review, undefined, true), false, "and a part the summary keeps must match");
}
console.log("Close review: independent approval, exact snapshots, historical paging, admin reassignment, immutable evidence and stale refusal passed.");
