import assert from "node:assert/strict";
import { seedMerchant } from "../src/lib/valopay-seed";
import {
  saveImportBatch,
  commitImportBatch,
} from "../src/domain/pilot-workflow";
import { makeRecord } from "../src/domain/records";
import {
  previewImportCorrection,
  proposeImportCorrection,
  decideImportCorrection,
  listImportCorrections,
  assertImportedCorrectionChange,
  assertNoDirectImportedCorrection,
  reassignImportCorrection,
  importCorrectionComparison,
} from "../src/domain/import-corrections";
import { derivePersonalWork, recordWorkReceipt } from "../src/domain/personal-work";
import { bindCloseReviewBasis, closeReviewIssues, decideCloseReview, prepareCloseReview, reassignCloseReview } from "../src/domain/close-review";
import type { DomainState } from "../src/domain/types";
import { ResponseContractError } from "../src/lib/contract";
import { canonicalDigest } from "../src/lib/digests";

const ctx = {
  actor: "Clerk:operator",
  principalId: "person-operator",
  role: "Operations",
  now: "2026-09-22T09:00:00.000Z",
};
const finance = {
  actor: "Clerk:finance",
  principalId: "person-finance",
  role: "Finance",
  now: "2026-09-22T10:00:00.000Z",
};
const reviewers = [{ actor: finance.actor, role: "Finance" }];
const fresh = () => {
  const s = seedMerchant("corrections-test", true);
  s.records = [];
  return s;
};
function imported(
  s: DomainState,
  kind: "customers" | "due-items",
  csv: string,
) {
  const batch = saveImportBatch(s, ctx, {
    name: `Imported ${kind}`,
    source: "pilot-lms",
    sourceBatchId: `batch-${kind}`,
    kind,
    csv,
    identityColumn: "source_row_id",
    amountUnit: "naira",
    mapping: {},
    syntheticOnly: true,
  });
  commitImportBatch(s, ctx, batch.id, batch.updatedAt);
  return {
    batch,
    target: s.records.find((r) => r.data.importIdentity?.batchId === batch.id)!,
  };
}
/** A lender as loadState reads it (closeSummarySql): every close more than
 * seven days older than the newest keeps its data without the report's detail
 * and the operational and metrics parts, with the report's unallocated and
 * exception totals. */
function asLoaded(s: DomainState): DomainState {
  const loaded = structuredClone(s),
    closes = loaded.records.filter((r) => r.kind === "closes");
  const cutoff =
    Math.max(...closes.map((r) => Date.parse(r.createdAt))) - 7 * 86_400_000;
  for (const close of closes.filter((r) => Date.parse(r.createdAt) < cutoff)) {
    const { report, operational: _operational, metrics: _metrics, ...kept } =
      close.data;
    close.data =
      "report" in close.data
        ? { ...kept, report: { unallocated: report?.unallocated ?? null, exceptions: report?.exceptions ?? null } }
        : kept;
  }
  return loaded;
}
/** A proposal as builds before impact versions stored it: no version, and
 * impact and preview digests of the affected records whole. */
function asEarlierBuild(s: DomainState, id: string) {
  const stored = s.records.find((r) => r.id === id)!;
  const { impactVersion: _version, proposalDigest: _digest, ...data } =
    stored.data;
  const earlier = importCorrectionComparison(s, finance, { ...stored, data });
  const evidence = {
    ...data,
    impactDigest: earlier.impactDigest,
    preview: { ...data.preview, previewDigest: earlier.preview.previewDigest },
  };
  stored.data = {
    ...evidence,
    proposalDigest: canonicalDigest(evidence, "legacy-en-us-replacer"),
  };
  return String(stored.data.proposalDigest);
}
const s = fresh();
const { batch, target } = imported(
  s,
  "customers",
  "source_row_id,name,reference,consentProvenance\nc-1,Synthetic customer,COR-C-1,Synthetic consent",
);
const input = {
  batchId: batch.id,
  targetId: target.id,
  expectedUpdatedAt: target.updatedAt,
  changes: { name: "Corrected synthetic customer" },
  syntheticOnly: true as const,
};
const originalBatch = structuredClone(batch),
  originalTarget = structuredClone(target);
const preview = previewImportCorrection(s, ctx, input);
assert.equal(preview.blockers.length, 0);
assert.equal(preview.financial, false);
assert.equal(preview.differences[0]?.before, "Synthetic customer");
assert.throws(
  () => previewImportCorrection(s, { ...ctx, role: "Read-only" }, input),
  /role/,
);
assert.throws(
  () =>
    previewImportCorrection(s, ctx, {
      ...input,
      expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
    }),
  /changed/,
);
const proposalInput = {
  ...input,
  previewDigest: preview.previewDigest,
  reviewer: finance.actor,
  reason: "Correct the misspelled source name",
  evidence: "SOURCE-CORRECTION-001",
};
assert.throws(
  () =>
    proposeImportCorrection(
      s,
      ctx,
      { ...proposalInput, previewDigest: "0".repeat(64) },
      reviewers,
    ),
  /comparison changed/,
);
const proposal = proposeImportCorrection(s, ctx, proposalInput, reviewers);
assert.deepEqual(target, originalTarget);
assert.deepEqual(batch, originalBatch);
{
  // A stored proposal the view cannot describe is the service's fault: a ResponseContractError, answered as a 500
  // and logged as response.invalid, never a validation 400 that blames the request (audit item 24, review).
  const tampered = structuredClone(s);
  tampered.records.find((r) => r.id === proposal.id)!.data.reason = 42;
  assert.throws(
    () => listImportCorrections(tampered, ctx, batch.id),
    (error: unknown) =>
      error instanceof ResponseContractError &&
      error.issues.some((issue) => issue.path === "reason"),
  );
}
assert.throws(
  () => proposeImportCorrection(s, ctx, proposalInput, reviewers),
  /open correction/,
);
const decision = {
  proposalDigest: proposal.proposalDigest,
  action: "approve" as const,
  reason: "Checked against corrected source evidence",
};
assert.throws(
  () =>
    decideImportCorrection(
      s,
      { ...finance, principalId: ctx.principalId },
      proposal.id,
      decision,
      reviewers,
    ),
  /different person/,
);
assert.throws(
  () => decideImportCorrection(s, ctx, proposal.id, decision, reviewers),
  /named active Finance/,
);
const snapshot = structuredClone(s);
const approved = decideImportCorrection(
  s,
  finance,
  proposal.id,
  decision,
  reviewers,
);
assert.equal(approved.status, "approved");
assert.equal(target.name, "Corrected synthetic customer");
assert.deepEqual(
  target.data.importIdentity,
  originalTarget.data.importIdentity,
);
assert.deepEqual(batch, originalBatch);
assert.doesNotThrow(() =>
  assertImportedCorrectionChange(originalTarget, target, snapshot, s),
);
assert.throws(
  () => assertNoDirectImportedCorrection(originalTarget, target),
  /independent Finance/,
);
for (const patch of [
  { reference: "CHANGED-SOURCE" },
  { customerId: "different-person" },
  { data: { ...originalTarget.data, bankName: "Changed bank" } },
  { status: "inactive" },
]) {
  assert.throws(
    () =>
      assertNoDirectImportedCorrection(originalTarget, {
        ...originalTarget,
        ...patch,
      }),
    /cannot be edited directly/,
  );
}
assert.doesNotThrow(() =>
  assertNoDirectImportedCorrection(originalTarget, {
    ...originalTarget,
    updatedAt: finance.now,
  }),
);
assert.throws(
  () => decideImportCorrection(s, finance, proposal.id, decision, reviewers),
  /already has a decision/,
);
const forged = structuredClone(s);
forged.records.find((r) => r.id === proposal.id)!.data.after.name = "Forged";
assert.throws(
  () =>
    assertImportedCorrectionChange(
      originalTarget,
      { ...target, name: "Forged" },
      snapshot,
      forged,
    ),
  /independently approved/,
);
assert.throws(
  () => assertImportedCorrectionChange(originalTarget, target, s, s),
  /independently approved/,
);
assert.throws(
  () =>
    previewImportCorrection(
      { ...s, merchant: { ...s.merchant, id: "foreign" } },
      ctx,
      input,
    ),
  /committed import batch/,
);

const financial = fresh();
const customer = imported(
  financial,
  "customers",
  "source_row_id,name,reference,consentProvenance\nc-1,Synthetic payer,COR-C-2,Synthetic consent",
).target;
const instalment = imported(
  financial,
  "due-items",
  "source_row_id,name,reference,customerId,amount,dueDate,owner\nd-1,Synthetic instalment,COR-D-1,COR-C-2,25000,2028-12-01,lms",
);
const dueInput = {
  batchId: instalment.batch.id,
  targetId: instalment.target.id,
  expectedUpdatedAt: instalment.target.updatedAt,
  changes: { amountKobo: 3000000, dueDate: "2028-12-02" },
  syntheticOnly: true as const,
};
const close = makeRecord(financial, "closes", {
  name: "Historical close",
  status: "complete",
  createdAt: "2026-09-21T18:00:00.000Z",
});
const duePreview = previewImportCorrection(financial, ctx, dueInput);
assert.equal(duePreview.financial, true);
assert.deepEqual(duePreview.blockers, []);
assert.ok(duePreview.affected.some((r) => r.id === close.id));
const dueProposal = proposeImportCorrection(
  financial,
  ctx,
  {
    ...dueInput,
    previewDigest: duePreview.previewDigest,
    reviewer: finance.actor,
    reason: "Upstream scheduled amount was corrected",
    evidence: "SOURCE-AMOUNT-002",
  },
  reviewers,
);
// A close recorded after the comparison (tonight's scheduled close) carries
// the same uncorrected value but does not change what approval does, so it
// leaves the proposal current; only closes recorded before it are its evidence.
makeRecord(financial, "closes", {
  name: "Later close",
  status: "complete",
  createdAt: "2026-09-22T23:00:00.000Z",
});
assert.equal(
  listImportCorrections(financial, ctx, instalment.batch.id).proposals.find(
    (p) => p.id === dueProposal.id,
  )?.current,
  true,
);
const dueSnapshot = structuredClone(financial);
const dueDecision = { ...decision, proposalDigest: dueProposal.proposalDigest };
decideImportCorrection(
  financial,
  finance,
  dueProposal.id,
  dueDecision,
  reviewers,
);
assert.equal(instalment.target.amountKobo, 3000000);
assert.equal(instalment.target.data.outstandingKobo, 3000000);
assert.doesNotThrow(() =>
  assertImportedCorrectionChange(
    dueSnapshot.records.find((r) => r.id === instalment.target.id)!,
    instalment.target,
    dueSnapshot,
    financial,
  ),
);
makeRecord(financial, "payments", {
  customerId: customer.id,
  name: "New payment",
  amountKobo: 3000000,
});
assert.throws(
  () =>
    assertImportedCorrectionChange(
      dueSnapshot.records.find((r) => r.id === instalment.target.id)!,
      instalment.target,
      dueSnapshot,
      financial,
    ),
  /dependencies changed/,
);
const blocked = previewImportCorrection(financial, ctx, {
  ...dueInput,
  expectedUpdatedAt: instalment.target.updatedAt,
  changes: { amountKobo: 3500000 },
});
assert.ok(
  blocked.blockers.some((b) => /payment or collection history/.test(b)),
);
assert.ok(blocked.affected.some((r) => r.kind === "payments"));

const stale = structuredClone(dueSnapshot);
makeRecord(stale, "allocations", {
  customerId: customer.id,
  data: { dueItemId: instalment.target.id },
});
assert.throws(
  () =>
    decideImportCorrection(
      stale,
      finance,
      dueProposal.id,
      dueDecision,
      reviewers,
    ),
  /evidence changed/,
);
assert.equal(
  listImportCorrections(stale, ctx, instalment.batch.id).proposals[0]?.current,
  false,
);
assert.throws(
  () =>
    decideImportCorrection(
      stale,
      finance,
      dueProposal.id,
      { ...dueDecision, action: "withdraw" },
      reviewers,
    ),
  /Only the proposer/,
);
assert.equal(
  decideImportCorrection(
    stale,
    ctx,
    dueProposal.id,
    { ...dueDecision, action: "withdraw" },
    reviewers,
  ).status,
  "withdrawn",
);
{
  // MAN-07 (audit item 20): the amended instalment is checked as the person who
  // proposed the correction, as a direct edit would be, never as an Admin.
  const low = fresh();
  imported(
    low,
    "customers",
    "source_row_id,name,reference,consentProvenance\nc-1,Synthetic payer,COR-C-3,Synthetic consent",
  );
  const instalment = imported(
    low,
    "due-items",
    "source_row_id,name,reference,customerId,amount,dueDate,owner,overrideReason\nd-1,Synthetic instalment,COR-D-3,COR-C-3,25000,2028-12-01,lms,An Admin accepted a low ticket for this loan",
  );
  const lowInput = {
    batchId: instalment.batch.id,
    targetId: instalment.target.id,
    expectedUpdatedAt: instalment.target.updatedAt,
    changes: { amountKobo: 600000 },
    syntheticOnly: true as const,
  };
  assert.ok(
    previewImportCorrection(low, ctx, lowInput).blockers.some((blocker) =>
      /need an Admin/.test(blocker),
    ),
    "Operations cannot correct an instalment below the lender minimum, as they cannot edit one there directly",
  );
  const admin = {
    actor: "Clerk:admin",
    principalId: "person-admin",
    role: "Admin",
    now: ctx.now,
  };
  const byAdmin = previewImportCorrection(low, admin, lowInput);
  assert.deepEqual(byAdmin.blockers, [], "an Admin may");
  const proposalInput = {
    ...lowInput,
    previewDigest: byAdmin.previewDigest,
    reviewer: finance.actor,
    reason: "The lender agreed a lower instalment",
    evidence: "SOURCE-AMOUNT-003",
  };
  const legacy = structuredClone(low);
  const proposal = proposeImportCorrection(low, admin, proposalInput, reviewers);
  assert.equal(
    listImportCorrections(low, finance, instalment.batch.id).proposals[0]
      ?.current,
    true,
    "the Finance reviewer sees the Admin's proposal as current",
  );
  const before = structuredClone(low);
  decideImportCorrection(
    low,
    finance,
    proposal.id,
    {
      proposalDigest: proposal.proposalDigest,
      action: "approve",
      reason: "Independently checked the lower instalment",
    },
    reviewers,
  );
  assert.equal(instalment.target.amountKobo, 600000);
  assert.doesNotThrow(() =>
    assertImportedCorrectionChange(
      before.records.find((r) => r.id === instalment.target.id)!,
      instalment.target,
      before,
      low,
    ),
  );
  // A proposal recorded before the proposer's role was kept is checked as a
  // non-Admin: such a change below the minimum needs a fresh proposal.
  const old = proposeImportCorrection(legacy, admin, proposalInput, reviewers);
  const stored = legacy.records.find((r) => r.id === old.id)!;
  const { proposedRole: _role, proposalDigest: _digest, ...evidence } =
    stored.data;
  stored.data = {
    ...evidence,
    proposalDigest: canonicalDigest(evidence, "legacy-en-us-replacer"),
  };
  assert.throws(
    () =>
      decideImportCorrection(
        legacy,
        finance,
        old.id,
        {
          proposalDigest: stored.data.proposalDigest,
          action: "approve",
          reason: "Independently checked the lower instalment",
        },
        reviewers,
      ),
    /prepare a fresh comparison/,
  );
}
{
  const state = structuredClone(snapshot), originalProposal = structuredClone(state.records.find(r => r.id === proposal.id)!);
  const admin = { actor: 'Clerk:admin', principalId: 'person-admin', role: 'Admin', now: '2026-09-24T09:00:00.000Z' };
  const replacement = { actor: 'Clerk:replacement', principalId: 'person-replacement', name: 'New Finance reviewer', role: 'Finance', now: '2026-09-24T10:00:00.000Z' };
  const people = [replacement, { ...admin, name: 'Administrator' }];
  const request = { proposalDigest: proposal.proposalDigest, expectedAssignmentEventId: null, reviewer: replacement.actor, reason: 'Both original staff members have left this lender.' };
  const unavailable = derivePersonalWork(state, admin, people, { scope: 'team', filter: 'review' });
  assert.equal(unavailable.items[0]?.type, 'correction');
  assert.equal(unavailable.counts.review, 1);
  assert.equal(unavailable.items[0]?.escalated, true);
  assert.match(unavailable.items[0]!.escalationReason!, /no longer available/);
  assert.ok(unavailable.items[0]!.href.includes(`batch=${batch.id}&correction=${proposal.id}`));
  assert.equal(derivePersonalWork(state, replacement, people).total, 0, 'new reviewer cannot see another person’s assignment in their own queue');
  assert.throws(() => reassignImportCorrection(state, ctx, proposal.id, request, people), /Only an administrator/);
  assert.throws(() => reassignImportCorrection(state, admin, proposal.id, { ...request, reviewer: ctx.actor }, [...people, { actor: ctx.actor, role: 'Finance' }]), /independent of the proposer/);
  assert.throws(() => reassignImportCorrection(state, admin, proposal.id, request, []), /active Finance/);
  assert.throws(() => reassignImportCorrection({ ...state, merchant: { ...state.merchant, id: 'other-lender' } }, admin, proposal.id, request, people), /not found in this lender/);
  const recovered = reassignImportCorrection(state, admin, proposal.id, request, people);
  assert.equal(recovered.status, 'awaiting_review', 'assignment is not a decision');
  assert.equal(recovered.reviewer, replacement.actor);
  assert.equal(recovered.originalReviewer, finance.actor);
  assert.equal(recovered.assignmentHistory[0]?.actor, admin.actor);
  assert.equal(recovered.assignmentHistory[0]?.reason, request.reason);
  assert.deepEqual(state.records.find(r => r.id === proposal.id), originalProposal, 'original proposal and its digest remain immutable');
  assert.deepEqual(state.records.find(r => r.id === target.id), originalTarget, 'assignment never changes imported values');
  assert.throws(() => reassignImportCorrection(state, admin, proposal.id, request, people), /assignment changed/);
  assert.throws(() => decideImportCorrection(state, replacement, proposal.id, decision, people), /reassigned/);
  assert.throws(() => decideImportCorrection(state, finance, proposal.id, { ...decision, assignmentEventId: recovered.assignmentEventId }, reviewers), /named active Finance/);
  assert.throws(() => decideImportCorrection(state, { ...replacement, principalId: ctx.principalId }, proposal.id, { ...decision, assignmentEventId: recovered.assignmentEventId }, people), /different person/);
  const queue = derivePersonalWork(state, replacement, people, { filter: 'review' });
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0]?.waitingSince, proposal.createdAt, 'reassignment does not reset the original waiting age');
  assert.equal(derivePersonalWork(state, finance, people).total, 0, 'prior assignee loses the work item');
  const item = queue.items[0]!, receipt = { sourceId: item.sourceId, eventId: item.eventId, expectedUpdatedAt: item.sourceVersion, expectedDigest: item.sourceDigest };
  recordWorkReceipt(state, replacement, people, 'read', receipt);
  assert.equal(derivePersonalWork(state, replacement, people).items[0]?.readAt, replacement.now);
  assert.equal(listImportCorrections(state, replacement, batch.id).proposals[0]?.status, 'awaiting_review', 'marking read never decides the correction');
  assert.throws(() => recordWorkReceipt(state, finance, [...people, { ...finance, name: 'Former reviewer' }], 'read', receipt), /currently assigned/);
  const before = structuredClone(state);
  const applied = decideImportCorrection(state, replacement, proposal.id, { ...decision, assignmentEventId: recovered.assignmentEventId }, people);
  assert.equal(applied.status, 'approved');
  assert.equal(derivePersonalWork(state, replacement, people).total, 0);
  assert.doesNotThrow(() => assertImportedCorrectionChange(originalTarget, state.records.find(r => r.id === target.id)!, before, state));
  assert.throws(() => reassignImportCorrection(state, admin, proposal.id, { ...request, expectedAssignmentEventId: recovered.assignmentEventId }, people), /already has a decision/);
  assert.deepEqual(state.records.find(r => r.id === proposal.id), originalProposal);
}
{
  const state = structuredClone(snapshot), admin = { actor: 'Clerk:admin', principalId: 'person-admin', role: 'Admin', now: finance.now };
  const replacement = { ...finance, actor: 'Clerk:replacement', principalId: 'person-replacement' };
  const first = reassignImportCorrection(state, admin, proposal.id, { proposalDigest: proposal.proposalDigest, expectedAssignmentEventId: null, reviewer: replacement.actor, reason: 'Original reviewer is away this week.' }, [replacement]);
  const second = reassignImportCorrection(state, admin, proposal.id, { proposalDigest: proposal.proposalDigest, expectedAssignmentEventId: first.assignmentEventId, reviewer: finance.actor, reason: 'Original reviewer has returned to the team.' }, reviewers);
  assert.equal(second.assignmentHistory.length, 2, 'same-timestamp reassignments follow explicit versions, not an arbitrary sort');
  assert.throws(() => decideImportCorrection(state, finance, proposal.id, decision, reviewers), /reassigned/, 'old browser cannot approve even after assignment returns to the same person');
  state.records.find(r => r.id === target.id)!.name = 'Changed upstream record';
  assert.throws(() => decideImportCorrection(state, finance, proposal.id, { ...decision, assignmentEventId: second.assignmentEventId }, reviewers), /evidence changed/);
  assert.equal(decideImportCorrection(state, finance, proposal.id, { ...decision, action: 'reject', assignmentEventId: second.assignmentEventId }, reviewers).status, 'rejected', 'new reviewer can close stale work without applying it');
}
{
  // Review of PR #71: My work, Mark as read and a batch's correction list compared every correction the lender ever
  // had again, each digesting every close and close review recorded before it, before skipping the decided ones (29
  // decided corrections over 250 closes and reviews of about 20 KB took about 3.5 s a read). Each comparison reads its
  // proposal's saved input, and each digest of a close or a review reads its report or its snapshot: both are counted.
  const state = fresh(), admin = { actor: "Clerk:admin", principalId: "person-admin", role: "Admin", now: "2026-09-24T09:00:00.000Z" };
  const people = [{ ...finance, name: "Synthetic Finance reviewer" }, { ...admin, name: "Synthetic administrator" }];
  const rows = Array.from({ length: 20 }, (_, row) => `c-${row},Synthetic customer ${row},WORK-C-${row},Synthetic consent`).join("\n");
  const { batch } = imported(state, "customers", `source_row_id,name,reference,consentProvenance\n${rows}`);
  let comparisons = 0, evidenceReads = 0;
  const counted = (object: Record<string, unknown>, key: string, count: () => void) => {
    const value = object[key];
    Object.defineProperty(object, key, { enumerable: true, configurable: true, get: () => { count(); return value; } });
  };
  const positions = Array.from({ length: 40 }, (_, index) => ({ customerId: `customer-${index}`, reference: `POSITION-${index}`, outstandingKobo: 1000 * index, note: "Synthetic position change for the count" }));
  for (let day = 0; day < 10; day++) {
    const at = new Date(Date.parse("2026-09-10T18:00:00.000Z") + day * 86_400_000).toISOString();
    const close = makeRecord(state, "closes" as string, { status: "completed", createdAt: at, name: `Synthetic close ${day}`, data: { closedAt: at, report: { unallocated: { count: 0 }, proposed: { count: 0 }, customerPositionsChanged: positions } } });
    const review = makeRecord(state, "close-reviews" as string, { status: "changes_requested", createdAt: at, name: `Synthetic review ${day}`, data: { closeId: close.id, reviewer: finance.actor, snapshot: structuredClone(close) } });
    counted(close.data, "report", () => { evidenceReads += 1; });
    counted(review.data, "snapshot", () => { evidenceReads += 1; });
  }
  const proposals = state.records.filter((r) => r.data.importIdentity?.batchId === batch.id).map((target) => {
    const input = { batchId: batch.id, targetId: target.id, expectedUpdatedAt: target.updatedAt, changes: { name: `${target.name} corrected` }, syntheticOnly: true as const };
    return proposeImportCorrection(state, ctx, { ...input, previewDigest: previewImportCorrection(state, ctx, input).previewDigest, reviewer: finance.actor, reason: "Correct the synthetic source name", evidence: "SYNTHETIC-WORK-COUNT" }, reviewers);
  });
  for (const [index, decided] of proposals.slice(1).entries()) {
    const action = (["reject", "approve", "withdraw"] as const)[index % 3]!;
    decideImportCorrection(state, action === "withdraw" ? ctx : finance, decided.id, { proposalDigest: decided.proposalDigest, action, reason: "Synthetic decision for the count" }, reviewers);
  }
  const countComparisons = (id: string) => counted(state.records.find((r) => r.id === id)!.data, "input", () => { comparisons += 1; });
  for (const proposal of proposals) countComparisons(proposal.id);
  const pending = proposals[0]!, reset = () => { comparisons = 0; evidenceReads = 0; };
  const read = (item: { sourceId: string; eventId: string; sourceVersion: string; sourceDigest: string }) => recordWorkReceipt(state, finance, people, "read", { sourceId: item.sourceId, eventId: item.eventId, expectedUpdatedAt: item.sourceVersion, expectedDigest: item.sourceDigest });
  reset();
  const own = derivePersonalWork(state, finance, people);
  assert.deepEqual(own.items.map((item) => item.sourceId), [pending.id]);
  assert.equal(comparisons, 1, "My work compares only the pending correction: decided ones leave the queue before any comparison");
  assert.equal(evidenceReads, 0, "a pending correction's currency check reads no close report or review snapshot");
  reset();
  assert.equal(derivePersonalWork(state, admin, people, { scope: "team" }).total, 1);
  assert.deepEqual([comparisons, evidenceReads], [1, 0], "the team workload likewise");
  reset();
  const statuses = listImportCorrections(state, finance, batch.id).proposals.map((proposal) => proposal.status);
  assert.deepEqual(Object.fromEntries(["approved", "awaiting_review", "rejected", "withdrawn"].map((status) => [status, statuses.filter((saved) => saved === status).length])), { approved: 6, awaiting_review: 1, rejected: 7, withdrawn: 6 });
  assert.deepEqual([comparisons, evidenceReads], [1, 0], "the batch's correction list compares only its pending correction");
  reset();
  assert.equal(read(own.items[0]!).duplicate, false);
  assert.deepEqual([comparisons, evidenceReads], [1, 0], "Mark as read derives its one item, once");
  // A proposal saved before impact versions keeps its first check, of the closes and reviews whole: once a read.
  asEarlierBuild(state, pending.id);
  countComparisons(pending.id);
  reset();
  const earlierItem = derivePersonalWork(state, finance, people).items[0]!;
  assert.deepEqual([comparisons, evidenceReads, Number(earlierItem.reviewCurrent)], [1, 20, 1], "a proposal saved without a version is checked by its first rule, once");
  reset();
  assert.equal(read(earlierItem).duplicate, false);
  assert.deepEqual([comparisons, evidenceReads], [1, 20], "and Mark as read checks it once");
}
{
  // Review of PR #71: a proposal's impact digest covered every close recorded before it as loadState returns it, and
  // loadState summarises a close more than seven days older than the newest. A week of later daily closes changed an
  // unchanged proposal's digest: it read as stale and approval was refused, so a replacement reviewer could only reject.
  const state = fresh(), { batch } = imported(state, "customers", "source_row_id,name,reference,consentProvenance\nc-1,Synthetic customer,DRIFT-C-1,Synthetic consent\nc-2,Earlier synthetic customer,DRIFT-C-2,Synthetic consent");
  const [target, earlierTarget] = state.records.filter((r) => r.data.importIdentity?.batchId === batch.id);
  const report = { unallocated: { count: 0 }, proposed: { count: 1, kobo: 500 }, possibleDuplicates: { count: 0 }, positionRebuild: { mismatches: [] }, variances: { count: 0, batches: [] } };
  const earlier = makeRecord(state, "closes" as string, { status: "completed", createdAt: "2026-09-03T18:00:00.000Z", name: "Synthetic close 3 September", data: { closedAt: "2026-09-03T18:00:00.000Z", report, operational: { attempts: 3 }, metrics: { matched: 2 } } });
  makeRecord(state, "close-reviews" as string, { status: "changes_requested", createdAt: "2026-09-03T19:00:00.000Z", name: "Synthetic review 3 September", data: { closeId: earlier.id, reviewer: finance.actor, snapshot: structuredClone(earlier) } });
  const proposer = { ...ctx, now: "2026-09-10T09:00:00.000Z" }, reviewer = { ...finance, now: "2026-09-20T10:00:00.000Z" };
  const people = [{ ...finance, name: "Synthetic Finance reviewer" }];
  const propose = (record: typeof target) => {
    const input = { batchId: batch.id, targetId: record!.id, expectedUpdatedAt: record!.updatedAt, changes: { name: `${record!.name} corrected` }, syntheticOnly: true as const };
    return proposeImportCorrection(state, proposer, { ...input, previewDigest: previewImportCorrection(state, proposer, input).previewDigest, reviewer: finance.actor, reason: "Correct the misspelled source name", evidence: "SYNTHETIC-DRIFT-EVIDENCE" }, reviewers);
  };
  const proposal = propose(target), saved = propose(earlierTarget);
  asEarlierBuild(state, saved.id);
  // Nine daily closes after the proposals: the 3 September close is now more than seven days older than the newest.
  for (let day = 11; day <= 19; day++) makeRecord(state, "closes" as string, { status: "completed", createdAt: `2026-09-${day}T18:00:00.000Z`, name: `Synthetic close ${day} September`, data: { closedAt: `2026-09-${day}T18:00:00.000Z`, report } });
  const loaded = asLoaded(state), current = (lender: DomainState) => Object.fromEntries(listImportCorrections(lender, reviewer, batch.id).proposals.map((p) => [p.id, p.current]));
  assert.equal(loaded.records.find((r) => r.id === earlier.id)!.data.operational, undefined, "the load summarises the earlier close");
  assert.deepEqual(current(state), { [proposal.id]: true, [saved.id]: true }, "both are current while every close loads whole");
  // A proposal saved before impact versions keeps the check it was saved with, so it can still only be rejected or withdrawn.
  assert.deepEqual(current(loaded), { [proposal.id]: true, [saved.id]: false }, "an unchanged proposal stays current when an earlier close loads as its summary");
  assert.equal(derivePersonalWork(loaded, reviewer, people, { filter: "review" }).items.find((item) => item.sourceId === proposal.id)?.reviewCurrent, true, "My work agrees");
  const before = structuredClone(loaded);
  assert.equal(decideImportCorrection(loaded, reviewer, proposal.id, { proposalDigest: proposal.proposalDigest, action: "approve", reason: "Independently compared the source" }, reviewers).status, "approved");
  assert.doesNotThrow(() => assertImportedCorrectionChange(before.records.find((r) => r.id === target!.id)!, loaded.records.find((r) => r.id === target!.id)!, before, loaded), "the save's check uses the same rule");
}
{
  // Review of PR #71, follow-up: impact version 2 still covers a decision or reassignment of a close review recorded
  // before a proposal. Returning a review moves its status and version, reassigning it only its version (and reviewer):
  // either way the proposal reads as changed and its approval is refused, as before version 2.
  const state = fresh(), { batch, target } = imported(state, "customers", "source_row_id,name,reference,consentProvenance\nc-1,Synthetic customer,STALE-C-1,Synthetic consent");
  const admin = { actor: "Clerk:admin", principalId: "person-admin", role: "Admin", now: "2026-09-22T11:00:00.000Z" };
  const other = { actor: "Clerk:other-finance", role: "Finance" }, people = [...reviewers, other];
  const earlierClose = bindCloseReviewBasis(state, makeRecord(state, "closes" as string, { status: "completed", createdAt: "2026-09-21T18:00:00.000Z", name: "Synthetic close 21 September", data: { closedAt: "2026-09-21T18:00:00.000Z", report: { unallocated: { count: 0 }, proposed: { count: 0 }, possibleDuplicates: { count: 0 } } } }));
  const review = prepareCloseReview(state, { ...admin, now: "2026-09-21T19:00:00.000Z" }, { closeId: earlierClose.id, expectedUpdatedAt: earlierClose.updatedAt, reviewer: finance.actor, preparationNote: "Checked the synthetic close inputs.", unresolvedAcceptance: "Synthetic owners follow up the open items.", discrepancyResponses: closeReviewIssues(earlierClose).map((issue) => ({ issueId: issue.id, explanation: "Synthetic explanation for this check." })) }, people);
  const input = { batchId: batch.id, targetId: target.id, expectedUpdatedAt: target.updatedAt, changes: { name: "Corrected synthetic customer" }, syntheticOnly: true as const };
  const proposal = proposeImportCorrection(state, ctx, { ...input, previewDigest: previewImportCorrection(state, ctx, input).previewDigest, reviewer: finance.actor, reason: "Correct the misspelled source name", evidence: "SYNTHETIC-STALE-EVIDENCE" }, reviewers);
  assert.equal(state.records.find((r) => r.id === proposal.id)!.data.impactVersion, 2);
  assert.equal(listImportCorrections(state, finance, batch.id).proposals[0]?.current, true, "current while the earlier review is unchanged");
  const approve = { proposalDigest: proposal.proposalDigest, action: "approve" as const, reason: "Independently compared the source" };
  const changes: Array<[string, (lender: DomainState) => void]> = [
    ["returned", (lender) => { const saved = lender.records.find((r) => r.id === review.id)!; decideCloseReview(lender, { ...finance, now: "2026-09-22T10:30:00.000Z" }, saved.id, { action: "return", expectedUpdatedAt: saved.updatedAt, note: "Return the synthetic close for changes." }); }],
    ["reassigned", (lender) => { const saved = lender.records.find((r) => r.id === review.id)!; reassignCloseReview(lender, admin, saved.id, { expectedUpdatedAt: saved.updatedAt, reviewer: other.actor, reason: "The named reviewer is away this week." }, people); }],
  ];
  for (const [label, change] of changes) {
    const lender = structuredClone(state);
    change(lender);
    assert.equal(listImportCorrections(lender, finance, batch.id).proposals[0]?.current, false, `an earlier close review ${label} after the proposal makes it stale`);
    assert.throws(() => decideImportCorrection(lender, finance, proposal.id, approve, reviewers), (error: any) => error.status === 409 && /evidence changed/.test(error.message), `and its approval is refused once that review is ${label}`);
  }
}
{
  // Review of PR #71: a forked reviewer assignment (two reassignments from the same version, which only bad data
  // holds) failed My work, Mark as read and the batch's correction list for the whole lender. Only that proposal fails.
  const state = fresh(), admin = { actor: "Clerk:admin", principalId: "person-admin", role: "Admin", now: finance.now };
  const people = [{ ...finance, name: "Synthetic Finance reviewer" }, { ...admin, name: "Synthetic administrator" }];
  const { batch } = imported(state, "customers", "source_row_id,name,reference,consentProvenance\nc-1,Synthetic customer one,FORK-C-1,Synthetic consent\nc-2,Synthetic customer two,FORK-C-2,Synthetic consent");
  const [forked, healthy] = state.records.filter((r) => r.data.importIdentity?.batchId === batch.id).map((target) => {
    const input = { batchId: batch.id, targetId: target.id, expectedUpdatedAt: target.updatedAt, changes: { name: `${target.name} corrected` }, syntheticOnly: true as const };
    return proposeImportCorrection(state, ctx, { ...input, previewDigest: previewImportCorrection(state, ctx, input).previewDigest, reviewer: finance.actor, reason: "Correct the synthetic source name", evidence: "SYNTHETIC-FORK-EVIDENCE" }, reviewers);
  }) as [ReturnType<typeof proposeImportCorrection>, ReturnType<typeof proposeImportCorrection>];
  for (const other of ["Clerk:other-one", "Clerk:other-two"])
    makeRecord(state, "import-correction-events", { status: "recorded", createdAt: finance.now, data: { proposalId: forked.id, targetId: forked.preview.targetId, batchId: batch.id, proposalDigest: forked.proposalDigest, action: "reassign", actor: admin.actor, principalId: admin.principalId, reason: "Synthetic forked history", previousAssignmentEventId: null, fromReviewer: finance.actor, reviewer: other } });
  const own = derivePersonalWork(state, finance, people);
  const healthyItem = own.items.find((item) => item.sourceId === healthy.id)!, forkedItem = own.items.find((item) => item.sourceId === forked.id)!;
  assert.equal(healthyItem.notice, null, "the other correction is listed as before");
  assert.match(forkedItem.notice!, /inconsistent assignment history/, "the forked one is listed with what is wrong");
  assert.equal(derivePersonalWork(state, admin, people, { scope: "team" }).items.find((item) => item.sourceId === forked.id)?.escalated, true, "and escalated to the administrator");
  const read = (item: typeof healthyItem) => recordWorkReceipt(state, finance, people, "read", { sourceId: item.sourceId, eventId: item.eventId, expectedUpdatedAt: item.sourceVersion, expectedDigest: item.sourceDigest });
  assert.equal(read(healthyItem).sourceId, healthy.id, "Mark as read works for the rest of the lender");
  assert.deepEqual(listImportCorrections(state, finance, batch.id).proposals.map((proposal) => proposal.id).sort(), [forked.id, healthy.id].sort(), "the batch's list still answers");
  assert.throws(() => decideImportCorrection(state, finance, forked.id, { proposalDigest: forked.proposalDigest, action: "reject", reason: "Synthetic decision on bad history" }, reviewers), /inconsistent assignment history/, "a decision on the forked proposal still fails closed");
  assert.throws(() => reassignImportCorrection(state, admin, forked.id, { proposalDigest: forked.proposalDigest, expectedAssignmentEventId: null, reviewer: "Clerk:another", reason: "Synthetic recovery on bad history" }, [{ actor: "Clerk:another", role: "Finance" }]), /inconsistent assignment history/);
}
{
  // Review of PR #71: reassignment compared the new reviewer, an actor, with `Clerk:<the proposer's principal>`; a
  // principal is a digest of the person's identity, so it never matched a proposer and could only refuse a colleague.
  // Independence from the proposer is their actor here and their principal at the decision. A demo persona shares the
  // browser person's principal, so it could be assigned and then never decide: it is refused, as a close review's is.
  const state = fresh(), admin = { actor: "Clerk:admin", principalId: "person-admin", role: "Admin", now: finance.now };
  const { batch, target } = imported(state, "customers", "source_row_id,name,reference,consentProvenance\nc-1,Synthetic customer,ASSIGN-C-1,Synthetic consent");
  const input = { batchId: batch.id, targetId: target.id, expectedUpdatedAt: target.updatedAt, changes: { name: "Corrected synthetic customer" }, syntheticOnly: true as const };
  const proposal = proposeImportCorrection(state, ctx, { ...input, previewDigest: previewImportCorrection(state, ctx, input).previewDigest, reviewer: finance.actor, reason: "Correct the misspelled source name", evidence: "SYNTHETIC-ASSIGN-EVIDENCE" }, reviewers);
  const request = { proposalDigest: proposal.proposalDigest, expectedAssignmentEventId: null, reason: "The named reviewer is away this week." };
  const demo = { actor: "Sandbox Finance", role: "Finance" };
  assert.throws(() => reassignImportCorrection(state, admin, proposal.id, { ...request, reviewer: demo.actor }, [demo]), (error: any) => error.status === 403 && /Demo roles cannot provide independent review/.test(error.message));
  const colleague = { actor: `Clerk:${ctx.principalId}`, role: "Finance" };
  assert.equal(reassignImportCorrection(state, admin, proposal.id, { ...request, reviewer: colleague.actor }, [colleague]).reviewer, colleague.actor, "a colleague is judged by their own actor");
}
console.log(
  "Import correction checks passed: immutable provenance, exact comparison, independent approval, stale dependencies, controlled financial changes, the proposer's own authority, withdrawal and isolation; currency that later closes leave unchanged, each pending correction compared once a read, a forked assignment confined to its proposal and independent reassignment.",
);
