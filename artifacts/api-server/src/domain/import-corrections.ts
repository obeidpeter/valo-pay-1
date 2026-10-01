import {
  importCorrectionPreviewInputSchema,
  importCorrectionProposalInputSchema,
  importCorrectionDecisionInputSchema,
  importCorrectionRecoveryInputSchema,
  importCorrectionPreviewSchema,
  importCorrectionViewSchema,
  type ImportCorrectionPreviewInput,
  type ImportCorrectionProposalInput,
  type ImportCorrectionDecisionInput,
  type ImportCorrectionRecoveryInput,
  fromImportBatch,
  legacyCollatedCompare,
  sameJson,
  changedText,
  demoRolesNote,
  importFieldLabel,
  notFoundText,
} from "@workspace/valopay-schema";
import type { Context, DomainState, ValopayRecord } from "./types";
import { makeRecord, assertNoRealBankDetails } from "./records";
import { roleRefusal, validateRecord } from "./validation";
import { canonicalDigest } from "../lib/digests";
import { contractAnswer } from "../lib/contract";

// Impact, preview and proposal digests are stored in a proposal and computed
// again when it is approved and saved: their first form.
const digest = (value: unknown) =>
  canonicalDigest(value, "legacy-en-us-replacer");
const principal = (ctx: Context) => ctx.principalId || ctx.actor;
/** The role the correction is checked as: its proposer's (MAN-07 lets only an Admin set a new sub-minimum amount).
 * A proposal recorded before the role was kept is checked as a writer who is not an Admin. */
const proposerRole = (proposal: ValopayRecord): string =>
  typeof proposal.data.proposedRole === "string"
    ? proposal.data.proposedRole
    : "Operations";
function refuse(message: string, status = 409): never {
  throw Object.assign(new Error(message), { status });
}
function writer(ctx: Context) {
  if (!["Admin", "Operations", "Finance"].includes(ctx.role))
    refuse(roleRefusal(ctx, ["Admin", "Operations", "Finance"], "propose an import correction"), 403);
}
const financialKinds = new Set([
  "payments",
  "observations",
  "allocations",
  "attempts",
  "refunds",
  "adjustments",
  "retry-decisions",
  "connected-intents",
  "notifications",
]);
function ownedBatch(state: DomainState, id: string) {
  const batch = state.records.find(
    (r) =>
      r.id === id &&
      r.kind === "import-batches" &&
      r.merchantId === state.merchant.id,
  );
  if (!batch || batch.status !== "committed")
    refuse(batch ? "This batch is not imported yet, so it has no import corrections. Correct its rows in Import batches before you import it." : notFoundText("import batch"), 404);
  return batch;
}
function ownedTarget(state: DomainState, batch: ValopayRecord, id: string) {
  const target = state.records.find(
    (r) =>
      r.id === id &&
      r.merchantId === state.merchant.id &&
      r.data.importIdentity?.batchId === batch.id,
  );
  if (
    !target ||
    target.data.importIdentity.source !== batch.data.source ||
    target.kind !== batch.data.kind
  )
    refuse("This record was not imported in this batch. Choose one of its records.", 404);
  return target;
}
/** A record as the comparison lists it among the affected records. */
const listed = ({ id, kind, name, reference, status, updatedAt }: ValopayRecord) => ({ id, kind, name, reference, status, updatedAt });
/** From impact version 2 a proposal covers each close and close review
 * recorded before it as the comparison lists it: its name, reference, status
 * and version. loadState keeps a close more than a week older than the newest
 * as its summary, so a digest of whole closes changed when later daily closes
 * moved that cutoff. Closes never change once recorded (saveState refuses),
 * any change to a review moves its version, and its frozen snapshot never
 * changes. A proposal saved without a version (1) keeps its first rule: every
 * affected record whole, as loaded. */
const IMPACT_VERSION = 2;
const impactVersion = (proposal: ValopayRecord) =>
  proposal.data.impactVersion === IMPACT_VERSION ? IMPACT_VERSION : 1;
function impactDigestOf(affected: ValopayRecord[], version: number) {
  return digest(
    version === 1
      ? affected
      : affected.map((r) =>
          r.kind === "closes" || r.kind === "close-reviews" ? listed(r) : r,
        ),
  );
}
/** The records a correction touches: the target's financial dependents, and
 * the closes and close reviews recorded up to the comparison time. A close
 * recorded after a proposal contains the same uncorrected value but does not
 * change what approval does, so it does not invalidate the proposal. */
function affectedRecords(state: DomainState, target: ValopayRecord, asOf: string) {
  const customerId =
    target.kind === "customers" ? target.id : target.customerId;
  const recordedBy = (r: ValopayRecord) =>
    Date.parse(r.createdAt) <= Date.parse(asOf);
  return state.records
    .filter(
      (r) =>
        r.id !== target.id &&
        (((r.kind === "closes" || r.kind === "close-reviews") &&
          recordedBy(r)) ||
          (financialKinds.has(r.kind) &&
            ((r.customerId === customerId && !!customerId) ||
              [
                r.data.dueItemId,
                r.data.linkedRecordId,
                r.data.originalDueItemId,
              ].includes(target.id)))),
    )
    .sort((a, b) => legacyCollatedCompare(a.id, b.id));
}
function calculate(
  state: DomainState,
  ctx: Context,
  raw: ImportCorrectionPreviewInput,
  asOf = ctx.now,
  role = ctx.role,
  version = IMPACT_VERSION,
) {
  const input = importCorrectionPreviewInputSchema.parse(raw),
    batch = ownedBatch(state, input.batchId),
    target = ownedTarget(state, batch, input.targetId);
  if (target.updatedAt !== input.expectedUpdatedAt)
    refuse(
      changedText("record"),
    );
  assertNoRealBankDetails(input.changes);
  const after = structuredClone(target),
    differences: Array<{
      field: "name" | "phoneMasked" | "amountKobo" | "dueDate";
      before: string | number | null;
      after: string | number;
    }> = [],
    blockers: string[] = [];
  const supported =
    target.kind === "customers"
      ? ["name", "phoneMasked"]
      : target.kind === "due-items"
        ? ["amountKobo", "dueDate"]
        : [];
  if (!supported.length)
    blockers.push(
      "Import corrections can change only customers and unpaid instalments. For other records, use their own actions, such as Resolve exception.",
    );
  for (const [field, value] of Object.entries(input.changes)) {
    if (!supported.includes(field)) {
      blockers.push(`${importFieldLabel(target.kind, field)} cannot be changed through an import correction.`);
      continue;
    }
    const before =
      field === "name"
        ? target.name
        : field === "amountKobo"
          ? target.amountKobo
          : (target.data[field] ?? null);
    if (before === value) continue;
    differences.push({ field: field as any, before, after: value! });
    if (field === "name") after.name = String(value);
    else if (field === "amountKobo") after.amountKobo = Number(value);
    else after.data[field] = value;
  }
  if (!differences.length)
    blockers.push(
      "Enter a value different from the one imported.",
    );
  const financial = target.kind === "due-items",
    affected = affectedRecords(state, target, asOf);
  if (financial) {
    if (
      target.status !== "scheduled" ||
      target.data.outstandingKobo !== target.amountKobo
    )
      blockers.push(
        "Only an unpaid scheduled instalment with its full amount outstanding can be corrected.",
      );
    if (affected.some((r) => financialKinds.has(r.kind)))
      blockers.push(
        "An import correction cannot change an instalment once its customer has any payment or collection history, including customer messages. You can see that history in Customer history.",
      );
    if (target.data.experimentId || target.data.firstFailureAt)
      blockers.push(
        "An instalment in a retry experiment cannot be corrected here.",
      );
    after.data.outstandingKobo = after.amountKobo;
  }
  if (!blockers.length) {
    try {
      // Checked with the proposer's authority, as their own direct edit would be, whoever views or decides it.
      validateRecord(state, { ...ctx, role }, target.kind, after, true);
    } catch (error) {
      blockers.push(
        error instanceof Error
          ? error.message
          : "The corrected record is not valid.",
      );
    }
  }
  const affectedView = affected.map(listed);
  const impactDigest = impactDigestOf(affected, version),
    previewDigest = digest({
      batchId: batch.id,
      before: target,
      after,
      impactDigest,
    });
  // The comparison is an answer: a mismatch is the service's 500 (response.invalid), never the request's 400.
  const preview = contractAnswer(importCorrectionPreviewSchema, {
    merchantId: state.merchant.id,
    batchId: batch.id,
    targetId: target.id,
    targetKind: target.kind,
    source: target.data.importIdentity.source,
    rowId: target.data.importIdentity.rowId,
    targetUpdatedAt: target.updatedAt,
    financial,
    previewDigest,
    differences,
    affected: affectedView,
    blockers,
    consequence:
      "Approving changes only the current record. The imported file, its source row IDs and the before-and-after evidence stay as they are. A close approved before this comparison must be prepared again; a close recorded after it does not change the comparison.",
  });
  return { input, batch, target, after, impactDigest, preview };
}
export function previewImportCorrection(
  state: DomainState,
  ctx: Context,
  input: ImportCorrectionPreviewInput,
) {
  writer(ctx);
  return calculate(state, ctx, input).preview;
}
function proposalOf(state: DomainState, id: string) {
  return (
    state.records.find(
      (r) =>
        r.id === id &&
        r.kind === "import-corrections" &&
        r.merchantId === state.merchant.id,
    ) || refuse(notFoundText("import correction"), 404)
  );
}
function decisionOf(state: DomainState, id: string) {
  return state.records.find(
    (r) => r.merchantId === state.merchant.id && r.kind === "import-correction-events" && r.data.proposalId === id && ["approve", "reject", "withdraw"].includes(r.data.action),
  );
}
/** A saved proposal's comparison made again now, with its proposer's role and
 * the impact rule it was saved with: the view, the decision and the save all
 * judge it by this. */
export function importCorrectionComparison(
  state: DomainState,
  ctx: Context,
  proposal: ValopayRecord,
) {
  return calculate(
    state,
    ctx,
    proposal.data.input,
    proposal.createdAt,
    proposerRole(proposal),
    impactVersion(proposal),
  );
}
export const inconsistentAssignment =
  "This correction’s assignment history is inconsistent. Ask an Admin to investigate.";
/** Reassignment never rewrites the proposal. Follow its versioned event chain
 * as far as it is unambiguous: `consistent` is false where it forks, breaks or
 * leaves events off the chain, which only bad data does. A read shows that one
 * proposal as far as its history agrees; a decision refuses it. */
export function followImportCorrectionAssignment(state: DomainState, proposal: ValopayRecord) {
  const events = state.records.filter(r => r.merchantId === state.merchant.id && r.kind === "import-correction-events" && r.data.proposalId === proposal.id && r.data.action === "reassign");
  let reviewer = String(proposal.data.reviewer), eventId: string | null = null, updatedAt = proposal.createdAt;
  const history: Array<{ id: string; fromReviewer: string; reviewer: string; actor: string; reason: string; at: string }> = [];
  while (history.length < events.length) {
    const next = events.filter(r => r.data.previousAssignmentEventId === eventId);
    if (next.length !== 1 || next[0]!.data.fromReviewer !== reviewer || next[0]!.data.proposalDigest !== proposal.data.proposalDigest || history.some(r => r.id === next[0]!.id))
      return { reviewer, eventId, updatedAt, history, consistent: false };
    const event = next[0]!;
    history.push({ id: event.id, fromReviewer: reviewer, reviewer: event.data.reviewer, actor: event.data.actor, reason: event.data.reason, at: event.createdAt });
    reviewer = event.data.reviewer; eventId = event.id; updatedAt = event.createdAt;
  }
  return { reviewer, eventId, updatedAt, history, consistent: true };
}
/** The current assignment for a decision or reassignment: ambiguous history fails closed. */
export function importCorrectionAssignment(state: DomainState, proposal: ValopayRecord) {
  const { consistent, ...assignment } = followImportCorrectionAssignment(state, proposal);
  if (!consistent) refuse(inconsistentAssignment);
  return assignment;
}
export function importCorrectionView(
  state: DomainState,
  ctx: Context,
  proposal: ValopayRecord,
  assignment = followImportCorrectionAssignment(state, proposal),
) {
  const decision = decisionOf(state, proposal.id);
  let current = false;
  // A decided proposal is never current, so it is not compared again.
  if (!decision)
    try {
      const comparison = importCorrectionComparison(state, ctx, proposal).preview;
      current = comparison.blockers.length === 0 && comparison.previewDigest === proposal.data.preview.previewDigest;
    } catch {
      /* changed source or dependencies */
    }
  return contractAnswer(importCorrectionViewSchema, {
    id: proposal.id,
    merchantId: state.merchant.id,
    createdAt: proposal.createdAt,
    proposedBy: proposal.data.proposedBy,
    proposedPrincipal: proposal.data.proposedPrincipal,
    reviewer: assignment.reviewer,
    originalReviewer: proposal.data.reviewer,
    assignmentEventId: assignment.eventId,
    assignmentUpdatedAt: assignment.updatedAt,
    assignmentHistory: assignment.history,
    reason: proposal.data.reason,
    evidence: proposal.data.evidence,
    proposalDigest: proposal.data.proposalDigest,
    status: decision
      ? decision.data.action === "approve"
        ? "approved"
        : decision.data.action === "withdraw"
          ? "withdrawn"
          : "rejected"
      : "awaiting_review",
    current,
    preview: proposal.data.preview,
    decision: decision
      ? {
          id: decision.id,
          action: decision.data.action,
          actor: decision.data.actor,
          principalId: decision.data.principalId,
          reason: decision.data.reason,
          at: decision.createdAt,
        }
      : null,
  });
}
export function listImportCorrections(
  state: DomainState,
  ctx: Context,
  batchId: string,
) {
  const batch = ownedBatch(state, batchId);
  return {
    batchId,
    actor: ctx.actor,
    ownPrincipal: principal(ctx),
    role: ctx.role,
    targets: state.records
      .filter(
        (r) =>
          r.data.importIdentity?.batchId === batch.id &&
          r.merchantId === state.merchant.id,
      )
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        reference: r.reference,
        updatedAt: r.updatedAt,
        rowId: r.data.importIdentity.rowId,
        amountKobo: r.amountKobo,
        dueDate: r.data.dueDate || null,
        phoneMasked: r.data.phoneMasked || "",
        supported: ["customers", "due-items"].includes(r.kind),
        status: r.status,
      })),
    proposals: state.records
      .filter(
        (r) => r.merchantId === state.merchant.id && r.kind === "import-corrections" && r.data.batchId === batchId,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => importCorrectionView(state, ctx, r)),
    syntheticOnly: true as const,
  };
}
export function proposeImportCorrection(
  state: DomainState,
  ctx: Context,
  raw: ImportCorrectionProposalInput,
  reviewers: Array<{ actor: string; role: string }>,
) {
  writer(ctx);
  const input = importCorrectionProposalInputSchema.parse(raw);
  const {
    previewDigest: _digest,
    reviewer,
    reason,
    evidence,
    ...previewInput
  } = input;
  const checked = calculate(state, ctx, previewInput);
  if (checked.preview.blockers.length)
    refuse(checked.preview.blockers.join(" "));
  if (input.previewDigest !== checked.preview.previewDigest)
    refuse(
      "The comparison changed. Preview it again before proposing a correction.",
    );
  if (
    input.reviewer === ctx.actor ||
    !reviewers.some((r) => r.actor === input.reviewer && r.role === "Finance")
  )
    refuse(
      "Choose another active Finance reviewer with access to this lender.",
      403,
    );
  if (
    state.records.some(
      (r) =>
        r.kind === "import-corrections" &&
        r.data.targetId === input.targetId &&
        !decisionOf(state, r.id),
    )
  )
    refuse(
      "This record already has an open correction. Review or reject it before proposing another.",
    );
  const data = {
    batchId: input.batchId,
    targetId: input.targetId,
    input: previewInput,
    before: structuredClone(checked.target),
    after: checked.after,
    impactDigest: checked.impactDigest,
    impactVersion: IMPACT_VERSION,
    preview: checked.preview,
    proposedBy: ctx.actor,
    proposedPrincipal: principal(ctx),
    proposedRole: ctx.role,
    reviewer,
    reason,
    evidence,
    synthetic: true,
  };
  const proposal = makeRecord(state, "import-corrections", {
    name: "Proposed import correction",
    status: "recorded",
    createdAt: ctx.now,
    updatedAt: ctx.now,
    data: { ...data, proposalDigest: digest(data) },
  });
  return importCorrectionView(state, ctx, proposal);
}
/** Recover an unavailable reviewer without changing evidence or granting the administrator approval authority. */
export function reassignImportCorrection(
  state: DomainState, ctx: Context, id: string, raw: ImportCorrectionRecoveryInput,
  reviewers: Array<{ actor: string; role: string }>,
) {
  if (ctx.role !== "Admin") refuse(roleRefusal(ctx, ["Admin"], "reassign an import correction"), 403);
  const input = importCorrectionRecoveryInputSchema.parse(raw), proposal = proposalOf(state, id);
  if (decisionOf(state, id)) refuse("This correction already has a decision. Its history is kept.");
  const assignment = importCorrectionAssignment(state, proposal);
  if (input.proposalDigest !== proposal.data.proposalDigest || input.expectedAssignmentEventId !== assignment.eventId)
    refuse("This correction or its reviewer changed after you opened it. Reload the page and try again.");
  if (input.reviewer === assignment.reviewer) refuse("Choose a different active Finance reviewer.");
  // The proposer's principal is a digest of their identity, never an actor: the decision compares it.
  if (input.reviewer === proposal.data.proposedBy || !reviewers.some(r => r.actor === input.reviewer && r.role === "Finance"))
    refuse("Choose another active Finance reviewer with access to this lender, who did not propose it.", 403);
  // A demo persona is the same browser person as the proposer, so it could never decide, as for a close review.
  if (input.reviewer.startsWith("Sandbox ")) refuse("Choose a staff Finance reviewer. Switching demo roles is not a second person.", 403);
  makeRecord(state, "import-correction-events", {
    name: "Import correction reviewer reassigned", status: "recorded", createdAt: ctx.now, updatedAt: ctx.now,
    data: { proposalId: id, targetId: proposal.data.targetId, batchId: proposal.data.batchId, proposalDigest: proposal.data.proposalDigest,
      action: "reassign", actor: ctx.actor, principalId: principal(ctx), reason: input.reason,
      previousAssignmentEventId: assignment.eventId, fromReviewer: assignment.reviewer, reviewer: input.reviewer, synthetic: true },
  });
  return importCorrectionView(state, ctx, proposal);
}
export function decideImportCorrection(
  state: DomainState,
  ctx: Context,
  id: string,
  raw: ImportCorrectionDecisionInput,
  reviewers: Array<{ actor: string; role: string }>,
) {
  const input = importCorrectionDecisionInputSchema.parse(raw),
    proposal = proposalOf(state, id);
  if (input.proposalDigest !== proposal.data.proposalDigest)
    refuse(
      changedText("correction"),
    );
  if (decisionOf(state, id))
    refuse("This correction already has a decision. Its history is kept.");
  const assignment = importCorrectionAssignment(state, proposal);
  if ((input.assignmentEventId ?? null) !== assignment.eventId)
    refuse("This correction was reassigned. Reload the page to see its current reviewer.");
  if (input.action === "withdraw") {
    writer(ctx);
    if (principal(ctx) !== proposal.data.proposedPrincipal)
      refuse("Only the person who proposed this correction can withdraw it.", 403);
  } else {
    if (
      ctx.role !== "Finance" ||
      ctx.actor !== assignment.reviewer ||
      !reviewers.some((r) => r.actor === ctx.actor && r.role === "Finance")
    )
      refuse(
        "Only the named Finance reviewer can decide this correction.",
        403,
      );
    if (
      principal(ctx) === proposal.data.proposedPrincipal ||
      ctx.actor === proposal.data.proposedBy
    )
      refuse(
        `A different person must review this correction.${demoRolesNote(ctx.accessMode)}`,
        403,
      );
  }
  if (input.action === "approve") {
    const checked = importCorrectionComparison(state, ctx, proposal);
    if (
      checked.preview.blockers.length ||
      checked.preview.previewDigest !== proposal.data.preview.previewDigest
    )
      refuse(
        "The record, or the evidence it affects, changed. Reject this proposal and propose the correction again.",
      );
    Object.assign(checked.target, structuredClone(proposal.data.after), {
      updatedAt: ctx.now,
    });
  }
  makeRecord(state, "import-correction-events", {
    name:
      input.action === "approve"
        ? "Import correction approved"
        : input.action === "withdraw"
          ? "Import correction withdrawn"
          : "Import correction rejected",
    status: "recorded",
    createdAt: ctx.now,
    updatedAt: ctx.now,
    data: {
      proposalId: id,
      targetId: proposal.data.targetId,
      batchId: proposal.data.batchId,
      proposalDigest: proposal.data.proposalDigest,
      action: input.action,
      assignmentEventId: assignment.eventId,
      actor: ctx.actor,
      principalId: principal(ctx),
      reason: input.reason,
      synthetic: true,
    },
  });
  return importCorrectionView(state, ctx, proposal);
}

/** Only a newly appended independent approval permits a controlled imported-field change to a batch-imported record. */
export function assertImportedCorrectionChange(
  before: ValopayRecord,
  after: ValopayRecord,
  snapshot: DomainState,
  state: DomainState,
) {
  if (!fromImportBatch(before)) return;
  const changed =
    before.kind === "customers"
      ? before.name !== after.name ||
        before.data.phoneMasked !== after.data.phoneMasked
      : before.kind === "due-items"
        ? before.amountKobo !== after.amountKobo ||
          before.data.dueDate !== after.data.dueDate
        : false;
  if (!changed) return;
  const event = state.records.find(
    (r) =>
      r.kind === "import-correction-events" &&
      r.data.action === "approve" &&
      r.data.targetId === before.id &&
      !snapshot.records.some((old) => old.id === r.id),
  );
  const proposal =
    event &&
    snapshot.records.find(
      (r) => r.id === event.data.proposalId && r.kind === "import-corrections",
    );
  if (
    !proposal ||
    decisionOf(snapshot, proposal.id) ||
    proposal.data.proposedPrincipal === event!.data.principalId ||
    importCorrectionAssignment(snapshot, proposal).reviewer !== event!.data.actor ||
    importCorrectionAssignment(snapshot, proposal).eventId !== (event!.data.assignmentEventId ?? null) ||
    proposal.data.proposalDigest !== event!.data.proposalDigest ||
    !sameJson(proposal.data.before, before) ||
    !sameJson({ ...proposal.data.after, updatedAt: after.updatedAt }, after)
  )
    refuse(
      "Imported details change only through an import correction that a different person approves.",
    );
  const { proposalDigest, ...evidence } = proposal.data;
  if (digest(evidence) !== proposalDigest)
    refuse("This correction’s saved evidence has changed, so it cannot be used. Reject it and propose the correction again.");
  const checked = importCorrectionComparison(
    snapshot,
    {
      actor: event!.data.actor,
      principalId: event!.data.principalId,
      role: "Finance",
      now: after.updatedAt,
    },
    proposal,
  );
  if (
    checked.preview.blockers.length ||
    checked.preview.previewDigest !== proposal.data.preview.previewDigest ||
    !sameJson(checked.after, proposal.data.after) ||
    impactDigestOf(
      affectedRecords(state, before, proposal.createdAt),
      impactVersion(proposal),
    ) !== proposal.data.impactDigest
  )
    refuse("Records this correction depends on have changed. Propose the correction again.");
}
/** Generic record editing cannot bypass the source amendment review of a batch-imported record (fromImportBatch). */
export function assertNoDirectImportedCorrection(
  before: ValopayRecord,
  after: ValopayRecord,
) {
  if (!fromImportBatch(before)) return;
  // PATCH adds these envelope values itself; neither is a requested source amendment.
  const normalised = {
    ...after,
    updatedAt: before.updatedAt,
    data: { ...after.data, synthetic: before.data.synthetic },
  };
  if (!sameJson(before, normalised))
    refuse(
      "Imported records cannot be edited directly. To correct a customer or an unpaid instalment, open its import batch and propose a correction. A different Finance team member must review it. For other changes, use the record’s own actions. The original import stays as it was.",
    );
}
