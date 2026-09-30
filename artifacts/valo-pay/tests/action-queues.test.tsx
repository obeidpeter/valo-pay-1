import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { formatKobo } from '@/lib/formatters';
import { queueDay } from '@/lib/queue-filters';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe('actionable operational queues', () => {
  it('opens the overdue exceptions queue from the overview and combines its filters in the URL', async () => {
    const user = userEvent.setup();
    renderApp('/overview');
    await user.click(await screen.findByRole('link', { name: /Overdue exceptions/ }));
    expect((await screen.findByRole('tab', { name: 'Overdue (1)' })).getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
    expect(within(screen.getByRole('table')).getByText('Missing consent evidence')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Filter exceptions by team'), 'Finance');
    expect(await screen.findByText('No exceptions match these filters')).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get('view')).toBe('overdue');
    expect(new URLSearchParams(window.location.search).get('owner')).toBe('Finance');
    await user.click(screen.getByRole('tab', { name: 'All open (2)' }));
    expect(within(screen.getByRole('table')).getAllByText('Unallocated payment')).toHaveLength(2);
    expect(new URLSearchParams(window.location.search).get('owner')).toBe('Finance');
  });

  it('supports a shareable exception type filter and puts overdue work ahead of later high severity', async () => {
    api.mutate(state => {
      const exceptions = state.records.filter(record => record.kind === 'exceptions');
      exceptions[0]!.data.dueBy = '2000-01-01T00:00:00Z';
      exceptions[0]!.data.owner = 'Finance';
      exceptions[1]!.data.dueBy = '2099-01-01T00:00:00Z';
      exceptions[1]!.data.severity = 'high';
    });
    renderApp('/exceptions?type=unallocated_payment&owner=Finance');
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect((screen.getByLabelText('Filter exceptions by type') as HTMLSelectElement).value).toBe('unallocated_payment');
    expect(within(table).queryByText('Missing consent evidence')).toBeNull();
    expect(within(table).getAllByRole('row')[1]!.textContent).toContain('Overdue');
  });

  it('shows each failed attempt with its linked amount, deadline, owner and next action', async () => {
    const failed = api.state().records.find(record => record.kind === 'attempts' && record.status === 'failed')!;
    const due = api.state().records.find(record => record.id === failed.data.dueItemId)!;
    renderApp('/collections?view=failed');
    const row = (await screen.findByText(due.reference)).closest('tr')!;
    expect((screen.getByRole('button', { name: 'Failed collection attempts (1)' })).getAttribute('aria-pressed')).toBe('true');
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
    expect(row.textContent).toContain(formatKobo(due.amountKobo));
    expect(row.textContent).toContain('outstanding');
    expect(within(row).getByText('Loan management system')).toBeTruthy();
    expect(within(row).getByText('Insufficient funds')).toBeTruthy();
    expect(within(row).getByText('Review the failed collection attempt and retry policy')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'CSV content' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Import sample data' }));
    expect(screen.getByRole('textbox', { name: 'CSV content' })).toBeTruthy();
  });

  it('filters unpaid instalments due today by owner, excluding completed work', async () => {
    api.mutate(state => {
      const due = state.records.filter(record => record.kind === 'due-items');
      for (const item of due) item.data.dueDate = queueDay(Date.now());
      due.find(item => item.status === 'scheduled')!.data.owner = 'merchant_manual';
    });
    renderApp('/collections?view=due-today&owner=merchant_manual');
    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2));
    expect(within(table).getByText('Lender team')).toBeTruthy();
    expect(within(table).queryByText('Paid')).toBeNull();
    expect(screen.getByRole('button', { name: 'Due today (1)' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('discards a late import preview from the previous lender instead of enabling its import', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    const fakeFetch = globalThis.fetch;
    let release: (response: Response) => void = () => {};
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => String(input).includes('/v1/imports') ? pending : fakeFetch(input, init));
    try {
      renderApp('/collections');
      await screen.findByText('DEMO-LOAN-1004');
      await user.click(screen.getByRole('button', { name: 'Import sample data' }));
      await user.selectOptions(screen.getByLabelText('Amounts in your CSV *'), 'kobo');
      await user.type(screen.getByRole('textbox', { name: 'CSV content' }), 'row_id,name,reference\nr1,Sample instalment,SAMPLE-001');
      await user.click(screen.getByRole('button', { name: 'Check data' }));
      expect(await screen.findByRole('button', { name: 'Checking data…' })).toBeTruthy();
      await user.selectOptions(screen.getAllByLabelText('Active lender')[0]!, api.merchantIds[1]!);
      release(new Response(JSON.stringify({ valid: 1, invalid: 0, rows: [{ row: 1, status: 'valid', message: 'Ready to import.' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      await waitFor(() => expect((screen.getAllByLabelText('Active lender')[0] as HTMLSelectElement).value).toBe(api.merchantIds[1]));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Import data' }).hasAttribute('disabled')).toBe(true));
      expect(screen.queryByText('Ready to import.')).toBeNull();
      expect(screen.getByRole('button', { name: 'Check data' }).hasAttribute('disabled')).toBe(true);
      expect((screen.getByLabelText('CSV content') as HTMLTextAreaElement).value).toBe('');
    } finally { spy.mockRestore(); }
  });

  it('shows activation deadlines in its exact queue and creates mandates from naira input', async () => {
    const user = userEvent.setup();
    api.mutate(state => {
      state.records.find(record => record.kind === 'mandates' && record.status === 'pending_activation')!.data.activationDeadline = '2000-01-01T00:00:00Z';
    });
    renderApp('/mandates?view=overdue');
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Overdue · follow up or reissue')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create synthetic mandate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create synthetic mandate' });
    await user.type(within(dialog).getByLabelText(/Mandate name/), 'New synthetic mandate');
    await user.selectOptions(within(dialog).getByLabelText(/Customer/), api.state().records.find(record => record.kind === 'customers')!.id);
    await user.type(within(dialog).getByLabelText(/Debit limit/), '12,345.67');
    await user.type(within(dialog).getByLabelText(/Provider reference/), 'SAMPLE-NEW-MANDATE');
    await user.type(within(dialog).getByLabelText(/Consent evidence reference/), 'SYNTHETIC-CONSENT');
    await user.selectOptions(within(dialog).getByLabelText(/^Policy/), api.state().records.find(record => record.kind === 'policies')!.id);
    await user.click(within(dialog).getByRole('button', { name: 'Create mandate' }));
    await waitFor(() => expect(api.calls.find(call => call.method === 'POST' && call.path === '/v1/records/mandates')?.body).toMatchObject({ amountKobo: 1234567 }));
  });

  it('offers the mandate customers one searched page at a time, keeping the one chosen', async () => {
    const user = userEvent.setup();
    renderApp('/mandates');
    await user.click(await screen.findByRole('button', { name: 'Create synthetic mandate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create synthetic mandate' });
    const customers = api.state().records.filter(record => record.kind === 'customers');
    const picker = within(dialog).getByLabelText(/Customer/) as HTMLSelectElement;
    await waitFor(() => expect(picker.options.length).toBe(customers.length + 1));
    const listed = () => api.calls.filter(call => call.method === 'GET' && call.path === '/v1/records/customers');
    expect(listed().every(call => call.query.limit === '25'), 'the picker asks for a page, never every customer').toBe(true);
    const [chosen, other] = [customers[0]!, customers.find(customer => customer.id !== customers[0]!.id && !customer.name.includes(customers[0]!.name))!];
    await user.selectOptions(picker, chosen.id);
    await user.type(within(dialog).getByLabelText('Search customers'), other.reference);
    await waitFor(() => expect(listed().some(call => call.query.search === other.reference)).toBe(true));
    await waitFor(() => expect([...picker.options].map(option => option.value)).toEqual(['', chosen.id, other.id]));
    expect(picker.value, 'the chosen customer stays chosen while the person searches').toBe(chosen.id);
  });

  it('starts the next mandate with an empty customer search and no customer chosen', async () => {
    // Second review of the audit fixes, console finding 3.
    const user = userEvent.setup();
    renderApp('/mandates');
    await user.click(await screen.findByRole('button', { name: 'Create synthetic mandate' }));
    let dialog = await screen.findByRole('dialog', { name: 'Create synthetic mandate' });
    const customers = api.state().records.filter(record => record.kind === 'customers');
    const [chosen] = customers;
    await user.type(within(dialog).getByLabelText('Search customers'), chosen!.reference);
    const picker = () => within(dialog).getByLabelText(/Customer/) as HTMLSelectElement;
    await waitFor(() => expect([...picker().options].map(option => option.value)).toEqual(['', chosen!.id]));
    await user.selectOptions(picker(), chosen!.id);
    await user.type(within(dialog).getByLabelText(/Mandate name/), 'Searched synthetic mandate');
    await user.type(within(dialog).getByLabelText(/Debit limit/), '500');
    await user.type(within(dialog).getByLabelText(/Provider reference/), 'SAMPLE-SEARCHED-MANDATE');
    await user.type(within(dialog).getByLabelText(/Consent evidence reference/), 'SYNTHETIC-CONSENT');
    await user.selectOptions(within(dialog).getByLabelText(/^Policy/), api.state().records.find(record => record.kind === 'policies')!.id);
    await user.click(within(dialog).getByRole('button', { name: 'Create mandate' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create synthetic mandate' })).toBeNull());
    expect(api.state().records.some(record => record.kind === 'mandates' && record.reference === 'SAMPLE-SEARCHED-MANDATE')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Create synthetic mandate' }));
    dialog = await screen.findByRole('dialog', { name: 'Create synthetic mandate' });
    expect((within(dialog).getByLabelText('Search customers') as HTMLInputElement).value).toBe('');
    // Every customer is offered again, with none chosen.
    await waitFor(() => expect(picker().options.length).toBe(customers.length + 1));
    expect(picker().value).toBe('');
  });
});
