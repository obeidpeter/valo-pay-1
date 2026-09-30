// Golden (the 23 September 2026 audit, the daily close's cost): two daily
// closes of a lender with many customers, a month-end's evidence (certain and
// probable matches, duplicates, settlement lines, a reversal, aged receipts)
// and future instalments under an approved retry policy (failures, an
// experiment, disputes, unknown outcomes). They must write exactly the records
// the close wrote before its lookups were indexed (the digests were computed by
// the code at c22c229 running this scenario), and their work must grow with the
// records, not with the records times the items a close handles.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";

process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
// Fixed record IDs: the digests cover the records a close makes, and the domain draws their IDs from randomUUID.
const nodeCrypto = createRequire(import.meta.url)("node:crypto") as { randomUUID: () => string };
let issued = 0;
nodeCrypto.randomUUID = () => `00000000-0000-4000-8000-${String(++issued).padStart(12, "0")}`;
syncBuiltinESMExports();

const { workflowFixture, WORKFLOW_NOW } = await import("./workflow-fixture.js");
const { runDailyClose } = await import("../src/domain/actions.js");
import type { DomainState, ValopayRecord } from "../src/domain/types.js";

const DAY = 86_400_000;
const at = WORKFLOW_NOW;
const shifted = (days: number) => new Date(Date.parse(at) + days * DAY).toISOString();

function scenario(customers: number): DomainState {
  // Six settled instalments per customer, and a fresh webhook observation for every fifth customer.
  const state = workflowFixture(customers);
  state.merchant.mode = "instruction";
  state.merchant.preLiveReady = true;
  const provider = state.merchant.provider;
  const add = (kind: string, id: string, fields: Partial<ValopayRecord> & { data: Record<string, any> }): ValopayRecord => {
    const record: ValopayRecord = { id, merchantId: state.merchant.id, kind, name: `Synthetic ${id}`, reference: `SYN-${id}`, customerId: "", status: "active", amountKobo: 0, createdAt: at, updatedAt: at, ...fields, data: { ...fields.data, synthetic: true } };
    state.records.push(record);
    return record;
  };
  const policy = add("policies", "policy-scale", { name: "Standard lender retry policy", status: "approved", data: { version: 1, maxAttempts: 3, spacingHours: 48, firstNoticeHours: 48, retryNoticeHours: 24, partialAllowed: false, author: "Sandbox Admin", reviewer: "Sandbox Compliance reviewer", approvedAt: "2027-06-01T09:00:00.000Z" } });
  add("experiments", "experiment-scale", { status: "preregistered", data: { policyId: policy.id, preregisteredAt: "2027-06-01T00:00:00.000Z", enrolmentClose: "2027-12-31", seed: "scale-seed", holdoutShare: 0.5, baselineRate: 0.4, minPerArm: 100 } });
  const observation = (id: string, customerId: string, amountKobo: number, data: Record<string, any>, reference = `EVIDENCE-${id}`) =>
    add("observations", id, { reference, customerId, status: "unresolved", amountKobo, data: { provider, occurredAt: at, ...data } });
  const attempt = (id: string, due: ValopayRecord, status: string, data: Record<string, any>) =>
    add("attempts", id, { status, customerId: due.customerId, amountKobo: due.amountKobo, data: { dueItemId: due.id, number: 1, source: "external", ...data } });
  for (let c = 0; c < customers; c++) {
    const customerId = `customer-${c}`;
    const mandate = add("mandates", `mandate-${c}`, { customerId, amountKobo: 5_000_000, data: { policyId: policy.id, consentEvidence: `CONSENT-${c}`, consentGaps: [], frequency: "monthly", workflow: "hosted_consent" } });
    // Future instalments under the approved policy: every close evaluates them.
    const future = [1, 2, 3].map((month) => add("due-items", `future-${c}-${month}`, {
      customerId, status: "scheduled", amountKobo: 1_000_000,
      data: { dueDate: shifted(month * 30).slice(0, 10), outstandingKobo: 1_000_000, owner: c % 2 ? "valopay" : "lms", mandateId: mandate.id },
    }));
    if (c % 6 === 1) { attempt(`failed-${c}`, future[1]!, "failed", { failureCode: "INSUFFICIENT_FUNDS", occurredAt: shifted(-1) }); future[1]!.status = "in_collection"; }
    if (c % 12 === 5) { attempt(`disputed-${c}`, future[2]!, "failed", { failureCode: "CUSTOMER_DISPUTED", occurredAt: shifted(-1) }); future[2]!.status = "in_collection"; }
    if (c % 12 === 7) { attempt(`invalid-${c}`, future[2]!, "failed", { failureCode: "INVALID_ACCOUNT", occurredAt: shifted(-1) }); future[2]!.status = "in_collection"; }
    if (c % 30 === 11) { attempt(`unknown-${c}`, future[0]!, "unknown", { failureCode: "TIMEOUT_UNKNOWN", occurredAt: shifted(-2) }); future[0]!.status = "in_collection"; }
    if (c % 30 === 13) { attempt(`unmapped-${c}`, future[0]!, "failed", { failureCode: "UNKNOWN", rawFailureCode: "RX-77", occurredAt: shifted(-1) }); future[0]!.status = "in_collection"; }
    // Evidence with no payer, naming a future instalment: proposed for Finance to confirm the payer.
    if (c % 25 === 8) observation(`payerless-${c}`, "", 1_000_000, { source: "webhook", dueItemId: future[0]!.id }, `PAYERLESS-${c}`);
    // A reversal of a settled history payment.
    if (c % 40 === 3) observation(`reversal-${c}`, customerId, 1_000_000, { source: "webhook", reversed: true }, `SYN-payment-${c}-6`);
    // Money no rule can match, observed three days ago: it ages into an exception.
    if (c % 50 === 9) observation(`aged-${c}`, customerId, 123_456, { source: "transfer", occurredAt: shifted(-3) });
    if (c % 5 === 0) continue;
    // Month-end: every other customer's instalment falls due today with evidence of its payment.
    const due = add("due-items", `pay-${c}`, { customerId, status: "scheduled", amountKobo: 1_000_000, data: { dueDate: at, outstandingKobo: 1_000_000, owner: "lms", mandateId: mandate.id } });
    if (c % 5 === 1) {
      attempt(`scheduled-${c}`, due, "scheduled", { source: "valo", plannedAt: at });
      observation(`webhook-${c}`, customerId, 1_000_000, { source: "webhook", dueItemId: due.id }, `PAY-${c}`);
      if (c % 10 === 1) observation(`again-${c}`, customerId, 1_000_000, { source: "webhook", dueItemId: due.id }, `PAYDUP-${c}`);
      if (c % 15 === 1) observation(`settled-${c}`, customerId, 995_000, { source: "settlement", dueItemId: due.id, grossAmountKobo: 1_000_000, feeKobo: 5_000, batchReference: "BATCH-SCALE" }, `PAY-${c}`);
    } else if (c % 5 === 2) {
      observation(`narration-${c}`, customerId, 1_000_000, { source: "transfer", narration: `Repayment ${due.reference} July` });
      if (c % 10 === 2) observation(`twin-${c}`, customerId, 1_000_000, { source: "transfer", occurredAt: new Date(Date.parse(at) + 60_000).toISOString() });
    } else if (c % 5 === 3) observation(`account-${c}`, customerId, 1_000_000, { source: "transfer", virtualAccountCustomerId: customerId });
    else if (c % 10 === 4) observation(`part-${c}`, customerId, 400_000, { source: "transfer", virtualAccountCustomerId: customerId });
    else observation(`near-${c}`, customerId, 1_000_000, { source: "transfer" });
  }
  const lines = state.records.filter((record) => record.kind === "observations" && record.data.batchReference === "BATCH-SCALE").length;
  add("observations", "statement-scale", { reference: "STMT-SCALE", status: "unresolved", amountKobo: 995_000 * lines, data: { source: "statement", batchReference: "BATCH-SCALE", provider, occurredAt: at } });
  return state;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const byId = (a: ValopayRecord, b: ValopayRecord) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Visits of whole-list scans of the lender's records, counted on the list itself. */
function countScans(state: DomainState): { visits: number; stop: () => void } {
  const counter = { visits: 0, stop: () => { for (const name of ["filter", "find", "some"]) delete (state.records as any)[name]; } };
  for (const name of ["filter", "find", "some"] as const) {
    const original = Array.prototype[name] as (...args: any[]) => any;
    Object.defineProperty(state.records, name, { configurable: true, value(this: ValopayRecord[], ...args: any[]) { counter.visits += this.length; return original.apply(this, args); } });
  }
  return counter;
}

const customers = 150;
const state = scenario(customers);
const records = state.records.length;
const first = countScans(state);
const monthEnd = runDailyClose(state, { now: at, actor: "Sandbox Finance", role: "Finance" }, "manual");
first.stop();
const second = countScans(state);
const nextDay = runDailyClose(state, { now: shifted(1), actor: "Sandbox Finance", role: "Finance" }, "manual");
second.stop();

// The scenario reaches every path the closes' lookups serve, many times over.
const count = (kind: string, test: (record: ValopayRecord) => boolean) => state.records.filter((record) => record.kind === kind && test(record)).length;
assert.deepEqual(monthEnd.data.allocationsByRule, { R1: 66, R4: 30, R2: 30, R3: 15, R5: 15 }, "certain and probable matches by every rule");
assert.equal(monthEnd.record!.data.report.allocated.count, customers * 6 - 4 + 120, "the certain matches are applied: six settled instalments a customer, four reversed, 120 matched");
assert.equal(count("attempts", (attempt) => attempt.status === "cancelled"), 30, "a paid instalment's unsent attempt is cancelled");
assert.equal(count("payments", (payment) => payment.data.reversalApplied === true), 4, "a reversal takes a payment's allocations off");
assert.equal(count("settlement-batches", (batch) => batch.status === "reconciled"), 1, "the settlement lines and the statement credit reconcile the batch");
// The four reversals of applied money each open a customer_dispute exception that owns the instalment they reopen.
assert.deepEqual([monthEnd.data.proposed, monthEnd.data.possibleDuplicates, monthEnd.data.unknownOutcomes, monthEnd.data.exceptionsOpened], [36, 30, 5, 90]);
assert.deepEqual([monthEnd.data.retryDecisionsRecorded, monthEnd.data.finalAttemptExceptions, monthEnd.data.disputesFrozen, monthEnd.data.noticesNotEvidenced], [60, 17, 13, 13], "the retry rules decide the failed instalments");
assert.equal(count("due-items", (due) => typeof due.data.experimentArm === "string"), 25, "failures are enrolled in the experiment");
assert.deepEqual([nextDay.data.retryDecisionsRecorded, nextDay.data.agedUnallocated], [13, 3]);

const outcome = {
  records: digest([state.merchant, state.settings, [...state.records].sort(byId)]),
  monthEnd: digest(monthEnd.data),
  nextDay: digest(nextDay.data),
};
// FIN-03 adds a stable provider-scoped batch identity. Prove that this metadata is the only
// change to this older single-provider scenario before updating its full-record digest.
const beforeProviderIdentity = structuredClone(state.records);
for (const record of beforeProviderIdentity) if (record.kind === "settlement-batches") {
  assert.equal(record.data.providerIdentityKey, JSON.stringify([String(record.data.providerConnection).trim().toLowerCase(), record.reference]));
  delete record.data.providerIdentityKey;
}
assert.equal(digest([state.merchant, state.settings, beforeProviderIdentity.sort(byId)]), "bf1a1d1ba6bd71ea02dfe7b44ddfcb60f9e33820d46133140a60a141952325d3", "only the new provider identity changes the earlier golden records (reworded as the language pass below says)");
if (process.env.VALOPAY_GOLDEN_PRINT === "1") console.log(JSON.stringify({ outcome, records, visits: [first.visits, second.visits] }, null, 2));
/**
 * Computed for this scenario by the code before its lookups were indexed: first at c22c229, then again by the dispute
 * fixes' code without the index, since a reversal of applied money now raises an exception, again with the index
 * switched off once counted text ("1 obligation", "2 obligations") changed the records' wording, and again with the
 * index switched off once a pass read reversal evidence after other evidence (the fixed ids land on other records) and
 * settlement lines recorded the gross they add to their batch, and once a settlement batch recorded its currency, the
 * records' only change, checked by leaving that field out (VALOPAY_GOLDEN_PRINT=1 prints the current values). The
 * language pass then changed only words: exception names from the catalogue ("Possible duplicate", "Outcome unknown"),
 * the owner of a failure code to classify ("Valo Pay team"), money in notes ("₦10,000.00"), a daily close's name and
 * summary ("Daily close 1 Jul 2027", "payment evidence records received", "older than 24 hours"), and the names,
 * explanations, notes, reasons and cancellation reasons reconciliation and the retry rules write ("Payment PSK-1",
 * "Allocation of PSK-1 to DEMO-1", "Retry decision · retry postponed (notice not confirmed)"), and the details of the
 * measurements a close records ("1,016 of 1,089 payments are allocated in full or in part", "Amount still owed on instalments"), checked field by field
 * against the records the earlier code wrote; the close answers' data are unchanged.
 */
const golden = {
  records: "4535eeb7775b836e4cdffc1bbe3f513a6f77bc83d768ef4af2905b6388cc324c",
  monthEnd: "dff97eb6d50336fb650cf48652975f842fd2b85f14df835eb535a7dbb4a35a7d",
  nextDay: "1a88e829ce6bd3940c6a5248e5bbdfddc0a7786480202fc138aca0a834c4a798",
};
assert.deepEqual(outcome, golden, "the closes write exactly the records and answers they wrote before their lookups were indexed");

// A deterministic work budget, not a machine-speed assertion: each close scans the whole list a bounded
// number of times. Before the lookups were indexed, each certain match scanned it four times and each open
// instalment under an approved policy about six, so the month-end close visited about 19 million records here.
for (const [label, visits] of [["month-end", first.visits], ["next-day", second.visits]] as const) {
  assert.ok(visits < records * 200, `the ${label} close visited ${visits} records scanning a list of about ${records}: it grew with the items it handled`);
}
console.log(`Two closes over ${records} records gave the golden records and answers, visiting ${first.visits} and ${second.visits} records.`);
