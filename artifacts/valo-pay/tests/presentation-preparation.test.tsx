// Prepare for presentation, pressed on the Presentation page against the fake API, which runs the real domain: every
// step through the pages' own requests, then the state the presentation shows, a second press that adds nothing, a
// step that fails and is finished by pressing again, and no offer outside the sandbox.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { closeDates, preparePresentation, preparationSteps } from '@/lib/presentation-preparation';
import { reviewIsCurrent } from '../../api-server/src/domain/close-review';
import { connectedRevision, runConnectedAction } from '../../api-server/src/domain/connected';
import { WAT_OFFSET_MS } from '@workspace/valopay-schema';

let api: FakeApi;
/** Every write the console sent, with its Idempotency-Key and body. */
let writes: Array<{ method: string; path: string; merchantId: string | null; key: string | null; body: Record<string, unknown> }>;
beforeEach(() => {
  sessionStorage.clear();
  api = installFakeApi();
  writes = [];
  const fake = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase(), url = new URL(String(input), 'http://localhost');
    if (method !== 'GET') writes.push({ method, path: url.pathname, merchantId: url.searchParams.get('merchantId'), key: new Headers(init?.headers).get('Idempotency-Key'), body: typeof init?.body === 'string' ? JSON.parse(init.body) : {} });
    return fake(input, init);
  }) as typeof fetch;
});
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

  // Applicant A's assessment, reviewed by a different demo person; Applicant B's refused one.
  const assessments = records('connected-credit-assessments');
  const ready = assessments.find(assessment => assessment.data.scenario === 'ready')!;
  const refused = assessments.find(assessment => assessment.data.scenario === 'refused')!;
  expect(assessments).toHaveLength(2);
  expect(ready.data.createdBy).toBe('Sandbox Admin');
  expect(records('connected-credit-reviews')).toMatchObject([{ customerId: ready.customerId, data: { assessmentRecordId: ready.id, review: { reviewer: 'Sandbox Finance', outcome: 'approve' } } }]);
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
  const roles = writes.filter(write => write.body.action === 'set_role').map(write => (write.body.data as { role: string }).role);
  expect(roles).toEqual(['Finance', 'Admin', 'Finance', 'Admin']);
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

it('carries on a checkout an earlier press left part-way, and replaces a waiting checkout that expired', async () => {
  // Midday in West Africa Time, so the 20 minutes below stay on the same business date.
  api.uninstall();
  api = installFakeApi({ now: `${new Date().toISOString().slice(0, 10)}T11:00:00.000Z` });
  const user = userEvent.setup();
  // An earlier press created and authorised the checkout to be confirmed, then stopped.
  const due = records('due-items').find(item => item.reference === 'DEMO-LOAN-1008')!;
  const reason = 'Sample checkout 1 of 3, prepared for the presentation';
  const left = api.mutate((state, ctx) => {
    const created = runConnectedAction(state, ctx, { action: 'payment.create', data: { dueItemId: due.id, amountKobo: due.amountKobo }, reason, expectedRevision: connectedRevision(state) });
    runConnectedAction(state, ctx, { action: 'payment.authorise', data: {}, recordId: created.id, reason, expectedRevision: connectedRevision(state) });
    return created.id;
  });
  renderApp('/presentation');
  await screen.findByRole('heading', { name: 'Sample records for the presentation' });
  await press(user, ALL_DONE);
  expect(records('connected-intents')).toHaveLength(3);
  expect(records('connected-intents').find(checkout => checkout.id === left)!.data.events.map((event: { status: string }) => event.status)).toEqual(['created', 'authorised', 'pending', 'confirmed']);
  const waiting = records('connected-intents').find(checkout => checkout.status === 'created')!;

  // A checkout waits for the customer for 15 minutes.
  api.setNow(new Date(Date.parse(api.now) + 20 * 60_000).toISOString());
  await press(user, ALL_DONE);
  expect(statuses()).toEqual(preparationSteps.map((step, index) => [`${index + 1}. ${step.label}`, step.id === 'pay-by-bank' ? 'Completed' : 'Already done']));
  const checkouts = records('connected-intents');
  expect(checkouts).toHaveLength(4);
  expect(checkouts.find(checkout => checkout.id === waiting.id)).toMatchObject({ status: 'cancelled' });
  expect(checkouts.find(checkout => checkout.id === waiting.id)!.data.events.at(-1).detail).toBe('This checkout expired, so a new sample checkout replaces it.');
  expect(checkouts.filter(checkout => checkout.status === 'created' && Date.parse(checkout.data.expiresAt) > Date.parse(api.now))).toHaveLength(1);
  expect(api.role).toBe('Admin');
}, 60_000);

it('is not offered in a staff workspace, and the runner refuses there before sending anything', async () => {
  const fake = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await fake(input, init);
    if (new URL(String(input instanceof Request ? input.url : input), 'http://localhost').pathname !== '/api/v1/workspace') return response;
    return new Response(JSON.stringify({ ...(await response.json()), accessMode: 'staff', actor: 'Clerk:user_a', authenticated: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  renderApp('/presentation');
  await screen.findByRole('heading', { level: 1, name: 'Presentation' });
  await screen.findByText('Role: Admin');
  expect(screen.queryByRole('region', { name: 'Sample records for the presentation' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Prepare for presentation' })).toBeNull();
  await expect(preparePresentation({ merchantId: api.merchantIds[0]! })).rejects.toThrow('Prepare for presentation works only in the sandbox, with sample data.');
  expect(writes).toEqual([]);
});
