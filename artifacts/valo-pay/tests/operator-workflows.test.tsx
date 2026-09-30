import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axe from 'axe-core';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { safeCustomerReturnTo } from '@/lib/record-navigation';
import { queryClient } from '@/App';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); vi.spyOn(window, 'confirm').mockReturnValue(true); });
afterEach(() => api.uninstall());

describe('permissions before a workflow starts', () => {
  it('explains a read-only customer action without opening a form or sending a write', async () => {
    api.role = 'Read-only';
    const user = userEvent.setup(); renderApp('/customers');
    await screen.findByText('Ada Okonkwo');
    const add = screen.getByRole('button', { name: 'Add customer' });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(add.hasAttribute('disabled')).toBe(false);
    add.focus(); expect(document.activeElement).toBe(add);
    const reason = document.getElementById(add.getAttribute('aria-describedby')!);
    expect(reason?.textContent).toBe('Only Admin, Operations or Finance can add or edit customers.');
    await user.click(add);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.calls.some(call => call.method === 'POST')).toBe(false);
    const audit = await axe.run(screen.getByRole('main'));
    expect(audit.violations.filter(issue => ['serious', 'critical'].includes(issue.impact || ''))).toEqual([]);
  });

  it('lets Operations run reconciliation but explains why confirming a match needs Finance', async () => {
    api.role = 'Operations'; renderApp('/reconciliation');
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(confirm.getAttribute('aria-describedby')!)?.textContent).toBe('Only Admin or Finance can confirm a match.');
    expect(screen.getByRole('button', { name: 'Run reconciliation' }).getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add batch' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('requires a different reviewer for an authored template', async () => {
    api.role = 'Compliance reviewer';
    api.mutate(state => { const template = state.records.find(record => record.kind === 'templates')!; template.status = 'submitted'; template.data.author = 'Sandbox Compliance reviewer'; });
    renderApp('/policies');
    const request = await screen.findByRole('button', { name: 'Request changes' });
    expect(request.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(request.getAttribute('aria-describedby')!)?.textContent).toContain('You cannot review your own submission');
    const section = screen.getByRole('heading', { name: 'Notification templates' }).closest('section')!;
    expect(within(section).getByRole('button', { name: 'Approve' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('stops a dialog submission if the workspace role changes while it is open', async () => {
    const user = userEvent.setup(); renderApp('/customers');
    await user.click(await screen.findByRole('button', { name: 'Add customer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add customer' });
    await user.type(within(dialog).getByLabelText('Full name *'), 'Sample customer');
    api.role = 'Read-only';
    await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true));
    expect(within(dialog).getByLabelText('Full name *').getAttribute('value')).toBe('Sample customer');
    expect(api.calls.some(call => call.method === 'POST')).toBe(false);
  });
});

describe('customer consent and return context', () => {
  it('requires consent at the field before a request, with a linked example', async () => {
    const user = userEvent.setup(); renderApp('/customers');
    await user.click(await screen.findByRole('button', { name: 'Add customer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add customer' });
    await user.type(within(dialog).getByLabelText('Full name *'), 'Sample customer');
    await user.type(within(dialog).getByLabelText('Loan software reference *'), 'SAMPLE-NEW');
    const consent = within(dialog).getByLabelText('Consent source or reference *');
    expect(consent.getAttribute('aria-describedby')).toContain('record-consentProvenance-help');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(document.activeElement).toBe(consent);
    expect(consent.getAttribute('aria-invalid')).toBe('true');
    expect(api.calls.some(call => call.method === 'POST' && call.path === '/v1/records/customers')).toBe(false);
    await user.type(consent, 'Signed sample form CONSENT-001');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.state().records.find(record => record.reference === 'SAMPLE-NEW')?.data.consentProvenance).toBe('Signed sample form CONSENT-001');
  });

  it('restores a copied search, page size, page and row focus after customer history', async () => {
    api.mutate(state => {
      const sample = state.records.find(record => record.kind === 'customers')!;
      state.records.push(...Array.from({ length: 80 }, (_, index) => ({ ...sample, id: randomUUID(), name: `Search retained ${index.toString().padStart(3, '0')}`, reference: `RETURN-${index}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() })));
    });
    const user = userEvent.setup();
    renderApp(`/customers?q=Search+retained&page=2&size=50&lender=${api.merchantIds[0]}`);
    const history = (await screen.findAllByRole('link', { name: /View history for Search retained/ }))[0]!;
    const rowId = history.closest('tr')!.id;
    await user.click(history);
    await user.click(await screen.findByRole('link', { name: 'Back to customers' }));
    await waitFor(() => expect(document.activeElement?.id).toBe(rowId));
    expect((screen.getByRole('textbox', { name: 'Search customers' }) as HTMLInputElement).value).toBe('Search retained');
    expect((screen.getByRole('combobox', { name: 'Rows per page of customers' }) as HTMLSelectElement).value).toBe('50');
    expect(screen.getByRole('navigation', { name: 'customers pagination' }).textContent).toContain('51–80 of 80 customers');
    expect(new URLSearchParams(window.location.search).get('page')).toBe('2');
  });

  it('rejects external and other-lender return links', () => {
    const lender = api.merchantIds[0]!;
    expect(safeCustomerReturnTo('https://example.com/customers', lender)).toBeNull();
    expect(safeCustomerReturnTo('/customers?lender=another', lender)).toBeNull();
    expect(safeCustomerReturnTo(`/customers?lender=${lender}&q=Ada#record-123`, lender)).toContain('#record-123');
  });

  it('keeps a copied search when the operator selects its linked lender', async () => {
    const user = userEvent.setup();
    renderApp(`/customers?q=Ada&lender=${api.merchantIds[1]}`);
    await screen.findByRole('heading', { name: 'Choose the linked lender' });
    await user.selectOptions(screen.getAllByRole('combobox', { name: 'Active lender' })[0]!, api.merchantIds[1]!);
    await screen.findByText('Ada Okonkwo');
    expect((screen.getByRole('textbox', { name: 'Search customers' }) as HTMLInputElement).value).toBe('Ada');
    expect(api.calls.filter(call => call.path === '/v1/records/customers').every(call => call.query.merchantId === api.merchantIds[1])).toBe(true);
  });
});

describe('operational queue refresh', () => {
  it('keeps loaded customer records visible after a failed refresh and recovers in place', async () => {
    const user = userEvent.setup(); renderApp('/customers?q=Ada');
    await screen.findByText('Ada Okonkwo');
    api.failNext(/^\/v1\/records\/customers$/, { status: 503, error: 'Temporarily unavailable.' });
    await user.click(screen.getByRole('button', { name: 'Refresh queue' }));
    await screen.findByText(/Refresh did not complete/);
    expect(screen.getByText('Ada Okonkwo')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Search customers' }) as HTMLInputElement).value).toBe('Ada');
    await user.click(screen.getByRole('button', { name: 'Refresh queue' }));
    await waitFor(() => expect(screen.queryByText(/Refresh did not complete/)).toBeNull());
    expect(screen.getByText(/Last updated/)).toBeTruthy();
  });
});
