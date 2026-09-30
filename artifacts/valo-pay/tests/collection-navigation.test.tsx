import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { collectionReturnTo, recordDestination, safeCollectionReturnTo } from '@/lib/record-navigation';
import { koboToNaira } from '@/lib/money-input';

let api: FakeApi;
beforeEach(() => { api = installFakeApi({ now: '2026-09-18T11:00:00.000Z' }); });
afterEach(() => api.uninstall());

describe('collection record navigation', () => {
  it('opens the exact pending mandate and returns to the same owner and view with row focus', async () => {
    const user = userEvent.setup();
    const mandate = api.state().records.find(record => record.kind === 'mandates' && record.status === 'pending_activation')!;
    const due = api.state().records.find(record => record.kind === 'due-items' && record.data.mandateId === mandate.id)!;
    api.mutate(state => { const item = state.records.find(record => record.id === due.id)!; item.data.owner = 'merchant_manual'; item.data.dueDate = '2000-01-01'; });
    renderApp('/collections?view=overdue&owner=merchant_manual');
    const row = (await screen.findByText(due.reference)).closest('tr')!;
    const link = await within(row).findByRole('link', { name: 'Follow up on mandate activation' });
    await user.click(link);
    const selected = (await screen.findByText(mandate.reference)).closest('tr')!;
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
    await waitFor(() => expect(document.activeElement).toBe(selected));
    await user.click(screen.getByRole('link', { name: 'Back to collections' }));
    const restored = (await screen.findByText(due.reference)).closest('tr')!;
    expect(new URLSearchParams(window.location.search).get('view')).toBe('overdue');
    expect((screen.getByLabelText('Filter collections by owner') as HTMLSelectElement).value).toBe('merchant_manual');
    await waitFor(() => expect(document.activeElement).toBe(restored));
  });

  it('identifies the failed attempt and partially paid instalment in their review links', async () => {
    const failed = api.state().records.find(record => record.kind === 'attempts' && record.status === 'failed')!;
    const failedDue = api.state().records.find(record => record.id === failed.data.dueItemId)!;
    const partPaid = api.state().records.find(record => record.kind === 'due-items' && record.id !== failedDue.id && record.status === 'scheduled')!;
    api.mutate(state => {
      const item = state.records.find(record => record.id === partPaid.id)!;
      item.status = 'partially_paid'; item.data.mandateId = ''; item.data.owner = 'merchant_manual';
    });
    renderApp('/collections');
    const failedRow = (await screen.findByText(failedDue.reference)).closest('tr')!;
    const failedLink = within(failedRow).getByRole('link', { name: 'Review the failed attempt and retry policy' });
    const failedUrl = new URL(failedLink.getAttribute('href')!, window.location.origin);
    expect(failedUrl.pathname).toBe(`/customers/${failedDue.customerId}`);
    expect(failedUrl.searchParams.get('record')).toBe(failed.id);
    expect(failedUrl.hash).toBe(`#record-${failed.id}`);
    const partRow = (await screen.findByText(partPaid.reference)).closest('tr')!;
    const paymentUrl = new URL(within(partRow).getByRole('link', { name: 'Review the remaining amount' }).getAttribute('href')!, window.location.origin);
    expect(paymentUrl.pathname).toBe('/reconciliation');
    expect(paymentUrl.searchParams.get('dueItem')).toBe(partPaid.id);
    expect(paymentUrl.searchParams.get('lender')).toBe(api.merchantIds[0]);
  });

  it('pages long queues and finds a returned row beyond page one', async () => {
    const user = userEvent.setup();
    const mandate = api.state().records.find(record => record.kind === 'mandates' && record.status === 'pending_activation')!;
    const template = api.state().records.find(record => record.kind === 'due-items' && record.data.mandateId === mandate.id)!;
    const rowIds: string[] = [];
    api.mutate(state => {
      for (let i = 0; i < 31; i++) {
        const id = randomUUID(); rowIds.push(id);
        state.records.push({ ...structuredClone(template), id, reference: `PAGE-${i.toString().padStart(2, '0')}`, data: { ...template.data, owner: 'merchant_manual', dueDate: new Date(Date.UTC(2000, 0, i + 1)).toISOString().slice(0, 10) } });
      }
    });
    renderApp(`/collections?owner=merchant_manual&lender=${api.merchantIds[0]}#record-${rowIds[30]}`);
    const returned = (await screen.findByText('PAGE-30')).closest('tr')!;
    await waitFor(() => expect(document.activeElement).toBe(returned));
    expect(screen.getByText('Page 2 of 2')).toBeTruthy();
    expect(within(screen.getByRole('table')).queryByText('PAGE-00')).toBeNull();
    await user.click(within(returned).getByRole('link', { name: 'Follow up on mandate activation' }));
    await screen.findByText(mandate.reference);
    await user.click(screen.getByRole('link', { name: 'Back to collections' }));
    await screen.findByText('PAGE-30');
    expect(screen.getByText('Page 2 of 2')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Previous page of instalments' }));
    expect(await screen.findByText('PAGE-00')).toBeTruthy();
    expect(screen.queryByText('PAGE-30')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Rows per page of instalments'), '50');
    expect(await screen.findByText('PAGE-30')).toBeTruthy();
  });

  it('does not show a cross-lender or external return link', async () => {
    const mandate = api.state().records.find(record => record.kind === 'mandates')!;
    renderApp(`/mandates?record=${mandate.id}&lender=another-lender&returnTo=${encodeURIComponent('/collections?lender=another-lender')}`);
    expect(await screen.findByText('This mandate link belongs to another lender')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Back to collections' })).toBeNull();
    expect(screen.queryByText(mandate.reference)).toBeNull();
  });

  it('paginates mandates without changing the full awaiting-activation count', async () => {
    const user = userEvent.setup();
    const template = api.state().records.find(record => record.kind === 'mandates' && record.status === 'pending_activation')!;
    api.mutate(state => {
      for (let i = 0; i < 30; i++) state.records.push({ ...structuredClone(template), id: randomUUID(), reference: `MANDATE-PAGE-${i}`, data: { ...template.data, activationDeadline: new Date(Date.UTC(2000, 0, i + 1)).toISOString() } });
    });
    const total = api.state().records.filter(record => record.kind === 'mandates' && record.status === 'pending_activation').length;
    renderApp('/mandates?view=awaiting-activation');
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(26);
    expect(screen.getByRole('button', { name: `Awaiting activation (${total})` })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next page of mandates' }));
    await waitFor(() => expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(total - 25 + 1));
    await user.selectOptions(screen.getByLabelText('Rows per page of mandates'), '50');
    await waitFor(() => expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(total + 1));
  });
});

describe('mandate change confirmations', () => {
  it('shows the customer, transition and recovery, then resumes without restoring cancelled attempts', async () => {
    const user = userEvent.setup();
    const mandate = api.state().records.find(record => record.kind === 'mandates' && record.status === 'active')!;
    const customer = api.state().records.find(record => record.id === mandate.customerId)!;
    const due = api.state().records.find(record => record.kind === 'due-items' && record.data.mandateId === mandate.id)!;
    const attemptId = randomUUID();
    api.mutate(state => {
      const attempt = state.records.find(record => record.kind === 'attempts')!;
      state.records.push({ ...structuredClone(attempt), id: attemptId, status: 'scheduled', data: { ...attempt.data, dueItemId: due.id } });
    });
    renderApp(`/mandates?record=${mandate.id}`);
    const row = (await screen.findByText(mandate.reference)).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Suspend' }));
    let dialog = await screen.findByRole('dialog', { name: 'Suspend mandate' });
    const summary = within(dialog).getByRole('region', { name: 'Mandate change summary' });
    expect(within(summary).getByText(customer.name)).toBeTruthy();
    expect(within(summary).getByText(mandate.reference)).toBeTruthy();
    expect(within(summary).getByText('Active')).toBeTruthy();
    expect(within(summary).getByText('Suspended')).toBeTruthy();
    expect(summary.textContent).toContain('Resuming does not restore cancelled attempts');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend mandate' }));
    expect(api.calls.some(call => call.path === '/v1/actions' && (call.body as any)?.action === 'mandate_suspend')).toBe(false);
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Pause while the customer dispute is checked');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend mandate' }));
    await waitFor(() => expect(api.state().records.find(record => record.id === attemptId)?.status).toBe('cancelled'));
    await user.click(await screen.findByRole('button', { name: 'Resume' }));
    dialog = await screen.findByRole('dialog', { name: 'Resume mandate' });
    expect(dialog.textContent).toContain('Cancelled attempts stay cancelled');
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Customer review complete');
    await user.click(within(dialog).getByRole('button', { name: 'Resume mandate' }));
    await waitFor(() => expect(api.state().records.find(record => record.id === mandate.id)?.status).toBe('active'));
    expect(api.state().records.find(record => record.id === attemptId)?.status).toBe('cancelled');
  });

  it('explains reissue as a new mandate and requires fresh consent instead of prefilling old evidence', async () => {
    const user = userEvent.setup();
    const mandate = api.state().records.find(record => record.kind === 'mandates' && record.status === 'pending_activation')!;
    renderApp(`/mandates?record=${mandate.id}`);
    await user.click(await screen.findByRole('button', { name: 'Reissue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reissue mandate' });
    expect(dialog.textContent).toContain('Existing mandate: Expired · New mandate: Awaiting activation');
    expect(dialog.textContent).toContain('Existing instalments are not relinked automatically');
    const consent = within(dialog).getByLabelText(/^New consent evidence/);
    expect((consent as HTMLInputElement).value).toBe('');
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Replace the expired consent link');
    await user.click(within(dialog).getByRole('button', { name: 'Reissue mandate' }));
    expect(consent.getAttribute('aria-invalid')).toBe('true');
    await user.type(consent, 'NEW-SYNTHETIC-CONSENT');
    // A limit is part of the consent: the reissue starts from the current one and the new consent may cover another.
    const limit = within(dialog).getByLabelText(/^Debit limit the new consent covers/) as HTMLInputElement;
    expect(limit.value).toBe(koboToNaira(mandate.amountKobo));
    await user.clear(limit);
    await user.type(limit, '75000');
    await user.click(within(dialog).getByRole('button', { name: 'Reissue mandate' }));
    await waitFor(() => expect(api.state().records.find(record => record.data.reissuedFrom === mandate.id)?.data.consentEvidence).toBe('NEW-SYNTHETIC-CONSENT'));
    expect(api.state().records.find(record => record.id === mandate.id)?.status).toBe('expired');
    const fresh = api.state().records.find(record => record.data.reissuedFrom === mandate.id)!;
    expect(fresh.amountKobo).toBe(7_500_000);
    expect(api.state().records.find(record => record.id === mandate.id)?.amountKobo).toBe(mandate.amountKobo);
    const replacements = await screen.findByRole('region', { name: 'Reissued mandates' });
    await user.click(within(replacements).getByRole('link', { name: fresh.reference || fresh.name }));
    expect(await screen.findByText(fresh.reference)).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get('record')).toBe(fresh.id);
  });
});

describe('collection return addresses', () => {
  it('preserves filters while rejecting other routes, lenders and external destinations', () => {
    const back = collectionReturnTo(new URLSearchParams('view=failed&owner=Finance'), 'lender-1', 'attempt-1');
    expect(safeCollectionReturnTo(back, 'lender-1')).toBe(back);
    expect(safeCollectionReturnTo(back, 'lender-2')).toBeNull();
    for (const unsafe of ['https://example.com/collections?lender=lender-1', '//example.com/collections?lender=lender-1', '/settings?lender=lender-1', '/collections/../settings?lender=lender-1', '/collections?lender=lender-1\n']) expect(safeCollectionReturnTo(unsafe, 'lender-1')).toBeNull();
    const target = new URL(recordDestination('/mandates', 'mandate-1', back, 'lender-1'), 'https://valopay.invalid');
    expect(target.searchParams.get('returnTo')).toBe(back);
    expect(target.searchParams.get('record')).toBe('mandate-1');
  });
});
