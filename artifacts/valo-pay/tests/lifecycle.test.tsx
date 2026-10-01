import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { screen, userEvent, waitFor, renderApp, within } from './harness';
import { installFakeApi, type FakeApi } from './fake-api';
import { makeRecord } from '../../api-server/src/domain/records';
import { lifecyclePolicy, lifecycleHolds, saveLifecyclePolicy, setLifecycleHold } from '../../api-server/src/domain/lifecycle';

let api: FakeApi, batchId: string;
beforeEach(() => {
  api = installFakeApi({ now: '2026-09-25T10:00:00.000Z' });
  batchId = api.mutate(state => makeRecord(state, 'import-batches', { name: 'Aged sample import', status: 'committed', createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z', data: { csv: 'reference,name\nSAMPLE-ROW,Sample customer', committedAt: '2026-08-01T10:00:00.000Z', rowIds: ['source-1'], recordIds: ['original-record'], check: { valid: 1, invalid: 0, imported: 1, rows: [], preview: [{ row: 1, values: { reference: 'SAMPLE-ROW' } }] } } }).id);
});
afterEach(() => api.uninstall());
function enable() { api.mutate((state, ctx) => saveLifecyclePolicy(state, ctx, { policy: { rawCsvDays: 30, journalPayloadDays: null, exportFileDays: null, auditTrail: 'retain' }, expectedRevision: lifecyclePolicy(state).revision, reason: 'The sample source has passed its retention review.' })); }
async function prepare(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Prepare deletion preview' }));
  await screen.findByRole('heading', { name: 'Check the items to delete' });
}
async function approve(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('checkbox', { name: /I have checked every item/ }));
  await user.type(screen.getByRole('textbox', { name: 'Reason for approving this deletion' }), 'Approved the exact synthetic source after checking the hold rules.');
  await user.click(screen.getByRole('button', { name: 'Approve deletion' }));
}

it('starts disabled and requires a policy, exact preview and explicit approval before raw source deletion', async () => {
  const user = userEvent.setup(); renderApp('/lifecycle');
  const start = await screen.findByRole('button', { name: 'Prepare deletion preview' });
  expect((start as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('checkbox', { name: 'Import files (CSV)' }));
  await user.type(screen.getByRole('textbox', { name: 'Reason for the policy change' }), 'Retain this committed sample source for at least thirty days.');
  await user.click(screen.getByRole('button', { name: 'Save retention policy' }));
  await screen.findByText('Retention policy saved. Saving a policy does not delete data.');
  expect(api.state().records.find(record => record.id === batchId)!.data.csv).toContain('SAMPLE-ROW');
  await waitFor(() => expect((screen.getByRole('button', { name: 'Prepare deletion preview' }) as HTMLButtonElement).disabled).toBe(false));
  await prepare(user);
  expect((screen.getByRole('button', { name: 'Approve deletion' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('list', { name: 'Items in this deletion preview' }).textContent).toContain(batchId);
  expect(api.state().records.find(record => record.id === batchId)!.data.csv).toContain('SAMPLE-ROW');
  await approve(user);
  await screen.findByRole('button', { name: 'Start deletion' });
  expect(api.state().records.find(record => record.id === batchId)!.data.csv).toContain('SAMPLE-ROW');
  const financial = JSON.stringify(api.state().records.filter(record => ['customers', 'payments', 'allocations', 'due-items'].includes(record.kind)));
  await user.click(screen.getByRole('button', { name: 'Start deletion' }));
  await screen.findByRole('heading', { name: 'Deletion records' });
  const saved = api.state().records.find(record => record.id === batchId)!;
  expect(saved.data.csv).toBeUndefined();
  expect(saved.data.check.preview).toBeUndefined();
  expect(saved.data.rowIds).toEqual(['source-1']);
  expect(saved.status).toBe('committed');
  expect(JSON.stringify(api.state().records.filter(record => ['customers', 'payments', 'allocations', 'due-items'].includes(record.kind)))).toBe(financial);
  expect(api.state().records.filter(record => record.kind === 'retention-receipts' && record.data.result === 'deleted')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Start deletion' })).toBeNull();
});

it('shows deletion run and deletion record statuses in words, and keeps the preview codes in closed Technical details', async () => {
  enable(); const user = userEvent.setup(); renderApp('/lifecycle');
  await prepare(user);
  const runs = () => screen.getByRole('heading', { name: 'Deletion runs' }).closest('section')!;
  await waitFor(() => expect(within(runs()).getByText('Waiting for review · 0 deleted')).toBeTruthy());
  const code = screen.getByText(/^Preview code \(SHA-256\): [a-f0-9]+$/).closest('details')!;
  expect(code.open).toBe(false);
  expect(within(code).getByText('Technical details')).toBeTruthy();
  await approve(user);
  await user.click(await screen.findByRole('button', { name: 'Start deletion' }));
  await screen.findByRole('heading', { name: 'Deletion records' });
  expect(screen.getByText('Import file (CSV) · Deleted')).toBeTruthy();
  await waitFor(() => expect(within(runs()).getByText('Completed · 1 deleted')).toBeTruthy());
});

it('blocks approval after another administrator places a hold on the previewed source', async () => {
  enable(); const user = userEvent.setup(); renderApp('/lifecycle');
  await prepare(user);
  api.mutate((state, ctx) => setLifecycleHold(state, ctx, { kind: 'raw_csv', sourceId: batchId, held: true, expectedHoldRevision: lifecycleHolds(state).revision, reason: 'This source is needed for a new sample investigation.' }));
  await approve(user);
  await screen.findByText(/A previewed source changed, is held or is no longer eligible/);
  expect(api.state().records.find(record => record.id === batchId)!.data.csv).toContain('SAMPLE-ROW');
  expect(api.state().records.filter(record => record.kind === 'retention-receipts')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Start deletion' })).toBeNull();
});

it('recovers an execution whose committed response was lost using the identical request identity', async () => {
  enable(); const user = userEvent.setup(); renderApp('/lifecycle');
  await prepare(user); await approve(user);
  await screen.findByRole('button', { name: 'Start deletion' });
  const baseFetch = globalThis.fetch;
  let lose = true;
  const requests: Array<{ body: string; key: string }> = [], saved = new Map<string, Response>();
  globalThis.fetch = async (input, options) => {
    if (!String(input).includes('/execute')) return baseFetch(input, options);
    const key = new Headers(options?.headers).get('Idempotency-Key')!;
    requests.push({ key, body: String(options?.body) });
    if (saved.has(key)) return saved.get(key)!.clone();
    const response = await baseFetch(input, options);
    if (response.ok) saved.set(key, response.clone());
    if (response.ok && lose) { lose = false; throw new TypeError('Lost response after deletion receipt committed'); }
    return response;
  };
  await user.click(screen.getByRole('button', { name: 'Start deletion' }));
  await screen.findByText('Request not confirmed');
  expect((screen.getByRole('button', { name: 'Start deletion' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Check original request' }));
  await screen.findByRole('heading', { name: 'Deletion records' });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(api.state().records.filter(record => record.kind === 'retention-receipts')).toHaveLength(1);
});

/** Two more aged committed batches, so a run has three sources: the first, then these in order. */
function moreBatches() {
  return ['2026-08-02T10:00:00.000Z', '2026-08-03T10:00:00.000Z'].map((at, index) => api.mutate(state => makeRecord(state, 'import-batches', { name: `Aged sample import ${index + 2}`, status: 'committed', createdAt: at, updatedAt: at, data: { csv: `reference,name\nSAMPLE-ROW-${index + 2},Sample customer`, committedAt: at, rowIds: [`source-${index + 2}`], recordIds: [`original-record-${index + 2}`], check: { valid: 1, invalid: 0, imported: 1, rows: [], preview: [] } } }).id));
}
const csvLeft = (ids: string[]) => ids.filter(id => typeof api.state().records.find(record => record.id === id)!.data.csv === 'string').length;
/** Every execute request's Idempotency-Key, in order. */
function executeKeys() {
  const keys: string[] = [], baseFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => { if (String(input).includes('/execute')) keys.push(new Headers(options?.headers).get('Idempotency-Key')!); return baseFetch(input, options); };
  return keys;
}

it('keeps executing an approved run, request after request, until every source is removed', async () => {
  const ids = [batchId, ...moreBatches()];
  enable(); const user = userEvent.setup(); renderApp('/lifecycle');
  await prepare(user); await approve(user);
  const keys = executeKeys(), release = api.hold(/\/execute$/);
  await user.click(await screen.findByRole('button', { name: 'Start deletion' }));
  // While a request runs, the page's status area shows how far the run has got, and Stop takes the focus from Execute, which waits.
  expect((await screen.findByText(/Deleting the approved items\. 0 of 3 items deleted\./)).getAttribute('role')).toBe('status');
  expect(screen.getByRole('progressbar', { name: 'Items deleted' })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Start deletion' }) as HTMLButtonElement).disabled).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stop' }));
  release();
  const outcome = await screen.findByText('Deletion run complete. See its deletion records below.');
  // Stop goes with the run, and reading continues from what happened.
  await waitFor(() => expect(document.activeElement).toBe(outcome));
  // The service removed one source a request here, so the console asked three times, each a new request with its own key.
  expect(api.calls.filter(call => call.path.endsWith('/execute')).map(call => call.status)).toEqual([200, 200, 200]);
  expect(new Set(keys).size).toBe(3);
  expect(csvLeft(ids)).toBe(0);
  expect(api.state().records.filter(record => record.kind === 'retention-receipts' && record.data.result === 'deleted')).toHaveLength(3);
  expect(screen.queryByRole('button', { name: /Start deletion|Continue deletion|Stop/ })).toBeNull();
});

it('stops after the current request when asked, and Resume carries the run on', async () => {
  const ids = [batchId, ...moreBatches()];
  enable(); const user = userEvent.setup(); renderApp('/lifecycle');
  await prepare(user); await approve(user);
  const release = api.hold(/\/execute$/);
  await user.click(await screen.findByRole('button', { name: 'Start deletion' }));
  await user.click(await screen.findByRole('button', { name: 'Stop' }));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stopping…' }));
  expect(screen.getByText(/^Stopping after the current step\./)).toBeTruthy();
  release();
  await screen.findByText('Stopped. Deleted so far: 1 of 3 items. Select Continue deletion to go on. Each item is checked again first.');
  expect(api.calls.filter(call => call.path.endsWith('/execute'))).toHaveLength(1);
  expect(csvLeft(ids)).toBe(2);
  await user.click(screen.getByRole('button', { name: 'Continue deletion' }));
  await screen.findByText('Deletion run complete. See its deletion records below.');
  expect(csvLeft(ids)).toBe(0);
});

it('stops the run at a blocked source and says why', async () => {
  const ids = [batchId, ...moreBatches()];
  enable(); const user = userEvent.setup(); renderApp('/lifecycle');
  await prepare(user); await approve(user);
  api.mutate((state, ctx) => setLifecycleHold(state, ctx, { kind: 'raw_csv', sourceId: ids[1]!, held: true, expectedHoldRevision: lifecycleHolds(state).revision, reason: 'A new sample case needs this source after all.' }));
  await user.click(await screen.findByRole('button', { name: 'Start deletion' }));
  await screen.findByText(`Deletion stopped at Import file (CSV) ${ids[1]}, which is blocked: This source changed, is held or no longer meets the approved policy. Review the source and prepare a fresh preview. Deleted so far: 1 of 3 items.`);
  expect(api.calls.filter(call => call.path.endsWith('/execute'))).toHaveLength(2);
  expect(csvLeft(ids)).toBe(2);
  expect(api.state().records.find(record => record.id === ids[2])!.data.csv).toContain('SAMPLE-ROW-3');
  expect(screen.getByRole('button', { name: 'Continue deletion' })).toBeTruthy();
});

// Second review of the audit fixes, console finding 2: a run that stops on a failed or lost request says so, and focus goes there.
/** Answers the run's second execute request as `how` says; the others reach the service. */
function secondExecute(how: '502' | 'lost' | 'refused') {
  const baseFetch = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = async (input, options) => {
    if (!String(input).includes('/execute') || ++sent !== 2) return baseFetch(input, options);
    // A proxy's error page: nothing says whether the service did anything.
    if (how === '502') return new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } });
    if (how === 'refused') return new Response(JSON.stringify({ error: 'The approved preview does not match.' }), { status: 409, headers: { 'content-type': 'application/json' } });
    // The service removes the second source, and its answer never arrives.
    await baseFetch(input, options);
    throw new TypeError('Failed to fetch');
  };
}
async function runByKeyboard(user: ReturnType<typeof userEvent.setup>) {
  (await screen.findByRole('button', { name: 'Start deletion' })).focus();
  await user.keyboard('{Enter}');
}
for (const [how, said, removed] of [
  ['502', 'Deletion stopped because its last request was not confirmed. It may have deleted more items. Select Check original request above to find out. Deleted so far: 1 of 3 items.', 1],
  ['lost', 'Deletion stopped because its last request was not confirmed. It may have deleted more items. Select Check original request above to find out. Deleted so far: 1 of 3 items.', 2],
  ['refused', 'Deletion stopped because its last request was refused: The approved preview does not match. Deleted so far: 1 of 3 items.', 1],
] as const) it(`says where a run stopped when its request is ${how === '502' ? 'answered 502' : how === 'lost' ? 'lost' : 'refused'}, and reading continues from there`, async () => {
  const ids = [batchId, ...moreBatches()];
  enable(); const user = userEvent.setup(); renderApp('/lifecycle');
  await prepare(user); await approve(user);
  secondExecute(how);
  await runByKeyboard(user);
  const outcome = await screen.findByText(said);
  // Stop went with the run: focus is on what happened, never on the page body.
  await waitFor(() => expect(document.activeElement).toBe(outcome));
  expect(csvLeft(ids)).toBe(3 - removed);
  if (how === 'refused') expect(screen.queryByText('Request not confirmed')).toBeNull();
  else {
    expect(screen.getByText('Request not confirmed')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Check original request' }));
    await waitFor(() => expect(screen.queryByText('Request not confirmed')).toBeNull());
  }
});

// Third review of the audit fixes, finding 6: Discard original request moved focus to the nearest control above its
// notice, the tips (then the Sandbox guide) at the top of the page, rather than to the run it had been carrying on.
it('moves focus from a discarded run request back to the run, never to the tips above the page', async () => {
  moreBatches(); enable(); const user = userEvent.setup(); renderApp('/lifecycle');
  await prepare(user); await approve(user);
  secondExecute('lost');
  await runByKeyboard(user);
  await screen.findByText(/^Deletion stopped because its last request was not confirmed/);
  expect(screen.getByRole('button', { name: /^Tips/ })).toBeTruthy();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  screen.getByRole('button', { name: 'Discard original request' }).focus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Discard original request' })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /^(Start|Continue) deletion$/ })));
});

it('keeps retention details and controls unavailable to non-administrators', async () => {
  api.role = 'Finance'; renderApp('/lifecycle?run=retention-run-1');
  await screen.findByText('Only Admin can view or change data retention. Your role is Finance. Change your demo role in Settings.');
  expect(screen.queryByRole('button', { name: 'Save retention policy' })).toBeNull();
  expect(api.calls.filter(call => call.path.startsWith('/v1/lifecycle'))).toHaveLength(0);
});

it('tells a pilot member who is not an Admin to ask an Admin about holds and deletion runs', async () => {
  api.role = 'Finance';
  // A staff pilot has no demo roles, so the refusal names the person to ask instead.
  const send = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const response = await send(input, options);
    if (new URL(String(input instanceof Request ? input.url : input), 'http://localhost').pathname !== '/api/v1/workspace') return response;
    return new Response(JSON.stringify({ ...(await response.json()), accessMode: 'staff', actor: 'Clerk:user_a' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    renderApp('/lifecycle');
    expect(await screen.findByText('Only Admin can view or change data retention. Your role is Finance. Ask an Admin about holds and deletion runs.')).toBeTruthy();
    expect(screen.queryByText(/Change your demo role/)).toBeNull();
    expect(api.calls.filter(call => call.path.startsWith('/v1/lifecycle'))).toHaveLength(0);
  } finally { globalThis.fetch = send; }
});

it('says when the retention run the address names is not in this lender, and keeps the page usable', async () => {
  renderApp('/lifecycle?run=retention-run-elsewhere');
  await screen.findByText('Retention run not found in this lender.');
  expect(api.calls.some(call => call.method === 'GET' && call.path === '/v1/lifecycle/runs/retention-run-elsewhere')).toBe(true);
  expect(screen.getByRole('button', { name: 'Prepare deletion preview' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Approved deletion run' })).toBeNull();
});

it('lets an administrator place an exact artifact hold with an accountable reason', async () => {
  enable(); const user = userEvent.setup(); renderApp('/lifecycle');
  const target = await screen.findByRole('combobox', { name: 'Item to hold or release' });
  await user.selectOptions(target, `raw_csv:${batchId}`);
  await user.type(screen.getByRole('textbox', { name: 'Reason for the hold decision' }), 'Preserve this source while a sample case is reviewed.');
  await user.click(screen.getByRole('button', { name: 'Place a hold' }));
  await screen.findByText('Hold updated. Every deletion checks the current holds first.');
  await waitFor(() => expect((screen.getByRole('button', { name: 'Prepare deletion preview' }) as HTMLButtonElement).disabled).toBe(true));
  expect(api.state().records.filter(record => record.kind === 'retention-holds' && record.data.held)).toHaveLength(1);
  expect(api.state().records.find(record => record.id === batchId)!.data.csv).toContain('SAMPLE-ROW');
});

it('says why an export file kept as evidence is never offered for deletion', async () => {
  api.mutate((state, ctx) => saveLifecyclePolicy(state, ctx, { policy: { rawCsvDays: 30, journalPayloadDays: null, exportFileDays: 30, auditTrail: 'retain' }, expectedRevision: lifecyclePolicy(state).revision, reason: 'Sample sources and files have passed their retention review.' }));
  const exportId = api.mutate(state => makeRecord(state, 'exports', { name: 'Sample customer pack', status: 'ready', createdAt: '2026-08-02T10:00:00.000Z', data: { kind: 'customer-pack', format: 'json', bucket: 'synthetic-private', objectName: 'exports/sample.json', checksum: 'c'.repeat(64), generatedAt: '2026-08-02T10:00:00.000Z' } }).id);
  const caseId = api.mutate(state => makeRecord(state, 'exceptions', { name: 'Open sample case', status: 'in_progress', createdAt: '2026-08-02T10:00:00.000Z', data: { type: 'unmatched_payment', case: { assignee: 'Sandbox Admin', assigneeName: 'Sandbox Admin', nextAction: 'Review the linked export', nextActionAt: '2026-10-01T10:00:00.000Z', evidenceIds: [exportId] } } }).id);
  api.lifecycleExternal = [{ kind: 'export_file', merchantId: api.merchantIds[0]!, sourceId: exportId, version: 'generation-1', createdAt: '2026-08-02T10:00:00.000Z', label: 'Private export file', digest: 'd'.repeat(64), status: 'ready' }];
  const user = userEvent.setup(); renderApp('/lifecycle');
  await screen.findByText(/1 item can be deleted now · 1 kept as evidence/);
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Item to hold or release' }), `export_file:${exportId}`);
  expect(screen.getByText(new RegExp(`It is kept as evidence \\(linked to open case ${caseId}\\), so it cannot be deleted`))).toBeTruthy();
  expect(screen.getByRole('option', { name: new RegExp(`${exportId} · Kept as evidence`) })).toBeTruthy();
});

it('explains the retention minimum, and in the sandbox that a pilot needs a second administrator to approve a run', async () => {
  enable();
  const user = userEvent.setup(); renderApp('/lifecycle');
  expect(await screen.findByText('The sandbox keeps every category for at least 30 days, the time an inactive sandbox is kept. A pilot keeps evidence for six years.')).toBeTruthy();
  expect(screen.getByRole('spinbutton', { name: 'Import files (CSV): keep for at least (days)' }).getAttribute('min')).toBe('30');
  await prepare(user);
  expect(screen.getByText(/In a pilot, an Admin other than the one who prepared a preview must approve it\. In this sandbox one person plays every role, so here you may approve your own preview\./)).toBeTruthy();
  await approve(user);
  await screen.findByRole('button', { name: 'Start deletion' });
});

it('keeps a pilot administrator from approving the preview they prepared', async () => {
  enable();
  // A staff pilot's view: its minimums, and a second administrator approves each run.
  const send = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const response = await send(input, options);
    if (new URL(String(input instanceof Request ? input.url : input), 'http://localhost').pathname !== '/api/v1/lifecycle' || (options?.method ?? 'GET') !== 'GET') return response;
    return new Response(JSON.stringify({ ...(await response.json()), secondApprover: true, minimumDays: { rawCsvDays: 2192, journalPayloadDays: 366, exportFileDays: 2192 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const user = userEvent.setup(); renderApp('/lifecycle');
  expect(await screen.findByText(/In this pilot, import files and export files are kept for at least 2,192 days \(six years\)/)).toBeTruthy();
  await prepare(user);
  expect(screen.getByText('You prepared this preview, so another Admin must approve it. Either of you can then start the deletion.')).toBeTruthy();
  await user.click(screen.getByRole('checkbox', { name: /I have checked every item/ }));
  await user.type(screen.getByRole('textbox', { name: 'Reason for approving this deletion' }), 'Approving my own preview is not allowed in a pilot.');
  expect((screen.getByRole('button', { name: 'Approve deletion' }) as HTMLButtonElement).disabled).toBe(true);
  globalThis.fetch = send;
});
