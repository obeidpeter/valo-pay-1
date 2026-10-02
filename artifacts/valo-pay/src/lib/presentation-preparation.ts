/*
 * Prepare for presentation: the sample work the investor presentation shows, made for the active lender through the
 * requests the console's own pages send, with the same payloads and headers. Sandbox only, never a staff pilot.
 *
 * Each step reads what is there first and writes only what is missing, so pressing the button again adds nothing and
 * a step already done says so. A step that fails records why, in Valo Pay's words, and the steps that do not need it
 * still run. The presenter's demo role is switched where an action needs another role or a different person (in the
 * sandbox each demo role is a different sample person), and is always put back.
 *
 * The order matters. The daily closes run after every step that changes what a close covers (the imports, the case
 * and the checkouts), so the close waiting for review stays current. Credit Desk, Cash Desk and the exports change
 * none of it. No React here: the component (components/presentation-preparation.tsx) shows the progress.
 */
import {
  createExport, getExportJob, getWorkspace, listRecords, performAction, retryExportJob,
  type ActionInput, type ListRecordsParams,
} from '@workspace/api-client-react';
import {
  actionResultSchema, caseDetailSchema, closeReviewDetailSchema, closeReviewHistorySchema, connectedActionResultFor,
  exportResultSchema, valopayRecordSchema, WAT_OFFSET_MS, type BatchInput, type ConnectedActionResult, type ExportResultView, type ValopayRecordView,
} from '@workspace/valopay-schema';
import type { z, ZodTypeAny } from 'zod';
import { batchListSchema } from '@/features/imports/models';
import { answerProblem, INCOMPLETE_CONFIRMATION, readAnswer, UNREADABLE_ANSWER } from './answers';
import { request as connectedRequest, UNCONFIRMED_SAMPLE } from './connected';
import { consoleConnectedViewSchema, type ConnectedView } from './connected-view';
import { formatDate } from './formatters';
import { errorWords, referenceOf } from './notify';
import { lenderPath, pilotReceipt, pilotRequest } from './pilot';
import { PRESENTATION_CUSTOMER, PRESENTATION_INSTALMENT } from './presentation';
import { presentationSamples } from './presenter-brief';

export type PreparationStepId = 'imports' | 'case' | 'pay-by-bank' | 'daily-closes' | 'close-review' | 'credit-desk' | 'cash-desk' | 'exports';
export type PreparationStep = { id: PreparationStepId; label: string; description: string };

/** The steps, in the order they run. */
export const preparationSteps: readonly PreparationStep[] = [
  { id: 'imports', label: 'Import batches', description: 'Import the sample customers and instalments. Save and check the payment file, for you to import live.' },
  { id: 'case', label: 'A case with an owner', description: 'Claim one open exception with a next step and a note. Two others stay unclaimed for you.' },
  { id: 'pay-by-bank', label: 'Pay by Bank checkouts', description: 'Create 3 checkouts: confirmed, waiting for the customer and outcome unknown. Like any checkout, the waiting one expires after 15 minutes.' },
  { id: 'daily-closes', label: 'Daily closes', description: 'Run a daily close for each of the 3 days before today, in WAT.' },
  { id: 'close-review', label: 'Close review', description: 'Submit the latest close for review. It waits for a different person, a Finance team member.' },
  { id: 'credit-desk', label: 'Credit Desk', description: 'Run an assessment that waits for a different person to review it, and one for an applicant who refused permission.' },
  { id: 'cash-desk', label: 'Cash Desk', description: 'Set up Cash Desk with a forecast and a VAT schedule. An accounting draft and a payroll funding plan wait for approval.' },
  { id: 'exports', label: 'Saved exports', description: 'Export a dispute pack (PDF) for Ada Okonkwo and a billing statement (CSV).' },
];

export type PreparationStatus = 'waiting' | 'running' | 'completed' | 'already-done' | 'failed';
/** Each status in the words the steps show. */
export const preparationStatusLabels: Record<PreparationStatus, string> = {
  waiting: 'Waiting', running: 'In progress', completed: 'Completed', 'already-done': 'Already done', failed: 'Failed',
};
export type PreparationProgress = { id: PreparationStepId; status: PreparationStatus; reason?: string };
export type PreparationResult = {
  steps: Array<{ id: PreparationStepId; status: 'completed' | 'already-done' | 'failed'; reason?: string }>;
  failed: number;
  /** The demo role the presenter had when the run started. */
  role: string;
  /** Why the role could not be put back, when it could not. */
  roleProblem?: string;
};

/**
 * Offered, and run, only in the sandbox: never in a staff pilot, whose team members' records are not sample data, nor
 * in a workspace that does not say it is the sandbox.
 */
export function preparationOffered(workspace: { environment?: string; accessMode?: string } | undefined): boolean {
  return workspace?.environment === 'sandbox' && workspace.accessMode === 'sandbox';
}

const SANDBOX_ONLY = 'Prepare for presentation works only in the sandbox, with sample data.';
const STOPPED = 'Preparation stopped because you left the page. Select Prepare for presentation to carry on.';
const MISMATCH = 'Valo Pay’s reply does not match this lender or request. Check Request history before you try again.';
const NO_REASON = 'Valo Pay gave no reason. Try again.';
const TIMEOUT_MS = 25_000;
const DAY_MS = 86_400_000;
const idempotency = () => ({ 'Idempotency-Key': crypto.randomUUID() });
const timeout = () => AbortSignal.timeout(TIMEOUT_MS);
/** The WAT date of an instant, as the service dates its closes and batches. */
const watDay = (instant: string) => new Date(Date.parse(instant) + WAT_OFFSET_MS).toISOString().slice(0, 10);
/** The 3 business dates before today in West Africa Time, oldest first: each gets its own daily close. */
export function closeDates(today: string): string[] {
  return [3, 2, 1].map(days => new Date(Date.parse(`${today}T00:00:00.000Z`) - days * DAY_MS).toISOString().slice(0, 10));
}

type Outcome = 'completed' | 'already-done';
interface Run {
  merchantId: string;
  /** How long an export being prepared is followed before the step stops waiting. */
  exportWaitMs: number;
  /** Stops before the next request once the caller has gone; the role is still put back. */
  checkpoint(): void;
  /** Valo Pay's clock, read once: the dates and follow-up times written are its, not the browser's. */
  now(): Promise<string>;
  /** Makes one of these demo roles current: the presenter's own if it may act, else the current one, else the first. */
  actAs(roles: readonly string[]): Promise<void>;
  role(): string | undefined;
  actor(): string | undefined;
}

/** A failure in Valo Pay's words; a failure of the service itself also gives the request's reference, as the pages do. */
function reasonOf(error: unknown): string {
  const words = errorWords(error, NO_REASON);
  const status = (error as { status?: unknown } | null)?.status;
  const reference = typeof status === 'number' && status >= 500 ? referenceOf(error) : undefined;
  return reference ? `${words} Support reference: ${reference}.` : words;
}

// ---- Requests, as the pages send them ----

/** A pilot read (lib/pilot.ts), scoped to the lender. */
function pilotRead<S extends ZodTypeAny>(run: Run, path: string, schema: S): Promise<z.output<S>> {
  run.checkpoint();
  return pilotRequest(lenderPath(path, run.merchantId), schema);
}
/** A pilot write with its own key, read through the receipt its route answers and checked against this lender and request. */
async function pilotWrite(run: Run, path: string, data: Record<string, unknown>): Promise<ValopayRecordView> {
  run.checkpoint();
  const receipt = pilotReceipt(path);
  if (!receipt) throw answerProblem(INCOMPLETE_CONFIRMATION);
  const answer = await pilotRequest(lenderPath(path, run.merchantId), receipt.schema, { method: 'POST', headers: idempotency(), body: JSON.stringify(data) }, INCOMPLETE_CONFIRMATION);
  if (receipt.matches && !receipt.matches(answer, data, run.merchantId, run.actor())) throw answerProblem(MISMATCH);
  const record = readAnswer(valopayRecordSchema, answer);
  if (!record) throw answerProblem(INCOMPLETE_CONFIRMATION);
  return record;
}
/** The connected workspace as its pages read it (lib/connected.ts). */
async function connectedView(run: Run): Promise<ConnectedView> {
  run.checkpoint();
  const view = readAnswer(consoleConnectedViewSchema, await connectedRequest(`/api/v1/connected?merchantId=${encodeURIComponent(run.merchantId)}`));
  if (!view) throw answerProblem(UNREADABLE_ANSWER);
  return view;
}
/** A connected action naming the workspace's latest revision, read just before it; only the confirmation its action gives counts. */
async function connectedAction(run: Run, action: string, data: Record<string, unknown>, reason: string, recordId?: string): Promise<ConnectedActionResult> {
  const { revision } = await connectedView(run);
  run.checkpoint();
  const answer = await connectedRequest(`/api/v1/connected/actions?merchantId=${encodeURIComponent(run.merchantId)}`, {
    method: 'POST',
    headers: idempotency(),
    body: JSON.stringify({ action, data, ...(recordId ? { recordId } : {}), reason, expectedRevision: revision }),
  });
  const result = readAnswer(connectedActionResultFor(action, run.merchantId), answer);
  if (!result) throw answerProblem(UNCONFIRMED_SAMPLE);
  return result;
}
/** An action of the record API (POST /v1/actions), confirmed by its result in this lender, as Reports and Settings check it. */
async function recordAction(run: Run, input: ActionInput, check = true) {
  if (check) run.checkpoint();
  const answer = readAnswer(actionResultSchema, await performAction(input, { merchantId: run.merchantId }, { headers: idempotency(), signal: timeout() }));
  if (!answer?.message.trim() || (answer.record && answer.record.merchantId !== run.merchantId)) throw answerProblem(INCOMPLETE_CONFIRMATION);
  return answer;
}
/** One kind's records of this lender, newest first. */
async function records(run: Run, kind: string, params: Omit<ListRecordsParams, 'merchantId'> = {}) {
  run.checkpoint();
  return (await listRecords(kind, { merchantId: run.merchantId, limit: 500, ...params }, { signal: timeout() })).items;
}
const assigneeOf = (record: { data: Record<string, unknown> }) => (record.data.case as { assignee?: unknown } | undefined)?.assignee;
const isOpen = (record: { status: string }) => !['resolved', 'closed'].includes(record.status);

// ---- 1. Import batches ----

const SAMPLE_SOURCE = 'Presentation sample';
/** The record type of each sample file, in the pack's order (presentationSamples): customers, instalments, payment evidence. */
const sampleKinds = ['customers', 'due-items', 'observations'] as const;
const IMPORTERS = ['Admin', 'Operations', 'Finance'];
type SavedBatch = z.output<typeof batchListSchema>['items'][number];

async function savedBatches(run: Run): Promise<SavedBatch[]> {
  const found: SavedBatch[] = [];
  for (let offset = 0; ; offset += 25) {
    const page = await pilotRead(run, `/pilot/batches?offset=${offset}`, batchListSchema);
    found.push(...page.items);
    if (!page.items.length || offset + 25 >= page.total) return found;
  }
}
/**
 * The Presentation page's sample pack, with the settings its import steps name (sampleImportSteps): the source
 * "Presentation sample", the source row column source_row_id, amounts in naira and each file's own name as its
 * reference. Customers, then instalments, are saved, checked and imported once; the payment file is saved and checked
 * only, for the presenter to import during the demo.
 */
async function importSamples(run: Run): Promise<Outcome> {
  const today = watDay(await run.now());
  const samples = presentationSamples(today);
  if (samples.length !== sampleKinds.length) throw answerProblem('The sample files have changed. Import them yourself from this page.');
  const saved = await savedBatches(run);
  let wrote = false;
  for (const [index, sample] of samples.entries()) {
    const kind = sampleKinds[index]!, importIt = kind !== 'observations', file = sample.kind.toLowerCase();
    let batch: { id: string; status: string; updatedAt: string } | undefined = saved.find(b => b.data.source === SAMPLE_SOURCE && b.data.sourceBatchId === sample.filename && b.data.kind === kind);
    if (batch && (batch.status === 'committed' || (!importIt && batch.status === 'ready'))) continue;
    await run.actAs(IMPORTERS);
    const input: BatchInput = {
      name: `Presentation ${file}`, kind, source: SAMPLE_SOURCE, sourceBatchId: sample.filename, businessDate: today,
      identityColumn: 'source_row_id', amountUnit: 'naira', mapping: {}, csv: sample.csv, syntheticOnly: true,
    };
    // Saved before but not ready (checked before the records it names were imported): saved and checked again.
    batch = batch
      ? await pilotWrite(run, `/pilot/batches/${batch.id}/save`, { ...input, expectedUpdatedAt: batch.updatedAt })
      : await pilotWrite(run, '/pilot/batches', input);
    wrote = true;
    if (batch.status !== 'ready') throw answerProblem(`The ${file} file has rows to fix. Open Import batches to check it.`);
    if (!importIt) continue;
    batch = await pilotWrite(run, `/pilot/batches/${batch.id}/commit`, { expectedUpdatedAt: batch.updatedAt });
    if (batch.status !== 'committed') throw answerProblem(`The ${file} file was not imported. Open Import batches to check it.`);
  }
  return wrote ? 'completed' : 'already-done';
}

// ---- 2. A case with an owner ----

const CASE_WORKERS = ['Admin', 'Operations', 'Finance', 'Compliance reviewer'];
const severityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
/** The next step a team member would write for the exception's type. */
function nextStepFor(type: unknown): string {
  if (type === 'imported_consent_gap') return 'Ask the lender team for the customer’s signed consent record';
  if (type === 'activation_expired') return 'Ask the customer to activate the mandate again';
  if (type === 'unallocated_payment') return 'Confirm the payer, then allocate the payment';
  return 'Check the linked record and choose an outcome';
}
/**
 * One open exception claimed, as its case page claims it, with a next step a day ahead and a handover note, so its
 * case history and My work are not empty. The presenter's role claims it, preferring an exception that role owns; two
 * others stay unclaimed for the live demo.
 */
async function claimCase(run: Run): Promise<Outcome> {
  const open = (await records(run, 'exceptions')).filter(isOpen);
  if (open.some(record => assigneeOf(record))) return 'already-done';
  if (open.length < 3) throw answerProblem('Fewer than 3 exceptions are open, so none was claimed: 2 must stay unclaimed for your demo. For a fresh sandbox, use a private browser window.');
  await run.actAs(CASE_WORKERS);
  const role = run.role(), actor = run.actor()!;
  const [exception] = [...open].sort((a, b) =>
    Number(b.data.owner === role) - Number(a.data.owner === role)
    || (severityRank[String(a.data.severity)] ?? 3) - (severityRank[String(b.data.severity)] ?? 3)
    || String(a.data.dueBy ?? '').localeCompare(String(b.data.dueBy ?? ''))
    || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const path = `/pilot/cases/${encodeURIComponent(exception!.id)}`;
  const detail = await pilotRead(run, path, caseDetailSchema);
  if (!detail.assignees.some(person => person.actor === actor)) throw answerProblem('Your demo role cannot work on this lender’s cases. Change your demo role in Settings, then try again.');
  await pilotWrite(run, path, {
    action: 'claim', assignee: actor, expectedUpdatedAt: detail.record.updatedAt,
    note: 'I own this case now and will follow up tomorrow. Sample data only.',
    nextAction: nextStepFor(detail.record.data.type),
    nextActionAt: new Date(Date.parse(await run.now()) + DAY_MS).toISOString(),
    evidenceIds: [],
  });
  return 'completed';
}

// ---- 3. Pay by Bank checkouts ----

const CHECKOUT_WORKERS = ['Admin', 'Operations', 'Finance'];
type Checkout = 'confirmed' | 'unknown' | 'waiting';
/**
 * Each checkout's reason. Its first event keeps it, which the checkout timeline shows, and a later press finds the
 * checkout an earlier press made by it.
 */
const checkoutReasons: Record<Checkout, string> = {
  confirmed: 'Sample checkout 1 of 3, prepared for the presentation',
  unknown: 'Sample checkout 2 of 3, prepared for the presentation',
  waiting: 'Sample checkout 3 of 3, prepared for the presentation',
};
type Intent = ConnectedView['payments']['intents'][number];
const reasonOfCheckout = (intent: Intent) => intent.data.events?.[0]?.detail;

/**
 * The instalments a new checkout may be for, in a fixed order: open, with no checkout yet, held by no other payment,
 * and none the demo needs as it is. That rules out the sample pack's PRES-D001, an instalment with a match (such as
 * the proposed match waiting in Matches to review) and one an open exception is about, directly or through a payment,
 * collection attempt or checkout that names it. Instalments not due yet come first, then the others, each by reference.
 */
async function checkoutInstalments(run: Run, view: ConnectedView) {
  const [dueItems, allocations, exceptions, payments, attempts] = await Promise.all(
    ['due-items', 'allocations', 'exceptions', 'payments', 'attempts'].map(kind => records(run, kind)));
  const today = watDay(view.asOf);
  const dueDates = new Map(dueItems!.map(record => [record.id, String(record.data.dueDate ?? '')]));
  const named = new Map([...payments!, ...attempts!, ...view.payments.intents].map(record => [record.id, record.data.dueItemId]));
  // Matched instalments and those with a checkout already, each checkout on its own instalment.
  const needed = new Set<unknown>([...allocations!, ...view.payments.intents].map(record => record.data.dueItemId));
  for (const exception of exceptions!.filter(isOpen)) {
    const linked = exception.data.linkedRecordId;
    needed.add(linked).add(named.get(String(linked))).add(exception.data.dueItemId);
  }
  const overdue = (id: string) => Number((dueDates.get(id) ?? '') <= today);
  return view.payments.dues
    .filter(due => !due.blocked && due.outstandingKobo > 0 && due.reference !== PRESENTATION_INSTALMENT && !needed.has(due.id) && !view.payments.heldForReversalReview.includes(due.id))
    .sort((a, b) => overdue(a.id) - overdue(b.id) || a.reference.localeCompare(b.reference) || a.id.localeCompare(b.id));
}
/**
 * Three checkouts on three instalments, as Pay by Bank takes them: one created, authorised, returned from the bank and
 * confirmed; one created, authorised and reported with an outcome unknown; one created only, waiting for the customer.
 * A checkout of each kind already there counts, whoever made it, and one this step left part-way is carried on; a new
 * one takes the next instalment checkoutInstalments allows. Like every checkout, the waiting one expires 15 minutes
 * after it is created and then shows Checkout expired: it is left as it is.
 */
async function prepareCheckouts(run: Run): Promise<Outcome> {
  let wrote = false;
  for (const kind of ['confirmed', 'unknown', 'waiting'] as const) {
    const view = await connectedView(run);
    const sample = view.payments.dues.find(item => item.reference === PRESENTATION_INSTALMENT)?.id;
    const intents = view.payments.intents.filter(intent => !sample || intent.data.dueItemId !== sample);
    if (intents.some(intent => intent.status === (kind === 'waiting' ? 'created' : kind))) continue;
    await run.actAs(CHECKOUT_WORKERS);
    wrote = true;
    const reason = checkoutReasons[kind];
    const live = (intent: Intent) => Date.parse(String(intent.data.expiresAt ?? '')) > Date.parse(view.asOf);
    let checkout: { id: string; status: string } | undefined = kind === 'waiting' ? undefined
      : intents.find(intent => reasonOfCheckout(intent) === reason && (['authorised', 'pending'].includes(intent.status) || (intent.status === 'created' && live(intent))));
    if (!checkout) {
      const [due] = await checkoutInstalments(run, view);
      if (!due) throw answerProblem('No open instalment is free for a sample checkout. For a fresh sandbox, use a private browser window.');
      checkout = (await connectedAction(run, 'payment.create', { dueItemId: due.id, amountKobo: due.outstandingKobo }, reason)).record as { id: string; status: string };
    }
    if (kind === 'waiting') continue;
    if (checkout.status === 'created') await connectedAction(run, 'payment.authorise', {}, reason, checkout.id);
    if (kind === 'confirmed' && checkout.status !== 'pending') await connectedAction(run, 'payment.return', {}, reason, checkout.id);
    await connectedAction(run, 'payment.outcome', { outcome: kind }, reason, checkout.id);
  }
  return wrote ? 'completed' : 'already-done';
}

// ---- 4. Daily closes ----

const CLOSERS = ['Admin', 'Operations', 'Finance'];
type CloseEntry = z.output<typeof closeReviewDetailSchema>;
/** The closes of one business date, newest first, as Close review lists and searches them. */
async function closesOf(run: Run, date: string) {
  const page = await pilotRead(run, `/pilot/close-reviews?${new URLSearchParams({ search: date, limit: '25' })}`, closeReviewHistorySchema);
  return page.closes.filter(close => close.businessDate === date);
}
const closeDetail = (run: Run, id: string): Promise<CloseEntry> => pilotRead(run, `/pilot/close-reviews/${encodeURIComponent(id)}`, closeReviewDetailSchema);
const currentReview = (entry: CloseEntry['entry']) => entry.reviews.some(review => review.current && ['awaiting_review', 'approved'].includes(review.status));
/** Run daily close for one business date, as Reports sends it. */
const dailyClose = (run: Run, date: string) => recordAction(run, { action: 'daily_close', data: { sourceBusinessDate: date } });
/**
 * A daily close of each of the 3 business dates before today, oldest first. The newest close of the latest date must
 * be one Finance can review now: when the records changed after it (a close the schedule ran earlier, or a step an
 * earlier press finished later), that date is closed again. The earlier close stays as it was.
 */
async function runCloses(run: Run): Promise<Outcome> {
  const dates = closeDates(watDay(await run.now())), latest = dates.at(-1)!;
  let wrote = false, closedLatest = false;
  for (const date of dates) {
    if ((await closesOf(run, date)).length) continue;
    await run.actAs(CLOSERS);
    await dailyClose(run, date);
    wrote = true;
    closedLatest = date === latest;
  }
  if (!closedLatest) {
    const [newest] = await closesOf(run, latest);
    if (!newest) throw answerProblem(`The daily close for ${formatDate(latest)} could not be found. Open Close review to check it.`);
    const { entry } = await closeDetail(run, newest.id);
    // Import corrections waiting for a decision keep any new close from being reviewed: Close review says so.
    if (entry.problem && !currentReview(entry) && !entry.pendingFinancialCorrections) {
      await run.actAs(CLOSERS);
      await dailyClose(run, latest);
      wrote = true;
    }
  }
  return wrote ? 'completed' : 'already-done';
}

// ---- 5. Close review ----

const PREPARERS = ['Admin', 'Operations'];
const SAMPLE_EXPLANATION = 'Sample data for the presentation. It stays here for the Finance reviewer to check.';
/**
 * The latest close submitted for review as Close review submits it, naming a Finance reviewer from the list it offers
 * other than the preparer. Every listed difference and unresolved item gets an explanation. It waits for that
 * different person: one presenter cannot approve their own close.
 */
async function submitCloseReview(run: Run): Promise<Outcome> {
  const latest = closeDates(watDay(await run.now())).at(-1)!;
  const [newest] = await closesOf(run, latest);
  if (!newest) throw answerProblem(`There is no daily close for ${formatDate(latest)} to submit.`);
  const { entry, reviewers } = await closeDetail(run, newest.id);
  if (currentReview(entry)) return 'already-done';
  if (entry.problem) throw answerProblem(entry.problem);
  await run.actAs(PREPARERS);
  const reviewer = reviewers.find(person => person.role === 'Finance' && person.actor !== run.actor());
  if (!reviewer) throw answerProblem('No Finance team member other than you can review this close.');
  await pilotWrite(run, '/pilot/close-reviews/prepare', {
    closeId: entry.close.id,
    expectedUpdatedAt: entry.close.updatedAt,
    reviewer: reviewer.actor,
    preparationNote: 'Prepared with sample data for the presentation. Check the totals, the open exceptions and the source files before you decide.',
    discrepancyResponses: entry.issues.map(issue => ({ issueId: issue.id, explanation: SAMPLE_EXPLANATION })),
    unresolvedAcceptance: entry.issues.some(issue => issue.unresolved) ? 'Sample data for the presentation. Each open item keeps its owner and next step on its own page.' : '',
  });
  return 'completed';
}

// ---- 6. Credit Desk ----

const GRANTERS = ['Admin', 'Operations'];
const ASSESSORS = ['Admin', 'Operations'];
/** The loan the Credit Desk page starts with: ₦240,000.00, repaid at ₦90,000.00 a month for 3 months. */
const SAMPLE_LOAN = { principalKobo: 24_000_000, repaymentKobo: 9_000_000, termMonths: 3 };
type Assessment = ConnectedView['credit']['assessments'][number];

/** The permissions not active yet for one customer or the sample business ("sme"), granted for 30 days as Permissions and readiness grants them. */
async function grantPermissions(run: Run, subjectId: string, purposes: readonly string[]): Promise<boolean> {
  const view = await connectedView(run);
  const missing = purposes.filter(purpose => !view.consents.some(consent => consent.data.purpose === purpose && consent.data.subjectId === subjectId && consent.effectiveStatus === 'active'));
  for (const purpose of missing) {
    await run.actAs(GRANTERS);
    await connectedAction(run, 'consent.grant', { purpose, subjectId, days: 30 }, 'Grant a sample permission for the presentation');
  }
  return missing.length > 0;
}
const latestAssessment = (view: ConnectedView, customerId: string): Assessment | undefined => view.credit.assessments.find(item => item.customerId === customerId);
const assess = (run: Run, customerId: string, scenario: string) =>
  connectedAction(run, 'credit.assess', { customerId, scenario, ...SAMPLE_LOAN }, 'Assess a sample applicant for the presentation');
/**
 * Applicant A and Applicant B are the lender's first two customers by reference, never the sample pack's customer.
 * B has both permissions and an assessment in which the applicant refused permission to assess the application: it
 * shows "Refusal is not a credit-risk penalty." A has both permissions and a complete-evidence assessment that waits for
 * a different person to review it, like the close, the accounting draft and the payroll plan: the button approves
 * nothing. B goes first, so A's assessment is the newest and Credit Desk opens on it.
 */
async function prepareCredit(run: Run): Promise<Outcome> {
  let view = await connectedView(run);
  const [a, b] = view.customers.filter(customer => customer.reference !== PRESENTATION_CUSTOMER).sort((x, y) => x.reference.localeCompare(y.reference) || x.id.localeCompare(y.id));
  if (!a || !b) throw answerProblem('This lender needs at least 2 customers for Credit Desk.');
  let wrote = false;
  if (latestAssessment(view, b.id)?.scenario !== 'refused') {
    wrote = (await grantPermissions(run, b.id, ['account_read', 'credit_assessment'])) || wrote;
    await run.actAs(ASSESSORS);
    await assess(run, b.id, 'refused');
    wrote = true;
    view = await connectedView(run);
  }
  const waiting = latestAssessment(view, a.id);
  if (!(waiting?.scenario === 'ready' && !waiting.permissionRestricted && waiting.result.state === 'review_pending')) {
    wrote = (await grantPermissions(run, a.id, ['account_read', 'credit_assessment'])) || wrote;
    await run.actAs(ASSESSORS);
    await assess(run, a.id, 'ready');
    wrote = true;
  }
  return wrote ? 'completed' : 'already-done';
}

// ---- 7. Cash Desk ----

const CASH_MAKERS = ['Admin', 'Operations'];
const FORECASTERS = ['Admin', 'Operations', 'Finance'];
/** The Cash Desk page's starting assumptions: 70% of expected receipts arrive, 7 days late, with a ₦1,500,000.00 planning buffer. */
const SAMPLE_FORECAST = { downsideInflowBps: 7_000, downsideDelayDays: 7, bufferMinor: 150_000_000 };
/**
 * The sample business's three permissions, then Cash Desk set up as its page sets it up: an accounting draft and a
 * payroll funding plan, each waiting for a different Finance reviewer to approve it, a saved 30-day forecast and a VAT
 * schedule, which only Finance saves. Nothing is posted, filed or paid.
 */
async function prepareCash(run: Run): Promise<Outcome> {
  let wrote = await grantPermissions(run, 'sme', ['merchant_account_read', 'erp_draft', 'payroll_prepare']);
  const steps: Array<[done: (cash: ConnectedView['cash']) => boolean, roles: readonly string[], action: string, data: Record<string, unknown>, reason: string]> = [
    [cash => cash.initialised, CASH_MAKERS, 'cash.initialize', {}, 'Set up the sample business for the presentation'],
    [cash => cash.erpDrafts.length > 0, CASH_MAKERS, 'cash.erp.prepare', {}, 'Prepare a sample accounting draft for the presentation'],
    [cash => cash.payrollPlans.length > 0, CASH_MAKERS, 'cash.payroll.prepare', {}, 'Prepare a sample payroll funding plan for the presentation'],
    [cash => cash.savedForecast?.state === 'current', FORECASTERS, 'cash.forecast', SAMPLE_FORECAST, 'Save a sample 30-day forecast for the presentation'],
    [cash => cash.vatExports.some(schedule => schedule.state === 'current'), ['Finance'], 'cash.vat.export', {}, 'Save a sample VAT schedule for the presentation'],
  ];
  for (const [done, roles, action, data, reason] of steps) {
    if (done((await connectedView(run)).cash)) continue;
    await run.actAs(roles);
    await connectedAction(run, action, data, reason);
    wrote = true;
  }
  return wrote ? 'completed' : 'already-done';
}

// ---- 8. Saved exports ----

const EXPORTERS = ['Admin', 'Finance', 'Compliance reviewer'];
/** How long a press follows an export being prepared, as Saved exports follows it, unless a test sets another time. */
const EXPORT_WAIT_MS = 30_000;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const preparing = (job: { status?: string }) => ['queued', 'running'].includes(job.status ?? '');
/** A new or restarted export's answer is a confirmation only with its link, and its checksum once ready (safe-mutations). */
function exportJob(answer: unknown, id?: string): ExportResultView {
  const job = readAnswer(exportResultSchema, answer);
  if (!job || (id && job.id !== id) || !job.downloadUrl || !((job.status && job.status !== 'ready') || job.checksum)) throw answerProblem(INCOMPLETE_CONFIRMATION);
  return job;
}
/** An export as it is now, read as Saved exports reads it. */
async function exportNow(run: Run, id: string): Promise<ExportResultView> {
  run.checkpoint();
  return exportJob(await getExportJob(id, { merchantId: run.merchantId }, { signal: timeout() }), id);
}
/** Follows an export being prepared, as Saved exports does, until its file is ready or it failed, for 30 seconds at most. */
async function settled(run: Run, job: ExportResultView): Promise<ExportResultView> {
  for (const started = Date.now(); preparing(job) && Date.now() - started < run.exportWaitMs;) {
    await pause(1_500);
    job = await exportNow(run, job.id);
  }
  return job;
}
/**
 * A dispute pack (PDF) for Ada Okonkwo, as her history exports it, and a billing statement (CSV), as Reports exports
 * it. Only a file that is ready counts as done. One still being prepared, by this press or an earlier one, is followed
 * again rather than requested again; one that failed is retried. When the files cannot be prepared, such as where file
 * storage is not set up, the step says so in Valo Pay's words.
 */
async function prepareExports(run: Run): Promise<Outcome> {
  const ada = (await records(run, 'customers', { search: 'Ada Okonkwo' })).find(customer => customer.name === 'Ada Okonkwo');
  if (!ada) throw answerProblem('Ada Okonkwo is not one of this lender’s customers, so her dispute pack was not exported.');
  const wanted = [
    { title: 'Dispute pack (PDF)', input: { kind: 'dispute-pack', format: 'pdf' as const, customerId: ada.id } },
    { title: 'Billing statement (CSV)', input: { kind: 'billing', format: 'csv' as const } },
  ];
  // Following an export an earlier press left being prepared is this press's work too: the step is not Already done.
  let worked = false;
  for (const { title, input } of wanted) {
    const customerId = 'customerId' in input ? input.customerId : undefined;
    const saved = (await records(run, 'exports', { search: input.kind, ...(customerId ? { customerId } : {}) }))
      .filter(record => record.data.kind === input.kind && record.data.format === input.format && (!customerId || record.customerId === customerId) && !record.data.fileDeletedAt);
    if (saved.some(record => record.status === 'ready')) continue;
    const pending = saved.find(preparing), failed = saved.find(record => record.status === 'failed');
    let job: ExportResultView;
    if (pending) job = await exportNow(run, pending.id);
    else {
      await run.actAs(EXPORTERS);
      run.checkpoint();
      job = failed
        ? exportJob(await retryExportJob(failed.id, { merchantId: run.merchantId }, { headers: idempotency(), signal: timeout() }), failed.id)
        : exportJob(await createExport(input, { merchantId: run.merchantId }, { headers: idempotency(), signal: timeout() }));
    }
    job = await settled(run, job);
    worked = true;
    if (job.status === 'failed') throw answerProblem(`${title} not prepared. ${job.error || NO_REASON}`);
    if (preparing(job)) throw answerProblem(`${title} is still being prepared. Open Saved exports to check it, or select Prepare for presentation again.`);
  }
  return worked ? 'completed' : 'already-done';
}

const runners: Record<PreparationStepId, (run: Run) => Promise<Outcome>> = {
  imports: importSamples, case: claimCase, 'pay-by-bank': prepareCheckouts, 'daily-closes': runCloses,
  'close-review': submitCloseReview, 'credit-desk': prepareCredit, 'cash-desk': prepareCash, exports: prepareExports,
};
/** A step that cannot run while another failed. */
const prerequisites: Partial<Record<PreparationStepId, { step: PreparationStepId; reason: string }>> = {
  'close-review': { step: 'daily-closes', reason: 'This step needs the daily closes, which did not finish.' },
};

/**
 * The presenter's own demo role, kept in this browser tab by lender for the length of a run. A reload or a closed tab
 * ends a run before it can put the role back, so the next press puts back this role, not the one that run switched
 * to. Where the browser refuses storage, a run still puts the role back itself.
 */
const KEPT_ROLE = 'valopay-preparation-role:';
function keptRole(merchantId: string): string | null {
  try { return sessionStorage.getItem(KEPT_ROLE + merchantId); } catch { return null; }
}
function keepRole(merchantId: string, role: string | null): void {
  try {
    if (role === null) sessionStorage.removeItem(KEPT_ROLE + merchantId);
    else sessionStorage.setItem(KEPT_ROLE + merchantId, role);
  } catch { /* Storage refused, as some private windows refuse it: nothing to keep. */ }
}

/**
 * Runs every step in order for the lender, reporting each step's progress, and puts the presenter's demo role back
 * at the end, whatever happened. Refuses, before anything is sent, outside the sandbox or for a lender the workspace
 * does not have. `signal` stops the run before its next request, as when the page is left.
 */
export async function preparePresentation({ merchantId, onProgress, signal, exportWaitMs = EXPORT_WAIT_MS }: {
  merchantId: string;
  onProgress?: (progress: PreparationProgress) => void;
  signal?: AbortSignal;
  /** How long an export being prepared is followed: 30 seconds, as Saved exports follows it, unless a test sets less. */
  exportWaitMs?: number;
}): Promise<PreparationResult> {
  const workspace = await getWorkspace({ signal: timeout() });
  if (!preparationOffered(workspace)) throw answerProblem(SANDBOX_ONLY);
  if (!workspace.merchants.some(lender => lender.id === merchantId)) throw answerProblem('Choose a lender in Active lender, then try again.');
  // The presenter's own role: the one a run cut off in this tab kept, while it is still a demo role, else the current one.
  const kept = keptRole(merchantId);
  const original = kept && workspace.roles.includes(kept) ? kept : workspace.role;
  keepRole(merchantId, original);
  // The current role and person; unknown while a switch is not confirmed, so the role is put back even then.
  let role: string | undefined = workspace.role, actor: string | undefined = workspace.actor;
  const checkpoint = () => { if (signal?.aborted) throw answerProblem(STOPPED); };
  const switchRole = async (next: string, check = true) => {
    role = actor = undefined;
    // As Settings sends it: in the sandbox each demo role is its own sample person, "Sandbox Finance".
    await recordAction(run, { action: 'set_role', data: { role: next } }, check);
    role = next;
    actor = `Sandbox ${next}`;
  };
  let clock: Promise<string> | undefined;
  const run: Run = {
    merchantId,
    exportWaitMs,
    checkpoint,
    now: () => (clock ??= connectedView(run).then(view => view.asOf, (error: unknown) => { clock = undefined; throw error; })),
    async actAs(roles) {
      const target = roles.includes(original) ? original : role && roles.includes(role) ? role : roles[0]!;
      if (target !== role) await switchRole(target);
    },
    role: () => role,
    actor: () => actor,
  };
  const steps: PreparationResult['steps'] = [];
  let roleProblem: string | undefined;
  try {
    for (const step of preparationSteps) {
      checkpoint();
      const needs = prerequisites[step.id];
      if (needs && steps.some(done => done.id === needs.step && done.status === 'failed')) {
        steps.push({ id: step.id, status: 'failed', reason: needs.reason });
        onProgress?.({ id: step.id, status: 'failed', reason: needs.reason });
        continue;
      }
      onProgress?.({ id: step.id, status: 'running' });
      try {
        const status = await runners[step.id](run);
        steps.push({ id: step.id, status });
        onProgress?.({ id: step.id, status });
      } catch (error) {
        if (signal?.aborted) throw error;
        const reason = reasonOf(error);
        steps.push({ id: step.id, status: 'failed', reason });
        onProgress?.({ id: step.id, status: 'failed', reason });
      }
    }
  } finally {
    if (role !== original) {
      try { await switchRole(original, false); } catch (error) { roleProblem = reasonOf(error); }
    }
    // Kept until the role is back, so the next press still knows it when it could not be put back.
    if (role === original) keepRole(merchantId, null);
  }
  return { steps, failed: steps.filter(step => step.status === 'failed').length, role: original, ...(roleProblem ? { roleProblem } : {}) };
}
