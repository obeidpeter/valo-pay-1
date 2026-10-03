// Golden digests (audit item 26): every digest the platform stores and later
// computes or compares again, for one fixed synthetic lender whose field names
// the en-US collation and code units order differently. The expected values
// were computed by the code before the shared canonical JSON module (commit
// 9fdfb59) running this same scenario, so a change that altered any of them
// would stop matching evidence earlier builds stored.
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";

process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
// Fixed record IDs: several digests cover them, and the domain draws them from randomUUID.
const nodeCrypto = createRequire(import.meta.url)("node:crypto") as { randomUUID: () => string };
let issued = 0;
nodeCrypto.randomUUID = () => `00000000-0000-4000-8000-${String(++issued).padStart(12, "0")}`;
syncBuiltinESMExports();

const { seedMerchant } = await import("../src/lib/valo-pay-1-seed.js");
const { makeRecord } = await import("../src/domain/records.js");
const { saveImportBatch, commitImportBatch } = await import("../src/domain/pilot-workflow.js");
const { saveSourceManifest, sourceCompleteness } = await import("../src/domain/source-completeness.js");
const { bindCloseReviewBasis, closeReviewBasis, closeReviewIssues, prepareCloseReview, reviewIsCurrent } = await import("../src/domain/close-review.js");
const { importCorrectionComparison, previewImportCorrection, proposeImportCorrection } = await import("../src/domain/import-corrections.js");
const { personalWorkItems } = await import("../src/domain/personal-work.js");
const { lifecyclePolicy, lifecycleHolds, lifecycleCandidates, lifecyclePreview, saveLifecyclePolicy, setLifecycleHold } = await import("../src/domain/lifecycle.js");
const { decisionFingerprint } = await import("../src/domain/policy-engine.js");
const { cashEvidenceHash } = await import("../src/domain/connected-cash.js");
const { assessCredit, createSyntheticCreditInput } = await import("../src/domain/connected-credit.js");
const { connectedRevision } = await import("../src/domain/connected.js");
const { appendAudit, verifyAudit } = await import("../src/lib/valo-pay-1-store.js");
const { canonicalDigest, requestFingerprint } = await import("../src/lib/digests.js");

const date = "2026-09-22";
const ops = { actor: "Clerk:operator", principalId: "person-operator", role: "Operations", now: "2026-09-23T09:00:00.000Z" };
const finance = { actor: "Clerk:finance", principalId: "person-finance", role: "Finance", now: "2026-09-23T10:00:00.000Z" };
const admin = { actor: "Clerk:admin", role: "Admin", now: "2026-10-30T10:00:00.000Z" };
const people = [{ actor: ops.actor, name: "Operator", role: "Operations" }, { actor: finance.actor, name: "Finance", role: "Finance" }, { actor: admin.actor, name: "Administrator", role: "Admin" }];
/** Field names whose en-US order and code-unit order differ, at two depths. */
const tricky = { Zeta: 1, ärende: 2, _x: [3, { B: 4, a: 5, "10": 6, "9": 7 }], checksum: "c", hash: "h", aB: 8, Ab: 9, amount_kobo: 10, amountKobo: 11 };

const state = seedMerchant("golden-lender", true);
state.records = [];
// The connected revision covers the lender record as it is stored: a sample lender that earlier builds created stored
// this segment (the language pass writes "sample data" for new ones), so the pinned revision is taken over it.
state.merchant.segment = "Smaller lender · synthetic";
const values: Record<string, unknown> = {};

// Source rows: a committed batch whose columns become data fields.
const batch = saveImportBatch(state, ops, {
  name: "Golden customers", source: "golden-lms", sourceBatchId: "golden-2026-09-22", kind: "customers", businessDate: date,
  csv: "source_row_id,name,reference,consentProvenance,Zeta,ärende,_x,Ab,aB\nrow-1,Ada Golden,G-001,Synthetic consent,1,2,3,4,5\nrow-2,Bola Golden,G-002,Synthetic consent,6,7,8,9,10",
  mapping: {}, identityColumn: "source_row_id", amountUnit: "naira", syntheticOnly: true,
});
commitImportBatch(state, ops, batch.id, batch.updatedAt);
values.importRowFingerprints = state.records.filter((record) => record.data.importIdentity).map((record) => record.data.importIdentity.fingerprint);

// Source completeness: a declaration, its file ID and the basis a close stores.
const manifest = saveSourceManifest(state, ops, { businessDate: date, files: [{ source: "golden-lms", sourceBatchId: "golden-2026-09-22", kind: "customers", expectedRows: 2, expectedAmountKobo: 0 }], noFilesExpected: false, reason: "The source owner confirms the complete daily file set.", evidence: "Source control report GOLDEN-22.", syntheticOnly: true });
values.sourceFileIds = manifest.data.files!.map((file) => file.id);
values.sourceBasis = sourceCompleteness(state, date).basisDigest;

// A case being worked, with a handover, whose assignment carries extra fields.
const exception = makeRecord(state, "exceptions" as string, { name: "Golden case", status: "in_progress", createdAt: ops.now, updatedAt: ops.now, data: { type: "unallocated_payment", case: { assignee: ops.actor, assigneeName: "Operator", nextAction: "Compare the sample receipt.", nextActionAt: "2026-09-24T10:00:00.000Z", evidenceIds: [], ...tricky } } });
const handover = makeRecord(state, "case-events" as string, { name: "Golden handover", status: "recorded", createdAt: ops.now, data: { exceptionId: exception.id, action: "handover", actor: admin.actor, after: structuredClone(exception.data.case) } });
exception.data.case.handoverEventId = handover.id;

// A close with its review basis, and a Finance review of it.
const close = makeRecord(state, "closes" as string, { name: "Golden close", status: "completed", createdAt: ops.now, data: { sourceBusinessDate: date, closedAt: ops.now, summary: "Golden close", report: { variances: { count: 0, batches: [] }, positionRebuild: { mismatches: [] }, unallocated: { count: 0 }, proposed: { count: 0 }, possibleDuplicates: { count: 0 }, operational: tricky } } });
bindCloseReviewBasis(state, close);
values.closeInput = close.data.reviewBasis.inputDigest;
values.closeSourceBasis = close.data.reviewBasis.sourceCompleteness.basisDigest;
const review = prepareCloseReview(state, ops, { closeId: close.id, expectedUpdatedAt: close.updatedAt, reviewer: finance.actor, preparationNote: "Compared the close against the original source controls.", discrepancyResponses: closeReviewIssues(close).map((issue) => ({ issueId: issue.id, explanation: "The source owner is investigating and Finance must review the gap." })), unresolvedAcceptance: "The source owner will deliver the missing evidence tomorrow." }, [finance]);
// Earlier builds named a close review "Finance review · {close}", and a comparison lists each review by its stored
// name, so the review keeps the name they stored (the language pass names new reviews "Close review · {close}").
review.name = `Finance review · ${close.name}`;
values.closeSnapshot = review.data.snapshotDigest;
assert.equal(reviewIsCurrent(state, review), true);
assert.equal(closeReviewBasis(state), close.data.reviewBasis.inputDigest);

// Work items: the case handover and the review awaiting Finance.
values.workItems = personalWorkItems(state, { ...ops, now: "2026-09-23T11:00:00.000Z" }, people).map((item) => [item.id, item.sourceDigest]);

// An import correction: its preview, impact and proposal digests.
const target = state.records.find((record) => record.data.importIdentity?.rowId === "row-1")!;
const correction = { batchId: batch.id, targetId: target.id, expectedUpdatedAt: target.updatedAt, changes: { name: "Ada Corrected" }, syntheticOnly: true as const };
const preview = previewImportCorrection(state, ops, correction);
proposeImportCorrection(state, ops, { ...correction, previewDigest: preview.previewDigest, reviewer: finance.actor, reason: "Correct the misspelled source name", evidence: "SOURCE-CORRECTION-GOLDEN" }, [{ actor: finance.actor, role: "Finance" }]);
const proposal = state.records.find((record) => record.kind === "import-corrections")!;
// A proposal records its proposer's role since the 23 September audit (item 20), and its impact version since the
// review of PR #71, and its digest covers both: checked here against the same rules. Version 2 covers each close and
// close review before it as the comparison lists it; its digests are pinned as the build that introduced it stored
// them. The golden values are pinned on the proposal as earlier builds stored it, without the role or the version:
// its comparison, made again by the rule such a proposal is still checked with, must give the digests they stored.
const { proposalDigest: storedDigest, proposedRole, impactVersion, ...earlierProposal } = proposal.data;
assert.equal(proposedRole, ops.role);
assert.equal(impactVersion, 2);
assert.equal(storedDigest, canonicalDigest({ ...earlierProposal, proposedRole, impactVersion }, "legacy-en-us-replacer"));
// A proposal stores its comparison's consequence, which the language pass words differently: the proposals pinned
// here are the ones those builds stored, with the consequence they wrote.
const earlierConsequence = "Approval changes the current record only. The committed file, original source identity and before/after evidence remain unchanged. Close approvals recorded before this comparison must be refreshed; a close recorded afterwards does not change the comparison.";
const asStored = { ...earlierProposal, preview: { ...earlierProposal.preview, consequence: earlierConsequence } };
values.correctionVersion2 = { preview: preview.previewDigest, impact: proposal.data.impactDigest, proposal: canonicalDigest({ ...asStored, proposedRole, impactVersion }, "legacy-en-us-replacer") };
const earlier = importCorrectionComparison(state, finance, { ...proposal, data: earlierProposal });
const earlierData = { ...asStored, impactDigest: earlier.impactDigest, preview: { ...asStored.preview, previewDigest: earlier.preview.previewDigest } };
proposal.data = { ...earlierData, proposalDigest: canonicalDigest(earlierData, "legacy-en-us-replacer") };
values.correction = { preview: earlier.preview.previewDigest, impact: earlier.impactDigest, proposal: proposal.data.proposalDigest };

// Retention: policy and hold revisions, candidate digests and a preview.
saveLifecyclePolicy(state, admin, { policy: { rawCsvDays: 30, journalPayloadDays: null, exportFileDays: null, auditTrail: "retain" }, expectedRevision: lifecyclePolicy(state).revision, reason: "Agreed source retention for the golden rehearsal." });
values.retentionPolicy = lifecyclePolicy(state).revision;
const hold = (held: boolean) => setLifecycleHold(state, admin, { kind: "raw_csv", sourceId: batch.id, held, expectedHoldRevision: lifecycleHolds(state).revision, reason: held ? "Keep this source for the golden case." : "The golden case is complete; release the hold." });
values.retentionHolds = [lifecycleHolds(state).revision, hold(true).revision, hold(false).revision];
values.retentionCandidates = lifecycleCandidates(state).map((candidate) => candidate.digest);
values.retentionPreview = lifecyclePreview(state, admin, { expectedPolicyRevision: lifecyclePolicy(state).revision }).previewDigest;

// A retry decision (item 13's fingerprint) with nested inputs.
values.retryDecision = decisionFingerprint({ dueItemId: "due-golden", attemptId: "attempt-golden", decision: "would_schedule", rule: "plan", nextAt: "2026-09-25T06:00:00.000Z", policyId: "policy-golden", policyVersion: 2, experimentArm: null, inputs: { ...tricky, calendar: { earliestAt: "x" } }, noticeRequired: { purpose: "failed_debit", leadHours: 24, requiredBy: "2026-09-24T06:00:00.000Z", noticeId: null, acceptedAt: null, evidenced: false } });

// Connected banking evidence.
values.cashEvidence = [cashEvidenceHash(tricky), cashEvidenceHash([tricky, null, { skipped: undefined, kept: true }])];
const creditContext = { tenantId: state.merchant.id, actorId: ops.actor, permissions: ["credit:assess"] as const, now: ops.now };
const creditInput = createSyntheticCreditInput({ tenantId: state.merchant.id, applicantId: "golden-applicant", applicationRef: "golden-application", now: ops.now });
// The sample schedule as the earlier builds wrote it, every 30 days (it now falls due monthly), so the digest covers the same input.
creditInput.repaymentSchedule = [30, 60, 90].map((days) => ({ dueAt: new Date(Date.parse(ops.now) + days * 86_400_000).toISOString(), amountKobo: 9_000_000 }));
values.creditAssessment = assessCredit(creditInput, { ...creditContext, permissions: [...creditContext.permissions] }).id;
// The connected revision is never stored: an action compares it with the one its view was given. The 23 September
// audit narrowed it to what the workspace shows and its actions read, and the review of those fixes to the settings
// the workspace reads, so its value here is the narrowed one's.
values.connectedRevision = connectedRevision(state);

// Request fingerprints stored with idempotency receipts and journal entries.
values.requestFingerprints = [
  requestFingerprint({ path: "/v1/records/customers", method: "POST", body: { name: "Ada", data: { consentProvenance: "Signed", ...tricky } }, actor: ops.actor }),
  requestFingerprint({ path: "/v1/actions", method: "POST", body: { action: "set_role", role: "Finance" }, actor: "Sandbox role switch" }),
  requestFingerprint({ method: "PATCH", path: "/v1/records/customers/abc", body: { data: tricky, expectedUpdatedAt: ops.now } }),
  requestFingerprint({ name: "Golden lender", segment: "Smaller lender" }),
  requestFingerprint({ input: { action: "cash.initialize", data: tricky, reason: "Golden" }, actor: ops.actor }),
];

// The audit chain: entries whose change digests cover the fields above.
appendAudit(state, ops, "golden.first", "workspace", "Golden first entry", { beforeDigest: "a".repeat(64), afterDigest: "b".repeat(64), changedRecords: 2, ...tricky });
appendAudit(state, finance, "golden.second", exception.id, "Golden second entry");
values.auditChain = state.records.filter((record) => record.kind === "audit").map((record) => [record.data.changeDigest, record.data.hash]);
assert.equal(verifyAudit(state).valid, true);

/** Computed by the code at 9fdfb59 for this scenario (VALO_PAY_1_GOLDEN_PRINT=1 prints the current values). */
const golden = {
  "importRowFingerprints": [
    "bb03698a5789dc2185bc008fe0ecdb7b9c205f0418eccd0bd2d6b10e850cfa31",
    "61b89619302ff36ad607d4f718653777e86c8001d42f920af8329f2d9eb97b70"
  ],
  "sourceFileIds": [
    "afe5015d9e9a498132b53f61e1c5d9d6eb7ff5897d8f1f9dca6d2d67bbe6564f"
  ],
  "sourceBasis": "545517c6e1d287bc4a6e91a175d531a2acf5d53e6e94a2c4eb18b8768e238680",
  "closeInput": "1292ced562528a48335f14f7826bdf92f9a38ef49ed7fff8f932e972ce89fcc0",
  "closeSourceBasis": "545517c6e1d287bc4a6e91a175d531a2acf5d53e6e94a2c4eb18b8768e238680",
  "closeSnapshot": "2682545bfa0a0ff2f9ab24bdc18785ad791c8397ec7839844b43d6eaaa3780cc",
  "workItems": [
    [
      "case:00000000-0000-4000-8000-000000000066",
      "e0104d1d19826cf3c8bd652248d7295ac332d7935b96f9a0cb9d83981122339b"
    ],
    [
      "review:00000000-0000-4000-8000-000000000072",
      "a9e2b3978235823501f3f9ca68f087b9910714c0b57217f6546e6b0ddf8b34d8"
    ]
  ],
  "correction": {
    "preview": "75652d84d26a3d20772fbe2a3a4e5ddaf19ee088def4841916c0ca341ef41910",
    "impact": "e2b5f8fc402d62df88466d8d2c0a95ccb1979aa165d3a5c9b007cb6c92e1cf12",
    "proposal": "71fd6df93bdd1700d69b9e69194fd11eb26e8801f40171773102e32e6afe19c5"
  },
  // Impact version 2 (review of PR #71), pinned from the build that introduced it.
  "correctionVersion2": {
    "preview": "e20cce9477b510f85bbf368406720f472f7607b3cde9396a9e9e91f062d0acb5",
    "impact": "db3845919d74b361ebd2874da762dae58356ebee0bc1d9a48e4fd3ea476e5a81",
    "proposal": "538116299f89e962b7769025cb53a74558ee1ba80d0c00a753d4826a1c4b0339"
  },
  "retentionPolicy": "879774952c43182ccb4e575b110eaf4385c5fd6d2e9ce7f6a736d586ae7b18fc",
  "retentionHolds": [
    "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "0bf1ed0c28c270e0ee0dfe87899d6a7cd455dc2f30972b2ed69e4181f9c8d5da",
    "6ff8281735942110e05a44f9789e92d7fa13dfa8162351585001c03b0106bbf1"
  ],
  "retentionCandidates": [
    "6090778303934623d39521cf0cf78a33955839224e3b2e7c1342c99106c99376"
  ],
  "retentionPreview": "9d9acf5c188361f0b8a4fbfcebf42b7ad4a945b33bcb550935e00e7c8e7f15dd",
  "retryDecision": "6faec4588d0a7732547f1e1ee2a17f6a570bd1109613fd55dac592bccca5edb2",
  "cashEvidence": [
    "15bc2dbd2ffcce6667725e1aaecb036aa88b110e70f89472f627f55227ca4419",
    "e358ad9a1fd8a46d1ca85a6fd84b839d195dcb366026fc99fd98136691f39737"
  ],
  "creditAssessment": "credit-66ff9d3a7f89f8791bd795dd075d227c",
  "connectedRevision": "7d3f8d05afd569ba80a34fd16e8fcf6a99a8847a75eeedd9746f3d6035bdd675",
  "requestFingerprints": [
    "f7960ff0d2491d875296293e6d68985433711ef9e7318094fe35c4dc2e9a27c3",
    "5f0924e2e458c05413a430d4a245829aa1dca699e16b6b441b5ba80d47d80d74",
    "b2e1b302e5105f7b5d4a6040aa4c50b0a3c4332d400006a0a26b0c6ce417a710",
    "01f0b9840ddfaefd6dcfff1a14a0c50eda3ff1f878a7d0c3b00cf56ad1a56416",
    "6a3609013e197b2d4cbefe6130bc7a03bd486650ee9355a84485cc6db3a3265c"
  ],
  "auditChain": [
    [
      "0009a18d1e5ba4cf109d416d143265c79c433546aa90bcf2d2a27709313442af",
      "3248d96423a50b947a45182e9036ae0e3bbea9402bec2b03eb2e5ea9d8ed4205"
    ],
    [
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "013ef7adf1726023a08e71119cf2e996ef04e359092c582bcade6ff8e4caa306"
    ]
  ]
};

if (process.env.VALO_PAY_1_GOLDEN_PRINT === "1") {
  console.log(JSON.stringify(values, null, 2));
} else {
  assert.deepEqual(values, golden);
  console.log(`Golden digests passed: ${Object.keys(golden).length} kinds of stored digest match the values the earlier helpers, or the build that introduced them, computed.`);
}
