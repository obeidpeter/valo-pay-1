import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { collectionReturnTo, recordDestination } from '@/lib/record-navigation';
import { queryClient } from '@/App';

let api: FakeApi;
beforeEach(() => { api = installFakeApi({ now: '2026-09-18T11:00:00.000Z' }); });
afterEach(() => api.uninstall());

function targetDue() {
  const proposal = api.state().records.find(record => record.kind === 'allocations' && record.status === 'proposed')!;
  const due = api.state().records.find(record => record.id === proposal.data.dueItemId)!;
  const customer = api.state().records.find(record => record.id === due.customerId)!;
  const back = collectionReturnTo(new URLSearchParams('view=all&owner=merchant_manual'), api.merchantIds[0]!, due.id);
  return { proposal, due, customer, back };
}

describe('collection targets on customer history', () => {
  it('focuses the exact instalment and returns to the original filtered collection row', async () => {
    const user = userEvent.setup();
    const { due, customer, back } = targetDue();
    api.mutate(state => { state.records.find(record => record.id === due.id)!.data.owner = 'merchant_manual'; });
    renderApp(recordDestination(`/customers/${customer.id}`, due.id, back, api.merchantIds[0]!));
    const selected = await screen.findByRole('region', { name: 'Selected collection record' });
    expect(within(selected).getByText(`${due.name} · ${due.reference}`)).toBeTruthy();
    expect(selected.textContent).toContain('Outstanding:');
    await waitFor(() => expect(document.activeElement).toBe(selected));
    expect(screen.getByRole('link', { name: 'Back to Collections' }).getAttribute('href')).toBe(back);
    await user.click(screen.getByRole('link', { name: 'Back to Collections' }));
    const row = (await screen.findByText(due.reference)).closest('tr')!;
    expect(new URLSearchParams(window.location.search).get('view')).toBe('all');
    expect((screen.getByLabelText('Filter instalments by who collects them') as HTMLSelectElement).value).toBe('merchant_manual');
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it('explains a missing linked record without substituting a different customer event', async () => {
    const { customer, due, back } = targetDue();
    renderApp(recordDestination(`/customers/${customer.id}`, 'missing-record', back, api.merchantIds[0]!));
    const selected = await screen.findByRole('region', { name: 'Selected collection record' });
    expect(within(selected).getByRole('heading', { name: 'Record not found' })).toBeTruthy();
    expect(within(selected).queryByText(`${due.name} · ${due.reference}`)).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to Collections' }).getAttribute('href')).toBe(back);
  });

  it('recovers a failed customer-history request while preserving its selected record and return address', async () => {
    const user = userEvent.setup();
    const { due, customer, back } = targetDue();
    api.failNext(/^\/v1\/customers\/[^/]+\/history$/, { status: 503, error: 'History temporarily unavailable.' });
    renderApp(recordDestination(`/customers/${customer.id}`, due.id, back, api.merchantIds[0]!));
    const problem = (await screen.findByText('Unable to load customer history')).closest('[role="alert"]')!;
    expect(screen.queryByText('Record not found')).toBeNull();
    await user.click(within(problem as HTMLElement).getByRole('button', { name: 'Try again' }));
    const selected = await screen.findByRole('region', { name: 'Selected collection record' });
    expect(within(selected).getByText(`${due.name} · ${due.reference}`)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Collections' }).getAttribute('href')).toBe(back);
  });

  it('gives lender guidance before displaying a customer target from another lender', async () => {
    const { due, customer, back } = targetDue();
    renderApp(recordDestination(`/customers/${customer.id}`, due.id, back, api.merchantIds[1]!));
    await screen.findByRole('heading', { name: 'Choose the linked lender' });
    expect(screen.getByText(new RegExp(`This link belongs to ${api.state(api.merchantIds[1]).merchant.name}`))).toBeTruthy();
    expect(screen.queryByRole('heading', { name: customer.name })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Selected collection record' })).toBeNull();
  });
});

describe('collection targets in reconciliation', () => {
  it('shows only proposals for the selected instalment and keeps its safe filtered return link', async () => {
    const { due, proposal, back } = targetDue();
    const otherDue = api.state().records.find(record => record.kind === 'due-items' && record.id !== due.id)!;
    api.mutate(state => {
      state.records.push({ ...structuredClone(proposal), id: randomUUID(), customerId: otherDue.customerId, data: { ...proposal.data, dueItemId: otherDue.id } });
    });
    renderApp(recordDestination('/reconciliation', due.id, back, api.merchantIds[0]!, 'dueItem'));
    const selected = await screen.findByRole('region', { name: 'Selected instalment' });
    await within(selected).findByText(due.reference);
    await waitFor(() => expect(document.activeElement).toBe(selected));
    const table = screen.getByRole('columnheader', { name: 'Confidence and reason' }).closest('table')!;
    await within(table).findByRole('button', { name: 'Confirm match' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText(due.reference)).toBeTruthy();
    expect(within(table).queryByText(otherDue.reference)).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to Collections' }).getAttribute('href')).toBe(back);
    expect(selected.textContent).toContain('Running reconciliation still checks all records for the selected lender.');
  });

  it('shows an empty proposal queue when no match exists for the linked instalment', async () => {
    const { due, back } = targetDue();
    const otherDue = api.state().records.find(record => record.kind === 'due-items' && record.id !== due.id)!;
    renderApp(recordDestination('/reconciliation', otherDue.id, back, api.merchantIds[0]!, 'dueItem'));
    const selected = await screen.findByRole('region', { name: 'Selected instalment' });
    await within(selected).findByText(otherDue.reference);
    await screen.findByText('No matches to review');
    expect(screen.queryByRole('button', { name: 'Confirm match' })).toBeNull();
  });

  it('distinguishes a failed target lookup from a missing instalment and retries in place', async () => {
    const user = userEvent.setup();
    const { due, back } = targetDue();
    api.failNext(/^\/v1\/reconciliation\/proposals$/, { status: 503, error: 'Instalments temporarily unavailable.' });
    renderApp(recordDestination('/reconciliation', due.id, back, api.merchantIds[0]!, 'dueItem'));
    const selected = await screen.findByRole('region', { name: 'Selected instalment' });
    await within(selected).findByText('Unable to load the selected instalment');
    expect(within(selected).queryByText(/Instalment not found/)).toBeNull();
    await user.click(within(selected).getByRole('button', { name: 'Try again' }));
    await within(selected).findByText(due.reference);
    expect(screen.getByRole('link', { name: 'Back to Collections' }).getAttribute('href')).toBe(back);
  });

  it('explains a missing instalment without showing unrelated proposals', async () => {
    const { back } = targetDue();
    renderApp(recordDestination('/reconciliation', 'missing-instalment', back, api.merchantIds[0]!, 'dueItem'));
    await screen.findByText('Instalment not found. It may have been deleted, or it belongs to another lender. Go back to Collections and select Refresh queue.');
    expect(screen.queryByRole('button', { name: 'Confirm match' })).toBeNull();
  });

  it('rejects a cross-lender return link and gives explicit lender guidance', async () => {
    const { due } = targetDue();
    const other = api.merchantIds[1]!;
    const back = collectionReturnTo(new URLSearchParams('view=failed'), other, due.id);
    renderApp(recordDestination('/reconciliation', due.id, back, other, 'dueItem'));
    await screen.findByText('This link belongs to a different lender. Select that lender to review its instalment.');
    expect(screen.queryByRole('link', { name: /Back to Collections/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm match' })).toBeNull();
  });

  it('ignores a run result that finishes after switching lenders and accepts a fresh run for the new lender', async () => {
    const user = userEvent.setup();
    const release = api.hold(/^\/v1\/actions$/);
    renderApp('/reconciliation');
    await user.click(await screen.findByRole('button', { name: 'Run reconciliation' }));
    await screen.findByRole('button', { name: 'Running reconciliation…' });
    await user.selectOptions(screen.getAllByLabelText('Active lender')[0]!, api.merchantIds[1]!);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const reportReads = () => api.calls.filter(call => call.path === '/v1/reconciliation/audit' && call.query.merchantId === api.merchantIds[1]).length;
    const before = reportReads();
    release();
    await waitFor(() => expect(api.calls.some(call => call.path === '/v1/actions' && call.query.merchantId === api.merchantIds[0])).toBe(true));
    // A result is applied only after invalidation finishes; wait beyond that boundary before asserting absence.
    await waitFor(() => { expect(reportReads()).toBeGreaterThan(before); expect(queryClient.isFetching()).toBe(0); expect(queryClient.isMutating()).toBe(0); });
    await screen.findByRole('button', { name: 'Run reconciliation' });
    expect(screen.queryByRole('status', { name: 'Reconciliation result' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Run reconciliation' }));
    await screen.findByRole('status', { name: 'Reconciliation result' });
    expect(api.calls.filter(call => call.path === '/v1/actions').map(call => call.query.merchantId)).toEqual(api.merchantIds);
  });
});
