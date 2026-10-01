import { randomUUID } from 'node:crypto';
import { useState } from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { PageButtons } from '@/components/record-pagination';
import { LoadProblem } from '@/components/load-problem';
import { PilotError, RecoveryNotice } from '@/components/pilot-ui';
import { makeRecord } from '../../api-server/src/domain/records';
import { queueExport } from '../../api-server/src/lib/export-jobs';
import { saveImportBatch } from '../../api-server/src/domain/pilot-workflow';
import { lifecyclePolicy, saveLifecyclePolicy } from '../../api-server/src/domain/lifecycle';
import { queryClient } from '@/App';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe('large customer directory', () => {
  it('requests and renders bounded pages from 10,000 customers, then searches beyond the first page', async () => {
    const user = userEvent.setup();
    api.mutate(state => {
      const sample = state.records.find(record => record.kind === 'customers')!;
      state.records = state.records.filter(record => record.kind !== 'customers');
      state.records.push(...Array.from({ length: 10_000 }, (_, index) => ({
        ...sample, id: randomUUID(), name: `Scale customer ${String(index).padStart(5, '0')}`, reference: `SCALE-${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      })));
    });
    renderApp('/customers');
    await screen.findByText('Scale customer 09999');
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(26);
    const pages = screen.getByRole('navigation', { name: 'Pages of customers' });
    expect(pages.textContent).toContain('1–25 of 10,000 customers');
    await user.click(within(pages).getByRole('button', { name: 'Next page of customers' }));
    await screen.findByText('Scale customer 09974');
    expect(screen.queryByText('Scale customer 09999')).toBeNull();
    const calls = () => api.calls.filter(call => call.path === '/v1/records/customers');
    expect(calls().map(call => [call.query.limit, call.query.offset])).toEqual([['25', '0'], ['25', '25']]);
    const beforeSearch = calls().length;
    // The keys go in without yielding to timers, so however busy the machine, the search's pause cannot end
    // between two of them and the whole text goes out as one search. The pause itself is pinned, on a fake
    // clock, in search-pause.test.ts.
    const typist = userEvent.setup({ delay: null });
    await typist.type(screen.getByRole('textbox', { name: 'Search customers' }), 'Scale customer 00001');
    await screen.findByText('Scale customer 00001');
    expect(calls().length - beforeSearch).toBe(1);
    expect(calls().at(-1)?.query).toMatchObject({ limit: '25', offset: '0', search: 'Scale customer 00001' });
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
    await user.clear(screen.getByRole('textbox', { name: 'Search customers' }));
    await screen.findByText('Scale customer 09999');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Rows per page of customers' }), '100');
    await waitFor(() => expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(101));
    expect(calls().at(-1)?.query).toMatchObject({ limit: '100', offset: '0' });
  });

  it('retries a failed customer request in place without claiming the directory is empty', async () => {
    const user = userEvent.setup();
    api.failNext(/^\/v1\/records\/customers$/, { status: 503, error: 'Directory temporarily unavailable.' });
    renderApp('/customers');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('We could not load customers');
    expect(screen.queryByText('No customers yet')).toBeNull();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByText('Ada Okonkwo');
  });
});

// Second review of the audit fixes, the older focus patterns: paging by keyboard keeps focus on the pager control
// pressed (or on the one still usable at the first or last page), never on the page body or the top of a dialog.
describe('paging by keyboard', () => {
  const press = async (user: ReturnType<typeof userEvent.setup>, control: HTMLElement) => { control.focus(); await user.keyboard('{Enter}'); };
  /** Sixty customers, the newest first: Pager customer 59 heads the first page and Pager customer 00 ends the last. */
  const sixtyCustomers = () => api.mutate(state => {
    const sample = state.records.find(record => record.kind === 'customers')!;
    state.records = state.records.filter(record => record.kind !== 'customers');
    state.records.push(...Array.from({ length: 60 }, (_, index) => ({
      ...sample, id: randomUUID(), name: `Pager customer ${String(index).padStart(2, '0')}`, reference: `PAGER-${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    })));
  });

  it('keeps focus on Next while the next page of customers loads, and moves it to Previous on the last page', async () => {
    const user = userEvent.setup();
    sixtyCustomers();
    renderApp('/customers');
    await screen.findByText('Pager customer 59');
    const pages = screen.getByRole('navigation', { name: 'Pages of customers' });
    const next = within(pages).getByRole('button', { name: 'Next page of customers' });
    const release = api.hold(/^\/v1\/records\/customers$/);
    await press(user, next);
    // The rows and the pager stay while the page loads; the pressed button keeps the focus and waits.
    await waitFor(() => expect(next.getAttribute('aria-disabled')).toBe('true'));
    expect(document.activeElement).toBe(next);
    expect(screen.getByText('Pager customer 59')).toBeTruthy();
    release();
    await screen.findByText('Pager customer 34');
    expect(document.activeElement).toBe(next);
    await press(user, next);
    await screen.findByText('Pager customer 00');
    expect(document.activeElement).toBe(within(pages).getByRole('button', { name: 'Previous page of customers' }));
    const size = within(pages).getByRole('combobox', { name: 'Rows per page of customers' });
    size.focus();
    await user.selectOptions(size, '50');
    await screen.findByText('Pager customer 59');
    expect(document.activeElement).toBe(size);
  });

  it('keeps focus on Next while the next page of audit entries loads', async () => {
    api.mutate(state => {
      const source = state.records.find(record => record.kind === 'audit')!;
      for (let index = 0; index < 60; index++) state.records.push({ ...structuredClone(source), id: `extra-audit-${index}`, name: `Sample event ${index}`, data: { ...source.data, summary: `Sample event ${index}` } });
    });
    const user = userEvent.setup();
    renderApp('/audit');
    await screen.findByRole('table');
    const total = api.state().records.filter(record => record.kind === 'audit').length;
    expect(total).toBeGreaterThan(50);
    expect(total).toBeLessThanOrEqual(75);
    const next = screen.getByRole('button', { name: 'Next page of audit entries' });
    const release = api.hold(/^\/v1\/records\/audit$/);
    await press(user, next);
    await waitFor(() => expect(next.getAttribute('aria-disabled')).toBe('true'));
    expect(document.activeElement).toBe(next);
    release();
    await waitFor(() => expect(next.getAttribute('aria-disabled')).toBeNull());
    expect(api.calls.some(call => call.path === '/v1/records/audit' && call.query.offset === '25')).toBe(true);
    expect(document.activeElement).toBe(next);
    await press(user, next);
    await waitFor(() => expect(api.calls.some(call => call.path === '/v1/records/audit' && call.query.offset === '50')).toBe(true));
    // The last page: Next has nowhere to go, so Previous takes the focus.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Previous page of audit entries' })));
  });

  it('keeps focus on the picker pager control pressed while the next page of customer choices loads', async () => {
    const user = userEvent.setup();
    sixtyCustomers();
    renderApp('/mandates');
    await user.click(await screen.findByRole('button', { name: 'Add mandate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add mandate' });
    await within(dialog).findByText('1–25 of 60 customer choices');
    const next = within(dialog).getByRole('button', { name: 'Next page of customer choices' });
    const release = api.hold(/^\/v1\/records\/customers$/);
    await press(user, next);
    // While the page loads the pager stays and the pressed button keeps the focus, never the top of the dialog.
    await waitFor(() => expect(next.getAttribute('aria-disabled')).toBe('true'));
    expect(document.activeElement).toBe(next);
    release();
    await within(dialog).findByText('26–50 of 60 customer choices');
    await waitFor(() => expect(next.getAttribute('aria-disabled')).toBeNull());
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Next page of customer choices' }));
    await press(user, within(dialog).getByRole('button', { name: 'Next page of customer choices' }));
    await within(dialog).findByText('51–60 of 60 customer choices');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Previous page of customer choices' }));
  });

  it('keeps focus on the allocation picker pager control pressed while the next page of instalment choices loads', async () => {
    const user = userEvent.setup();
    api.mutate(state => {
      const due = state.records.find(record => record.kind === 'due-items' && record.status === 'scheduled')!;
      state.records.push(...Array.from({ length: 60 }, (_, index) => ({ ...structuredClone(due), id: randomUUID(), reference: `PAGER-DUE-${index}` })));
    });
    renderApp('/reconciliation');
    const payments = (await screen.findByRole('heading', { name: 'Unallocated payments' })).parentElement!.parentElement!;
    const row = (await within(payments).findByText('SBX-UNIDENTIFIED-001')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Allocate payment' }));
    const dialog = await screen.findByRole('dialog', { name: 'Allocate payment' });
    const pager = await within(dialog).findByRole('navigation', { name: 'Pages of instalment choices' });
    const total = Number(within(pager).getByText(/^1–25 of \d+ instalment choices$/).textContent!.match(/of (\d+)/)![1]);
    expect(total).toBeGreaterThan(50);
    const next = within(pager).getByRole('button', { name: 'Next page of instalment choices' });
    const release = api.hold(/^\/v1\/records\/due-items$/);
    await press(user, next);
    await waitFor(() => expect(next.getAttribute('aria-disabled')).toBe('true'));
    expect(document.activeElement).toBe(next);
    release();
    await within(dialog).findByText(`26–50 of ${total} instalment choices`);
    await waitFor(() => expect(next.getAttribute('aria-disabled')).toBeNull());
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Next page of instalment choices' }));
  });

  /**
   * Pages a list by keyboard to its last page: while the second page loads, the rows shown and the pager stay and
   * Next keeps the focus, waiting; once the page arrives Next still has it; and on the last page, where Next has
   * nowhere to go, Previous takes it. At no moment is focus on the page body.
   */
  async function pageThrough(user: ReturnType<typeof userEvent.setup>, label: string, request: RegExp, rows: () => number) {
    // A page of several tables (Reconciliation's six) can take a few seconds to render under load.
    const pager = await screen.findByRole('navigation', { name: `Pages of ${label}` }, { timeout: 10_000 });
    const next = within(pager).getByRole('button', { name: `Next page of ${label}` });
    const release = api.hold(request);
    await press(user, next);
    await waitFor(() => expect(next.getAttribute('aria-disabled')).toBe('true'));
    expect(document.activeElement).toBe(next);
    expect(rows()).toBeGreaterThan(0);
    release();
    await waitFor(() => expect(next.getAttribute('aria-disabled')).toBeNull());
    expect(document.activeElement).toBe(next);
    while (!(next as HTMLButtonElement).disabled) {
      await press(user, next);
      await waitFor(() => expect(next.getAttribute('aria-disabled')).toBeNull());
      expect(document.activeElement).not.toBe(document.body);
    }
    await waitFor(() => expect(document.activeElement).toBe(within(pager).getByRole('button', { name: `Previous page of ${label}` })));
  }
  /** Sixty more records of `kind`, copied from one of its sample records `pick` chooses. */
  const sixtyMore = (kind: string, pick: (record: { status: string; customerId: string; reference: string }) => boolean, changes: (index: number) => Record<string, unknown> = () => ({})) => api.mutate(state => {
    const sample = state.records.find(record => record.kind === kind && pick(record))!;
    state.records.push(...Array.from({ length: 60 }, (_, index) => ({ ...structuredClone(sample), id: randomUUID(), reference: `PAGER-${kind}-${index}`, ...changes(index) })));
  });
  const tableRows = () => document.querySelectorAll('main tbody tr').length;

  it('keeps focus on the pager control pressed while the next page of the Exceptions queue loads', async () => {
    const user = userEvent.setup();
    sixtyMore('exceptions', record => record.status === 'open');
    renderApp('/exceptions');
    await pageThrough(user, 'exceptions', /^\/v1\/queues\/exceptions$/, () => document.querySelectorAll('main [id^="record-"]').length);
  });

  it('keeps focus on the pager control pressed while the next page of the Mandates queue loads', async () => {
    const user = userEvent.setup();
    sixtyMore('mandates', record => record.status === 'active');
    renderApp('/mandates');
    await pageThrough(user, 'mandates', /^\/v1\/queues\/mandates$/, tableRows);
  });

  it('keeps focus on the pager control pressed while the next page of the Collections queue loads', async () => {
    const user = userEvent.setup();
    sixtyMore('due-items', record => record.status === 'scheduled');
    renderApp('/collections');
    await pageThrough(user, 'instalments', /^\/v1\/queues\/collections$/, tableRows);
  });

  it('keeps focus on the pager control pressed while the next page of recorded closes loads', async () => {
    const user = userEvent.setup();
    api.mutate(state => {
      state.records.push(...Array.from({ length: 60 }, (_, index) => ({
        id: randomUUID(), merchantId: state.merchant.id, kind: 'closes', name: `Daily close ${index}`, status: 'completed', reference: `PAGER-CLOSE-${index}`, amountKobo: 0, customerId: '',
        createdAt: new Date(Date.UTC(2026, 6, 1 + index, 6)).toISOString(), updatedAt: new Date(Date.UTC(2026, 6, 1 + index, 6)).toISOString(),
        data: { synthetic: true, summary: `Recorded sample close ${index}`, report: { unallocated: { kobo: index * 100, count: index }, exceptions: { openAtClose: index } } },
      })));
    });
    renderApp('/reports');
    await pageThrough(user, 'recorded closes', /^\/v1\/close-history$/, () => document.querySelectorAll('ol[aria-label="Recorded daily closes"] > li').length);
  });

  it('keeps focus on the pager control pressed while the next page of a customer section loads', async () => {
    const user = userEvent.setup();
    const customer = api.state().records.find(record => record.kind === 'payments' && record.customerId)!.customerId;
    sixtyMore('payments', record => record.customerId === customer);
    renderApp(`/customers/${customer}`);
    await pageThrough(user, 'customer payments', /^\/v1\/customers\/[^/]+\/history$/, () => screen.getAllByText(/^PAGER-payments-\d+$/).length);
  });

  it('keeps focus on the pager control pressed while the next page of a reconciliation table loads', async () => {
    const user = userEvent.setup();
    sixtyMore('payments', record => record.reference === 'SBX-UNIDENTIFIED-001');
    renderApp('/reconciliation');
    await pageThrough(user, 'unallocated payments', /^\/v1\/reconciliation\/payments$/, tableRows);
  });
});

// The pilot pages' lists that page by a fixed step keep the same rules: the pressed button keeps the focus while the
// next page loads, and one the first or last page disables passes it to the other.
describe('paging a fixed-step list by keyboard', () => {
  const press = async (user: ReturnType<typeof userEvent.setup>, control: HTMLElement) => { control.focus(); await user.keyboard('{Enter}'); };
  /** Presses Next with the list's answer held: until it arrives, the button stays, waits and keeps the focus. */
  async function nextWhileHeld(user: ReturnType<typeof userEvent.setup>, name: string, hold: () => () => void, focusedWhileLoading = name) {
    // These pages fetch and render a long list first; under load that can take a few seconds.
    const next = await screen.findByRole('button', { name }, { timeout: 10_000 });
    const release = hold();
    await press(user, next);
    await waitFor(() => expect(screen.getByRole('button', { name: focusedWhileLoading }).getAttribute('aria-disabled')).toBe('true'));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: focusedWhileLoading }));
    expect(next.isConnected).toBe(true);
    release();
    await waitFor(() => expect(next.getAttribute('aria-disabled')).toBeNull());
    return next;
  }

  it('keeps focus on Next exports while the next page of saved exports loads', async () => {
    // Saved jobs that have finished (here, failed), since the service queues at most ten at once.
    api.mutate((state, ctx) => { for (let index = 0; index < 60; index++) { const { id } = queueExport(state, ctx, { kind: 'customers', format: 'csv' }, 'sample/private'); const job = state.records.find(record => record.id === id)!; job.status = 'failed'; job.data.error = 'Sample failure.'; } });
    const user = userEvent.setup();
    renderApp('/exports');
    const next = await nextWhileHeld(user, 'Next exports', () => api.hold(/^\/v1\/records\/exports$/));
    expect(document.activeElement).toBe(next);
    await screen.findByText(/^26–50 of \d+$/);
  }, 30_000);

  it('keeps focus on Next batches while the next page of import batches loads', async () => {
    api.mutate((state, ctx) => { for (let index = 0; index < 60; index++) saveImportBatch(state, ctx, { name: `Paged batch ${index}`, kind: 'customers', source: 'Pilot sample', sourceBatchId: `paged-${index}`, csv: `source_row_id,name,reference\nrow-${index},Paged customer ${index},PAGED-${index}`, mapping: {}, amountUnit: 'naira', identityColumn: 'source_row_id', syntheticOnly: true }); });
    const user = userEvent.setup();
    renderApp('/imports');
    const next = await nextWhileHeld(user, 'Next batches', () => api.hold(/^\/v1\/pilot\/batches$/));
    expect(document.activeElement).toBe(next);
  }, 30_000);

  it('keeps focus on Next items while the next page of kept items loads, and on Previous items at the last page', async () => {
    api.mutate((state, ctx) => {
      for (let index = 0; index < 205; index++) makeRecord(state, 'import-batches', { name: `Aged import ${index}`, status: 'committed', createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T10:00:00.000Z', data: { csv: `reference,name\nAGED-${index},Sample customer`, committedAt: '2026-01-01T10:00:00.000Z', rowIds: [`aged-${index}`], recordIds: [], check: { valid: 1, invalid: 0, imported: 1, rows: [], preview: [] } } });
      saveLifecyclePolicy(state, ctx, { policy: { rawCsvDays: 30, journalPayloadDays: null, exportFileDays: null, auditTrail: 'retain' }, expectedRevision: lifecyclePolicy(state).revision, reason: 'The aged sample sources have passed their retention review.' });
    });
    const user = userEvent.setup();
    renderApp('/lifecycle');
    const next = await nextWhileHeld(user, 'Next items', () => api.hold(/^\/v1\/lifecycle$/));
    expect(document.activeElement).toBe(next);
    await nextWhileHeld(user, 'Next items', () => api.hold(/^\/v1\/lifecycle$/), 'Previous items');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Previous items' }));
  }, 30_000);

  it('keeps focus on Next requests while the next page of Request history loads', async () => {
    // The offline API keeps no journal: sixty saved requests are answered here, and each answer can be held.
    const send = globalThis.fetch;
    let gate: Promise<void> | null = null;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost');
      if (url.pathname !== '/api/v1/operations') return send(input, init);
      await gate;
      const offset = Number(url.searchParams.get('offset') || 0);
      const items = Array.from({ length: Math.min(25, 60 - offset) }, (_, index) => ({ id: `operation-${offset + index}`, label: `Saved request ${offset + index}`, actor: 'Sandbox Admin', role: 'Admin', status: 'completed', createdAt: api.now, updatedAt: api.now, message: 'The request completed.', recordId: null, recordKind: null, summary: null }));
      return new Response(JSON.stringify({ items, total: 60, offset }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const hold = () => { let open!: () => void; gate = new Promise<void>(resolve => { open = resolve; }); return () => { gate = null; open(); }; };
    const user = userEvent.setup();
    renderApp('/operations');
    await screen.findByText('Saved request 0');
    const next = await nextWhileHeld(user, 'Next requests', hold);
    expect(document.activeElement).toBe(next);
    await screen.findByText('Saved request 25');
  }, 30_000);
});

// Third review of the audit fixes, finding 5: a page whose request had failed showed the previous page's rows as its own
// whenever it was fetched again (a refresh, a return to the tab), and the problem notice that replaced a pressed pager
// left keyboard focus on the page body.
describe('a page that fails to load', () => {
  const press = async (user: ReturnType<typeof userEvent.setup>, control: HTMLElement) => { control.focus(); await user.keyboard('{Enter}'); };
  const unavailable = { status: 503, error: 'The service is unavailable for a moment.' };
  const sixty = (kind: string, pick: (record: { status: string; reference: string }) => boolean, changes: (index: number) => Record<string, unknown> = () => ({})) => api.mutate(state => {
    const sample = state.records.find(record => record.kind === kind && pick(record))!;
    state.records.push(...Array.from({ length: 60 }, (_, index) => ({ ...structuredClone(sample), id: randomUUID(), reference: `PAGER-${kind}-${index}`, ...changes(index) })));
  });
  /** Sixty customers, the newest first: Pager customer 59 heads the first page. */
  const sixtyCustomers = () => api.mutate(state => {
    const sample = state.records.find(record => record.kind === 'customers')!;
    state.records = state.records.filter(record => record.kind !== 'customers');
    state.records.push(...Array.from({ length: 60 }, (_, index) => ({ ...structuredClone(sample), id: randomUUID(), name: `Pager customer ${String(index).padStart(2, '0')}`, reference: `PAGER-${index}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() })));
  });

  it('never shows the previous page\'s rows as its own once its request has failed, whatever fetches it again', async () => {
    const user = userEvent.setup();
    sixtyCustomers();
    renderApp('/customers');
    await screen.findByText('Pager customer 59');
    api.failNext(/^\/v1\/records\/customers$/, unavailable);
    await press(user, screen.getByRole('button', { name: 'Next page of customers' }));
    expect(await screen.findByText('We could not load customers')).toBeTruthy();
    // Fetched again, as a refresh or a return to the tab does: the page waits as a page of its own, with none of page 1's rows.
    const release = api.hold(/^\/v1\/records\/customers$/);
    const again = queryClient.refetchQueries({ type: 'active' });
    await waitFor(() => expect(screen.queryByText('We could not load customers')).toBeNull());
    expect(screen.queryByText('Pager customer 59')).toBeNull();
    expect(screen.queryByText(/^26–50 of 60 customers$/)).toBeNull();
    release();
    await again;
    await screen.findByText('Pager customer 34');
    expect(screen.queryByText('Pager customer 59')).toBeNull();
  });

  /** Presses Next with its page's request failing: the list's problem notice replaces its pager and takes the focus. */
  async function failingNext(user: ReturnType<typeof userEvent.setup>, next: HTMLElement, request: RegExp, notice: RegExp) {
    api.failNext(request, unavailable);
    await press(user, next);
    const alert = (await screen.findAllByRole('alert')).find(element => notice.test(element.textContent || ''))!;
    expect(alert).toBeTruthy();
    await waitFor(() => expect(next.isConnected).toBe(false));
    const retry = within(alert).queryByRole('button', { name: /^Try again/ });
    await waitFor(() => expect(document.activeElement).toBe(retry ?? alert));
  }

  it('moves focus to the notice that replaced the pager: Customers, the Exceptions queue and a Reconciliation table', async () => {
    const user = userEvent.setup();
    sixtyCustomers();
    sixty('exceptions', record => record.status === 'open');
    sixty('payments', record => record.reference === 'SBX-UNIDENTIFIED-001');
    const { unmount } = renderApp('/customers');
    await failingNext(user, await screen.findByRole('button', { name: 'Next page of customers' }), /^\/v1\/records\/customers$/, /^We could not load customers/);
    unmount();
    const exceptions = renderApp('/exceptions');
    await failingNext(user, await screen.findByRole('button', { name: 'Next page of exceptions' }), /^\/v1\/queues\/exceptions$/, /^We could not load exceptions/);
    exceptions.unmount();
    renderApp('/reconciliation');
    // A table's notice has no button of its own (Refresh queue sits above), so the notice itself takes the focus.
    await failingNext(user, await screen.findByRole('button', { name: 'Next page of unallocated payments' }, { timeout: 10_000 }), /^\/v1\/reconciliation\/payments$/, /^We could not load unallocated payments/);
  }, 30_000);

  it('moves focus to the notice that replaced the page buttons of a pilot list', async () => {
    api.mutate((state, ctx) => { for (let index = 0; index < 60; index++) saveImportBatch(state, ctx, { name: `Paged batch ${index}`, kind: 'customers', source: 'Pilot sample', sourceBatchId: `paged-${index}`, csv: `source_row_id,name,reference\nrow-${index},Paged customer ${index},PAGED-${index}`, mapping: {}, amountUnit: 'naira', identityColumn: 'source_row_id', syntheticOnly: true }); });
    const user = userEvent.setup();
    renderApp('/imports');
    await failingNext(user, await screen.findByRole('button', { name: 'Next batches' }, { timeout: 10_000 }), /^\/v1\/pilot\/batches$/, /^The service is unavailable for a moment\./);
  }, 30_000);

  it('moves focus to the notice that replaced a picker\'s pager, inside its dialog', async () => {
    const user = userEvent.setup();
    sixty('due-items', record => record.status === 'scheduled');
    renderApp('/reconciliation');
    const payments = (await screen.findByRole('heading', { name: 'Unallocated payments' })).parentElement!.parentElement!;
    const row = (await within(payments).findByText('SBX-UNIDENTIFIED-001')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Allocate payment' }));
    const dialog = await screen.findByRole('dialog', { name: 'Allocate payment' });
    await within(dialog).findByText(/^1–25 of \d+ instalment choices$/);
    await failingNext(user, within(dialog).getByRole('button', { name: 'Next page of instalment choices' }), /^\/v1\/records\/due-items$/, /^We could not load instalment choices/);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

// Fourth review of the audit fixes, findings 1 and 2: a failed page sent focus to whichever problem notice rendered first,
// another table's or a change's, even one behind the allocation dialog; and Try again on the failed page dropped focus to
// the page body, whether the page then loaded or failed again.
describe('the notice of the list whose page failed', () => {
  const press = async (user: ReturnType<typeof userEvent.setup>, control: HTMLElement) => { control.focus(); await user.keyboard('{Enter}'); };
  const unavailable = { status: 503, error: 'The service is unavailable for a moment.' };

  it('takes the focus alone: another list\'s notice, a change\'s and a first load\'s never do', async () => {
    const refused = { status: 409, data: { error: 'This change was refused.' } };
    const change = { hasUnconfirmedOutcome: false, isPending: false, error: refused, retryUnconfirmed: async () => undefined, abandonUnconfirmed: () => undefined };
    function Lists() {
      const [failed, setFailed] = useState(false);
      // In tree order before the list's own notice: each of these would find the focus lost first.
      return <main>
        <RecoveryNotice mutation={{ ...change, hasUnconfirmedOutcome: true, error: new TypeError('Failed to fetch') }} persistent={false} />
        <RecoveryNotice mutation={change} persistent={false} />
        <PilotError error={refused} />
        <LoadProblem what="the first load" error={unavailable} retry={() => undefined} />
        <LoadProblem what="other things" pager="other things" error={unavailable} retry={() => undefined} />
        <PilotError error={unavailable} pager="other things" retry={() => undefined} />
        {failed ? <LoadProblem what="things" pager="things" error={unavailable} retry={() => undefined} />
          : <PageButtons label="things" atStart atEnd={false} onPrevious={() => undefined} onNext={() => setFailed(true)} />}
      </main>;
    }
    const user = userEvent.setup();
    render(<Lists />);
    await press(user, screen.getByRole('button', { name: 'Next' }));
    const notice = (await screen.findByText('We could not load things')).parentElement!;
    await waitFor(() => expect(document.activeElement).toBe(within(notice).getByRole('button', { name: 'Try again' })));
  });

  it('keeps focus inside the allocation dialog when its picker page fails while a table behind it shows a problem', async () => {
    const user = userEvent.setup();
    api.mutate(state => {
      const sample = state.records.find(record => record.kind === 'due-items' && record.status === 'scheduled')!;
      state.records.push(...Array.from({ length: 60 }, (_, index) => ({ ...structuredClone(sample), id: randomUUID(), reference: `PAGER-due-${index}` })));
    });
    // The proposed matches cannot be read when the page opens, so their table shows its problem notice.
    api.failNext(/^\/v1\/reconciliation\/proposals$/, unavailable);
    renderApp('/reconciliation');
    await screen.findByText(/We could not load matches to review/, undefined, { timeout: 10_000 });
    const payments = (await screen.findByRole('heading', { name: 'Unallocated payments' })).parentElement!.parentElement!;
    const row = (await within(payments).findByText('SBX-UNIDENTIFIED-001')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Allocate payment' }));
    const dialog = await screen.findByRole('dialog', { name: 'Allocate payment' });
    await within(dialog).findByText(/^1–25 of \d+ instalment choices$/);
    api.failNext(/^\/v1\/records\/due-items$/, unavailable);
    await press(user, within(dialog).getByRole('button', { name: 'Next page of instalment choices' }));
    const notice = (await within(dialog).findByText('We could not load instalment choices')).parentElement!;
    await waitFor(() => expect(document.activeElement).toBe(within(notice).getByRole('button', { name: 'Try again' })));
    expect(dialog.contains(document.activeElement)).toBe(true);
  }, 30_000);

  it('moves focus to the notice of the table whose page failed, not to another table\'s above it', async () => {
    const user = userEvent.setup();
    api.mutate(state => {
      for (let index = 0; index < 30; index++) makeRecord(state, 'observations', { name: `Evidence ${index}`, status: 'unresolved', reference: `PAGER-OBS-${index}`, amountKobo: 100_000 + index, customerId: '', data: { source: 'statement', narration: 'unmatched transfer' } });
    });
    api.failNext(/^\/v1\/reconciliation\/proposals$/, unavailable);
    renderApp('/reconciliation');
    await screen.findByText(/We could not load matches to review/, undefined, { timeout: 10_000 });
    api.failNext(/^\/v1\/reconciliation\/observations$/, unavailable);
    await press(user, await screen.findByRole('button', { name: 'Next page of payment evidence' }, { timeout: 10_000 }));
    const notice = await screen.findByText(/^We could not load payment evidence/);
    await waitFor(() => expect(document.activeElement).toBe(notice));
  }, 30_000);

  /**
   * Pages to a page that fails, then presses its notice's Try again twice: while the service still fails, the notice goes
   * while the page loads (the query shows it loading, having no data) and, when it fails again, takes the focus back; once
   * the service answers, the page arrives and its pager takes the focus back, on the control pressed.
   */
  async function tryAgain(user: ReturnType<typeof userEvent.setup>, next: HTMLElement, request: RegExp, notice: RegExp, arrived: () => Promise<unknown>) {
    const nextName = next.getAttribute('aria-label') || next.textContent!;
    const retry = async () => {
      const alert = await waitFor(() => screen.getAllByRole('alert').find(element => notice.test(element.textContent || ''))!);
      const button = within(alert).getByRole('button', { name: 'Try again' });
      await waitFor(() => expect(document.activeElement).toBe(button));
      return button;
    };
    /** Presses Try again with the page's request held until its notice has gone, as it goes in a browser. */
    const pressRetry = async (button: HTMLElement) => {
      const release = api.hold(request);
      await user.keyboard('{Enter}');
      await waitFor(() => expect(button.isConnected).toBe(false));
      release();
    };
    api.failNext(request, unavailable);
    await press(user, next);
    const first = await retry();
    api.failNext(request, unavailable);
    await pressRetry(first);
    await pressRetry(await retry());
    await arrived();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: nextName })));
  }

  it('keeps the focus through Try again on Customers, whether the page fails again or arrives', async () => {
    const user = userEvent.setup();
    api.mutate(state => {
      const sample = state.records.find(record => record.kind === 'customers')!;
      state.records = state.records.filter(record => record.kind !== 'customers');
      state.records.push(...Array.from({ length: 60 }, (_, index) => ({ ...sample, id: randomUUID(), name: `Pager customer ${String(index).padStart(2, '0')}`, reference: `PAGER-${index}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() })));
    });
    renderApp('/customers');
    await screen.findByText('Pager customer 59');
    await tryAgain(user, screen.getByRole('button', { name: 'Next page of customers' }), /^\/v1\/records\/customers$/, /^We could not load customers/, () => screen.findByText('Pager customer 34'));
  }, 30_000);

  it('keeps the focus through Try again on the Exceptions queue', async () => {
    const user = userEvent.setup();
    api.mutate(state => {
      const sample = state.records.find(record => record.kind === 'exceptions' && record.status === 'open')!;
      state.records.push(...Array.from({ length: 60 }, (_, index) => ({ ...structuredClone(sample), id: randomUUID(), reference: `PAGER-exceptions-${index}` })));
    });
    renderApp('/exceptions');
    await tryAgain(user, await screen.findByRole('button', { name: 'Next page of exceptions' }), /^\/v1\/queues\/exceptions$/, /^We could not load exceptions/, () => screen.findByText(/^26–50 of \d+ exceptions$/));
  }, 30_000);

  it('keeps the focus through Try again on Saved exports', async () => {
    api.mutate((state, ctx) => { for (let index = 0; index < 60; index++) { const { id } = queueExport(state, ctx, { kind: 'customers', format: 'csv' }, 'sample/private'); const job = state.records.find(record => record.id === id)!; job.status = 'failed'; job.data.error = 'Sample failure.'; } });
    const user = userEvent.setup();
    renderApp('/exports');
    await tryAgain(user, await screen.findByRole('button', { name: 'Next exports' }, { timeout: 10_000 }), /^\/v1\/records\/exports$/, /^The service is unavailable for a moment\./, () => screen.findByText(/^26–50 of \d+$/));
  }, 30_000);
});
