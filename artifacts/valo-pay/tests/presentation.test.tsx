import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { presentationSamples, presenterBrief } from '@/lib/presenter-brief';
import { queryClient } from '@/App';
import { Layout } from '@/components/layout';
import { PresentationProvider } from '@/components/presentation-guide';
import { WorkspaceProvider } from '@/lib/workspace-context';
import { seedMerchant } from '../../api-server/src/lib/valopay-seed';
import { saveImportBatch, commitImportBatch } from '../../api-server/src/domain/pilot-workflow';
import { reconcile } from '../../api-server/src/domain/reconciliation';
import { pageReconciliation } from '../../api-server/src/lib/console-read-models';
import type { Context, DomainState } from '../../api-server/src/domain/types';

let api: FakeApi;
beforeEach(() => { sessionStorage.clear(); api = installFakeApi(); });
afterEach(() => { api.uninstall(); sessionStorage.clear(); });

/** The pack as the rehearsal imports it: each file saved, checked and committed once through the real batch functions. */
function importPack(state: DomainState, ctx: Context, date = '2026-09-22') {
  const kinds = ['customers', 'due-items', 'observations'] as const;
  return presentationSamples(date).map((sample, index) => {
    const input = { name: sample.kind, kind: kinds[index]!, source: 'Presentation sample', sourceBatchId: sample.filename, businessDate: date, identityColumn: 'source_row_id', amountUnit: 'naira' as const, syntheticOnly: true as const, mapping: {}, csv: sample.csv };
    const batch = saveImportBatch(state, ctx, input);
    return { input, batch, committed: commitImportBatch(state, ctx, batch.id, batch.updatedAt) };
  });
}
/** Starts the guide at a talking point for the first lender, as the preparation page saves it. */
function presentAt(step: number) {
  sessionStorage.setItem(`valopay-presentation-v1:${JSON.stringify(['Sandbox Admin', api.merchantIds[0]])}`, JSON.stringify({ active: true, step, checked: [] }));
}

it('keeps presentation controls separate from platform actions and resumes after navigation and reload', async () => {
  const user = userEvent.setup();
  renderApp('/presentation');
  await user.click(await screen.findByRole('button', { name: 'Start presentation guide' }));
  let guide = screen.getByRole('region', { name: 'Presentation guide' });
  expect(within(guide).getByText(/Show presenter notes/).closest('details')?.open).toBe(false);
  await user.click(within(guide).getByRole('link', { name: 'Open overview' }));
  await screen.findByRole('heading', { name: 'Operations overview' });
  expect(screen.queryByRole('region', { name: 'Sandbox guide' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Next talking point' }));
  expect(window.location.pathname).toBe('/overview');
  cleanup();
  renderApp('/overview');
  guide = await screen.findByRole('region', { name: 'Presentation guide' });
  expect(within(guide).getByText('2 of 6 · Bring in payment evidence')).toBeTruthy();
  await user.click(within(guide).getByRole('link', { name: 'Open import batches' }));
  await screen.findByRole('heading', { name: 'Import batches' });
  await user.click(screen.getByRole('button', { name: 'End presentation' }));
  expect(screen.queryByRole('region', { name: 'Presentation guide' })).toBeNull();
  expect(api.calls.filter(c => c.method !== 'GET')).toEqual([]);
});

it('separates preparation by lender and clearing checkboxes preserves all records', async () => {
  const user = userEvent.setup(), before = structuredClone(api.state());
  renderApp('/presentation');
  const check = await screen.findByRole('checkbox', { name: /I chose one sample lender/ });
  await user.click(check);
  await user.click(screen.getByRole('button', { name: 'Start presentation guide' }));
  await user.selectOptions(screen.getByLabelText('Active lender', { selector: '#lender-sidebar' }), api.merchantIds[1]!);
  expect(screen.queryByRole('region', { name: 'Presentation guide' })).toBeNull();
  expect(screen.getByText('0 of 6 preparation checks marked')).toBeTruthy();
  await user.selectOptions(screen.getByLabelText('Active lender', { selector: '#lender-sidebar' }), api.merchantIds[0]!);
  expect(screen.getByText('1 of 6 preparation checks marked')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Clear preparation checks' }));
  expect(screen.getByText('0 of 6 preparation checks marked')).toBeTruthy();
  expect(api.state()).toEqual(before);
  expect(api.calls.filter(c => c.method !== 'GET')).toEqual([]);
});

it('ignores malformed saved state and works when browser storage is unavailable', async () => {
  const key = `valopay-presentation-v1:${JSON.stringify(['Sandbox Admin', api.merchantIds[0]])}`;
  sessionStorage.setItem(key, JSON.stringify({ active: true, step: 999, checked: ['build'] }));
  const user = userEvent.setup();
  renderApp('/presentation');
  await screen.findByRole('button', { name: 'Start presentation guide' });
  expect(screen.queryByRole('region', { name: 'Presentation guide' })).toBeNull();
  cleanup();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  renderApp('/presentation');
  await user.click(await screen.findByRole('button', { name: 'Start presentation guide' }));
  expect(screen.getByRole('region', { name: 'Presentation guide' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Next talking point' }));
  expect(screen.getByText('2 of 6 · Bring in payment evidence')).toBeTruthy();
  expect(api.calls.filter(c => c.method !== 'GET')).toEqual([]);
});

it('imports the exact sample pack through batch validation, matches it automatically by rule R1 and refuses duplicate ingestion', () => {
  const state = seedMerchant('presentation-fixture', true);
  const ctx = { actor: 'Presentation rehearsal', role: 'Admin', now: '2026-09-22T10:00:00.000Z' };
  for (const { input, batch, committed } of importPack(state, ctx)) {
    expect(batch.data.check.invalid, JSON.stringify(batch.data.check)).toBe(0);
    expect(batch.status).toBe('ready');
    expect(committed.data.check.imported).toBe(1);
    const repeated = saveImportBatch(state, ctx, { ...input, sourceBatchId: `${input.sourceBatchId}-repeat` });
    expect(repeated.data.check.skipped).toBe(1);
    expect(repeated.data.check.valid).toBe(0);
  }
  const customer = state.records.find(r => r.reference === 'PRES-C001')!;
  const due = state.records.find(r => r.reference === 'PRES-D001')!;
  const observation = state.records.find(r => r.reference === 'PRES-O001')!;
  expect(due.amountKobo).toBe(1_800_050);
  expect(observation.amountKobo).toBe(due.amountKobo);
  expect(observation.customerId).toBe(customer.id);
  expect(observation.data.dueItemId).toBe(due.id);
  reconcile(state, ctx);
  expect(observation.status).toBe('resolved');
  // The payment names its instalment and equals it, so rule R1 matches it automatically and with certainty, for exactly 1,800,050 kobo.
  const allocations = state.records.filter(r => r.kind === 'allocations' && r.data.dueItemId === due.id);
  expect(allocations).toHaveLength(1);
  expect(allocations[0]).toMatchObject({ status: 'confirmed', amountKobo: 1_800_050, data: { rule: 'R1', confidence: 'certain', automatic: true } });
  expect(String(allocations[0]!.data.explanation)).toContain('resolved to instalment PRES-D001');
  const payment = state.records.find(r => r.kind === 'payments' && r.id === allocations[0]!.data.paymentId)!;
  expect(payment).toMatchObject({ status: 'allocated', amountKobo: 1_800_050, data: { allocatedKobo: 1_800_050 } });
  expect(due).toMatchObject({ status: 'paid', data: { outstandingKobo: 0 } });
  // So it is never in Matches to review, which holds only the seeded proposal that step three used to land on.
  const review = pageReconciliation(state, 'proposals', { limit: 100 }, ctx.now).items;
  expect(review.map(r => r.id)).not.toContain(allocations[0]!.id);
  expect(review.map(r => state.records.find(p => p.id === r.data.paymentId)?.reference)).toEqual(['SBX-PAY-1003']);
});

// Integration fix: the kit said to choose Naira for every file, but Import batches offers Payment evidence no unit by
// that name. It names the option each record type offers (amountUnitName).
it('names the amount unit of each sample file as Import batches offers it', async () => {
  const brief = presenterBrief('2026-09-22');
  expect(brief).toContain("In Import batches choose the matching record type and, under Amounts in the source file, Naira (₦), or Main unit (₦, or the row’s own currency) for Payment evidence;");
  expect(brief).not.toMatch(/choose Naira,/);
  renderApp('/presentation');
  expect((await screen.findByText(/^In Import batches, choose each matching record type/)).textContent).toMatch(/^In Import batches, choose each matching record type and, under Amounts in the source file, Naira \(₦\), or Main unit \(₦, or the row’s own currency\) for Payment evidence\. Use source name/);
});

it('opens the sample customer at step three, where the automatic R1 match and its explanation are shown', async () => {
  api.mutate((state, ctx) => { importPack(state, ctx, api.now.slice(0, 10)); reconcile(state, ctx); });
  const customer = api.state().records.find(r => r.kind === 'customers' && r.reference === 'PRES-C001')!;
  presentAt(2);
  const user = userEvent.setup();
  renderApp('/overview');
  const guide = await screen.findByRole('region', { name: 'Presentation guide' });
  expect(within(guide).getByText('3 of 6 · Explain the match')).toBeTruthy();
  const link = within(guide).getByRole('link', { name: 'Open the sample customer' });
  await waitFor(() => expect(link.getAttribute('href')).toBe(`/customers/${customer.id}`));
  await user.click(within(guide).getByText(/Show presenter notes/));
  expect(within(guide).getByText(/rule R1 matched them automatically and with certainty/)).toBeTruthy();
  expect(within(guide).getByText(/never appears in Matches to review/)).toBeTruthy();
  await user.click(link);
  await screen.findByRole('heading', { level: 1, name: 'Presentation customer' });
  const history = screen.getByRole('heading', { name: 'Customer history' }).closest('div.bg-card') as HTMLElement;
  const match = within(history).getByText(/^Matched automatically and with certainty by rule R1\./);
  expect(match.textContent).toContain('Provider reference PRES-O001 resolved to instalment PRES-D001');
  expect(within(match.parentElement!).getByText('₦18,000.50')).toBeTruthy();
  expect(api.calls.filter(c => c.method !== 'GET')).toEqual([]);
});

it('sends step three to the customer search while the sample pack is not imported', async () => {
  presentAt(2);
  renderApp('/overview');
  const guide = await screen.findByRole('region', { name: 'Presentation guide' });
  await waitFor(() => expect(api.calls.some(c => c.path === '/v1/records/customers' && c.query.search === 'PRES-C001')).toBe(true));
  expect(within(guide).getByRole('link', { name: 'Open the sample customer' }).getAttribute('href')).toBe('/customers?q=PRES-C001');
});

/** A page that stops working as it renders. */
function BrokenPage(): never {
  throw new Error('Rendering failed: an internal detail');
}

it('keeps the toolbar and End presentation when a page stops working during a presentation', async () => {
  // The boundary logs what it caught, and React reports the thrown render; neither is the subject here.
  vi.spyOn(console, 'error').mockImplementation(() => { /* silenced */ });
  presentAt(0);
  window.history.replaceState({}, '', '/reports');
  const user = userEvent.setup();
  render(
    <Router>
      <QueryClientProvider client={queryClient}>
        <WorkspaceProvider>
          <PresentationProvider><Layout><BrokenPage /></Layout></PresentationProvider>
        </WorkspaceProvider>
      </QueryClientProvider>
    </Router>,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'We could not display this page' })).toBeTruthy();
  const guide = await screen.findByRole('region', { name: 'Presentation guide' });
  expect(within(guide).getByText('1 of 6 · Start with the work')).toBeTruthy();
  expect(within(guide).getByRole('link', { name: 'Open overview' })).toBeTruthy();
  await user.click(within(guide).getByRole('button', { name: 'End presentation' }));
  expect(screen.queryByRole('region', { name: 'Presentation guide' })).toBeNull();
  // Ending the presentation leaves the page's notice, and every record, as they were.
  expect(screen.getByRole('heading', { level: 1, name: 'We could not display this page' })).toBeTruthy();
  expect(api.calls.filter(c => c.method !== 'GET')).toEqual([]);
});
