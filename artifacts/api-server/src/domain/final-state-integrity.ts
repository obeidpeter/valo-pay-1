import { observationEventKey, sameJson, sumMoney } from '@workspace/valopay-schema';
import type { DomainState, ValopayRecord } from './types';
import { assertImportedCorrectionChange } from './import-corrections';
import { exceptionCurrency } from './reconciliation-exceptions';
import { exceptionDecisionChanged, exceptionReviewSubjectChanged } from './exception-integrity';
import { assertProviderEventChange } from './provider-event-integrity';

/** Pure final-state validation; persistence supplies the trusted loaded snapshot. */
const conflict = (message: string): never => {
  throw Object.assign(new Error(message), { status: 409 });
};

function reference(record: ValopayRecord, id: unknown, kind: string, label: string, all: Map<string, ValopayRecord>): ValopayRecord {
  const recordId = typeof id === "string" && id ? id : conflict(`${label} is required.`);
  const target = all.get(recordId) ?? conflict(`${label} must reference a ${kind} in this lender.`);
  if (target.kind !== kind || target.merchantId !== record.merchantId) conflict(`${label} must reference a ${kind} in this lender.`);
  return target;
}
/** Pure guard exported for focused repository guard tests. */
function isExportRetry(before: ValopayRecord, after: ValopayRecord, now?: string): boolean {
  const expired = before.status === "running" && !!now && (!before.data.leaseExpiresAt || Date.parse(String(before.data.leaseExpiresAt)) <= Date.parse(now));
  if (after.status !== "queued" || !(before.status === "failed" || expired)) return false;
  const cleared = ["leaseToken", "leaseExpiresAt", "lastError"];
  if (cleared.some(key => after.data[key] !== undefined)) return false;
  if (after.data.stage !== 'queued' || after.data.lastProgressAt !== now) return false;
  const stableData = (record: ValopayRecord) => Object.fromEntries(Object.entries(record.data).filter(([key]) => ![...cleared, 'stage', 'lastProgressAt'].includes(key)));
  // A retry cannot change the request, private object identity, attempts,
  // checksum, customer or any prior evidence; it only clears the old lease/error.
  return sameJson({ ...after, status: before.status, updatedAt: before.updatedAt, data: stableData(after) }, { ...before, data: stableData(before) });
}

/**
 * The one change of a recorded payer the repository accepts: Finance's
 * identification withdrawn, back to no payer, while nothing of the payment is
 * applied and with the identification kept in its history
 * (withdrawPayerIdentification). A payer the evidence named never changes,
 * including one that evidence resolved to the payment since names.
 */
function payerWithdrawn(before: ValopayRecord, after: ValopayRecord, final: ReadonlyMap<string, ValopayRecord>): boolean {
  const identification = before.data.payerIdentification;
  if (after.customerId !== "" || !identification || identification.customerId !== before.customerId || after.data.payerIdentification !== undefined || Number(after.data.allocatedKobo || 0) !== 0) return false;
  const history: unknown[] = Array.isArray(after.data.payerIdentificationHistory) ? after.data.payerIdentificationHistory : [];
  if (!history.some((entry: any) => entry?.customerId === identification.customerId && entry?.allocationId === identification.allocationId)) return false;
  for (const record of final.values()) {
    if (record.kind === "allocations" && record.status === "confirmed" && record.data.paymentId === after.id) return false;
    if (record.kind === "observations" && record.status === "resolved" && record.data.paymentId === after.id && record.customerId === identification.customerId) return false;
  }
  return true;
}
/** A match taken out of use keeps the payer it was applied for once the payment's history shows that identification withdrawn. */
const withdrawnPayerOf = (allocation: ValopayRecord, payment: ValopayRecord): boolean => allocation.status === "superseded"
  && Array.isArray(payment.data.payerIdentificationHistory) && payment.data.payerIdentificationHistory.some((entry: any) => entry?.customerId === allocation.customerId);

/**
 * The repository's final-state checks. `unchanged` names records whose JSON is
 * identical to the loaded snapshot: they passed these checks when they were
 * written, so only added and changed records are compared field by field.
 */
export function assertFinalState(snapshot: DomainState, state: DomainState, merchantId: string, now?: string, unchanged: ReadonlySet<string> = new Set()) {
  if (state.merchant.id !== merchantId || snapshot.merchant.id !== merchantId) conflict("Lender identity cannot be reassigned.");
  const final = new Map<string, ValopayRecord>();
  for (const record of state.records) {
    if (final.has(record.id)) conflict("Duplicate record IDs are not permitted.");
    if (record.merchantId !== merchantId) conflict("Records cannot be moved between lenders.");
    if (!Number.isSafeInteger(record.amountKobo) || record.amountKobo < 0 || record.amountKobo > Number.MAX_SAFE_INTEGER) conflict("Amounts must be safe non-negative integer kobo.");
    if (record.kind === "due-items" && record.amountKobo < 500000) conflict("Debits under ₦5,000 are refused.");
    final.set(record.id, record);
  }
  const original = new Map(snapshot.records.map((record) => [record.id, record]));
  for (const [id, before] of original) {
    const after = final.get(id);
    const present = after ?? conflict("Records cannot be deleted.");
    if (unchanged.has(id)) continue;
    if (present.id !== before.id || present.merchantId !== before.merchantId || present.kind !== before.kind || present.createdAt !== before.createdAt) {
      conflict("Record identity, lender, kind, and creation time are immutable.");
    }
    // A payment's payer, once its evidence named one or Finance identified it, is never reassigned; Finance's identification may only be withdrawn (payerWithdrawn).
    if (before.kind === "payments" && before.customerId && present.customerId !== before.customerId && !payerWithdrawn(before, present, final)) conflict("A payment's payer cannot change once it is recorded.");
    const retentionChange=()=>{
      const kind=before.kind==='exports'?'export_file':'raw_csv';
      const receipt=[...final.values()].find(r=>r.kind==='retention-receipts'&&!original.has(r.id)&&r.data.sourceId===before.id&&r.data.kind===kind&&['deleted','already_absent'].includes(r.data.result));
      const run=receipt&&original.get(receipt.data.runId);
      if(!run||run.kind!=='retention-runs'||!['approved','running','attention'].includes(run.status)||!run.data.candidates.some((c:any)=>c.sourceId===before.id&&c.kind===kind&&c.version===before.updatedAt))return false;
      const expected=structuredClone(before);expected.updatedAt=present.updatedAt;
      if(kind==='raw_csv'){delete expected.data.csv;if(expected.data.check)delete expected.data.check.preview;expected.data.rawCsvRemovedAt=now;expected.data.rawCsvRetentionRunId=run.id;}
      else {expected.data.fileDeletedAt=now;expected.data.fileRetentionRunId=run.id;}
      return sameJson(expected,present);
    };
    if (["audit", "exports", "reviews", "closes", "retry-decisions", "invoices", "connected-credit-assessments", "connected-credit-reviews", "case-events", "import-revisions", "import-corrections", "import-correction-events", "source-manifests", "close-review-events", "work-events", "retention-policies", "retention-holds", "retention-receipts"].includes(before.kind) && !sameJson(present, before)
      && !(before.kind === "exports" && (isExportRetry(before, present, now)||retentionChange()))) conflict("Evidence records are immutable.");
    if (["policies", "templates", "experiments"].includes(before.kind) && ["approved", "preregistered", "closed"].includes(before.status) && !sameJson(present, before)) {
      conflict("Approved, preregistered, and closed versions are immutable.");
    }
    if (before.kind === 'provider-events') assertProviderEventChange(before,present);
    if (exceptionReviewSubjectChanged(before, present, original.get(before.data.linkedRecordId))) conflict('The subject of a historical evidence review is immutable.');
    if (before.kind === 'settlement-batches' && before.data.providerIdentityReview !== undefined && !sameJson(before.data.providerIdentityReview, present.data.providerIdentityReview)) conflict('A recorded settlement provider review snapshot is immutable.');
    if (before.kind === 'settlement-batches' && before.data.providerIdentityKey !== undefined
      && (before.reference !== present.reference || ['batchReference', 'provider', 'providerConnection', 'providerIdentityKey'].some(key => !sameJson(before.data[key], present.data[key])))) conflict('A recorded settlement provider identity is immutable.');
    // A legacy exception can acquire only the currency its original linked money already had; it cannot change the decision's monetary meaning.
    const derivedCurrency = before.kind === 'exceptions' && !before.data.currency && present.data.currency
      ? exceptionCurrency(before, (kind, id) => { const record = original.get(id); return record?.kind === kind ? record : undefined; }) : undefined;
    if (exceptionDecisionChanged(before, present, derivedCurrency)) conflict('A completed exception decision and its recorded attribution are immutable. Record a new review instead.');
    if (before.kind === 'source-profiles' && ['source','kind'].some(key=>!sameJson(before.data[key],present.data[key]))) conflict('A source profile cannot change its source or record type.');
    if (before.kind === 'import-batches' && before.status === 'committed' && !sameJson(present, before)&&!retentionChange()) conflict('Committed source batches are immutable.');
    if(before.kind==='close-reviews'&&!sameJson(present,before)){
      const expected=structuredClone(before);expected.status=present.status;expected.updatedAt=present.updatedAt;
      if (before.status === 'awaiting_review' && present.status === 'awaiting_review') {
        expected.data.reviewer = present.data.reviewer;
        const evidence = state.records.some(event => !original.has(event.id) && event.kind === 'close-review-events' && event.status === 'recorded'
          && event.data.action === 'reassign' && event.data.reviewId === before.id && event.data.closeId === before.data.closeId
          && event.data.previousReviewer === before.data.reviewer && event.data.reviewer === present.data.reviewer
          && event.data.snapshotDigest === before.data.snapshotDigest && typeof event.data.note === 'string' && event.data.note.trim().length >= 10);
        if (before.data.reviewer === present.data.reviewer || !evidence || !sameJson(expected, present)) conflict('Reassignments must retain the prepared snapshot and append their reason to the review history.');
      } else {
        for(const field of ['decidedBy','decidedPrincipal','decidedAt','decisionNote','sourceExceptions'])expected.data[field]=present.data[field];
        if(before.status!=='awaiting_review'||!['approved','changes_requested'].includes(present.status)||!sameJson(expected,present))conflict('The prepared close snapshot and recorded decision are immutable.');
      }
    }
    if(before.kind==='retention-runs'&&['candidates','previewDigest','policyRevision','expiresAt','preparedBy'].some(key=>!sameJson(before.data[key],present.data[key])))conflict('The approved retention manifest is immutable.');
    if (before.data.importIdentity && !sameJson(present.data.importIdentity, before.data.importIdentity)) conflict('Source row provenance is immutable.');
    assertImportedCorrectionChange(before, present, snapshot, state);
  }
  const dueReferences = new Set<string>(), customerReferences = new Set<string>(), observations = new Set<string>(), inflight = new Set<string>();
  const allocatedPayments = new Map<string, number>(), allocatedDues = new Map<string, number>();
  const changed = (record: ValopayRecord, ...keys: string[]) => {
    if (unchanged.has(record.id)) return false;
    const before = original.get(record.id);
    return !before || keys.some((key) => !sameJson(before.data[key], record.data[key]));
  };
  const changedCustomer = (record: ValopayRecord) => {
    if (unchanged.has(record.id)) return false;
    const before = original.get(record.id);
    return !before || before.customerId !== record.customerId;
  };
  const optionalReference = (record: ValopayRecord, key: string, kind: string, label: string) => {
    if (record.data[key] !== undefined && record.data[key] !== null && record.data[key] !== "" && changed(record, key)) {
      return reference(record, record.data[key], kind, label, final);
    }
    return undefined;
  };
  const anyReference = (record: ValopayRecord, key: string, label: string) => {
    if (record.data[key] === undefined || record.data[key] === null || record.data[key] === "" || !changed(record, key)) return;
    const target = final.get(String(record.data[key]));
    if (!target || target.merchantId !== record.merchantId) conflict(`${label} must belong to this lender.`);
  };
  for (const record of final.values()) {
    if (record.kind === 'customers' && record.reference) {
      if (customerReferences.has(record.reference)) conflict('Customer references must be unique within a lender.');
      customerReferences.add(record.reference);
    }
    if (record.customerId && changedCustomer(record)) reference(record, record.customerId, "customers", "Customer", final);
    // Shared data links are verified only when a new/changed state introduces
    // them; this protects writes without reinterpreting historical snapshots.
    optionalReference(record, "policyId", "policies", "Policy");
    optionalReference(record, "mandateId", "mandates", "Mandate");
    optionalReference(record, "dueItemId", "due-items", "Due item");
    optionalReference(record, "paymentId", "payments", "Payment");
    optionalReference(record, "noticeId", "notifications", "Notice");
    optionalReference(record, "experimentId", "experiments", "Experiment");
    optionalReference(record, "proposedDueItemId", "due-items", "Proposed due item");
    optionalReference(record, "virtualAccountCustomerId", "customers", "Virtual-account customer");
    optionalReference(record, "settlementBatchId", "settlement-batches", "Settlement batch");
    optionalReference(record, "countedInBatchId", "settlement-batches", "Settlement batch counting the line");
    optionalReference(record, "statementObservationId", "observations", "Statement observation");
    anyReference(record, "linkedRecordId", "Exception link");
    if (record.data.lineObservationIds !== undefined && changed(record, "lineObservationIds")) {
      if (!Array.isArray(record.data.lineObservationIds)) conflict("Settlement batch observation IDs must be an array.");
      for (const id of record.data.lineObservationIds) reference(record, id, "observations", "Settlement batch observation", final);
    }
    if (record.data.otherCurrencyLineIds !== undefined && changed(record, "otherCurrencyLineIds")) {
      if (!Array.isArray(record.data.otherCurrencyLineIds)) conflict("Settlement batch lines in another currency must be an array.");
      for (const id of record.data.otherCurrencyLineIds) reference(record, id, "observations", "Settlement batch line in another currency", final);
    }
    if (record.kind === "due-items") {
      if (record.reference) { if (dueReferences.has(record.reference)) conflict("Due-item reference already exists."); dueReferences.add(record.reference); }
      const mandate = optionalReference(record, "mandateId", "mandates", "Due-item mandate")
        || (changedCustomer(record) && record.data.mandateId ? reference(record, record.data.mandateId, "mandates", "Due-item mandate", final) : undefined);
      if (mandate && mandate.customerId !== record.customerId) conflict("Due-item mandate must belong to the same customer.");
      const outstanding = record.data.outstandingKobo;
      if (outstanding !== undefined && (!Number.isSafeInteger(outstanding) || outstanding < 0 || outstanding > record.amountKobo)) conflict("Outstanding balance is invalid.");
    }
    if (record.kind === "attempts") {
      // Attempts are facts, so their required parent remains checked on every
      // save.  This also permits the in-flight uniqueness calculation below.
      const due = reference(record, record.data.dueItemId, "due-items", "Attempt due item", final);
      const before = original.get(record.id);
      if ((!before || changed(record, "dueItemId") || changedCustomer(record) || before.amountKobo !== record.amountKobo)
        && (due.customerId !== record.customerId || record.amountKobo !== due.amountKobo)) {
        conflict("Attempt must match its due item and customer.");
      }
      if (["scheduled", "sent", "unknown"].includes(record.status)) {
        if (inflight.has(due.id)) conflict("Only one in-flight attempt is allowed for a due item.");
        inflight.add(due.id);
      }
    }
    if (record.kind === "observations") {
      const due = optionalReference(record, "dueItemId", "due-items", "Observation due item")
        || (changedCustomer(record) && record.data.dueItemId ? reference(record, record.data.dueItemId, "due-items", "Observation due item", final) : undefined);
      if (due && record.customerId && due.customerId !== record.customerId) conflict("Observation due item must belong to its customer.");
      if (record.data.eventId !== undefined && record.data.eventId !== null) {
        const key = observationEventKey(record.data)!;
        if (observations.has(key)) conflict("Observation already exists for this source event.");
        observations.add(key);
      }
    }
    if (record.kind === "payments") {
      const due = optionalReference(record, "dueItemId", "due-items", "Payment due item")
        || optionalReference(record, "proposedDueItemId", "due-items", "Proposed due item")
        || (changedCustomer(record) && record.data.dueItemId ? reference(record, record.data.dueItemId, "due-items", "Payment due item", final) : undefined)
        || (changedCustomer(record) && record.data.proposedDueItemId ? reference(record, record.data.proposedDueItemId, "due-items", "Proposed due item", final) : undefined);
      if (due && record.customerId && due.customerId !== record.customerId) conflict("Payment due item must belong to its customer.");
    }
    if (record.kind === "allocations") {
      // Every allocation status carries durable parent IDs; confirmed rows add
      // the final-state amount constraints below.
      const payment = reference(record, record.data.paymentId, "payments", "Allocation payment", final);
      const due = reference(record, record.data.dueItemId, "due-items", "Allocation due item", final);
      // A superseded allocation applies nothing, such as a proposal withdrawn when Finance identified another payer.
      if (record.status !== "superseded" && payment.customerId && due.customerId && payment.customerId !== due.customerId) conflict("Allocation payment and due item must have the same customer.");
      // A proposal for a payment whose evidence named no payer carries no customer until Finance identifies the payer, and a
      // match taken out of use keeps a payer whose identification was withdrawn (withdrawnPayerOf).
      if (record.customerId && (record.customerId !== due.customerId || (record.customerId !== payment.customerId && !withdrawnPayerOf(record, payment)))) conflict("Allocation customer must match its parents.");
      if (record.status === "confirmed") {
        // Evidence that named no payer is applied only once Finance has identified the payer.
        if (!payment.customerId || record.customerId !== payment.customerId) conflict("A payment is applied to an instalment only once its payer is identified.");
        allocatedPayments.set(payment.id, sumMoney([allocatedPayments.get(payment.id) || 0, record.amountKobo]));
        allocatedDues.set(due.id, sumMoney([allocatedDues.get(due.id) || 0, record.amountKobo]));
      }
    }
  }
  for(const record of final.values()) {
    if(record.kind==='connected-intents' && ['authorised','pending','unknown'].includes(record.status)) {
      const due=reference(record,record.data.dueItemId,'due-items','Checkout instalment',final);
      if(due.customerId!==record.customerId) conflict('Checkout customer must match the instalment.');
      if(inflight.has(due.id)) conflict('A pay-by-bank checkout and another collection cannot be in flight together.');
      inflight.add(due.id);
    }
  }
  for (const [id, amount] of allocatedPayments) if (amount > final.get(id)!.amountKobo) conflict("Allocations exceed the payment amount.");
  for (const [id, amount] of allocatedDues) if (amount > final.get(id)!.amountKobo) conflict("Allocations exceed the due-item amount.");
}

