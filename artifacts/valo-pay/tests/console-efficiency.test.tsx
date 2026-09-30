import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { closeHistory } from '@/lib/close-history';
import { fireEvent } from '@testing-library/react';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe('console efficiency', () => {
  it('saves and restores a filter combination only for its own lender', async () => {
    const user = userEvent.setup();
    renderApp('/exceptions?view=overdue&owner=Finance&type=unallocated_payment&q=private-customer-search');
    await screen.findByRole('tab', { name: /All open \(\d+\)/ });
    await user.click(screen.getByText('Saved views'));
    await user.type(screen.getByLabelText('View name'), 'Finance follow-up');
    await user.click(screen.getByRole('button', { name: 'Save current view' }));
    expect(await screen.findByText('Saved Finance follow-up.')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Filter exceptions by team'), '');
    await user.click(screen.getByRole('button', { name: 'Finance follow-up' }));
    await waitFor(() => expect((screen.getByLabelText('Filter exceptions by team') as HTMLSelectElement).value).toBe('Finance'));
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toMatchObject({ view: 'overdue', owner: 'Finance', type: 'unallocated_payment' });
    expect(JSON.parse(localStorage.getItem(`valopay-queue-views-v2:Sandbox Admin:${api.merchantIds[0]}:exceptions`) || 'null')).toEqual([
      { name: 'Finance follow-up', view: 'overdue', owner: 'Finance', type: 'unallocated_payment' },
    ]);
    expect(new URLSearchParams(window.location.search).has('q')).toBe(false);
    await user.selectOptions(screen.getByLabelText('Active lender', { selector: '#lender-sidebar' }), api.merchantIds[1]!);
    await user.click(screen.getByText('Saved views'));
    expect(screen.queryByRole('button', { name: 'Finance follow-up' })).toBeNull();
    await user.selectOptions(screen.getByLabelText('Active lender', { selector: '#lender-sidebar' }), api.merchantIds[0]!);
    await user.click(screen.getByText('Saved views'));
    await user.click(screen.getByRole('button', { name: 'Delete saved view Finance follow-up' }));
    expect(screen.queryByRole('button', { name: 'Finance follow-up' })).toBeNull();
    expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
  });

  // Backlog item UX-B06-X1: views saved before search text stopped being stored kept it under the v1 keys, which nothing
  // read or removed; and a stored view's search was still applied when opened.
  it('removes the views an earlier build saved with search text, and never applies a stored search', async () => {
    const user = userEvent.setup();
    const lender = api.merchantIds[0]!;
    localStorage.setItem(`valopay-queue-views-v1:${lender}:exceptions`, JSON.stringify([{ name: 'Old', view: 'open', owner: '', type: '', q: 'Ada Okonkwo' }]));
    localStorage.setItem(`valopay-queue-views-v1:${api.merchantIds[1]}:mandates`, '[]');
    localStorage.setItem('valopay-theme', 'dark');
    localStorage.setItem(`valopay-queue-views-v2:Sandbox Admin:${lender}:exceptions`, JSON.stringify([{ name: 'Edited by hand', view: 'overdue', owner: 'Finance', type: '', q: 'private-customer-search' }]));
    renderApp('/exceptions');
    await screen.findByRole('tab', { name: /All open \(\d+\)/ });
    expect(Object.keys(localStorage).filter(key => key.startsWith('valopay-queue-views-v1:'))).toEqual([]);
    expect(localStorage.getItem('valopay-theme')).toBe('dark');
    await user.click(screen.getByText('Saved views'));
    await user.click(screen.getByRole('button', { name: 'Edited by hand' }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('owner')).toBe('Finance'));
    expect(new URLSearchParams(window.location.search).has('q')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Delete saved view Edited by hand' }));
    expect(localStorage.getItem(`valopay-queue-views-v2:Sandbox Admin:${lender}:exceptions`)).toBe('[]');
  });

  it('does not claim a view was saved when browser storage fails', async () => {
    const user = userEvent.setup();
    renderApp('/collections');
    await screen.findByRole('table');
    await user.click(screen.getByText('Saved views'));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    await user.type(screen.getByLabelText('View name'), 'My collections');
    await user.click(screen.getByRole('button', { name: 'Save current view' }));
    expect(await screen.findByText(/This browser could not save the view/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'My collections' })).toBeNull();
  });

  it('requests bounded exception pages and keeps full queue counts', async () => {
    const user = userEvent.setup();
    api.mutate(state => {
      const sample = state.records.find(row => row.kind === 'exceptions')!;
      state.records = state.records.filter(row => row.kind !== 'exceptions');
      state.records.push(...Array.from({ length: 105 }, (_, i) => ({ ...sample, id: randomUUID(), status: 'open', data: { ...sample.data, owner: 'Finance', severity: 'medium', dueBy: new Date(Date.UTC(2020, 0, i + 1)).toISOString() } })));
    });
    renderApp('/exceptions');
    await screen.findByRole('tab', { name: 'All open (105)' });
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(26);
    await user.click(screen.getByRole('button', { name: 'Next page of exceptions' }));
    await screen.findByText('Page 2 of 5');
    expect(screen.getByRole('tab', { name: 'All open (105)' })).toBeTruthy();
    expect(api.calls.filter(call => call.path === '/v1/queues/exceptions').map(call => call.query.offset)).toEqual(['0', '25']);
    expect(api.calls.some(call => /^\/v1\/records\/(exceptions|customers)$/.test(call.path))).toBe(false);
    await user.click(screen.getByRole('tab', { name: 'Resolved (0)' }));
    await screen.findByText('No resolved exceptions yet');
    expect(api.calls.filter(call => call.path === '/v1/queues/exceptions').at(-1)?.query.offset).toBe('0');
  });

  it('shows report actions in their relevant view and validates a bookmarked date range', async () => {
    const user = userEvent.setup();
    renderApp('/reports?from=2026-10-01&to=2026-09-01');
    await screen.findByText('The From date must be on or before the To date.');
    expect(screen.getByRole('button', { name: 'Run daily close' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Issue invoice' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Billing' }));
    expect(await screen.findByRole('heading', { name: 'Billing statement · current period' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Issue invoice' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run daily close' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Pilot evidence' }));
    expect(await screen.findByRole('heading', { name: 'Operational evidence' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Billing statement · current period' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Operations' }));
    await user.click(screen.getByRole('button', { name: 'Clear dates' }));
    expect(await screen.findByText('No daily closes yet')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('From date (WAT)'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('To date (WAT)'), { target: { value: '2026-09-19' } });
    expect(new URLSearchParams(window.location.search).has('from')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Apply dates' }));
    expect(await screen.findByText(/Showing 0 recorded closes from 1 Sept 2026 to 19 Sept 2026/)).toBeTruthy();
  });
});

describe('recorded closing positions', () => {
  const close = (id: string, at: string, kobo?: number, exceptions?: number) => ({ id, createdAt: at, data: { report: { unallocated: { kobo }, exceptions: { openAtClose: exceptions } } } });
  it('includes full WAT days and compares positions without summing them', () => {
    const rows = [close('1', '2026-09-18T22:59:59Z', 9000, 7), close('2', '2026-09-18T23:00:00Z', 5000, 3), close('3', '2026-09-19T22:59:59Z', 2000, 1), close('4', '2026-09-19T23:00:00Z', 0, 0)];
    const result = closeHistory(rows, '2026-09-19', '2026-09-19');
    expect(result.items.map(row => row.id)).toEqual(['3', '2']);
    expect(result.metrics.map(metric => metric.change)).toEqual([-3000, -2]);
    // The close list carries naira only, and the label says so: money in another currency is in each close's details.
    expect(result.metrics[0]!.label).toBe('Unallocated payments at close (naira only)');
  });
  it('does not invent missing measurements or compare a single snapshot', () => {
    const first = close('1', '2026-09-18T12:00:00Z');
    expect(closeHistory([first, close('2', '2026-09-19T12:00:00Z', 0, 0)], '', '').metrics.map(metric => metric.change)).toEqual([null, null]);
    expect(closeHistory([close('1', '2026-09-18T12:00:00Z', 0, 0)], '', '').metrics.map(metric => metric.change)).toEqual([null, null]);
    expect(closeHistory([first], '2026-02-30', '').error).toBeTruthy();
  });
});
