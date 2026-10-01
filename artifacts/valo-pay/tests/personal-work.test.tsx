import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WorkPage from '@/pages/work';
import { seedMerchant } from '../../api-server/src/lib/valopay-seed';
import { makeRecord } from '../../api-server/src/domain/records';
import { derivePersonalWork, recordWorkReceipt } from '../../api-server/src/domain/personal-work';
import { saveImportBatch, commitImportBatch } from '../../api-server/src/domain/pilot-workflow';
import { previewImportCorrection, proposeImportCorrection } from '../../api-server/src/domain/import-corrections';
import type { DomainState } from '../../api-server/src/domain/types';

const context = vi.hoisted(() => ({ merchantId: 'work-ui', actor: 'Clerk:alice', role: 'Operations', accessMode: undefined as string | undefined }));
vi.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ merchantId: context.merchantId, workspace: { actor: context.actor, role: context.role, accessMode: context.accessMode } }) }));
const people = [{ actor: 'Clerk:alice', name: 'Alice', role: 'Operations' }, { actor: 'Clerk:bob', name: 'Bob', role: 'Finance' }, { actor: 'Clerk:admin', name: 'Administrator', role: 'Admin' }];
const now = '2026-09-25T10:00:00.000Z';
let state: DomainState, originalFetch: typeof fetch;
let requests: Array<{ body: string; key: string }>, responseMode: 'normal' | 'lost' | 'malformed';
let receipts: Map<string, Response>;
function assigned(actor: string, name: string, handover = false) {
  const record = makeRecord<string>(state, 'exceptions', { name, status: 'in_progress', createdAt: now, updatedAt: now, data: { type: 'unallocated_payment', case: { assignee: actor, assigneeName: people.find(person => person.actor === actor)?.name, nextAction: 'Compare the receipt with the instalment.', nextActionAt: '2026-09-24T09:00:00.000Z' } } });
  const event = makeRecord(state, 'case-events', { name: 'Sample assignment', status: 'recorded', createdAt: '2026-09-24T09:00:00.000Z', data: { exceptionId: record.id, action: handover ? 'handover' : 'claim', after: structuredClone(record.data.case) } });
  record.data.case.handoverEventId = event.id;
  record.data.case.eventId = event.id;
  return record;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  context.merchantId = 'work-ui'; context.actor = 'Clerk:alice'; context.role = 'Operations'; context.accessMode = undefined;
  state = seedMerchant(context.merchantId, true); requests = []; receipts = new Map(); responseMode = 'normal';
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const ctx = { actor: context.actor, role: context.role, now };
    try {
      if (url.pathname === '/api/v1/work' && (!options?.method || options.method === 'GET')) return json(derivePersonalWork(state, ctx, people, Object.fromEntries(url.searchParams) as any));
      const action = url.pathname.endsWith('/notifications/read') ? 'read' : 'acknowledge';
      const body = String(options?.body), key = new Headers(options?.headers).get('Idempotency-Key')!;
      requests.push({ body, key });
      if (receipts.has(key)) return receipts.get(key)!.clone();
      const result = json(recordWorkReceipt(state, ctx, people, action, JSON.parse(body)));
      receipts.set(key, result.clone());
      if (responseMode === 'lost') { responseMode = 'normal'; throw new TypeError('Connection lost after save'); }
      if (responseMode === 'malformed') { responseMode = 'normal'; return json({}); }
      return result;
    } catch (error: any) {
      if (error instanceof TypeError) throw error;
      return json({ error: error.message }, error.status || 400);
    }
  };
});
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><WorkPage /></QueryClientProvider>);
}

it('includes pending import corrections in Finance reviews with age and an exact source link', async () => {
  const proposer = { actor: 'Clerk:alice', role: 'Operations', now: '2026-09-24T09:00:00.000Z' };
  const batch = saveImportBatch(state, proposer, { name: 'Work queue sample', source: 'pilot-lms', sourceBatchId: 'work-source', kind: 'customers', csv: 'source_row_id,name,reference,consentProvenance\nqueue-1,Sample payer,WORK-COR-C1,Synthetic consent', identityColumn: 'source_row_id', amountUnit: 'naira', mapping: {}, syntheticOnly: true });
  commitImportBatch(state, proposer, batch.id, batch.updatedAt);
  const target = state.records.find(record => record.data.importIdentity?.batchId === batch.id)!;
  const input = { batchId: batch.id, targetId: target.id, expectedUpdatedAt: target.updatedAt, changes: { name: 'Corrected sample payer' }, syntheticOnly: true as const };
  const preview = previewImportCorrection(state, proposer, input);
  const proposal = proposeImportCorrection(state, proposer, { ...input, previewDigest: preview.previewDigest, reviewer: 'Clerk:bob', reason: 'Correct the name in the source file.', evidence: 'SOURCE-CORRECTION-QUEUE' }, people);
  context.actor = 'Clerk:bob'; context.role = 'Finance';
  const user = userEvent.setup(); mount();
  await screen.findByRole('heading', { name: 'Import correction waiting for review' });
  expect(screen.getByRole('link', { name: 'Review import correction' }).getAttribute('href')).toBe(`/imports?batch=${batch.id}&correction=${proposal.id}`);
  expect(screen.getByText(/Awaiting decision since/)).toBeTruthy();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'review');
  expect(await screen.findByRole('heading', { name: 'Import correction waiting for review' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Mark as read' }));
  await screen.findByText(/Notification marked as read/);
  expect(state.records.filter(record => record.kind === 'import-correction-events')).toHaveLength(0);
});

it('defaults to own current-lender work and exposes genuine filters and empty states', async () => {
  assigned('Clerk:alice', 'Alice sample case'); assigned('Clerk:bob', 'Bob private assignment');
  const user = userEvent.setup(); mount();
  await screen.findByRole('heading', { name: 'Alice sample case' });
  expect(screen.queryByText('Bob private assignment')).toBeNull();
  expect((screen.getByRole('combobox', { name: 'Work queue' }) as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByText('Escalated', { selector: 'span' })).toBeTruthy();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'review');
  await screen.findByText('No work matches this filter');
  expect(screen.getByRole('button', { name: 'Show all work' })).toBeTruthy();
});

it('records reading without resolving the case and retains history', async () => {
  const record = assigned('Clerk:alice', 'Read sample case');
  const user = userEvent.setup(); mount();
  await user.click(await screen.findByRole('button', { name: 'Mark as read' }));
  await screen.findByText(/Notification marked as read/);
  expect(record.status).toBe('in_progress');
  expect(state.records.filter(item => item.kind === 'work-events')).toHaveLength(1);
  expect(await screen.findByText('Notification read · Read sample case')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Read sample case' })).toBeTruthy();
});

it.each(['Cancel', 'Escape'] as const)('returns keyboard focus to the handover opener after %s', async close => {
  assigned('Clerk:alice', 'Handover to review', true);
  const user = userEvent.setup(); mount();
  const opener = await screen.findByRole('button', { name: 'Acknowledge handover' });
  opener.focus();
  await user.keyboard('{Enter}');
  const dialog = screen.getByRole('dialog');
  await user.click(within(dialog).getByRole('checkbox'));
  if (close === 'Cancel') await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  else await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(requests).toHaveLength(0);
  await user.keyboard('{Enter}');
  expect((within(screen.getByRole('dialog')).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
});

it.each([false, true])('handles a delayed acknowledged-queue refresh without losing or stealing focus (moved on: %s)', async movedOn => {
  assigned('Clerk:alice', 'Delayed handover refresh', true);
  const user = userEvent.setup(); mount();
  const opener = await screen.findByRole('button', { name: 'Acknowledge handover' });
  opener.focus();
  await user.keyboard('{Enter}');
  const dialog = screen.getByRole('dialog');
  await user.click(within(dialog).getByRole('checkbox'));
  const send = globalThis.fetch;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (input, options) => {
    if (String(input).includes('/api/v1/work?') && !options?.method) await held;
    return send(input, options);
  };
  await user.click(within(dialog).getByRole('button', { name: 'Acknowledge handover' }));
  const confirmation = await screen.findByText(/Handover acknowledged\. The case/);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
  const filter = screen.getByRole('combobox', { name: 'Show' });
  if (movedOn) filter.focus();
  release();
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Acknowledge handover' })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(movedOn ? filter : confirmation));
  expect(requests).toHaveLength(1);
});

it.each(['lost', 'malformed'] as const)('recovers %s handover responses with the original body/key and no duplicate acknowledgement', async mode => {
  const record = assigned('Clerk:alice', 'Handover sample', true);
  responseMode = mode;
  const user = userEvent.setup(); mount();
  await user.click(await screen.findByRole('button', { name: 'Acknowledge handover' }));
  const dialog = screen.getByRole('dialog');
  expect((within(dialog).getByRole('button', { name: 'Acknowledge handover' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(within(dialog).getByRole('checkbox'));
  await user.click(within(dialog).getByRole('button', { name: 'Acknowledge handover' }));
  await within(dialog).findByText('Request not confirmed');
  expect((within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(dialog).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog')).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Check original request' }));
  await screen.findByText(/Handover acknowledged\. The case/);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(state.records.filter(item => item.kind === 'work-events' && item.data.action === 'acknowledge')).toHaveLength(1);
  expect(record.status).toBe('in_progress');
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByText(/Handover acknowledged\. The case/)));
});

it('rejects a handover changed after the review opened and explains the current assignment check', async () => {
  const record = assigned('Clerk:alice', 'Stale handover', true);
  const user = userEvent.setup(); mount();
  await user.click(await screen.findByRole('button', { name: 'Acknowledge handover' }));
  record.data.case.nextAction = 'New next action'; record.updatedAt = '2026-09-25T10:01:00.000Z';
  const dialog = screen.getByRole('dialog');
  await user.click(within(dialog).getByRole('checkbox'));
  await user.click(within(dialog).getByRole('button', { name: 'Acknowledge handover' }));
  await within(dialog).findByText(/This work item changed/);
  expect(state.records.filter(item => item.kind === 'work-events')).toHaveLength(0);
  expect((within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false);
});

it('shows administrators a scoped team workload without another person’s acknowledgement controls', async () => {
  context.actor = 'Clerk:admin'; context.role = 'Admin';
  assigned('Clerk:alice', 'Alice handover', true); assigned('Clerk:bob', 'Bob case');
  const user = userEvent.setup(); mount();
  await screen.findByText('No work assigned yet');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Work queue' }), 'team');
  await screen.findByRole('heading', { name: 'Workload by team member' });
  expect(screen.getByRole('heading', { name: 'Alice handover' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Bob case' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Acknowledge handover' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Mark as read' })).toBeNull();
});

it('says who can mark work as read or acknowledge a handover, in the refusal pattern, to someone who cannot', async () => {
  const rule = 'Only Admin, Operations, Finance or Compliance reviewer can mark notifications as read or acknowledge handovers, and only with access to this lender.';
  context.actor = 'Clerk:reader'; context.role = 'Read-only';
  mount();
  expect(await screen.findByText(`${rule} Your role is Read-only. Change your demo role in Settings.`)).toBeTruthy();
  cleanup();
  // A staff member in a work role who is not on this lender's list: their role is not a demo role, so an Admin checks their access.
  context.actor = 'Clerk:carol'; context.role = 'Operations'; context.accessMode = 'staff';
  mount();
  expect(await screen.findByText(`${rule} Your role is Operations. Ask an Admin to check your access in Team and access.`)).toBeTruthy();
});

it('keeps keyboard focus off the page body while the next page of work loads, then moves it to the list', async () => {
  // Second review of the audit fixes: paging dropped the list and its pager while the next page loaded.
  for (let i = 0; i < 26; i++) assigned('Clerk:alice', `Paged case ${i}`);
  const user = userEvent.setup(); mount();
  await screen.findByText('1–25 of 26');
  const send = globalThis.fetch;
  let open!: () => void;
  const held = new Promise<void>(resolve => { open = resolve; });
  globalThis.fetch = async (input, options) => { if (String(input).includes('/api/v1/work') && String(input).includes('offset=25')) await held; return send(input, options); };
  screen.getByRole('button', { name: 'Next' }).focus();
  await user.keyboard('{Enter}');
  // The last page leaves Next nowhere to go, so while the page loads Previous has the focus, waiting.
  const previous = screen.getByRole('button', { name: 'Previous' });
  await waitFor(() => expect(previous.getAttribute('aria-disabled')).toBe('true'));
  expect(document.activeElement).toBe(previous);
  expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(25);
  open();
  await screen.findByText('26–26 of 26');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'All work (26)' })));
});

it('paginates a bounded queue without losing total counts', async () => {
  for (let i = 0; i < 26; i++) assigned('Clerk:alice', `Paged case ${i}`);
  const user = userEvent.setup(); mount();
  await screen.findByText('1–25 of 26');
  expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(25);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('26–26 of 26');
  expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(1);
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'All work (26)' })));
});
