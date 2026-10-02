// Prepare for presentation, pressed on the Presentation page against the fake API, which runs the real domain: every
// step through the pages' own requests, then the state the presentation shows, a second press that adds nothing, a
// step that fails and is finished by pressing again, the guards that keep what the live demo needs, the demo role put
// back however a run ends, and no offer outside the sandbox.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { closeDates, preparePresentation, preparationSteps } from '@/lib/presentation-preparation';
import { reviewIsCurrent } from '../../api-server/src/domain/close-review';
import { connectedRevision, runConnectedAction } from '../../api-server/src/domain/connected';
import { coordinateCase } from '../../api-server/src/domain/pilot-workflow';
import { WAT_OFFSET_MS } from '@workspace/valopay-schema';

let api: FakeApi;
/** Every write the console sent, with its Idempotency-Key and body. */
let writes: Array<{ method: string; path: string; merchantId: string | null; key: string | null; body: Record<string, unknown> }>;
/** A new fake API, with these options, recording every write the console sends it. */
function install(options?: Parameters<typeof installFakeApi>[0]) {
  (api as FakeApi | undefined)?.uninstall();
  api = installFakeApi(options);
  writes = [];
  const fake = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase(), url = new URL(String(input), 'http://localhost');
    if (method !== 'GET') writes.push({ method, path: url.pathname, merchantId: url.searchParams.get('merchantId'), key: new Headers(init?.headers).get('Idempotency-Key'), body: typeof init?.body === 'string' ? JSON.parse(init.body) : {} });
    return fake(input, init);
  }) as typeof fetch;
}
beforeEach(() => { sessionStorage.clear(); install(); });
afterEach(() => { api.uninstall(); sessionStorage.clear(); });

const records = (kind: string) => api.state().records.filter(record => record.kind === kind);
const section = () => screen.getByRole('region', { name: 'Sample records for the presentation' });
/** Each step's label and the status it shows, in order. */
const statuses = () => within(section()).getAllByRole('listitem').map(item => [item.querySelector('p')?.textContent, item.lastElementChild?.textContent]);
async function press(user: ReturnType<typeof userEvent.setup>, summary: string) {
  await user.click(within(section()).getByRole('button', { name: 'Prepare for presentation' }));
  await waitFor(() => expect(within(section()).getByRole('status').textContent).toBe(summary), { timeout: 45_000 });
}
const ALL_DONE = 'All 8 steps are done. Open Overview to start.';
/** Today in West Africa Time, by the fake API's clock. */
const watToday = () => new Date(Date.parse(api.now) + WAT_OFFSET_MS).toISOString().slice(0, 10);
const isOpen = (record: { status: string }) => !['resolved', 'closed'].includes(record.status);

it('fills the active lender’s pages through the pages’ own requests and puts the demo role back', async () => {
  const user = userEvent.setup();
  renderApp('/presentation');
  await screen.findByRole('heading', { name: 'Sample records for the presentation' });
  const lender = api.state();
  expect(section().textContent).toContain(`Fill ${lender.merchant.name}’s pages with sample work`);
  expect(section().textContent).toContain('Sample data only. No money moves and nothing is sent to a bank.');
  expect(statuses()).toEqual(preparationSteps.map((step, index) => [`${index + 1}. ${step.label}`, 'Waiting']));
  expect(writes).toEqual([]);

  await press(user, ALL_DONE);
  expect(statuses()).toEqual(preparationSteps.map((step, index) => [`${index + 1}. ${step.label}`, 'Completed']));
  expect(within(section()).getByRole('link', { name: 'Open Overview' }).getAttribute('href')).toBe('/overview');

  // The sample pack: customers and instalments imported, the payment file saved and checked, not imported.
  const batches = records('import-batches').filter(batch => batch.data.source === 'Presentation sample');
  expect(batches.map(batch => [batch.data.kind, batch.status, batch.name]).sort()).toEqual([
    ['customers', 'committed', 'Presentation customers'],
    ['due-items', 'committed', 'Presentation instalments'],
    ['observations', 'ready', 'Presentation payment evidence'],
  ]);
  expect(records('customers').some(customer => customer.reference === 'PRES-C001')).toBe(true);
  const sampleInstalment = records('due-items').find(due => due.reference === 'PRES-D001')!;
  expect(sampleInstalment.amountKobo).toBe(1_800_050);
  expect(records('observations').some(evidence => evidence.reference === 'PRES-O001')).toBe(false);

  // A close for each of the 3 dates before today (WAT), the latest waiting for a different person, Sandbox Finance.
  const today = new Date(Date.parse(api.now) + WAT_OFFSET_MS).toISOString().slice(0, 10);
  const dates = closeDates(today);
  expect(dates.map(date => (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000)).toEqual([3, 2, 1]);
  expect(records('closes').map(close => close.data.sourceBusinessDate).sort()).toEqual(dates);
  const [review] = records('close-reviews');
  expect(records('close-reviews')).toHaveLength(1);
  expect(review).toMatchObject({ status: 'awaiting_review', data: { preparedBy: 'Sandbox Admin', reviewer: 'Sandbox Finance' } });
  expect(records('closes').find(close => close.id === review!.data.closeId)?.data.sourceBusinessDate).toBe(dates[2]);
  // Nothing the later steps did made it out of date.
  expect(reviewIsCurrent(api.state(), review!)).toBe(true);

  // One claimed case, with its next step and handover note; the other exceptions stay open and unclaimed.
  const open = records('exceptions').filter(exception => !['resolved', 'closed'].includes(exception.status));
  const claimed = open.filter(exception => exception.data.case?.assignee);
  expect(claimed).toHaveLength(1);
  expect(claimed[0]!.data.case).toMatchObject({ assignee: 'Sandbox Admin', nextAction: expect.any(String), nextActionAt: expect.any(String) });
  expect(Date.parse(claimed[0]!.data.case.nextActionAt)).toBeGreaterThan(Date.parse(api.now));
  expect(records('case-events')).toMatchObject([{ data: { exceptionId: claimed[0]!.id, action: 'claim', actor: 'Sandbox Admin', note: expect.stringMatching(/\S{3}/) } }]);
  expect(open.length - claimed.length).toBeGreaterThanOrEqual(2);

  // Three checkouts on three instalments, never the sample pack's: confirmed, waiting for the customer and outcome unknown.
  const checkouts = records('connected-intents');
  expect(checkouts.map(checkout => checkout.status).sort()).toEqual(['confirmed', 'created', 'unknown']);
  expect(new Set(checkouts.map(checkout => checkout.data.dueItemId)).size).toBe(3);
  expect(checkouts.some(checkout => checkout.data.dueItemId === sampleInstalment.id)).toBe(false);
  const confirmed = checkouts.find(checkout => checkout.status === 'confirmed')!;
  expect(confirmed.data.events.map((event: { status: string }) => event.status)).toEqual(['created', 'authorised', 'pending', 'confirmed']);
  expect(checkouts.find(checkout => checkout.status === 'unknown')!.data.events.map((event: { status: string }) => event.status)).toEqual(['created', 'authorised', 'unknown']);
  // In a fixed order, on instalments the demo does not need as they are: never PRES-D001, one with a match or one an
  // open exception is about. The seeded proposed match is still waiting in Matches to review.
  const instalments = new Map(records('due-items').map(due => [due.id, due]));
  expect(['confirmed', 'unknown', 'created'].map(status => instalments.get(checkouts.find(checkout => checkout.status === status)!.data.dueItemId)!.reference)).toEqual(['DEMO-LOAN-1005', 'DEMO-LOAN-1006', 'DEMO-LOAN-1007']);
  const proposal = records('allocations').find(allocation => allocation.status === 'proposed')!;
  expect(instalments.get(proposal.data.dueItemId)).toMatchObject({ reference: 'DEMO-LOAN-1003', status: 'scheduled', data: { outstandingKobo: 1_800_000 } });
  expect(records('payments').find(payment => payment.id === proposal.data.paymentId)).toMatchObject({ reference: 'SBX-PAY-1003', status: 'proposed' });
  const waitingMatches = await (await fetch(`/api/v1/reconciliation/proposals?merchantId=${lender.merchant.id}`)).json();
  expect(waitingMatches.items.map((item: { id: string }) => item.id)).toEqual([proposal.id]);
  const exceptionLinks = new Set(records('exceptions').filter(exception => !['resolved', 'closed'].includes(exception.status)).map(exception => exception.data.linkedRecordId));
  expect(checkouts.some(checkout => exceptionLinks.has(checkout.data.dueItemId))).toBe(false);

  // Applicant A's assessment, waiting for a different person to review it: the button approves nothing. Applicant B's refused one.
  const assessments = records('connected-credit-assessments');
  const ready = assessments.find(assessment => assessment.data.scenario === 'ready')!;
  const refused = assessments.find(assessment => assessment.data.scenario === 'refused')!;
  expect(assessments).toHaveLength(2);
  expect(ready).toMatchObject({ status: 'review_pending', data: { createdBy: 'Sandbox Admin', result: { state: 'review_pending' } } });
  expect(records('connected-credit-reviews')).toEqual([]);
  expect(refused.customerId).not.toBe(ready.customerId);
  expect(JSON.stringify(refused.data.result.evidence.issues)).toContain('Refusal is not a credit-risk penalty.');
  const grants = records('connected-consents').filter(consent => consent.data.purpose !== 'one_time_payment');
  for (const customerId of [ready.customerId, refused.customerId])
    expect(grants.filter(consent => consent.data.subjectId === customerId).map(consent => consent.data.purpose).sort()).toEqual(['account_read', 'credit_assessment']);

  // Cash Desk set up, with a forecast, an accounting draft and a payroll plan waiting for approval, and a VAT schedule.
  expect(grants.filter(consent => consent.data.subjectId === 'sme').map(consent => consent.data.purpose).sort()).toEqual(['erp_draft', 'merchant_account_read', 'payroll_prepare']);
  expect(records('connected-cash-workspace')).toHaveLength(1);
  expect(records('connected-cash-forecasts')).toHaveLength(1);
  expect(records('connected-cash-erp')).toMatchObject([{ data: { draft: { status: 'proposed' } } }]);
  expect(records('connected-cash-payroll')).toMatchObject([{ data: { plan: { approvalStatus: 'draft', maker: 'Sandbox Admin' } } }]);
  expect(records('connected-cash-vat')).toMatchObject([{ data: { reviewer: 'Sandbox Finance' } }]);

  // The two saved exports.
  const ada = records('customers').find(customer => customer.name === 'Ada Okonkwo')!;
  expect(records('exports').map(file => [file.data.kind, file.data.format, file.customerId, file.status]).sort()).toEqual([
    ['billing', 'csv', '', 'ready'],
    ['dispute-pack', 'pdf', ada.id, 'ready'],
  ]);

  // The presenter's demo role, put back after the Finance steps; nothing touched the other lender.
  expect(api.role).toBe('Admin');
  // Only the VAT schedule, which only Finance saves, takes another demo role; it approves nothing.
  const roles = writes.filter(write => write.body.action === 'set_role').map(write => (write.body.data as { role: string }).role);
  expect(roles).toEqual(['Finance', 'Admin']);
  expect(writes.every(write => write.merchantId === lender.merchant.id)).toBe(true);
  expect(api.state(api.merchantIds[1]).records.some(record => record.kind.startsWith('connected-') || record.kind === 'closes' || record.kind === 'import-batches')).toBe(false);

  // Every write with its own new key; every connected action with the revision read just before it.
  expect(writes.length).toBeGreaterThan(30);
  expect(writes.every(write => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(write.key ?? ''))).toBe(true);
  expect(new Set(writes.map(write => write.key)).size).toBe(writes.length);
  const connected = writes.filter(write => write.path === '/api/v1/connected/actions');
  expect(connected.every(write => typeof write.body.expectedRevision === 'string' && write.body.expectedRevision.length > 0)).toBe(true);
  expect(api.calls.filter(call => call.method !== 'GET' && call.status >= 400)).toEqual([]);
}, 60_000);

it('shows every step already done on a second press and adds no record', async () => {
  const user = userEvent.setup();
  renderApp('/presentation');
  await screen.findByRole('heading', { name: 'Sample records for the presentation' });
  await press(user, ALL_DONE);
  const before = structuredClone(api.state().records), sent = writes.length, called = api.calls.length;

  await press(user, ALL_DONE);
  expect(statuses()).toEqual(preparationSteps.map((step, index) => [`${index + 1}. ${step.label}`, 'Already done']));
  expect(writes.slice(sent)).toEqual([]);
  expect(api.calls.slice(called).filter(call => call.method !== 'GET')).toEqual([]);
  expect(api.state().records).toEqual(before);
  expect(api.role).toBe('Admin');
}, 60_000);

it('records a failed step in Valo Pay’s words, carries on, puts the role back and finishes it on the next press', async () => {
  const user = userEvent.setup();
  renderApp('/presentation');
  await screen.findByRole('heading', { name: 'Sample records for the presentation' });
  // As where file storage is not set up: the first export is refused.
  api.failNext(/^\/v1\/exports$/, { status: 503, error: 'Exports are not set up yet. Contact the Valo Pay team.' }, 'POST');
  await press(user, '1 step failed. Select Prepare for presentation to try it again.');
  expect(statuses()).toEqual(preparationSteps.map((step, index) => [`${index + 1}. ${step.label}`, step.id === 'exports' ? 'Failed' : 'Completed']));
  const exportsStep = within(section()).getAllByRole('listitem').at(-1)!;
  expect(within(exportsStep).getByText(/^Exports are not set up yet\. Contact the Valo Pay team\. Support reference: fake-\w+\.$/)).toBeTruthy();
  expect(records('exports')).toEqual([]);
  expect(api.role).toBe('Admin');

  await press(user, ALL_DONE);
  expect(statuses()).toEqual(preparationSteps.map((step, index) => [`${index + 1}. ${step.label}`, step.id === 'exports' ? 'Completed' : 'Already done']));
  expect(records('exports').map(file => [file.data.kind, file.data.format]).sort()).toEqual([['billing', 'csv'], ['dispute-pack', 'pdf']]);
  expect(api.role).toBe('Admin');
}, 60_000);

it('fails the exports step while a file is still being prepared, and follows that file on the next press rather than requesting it again', async () => {
  // As on the published site, where the export worker prepares each file after it is requested.
  install({ queuedExports: true });
  const merchantId = api.merchantIds[0]!;
  const still = (name: string) => `${name} is still being prepared. Open Saved exports to check it, or select Prepare for presentation again.`;
  const first = await preparePresentation({ merchantId, exportWaitMs: 0 });
  expect(first.steps.at(-1)).toEqual({ id: 'exports', status: 'failed', reason: still('Dispute pack (PDF)') });
  expect(first.failed).toBe(1);
  const [pack] = records('exports');
  expect(records('exports')).toMatchObject([{ status: 'queued', data: { kind: 'dispute-pack', format: 'pdf' } }]);

  // Not Already done and not requested again: the file being prepared is read again, as Saved exports reads it.
  const sent = writes.length, called = api.calls.length;
  const second = await preparePresentation({ merchantId, exportWaitMs: 0 });
  expect(second.steps.slice(0, -1).map(step => step.status)).toEqual(preparationSteps.slice(0, -1).map(() => 'already-done'));
  expect(second.steps.at(-1)).toEqual({ id: 'exports', status: 'failed', reason: still('Dispute pack (PDF)') });
  expect(writes.slice(sent)).toEqual([]);
  expect(api.calls.slice(called).filter(call => call.path === `/v1/exports/${pack!.id}`).map(call => call.method)).toEqual(['GET']);
  expect(records('exports')).toHaveLength(1);

  // Once its file is ready, the next press counts it and requests the billing statement.
  api.mutate(state => { const job = state.records.find(record => record.id === pack!.id)!; job.status = 'ready'; job.data.checksum = 'sample-checksum'; });
  const third = await preparePresentation({ merchantId, exportWaitMs: 0 });
  expect(third.steps.at(-1)).toEqual({ id: 'exports', status: 'failed', reason: still('Billing statement (CSV)') });
  expect(records('exports').map(file => [file.data.kind, file.status])).toEqual([['dispute-pack', 'ready'], ['billing', 'queued']]);
  expect(api.role).toBe('Admin');
}, 60_000);

it('carries on a checkout an earlier press left part-way, and leaves a waiting checkout that expired as it is', async () => {
  // Midday in West Africa Time, so the 20 minutes below stay on the same business date.
  install({ now: `${new Date().toISOString().slice(0, 10)}T11:00:00.000Z` });
  const user = userEvent.setup();
  // An earlier press created and authorised the checkout to be confirmed, then stopped.
  const due = records('due-items').find(item => item.reference === 'DEMO-LOAN-1008')!;
  const reason = 'Sample checkout 1 of 3, prepared for the presentation';
  const left = api.mutate((state, ctx) => {
    const { id } = runConnectedAction(state, ctx, { action: 'payment.create', data: { dueItemId: due.id, amountKobo: due.amountKobo }, reason, expectedRevision: connectedRevision(state) }) as { id: string };
    runConnectedAction(state, ctx, { action: 'payment.authorise', data: {}, recordId: id, reason, expectedRevision: connectedRevision(state) });
    return id;
  });
  renderApp('/presentation');
  await screen.findByRole('heading', { name: 'Sample records for the presentation' });
  await press(user, ALL_DONE);
  expect(records('connected-intents')).toHaveLength(3);
  expect(records('connected-intents').find(checkout => checkout.id === left)!.data.events.map((event: { status: string }) => event.status)).toEqual(['created', 'authorised', 'pending', 'confirmed']);
  const before = structuredClone(api.state().records);

  // Like every checkout, the waiting one expires 15 minutes after it is created: a later press leaves it as it is.
  api.setNow(new Date(Date.parse(api.now) + 20 * 60_000).toISOString());
  await press(user, ALL_DONE);
  expect(statuses()).toEqual(preparationSteps.map((step, index) => [`${index + 1}. ${step.label}`, 'Already done']));
  expect(api.state().records).toEqual(before);
  const waiting = records('connected-intents').find(checkout => checkout.status === 'created')!;
  expect(Date.parse(waiting.data.expiresAt)).toBeLessThan(Date.parse(api.now));
  expect(api.role).toBe('Admin');
}, 60_000);

it('puts back a demo role other than Admin when the run ends', async () => {
  install({ role: 'Operations' });
  expect(await preparePresentation({ merchantId: api.merchantIds[0]! })).toMatchObject({ failed: 0, role: 'Operations' });
  // The VAT schedule takes Finance, which the exports keep: only the end of the run puts Operations back.
  expect(writes.filter(write => write.body.action === 'set_role').map(write => write.body)).toEqual([
    { action: 'set_role', data: { role: 'Finance' } },
    { action: 'set_role', data: { role: 'Operations' } },
  ]);
  expect(api.role).toBe('Operations');
}, 60_000);

it('stops when the presenter leaves the page during a run, sends nothing more and puts the demo role back', async () => {
  install({ role: 'Read-only' });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  renderApp('/presentation');
  await screen.findByRole('heading', { name: 'Sample records for the presentation' });
  // The first checkout waits on its way to Valo Pay, after the run switched to Admin for the imports.
  const release = api.hold(/^\/v1\/connected\/actions$/);
  await user.click(within(section()).getByRole('button', { name: 'Prepare for presentation' }));
  await waitFor(() => expect(writes.some(write => write.path === '/api/v1/connected/actions')).toBe(true), { timeout: 30_000 });
  expect(api.role).toBe('Admin');
  await user.click(screen.getAllByRole('link', { name: 'Overview' })[0]!);
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Sample records for the presentation' })).toBeNull());
  const sent = writes.length;
  release();
  await waitFor(() => expect(api.role).toBe('Read-only'));
  expect(writes.slice(sent).map(write => write.body)).toEqual([{ action: 'set_role', data: { role: 'Read-only' } }]);
  expect(records('connected-intents')).toHaveLength(1);
}, 60_000);

it('closes the latest date again when records changed after its close, and submits the new close for review', async () => {
  const merchantId = api.merchantIds[0]!, dates = closeDates(watToday());
  expect((await preparePresentation({ merchantId })).failed).toBe(0);
  // A second case claimed after the run: the latest close no longer matches its records.
  api.mutate((state, ctx) => {
    const exception = state.records.find(record => record.kind === 'exceptions' && isOpen(record) && !record.data.case?.assignee)!;
    coordinateCase(state, ctx, exception.id, {
      action: 'claim', expectedUpdatedAt: exception.updatedAt, note: 'Claimed after the preparation.', nextAction: 'Check the linked record',
      nextActionAt: new Date(Date.parse(ctx.now) + 86_400_000).toISOString(), evidenceIds: [],
    }, [{ actor: 'Sandbox Admin', name: 'Sandbox Admin', role: 'Admin' }]);
  });
  const [earlier] = records('close-reviews');
  expect(reviewIsCurrent(api.state(), earlier!)).toBe(false);

  const again = await preparePresentation({ merchantId });
  expect(again.steps.filter(step => step.status !== 'already-done')).toEqual([{ id: 'daily-closes', status: 'completed' }, { id: 'close-review', status: 'completed' }]);
  const closes = records('closes');
  expect(closes.map(close => close.data.sourceBusinessDate)).toEqual([...dates, dates[2]]);
  const review = records('close-reviews').find(item => item.id !== earlier!.id)!;
  expect(records('close-reviews')).toHaveLength(2);
  expect(review).toMatchObject({ status: 'awaiting_review', data: { closeId: closes[3]!.id, reviewer: 'Sandbox Finance' } });
  expect(reviewIsCurrent(api.state(), review)).toBe(true);
}, 60_000);

it('keeps the sample checkouts off the demo’s instalments once every seeded instalment is overdue', async () => {
  // Three days on, no seeded instalment comes first for not being due yet.
  install({ now: new Date(Date.now() + 3 * 86_400_000).toISOString() });
  const merchantId = api.merchantIds[0]!;
  const result = await preparePresentation({ merchantId });
  expect(result.steps.find(step => step.id === 'pay-by-bank')).toEqual({ id: 'pay-by-bank', status: 'completed' });
  const references = new Map(records('due-items').map(due => [due.id, due.reference]));
  const used = records('connected-intents').map(checkout => references.get(checkout.data.dueItemId));
  expect(used).toHaveLength(3);
  expect(used).not.toContain('DEMO-LOAN-1003');
  expect(used).not.toContain('PRES-D001');
  // The seeded proposed match is still waiting in Matches to review.
  const proposal = records('allocations').find(allocation => allocation.status === 'proposed')!;
  expect(references.get(proposal.data.dueItemId)).toBe('DEMO-LOAN-1003');
  const waitingMatches = await (await fetch(`/api/v1/reconciliation/proposals?merchantId=${merchantId}`)).json();
  expect(waitingMatches.items.map((item: { id: string }) => item.id)).toEqual([proposal.id]);
}, 60_000);

it('claims no case when fewer than 3 exceptions are open, so 2 stay unclaimed for the demo', async () => {
  api.mutate(state => {
    const open = state.records.filter(record => record.kind === 'exceptions' && isOpen(record));
    for (const exception of open.slice(2)) exception.status = 'resolved';
  });
  expect(records('exceptions').filter(isOpen)).toHaveLength(2);
  const result = await preparePresentation({ merchantId: api.merchantIds[0]! });
  expect(result.steps.find(step => step.id === 'case')).toEqual({
    id: 'case', status: 'failed',
    reason: 'Fewer than 3 exceptions are open, so none was claimed: 2 must stay unclaimed for your demo. For a fresh sandbox, use a private browser window.',
  });
  expect(result.failed).toBe(1);
  expect(records('case-events')).toEqual([]);
  expect(records('exceptions').some(exception => exception.data.case?.assignee)).toBe(false);
}, 60_000);

it('leaves the payment file for the live import, which pays PRES-D001 by rule R1 with the confidence Certain', async () => {
  const merchantId = api.merchantIds[0]!;
  expect((await preparePresentation({ merchantId })).failed).toBe(0);
  // Moments 2 and 3: the presenter imports the checked payment file, then runs reconciliation.
  const batch = records('import-batches').find(item => item.data.source === 'Presentation sample' && item.data.kind === 'observations')!;
  expect(batch.status).toBe('ready');
  const send = (path: string, body: unknown) => fetch(`/api/v1${path}?merchantId=${merchantId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body),
  });
  expect((await send(`/pilot/batches/${batch.id}/commit`, { expectedUpdatedAt: batch.updatedAt })).status).toBe(200);
  expect((await send('/actions', { action: 'run_reconciliation' })).status).toBe(200);
  const sample = records('due-items').find(due => due.reference === 'PRES-D001')!;
  expect(sample.status).toBe('paid');
  expect(records('allocations').filter(allocation => allocation.data.dueItemId === sample.id)).toMatchObject([{ data: { rule: 'R1', confidence: 'certain' } }]);
}, 60_000);

it('keeps the presenter’s own demo role in the tab while it runs, and puts it back after a reload cut an earlier run off', async () => {
  const merchantId = api.merchantIds[0]!, key = `valopay-preparation-role:${merchantId}`;
  // A reload during Cash Desk ended an earlier run as Finance, before it could put Admin back.
  sessionStorage.setItem(key, 'Admin');
  api.role = 'Finance';
  const release = api.hold(/^\/v1\/exports$/);
  const running = preparePresentation({ merchantId });
  await waitFor(() => expect(writes.some(write => write.path === '/api/v1/exports')).toBe(true), { timeout: 30_000 });
  expect(sessionStorage.getItem(key)).toBe('Admin');
  release();
  expect(await running).toMatchObject({ failed: 0, role: 'Admin' });
  // Admin, not the role the cut-off run left, did the work and is current again; nothing is kept once it is back.
  expect(records('close-reviews')).toMatchObject([{ data: { preparedBy: 'Sandbox Admin' } }]);
  expect(api.role).toBe('Admin');
  expect(sessionStorage.getItem(key)).toBeNull();
}, 60_000);

it('still puts the demo role back where the browser refuses storage', async () => {
  for (const method of ['getItem', 'setItem', 'removeItem'] as const)
    vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new DOMException('The operation is insecure.', 'SecurityError'); });
  api.role = 'Read-only';
  expect(await preparePresentation({ merchantId: api.merchantIds[0]! })).toMatchObject({ failed: 0, role: 'Read-only' });
  expect(api.role).toBe('Read-only');
  expect(writes.filter(write => write.body.action === 'set_role').at(-1)!.body).toMatchObject({ data: { role: 'Read-only' } });
}, 60_000);

it.each([
  { workspace: 'a staff workspace', change: { accessMode: 'staff', actor: 'Clerk:user_a', authenticated: true }, shown: 'Role: Admin' },
  // The field is optional in the contract: a workspace that leaves it out is not taken for the sandbox.
  { workspace: 'a workspace that does not say it is the sandbox', change: { accessMode: undefined }, shown: 'Demo role: Admin' },
])('is not offered in $workspace, and the runner refuses there before sending anything', async ({ change, shown }) => {
  const fake = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await fake(input, init);
    if (new URL(String(input instanceof Request ? input.url : input), 'http://localhost').pathname !== '/api/v1/workspace') return response;
    return new Response(JSON.stringify({ ...(await response.json()), ...change }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  renderApp('/presentation');
  await screen.findByRole('heading', { level: 1, name: 'Presentation' });
  await screen.findByText(shown);
  expect(screen.queryByRole('region', { name: 'Sample records for the presentation' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Prepare for presentation' })).toBeNull();
  await expect(preparePresentation({ merchantId: api.merchantIds[0]! })).rejects.toThrow('Prepare for presentation works only in the sandbox, with sample data.');
  expect(writes).toEqual([]);
});
