import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { importErrorCsv, safeCsvCell } from '@/components/import-results';
import { formatKobo } from '@/lib/formatters';
import axe from 'axe-core';
import { queryClient } from '@/App';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); vi.spyOn(window, 'confirm').mockReturnValue(true); });
afterEach(() => api.uninstall());

describe('template review lifecycle', () => {
  it('requests changes with a reason, lets the author edit and resubmit, then supports independent approval', async () => {
    api.role = 'Compliance reviewer';
    api.mutate(state => { state.records.find(record => record.kind === 'templates')!.status = 'submitted'; });
    const id = api.state().records.find(record => record.kind === 'templates')!.id;
    const user = userEvent.setup(); renderApp('/policies');
    await user.click(await screen.findByRole('button', { name: 'Request changes' }));
    let dialog = await screen.findByRole('dialog', { name: 'Request template changes' });
    await user.type(within(dialog).getByLabelText('Reason *'), 'Make the collection date easier to understand.');
    await user.click(within(dialog).getByRole('button', { name: 'Reject template' }));
    await waitFor(() => expect(api.state().records.find(record => record.id === id)?.status).toBe('rejected'));
    expect(await screen.findByText(/Make the collection date easier to understand/)).toBeTruthy();
    api.role = 'Admin';
    await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' }).hasAttribute('disabled')).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    dialog = await screen.findByRole('dialog', { name: 'Edit template' });
    const message = within(dialog).getByLabelText(/Message \(include/);
    await user.clear(message); await user.paste('{{merchant}} will collect {{amount}} on {{date}}. Questions? Contact {{contact}}.');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const templates = screen.getByRole('heading', { name: 'Notification templates' }).closest('section')!;
    await user.click(within(templates).getByRole('button', { name: 'Submit for review' }));
    dialog = await screen.findByRole('dialog', { name: 'Submit template for review' });
    await user.type(within(dialog).getByLabelText('Reason *'), 'Wording corrected for review.');
    await user.click(within(dialog).getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(api.state().records.find(record => record.id === id)?.status).toBe('submitted'));
    api.role = 'Compliance reviewer';
    await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    await waitFor(() => expect(within(templates).getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(false));
    await user.click(within(templates).getByRole('button', { name: 'Approve' }));
    dialog = await screen.findByRole('dialog', { name: 'Approve template' });
    await user.type(within(dialog).getByLabelText('Reason *'), 'Checked the corrected wording.');
    await user.click(within(dialog).getByRole('button', { name: 'Approve template' }));
    await waitFor(() => expect(api.state().records.find(record => record.id === id)?.status).toBe('approved'));
    expect((api.state().records.find(record => record.id === id)?.data.reviewHistory as unknown[]).length).toBe(2);
  });

  it('creates a linked template draft without changing approved wording', async () => {
    api.mutate(state => { state.records.find(record => record.kind === 'templates')!.status = 'approved'; });
    const previous = structuredClone(api.state().records.find(record => record.kind === 'templates')!);
    const user = userEvent.setup(); renderApp('/policies');
    await user.click(await screen.findByRole('button', { name: 'Draft next version' }));
    const dialog = await screen.findByRole('dialog', { name: 'Draft next template version' });
    await user.type(within(dialog).getByLabelText('Reason *'), 'Review the next message.');
    await user.click(within(dialog).getByRole('button', { name: 'Draft next version' }));
    await screen.findByText('v2');
    const draft = api.state().records.find(record => record.kind === 'templates' && record.data.version === 2)!;
    expect(draft.data.previousVersionId).toBe(previous.id);
    expect(draft.status).toBe('draft');
    expect(api.state().records.find(record => record.id === previous.id)).toEqual(previous);
  });

  it('uses the same placeholder rules in the preview and saving', async () => {
    const user = userEvent.setup(); renderApp('/policies');
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit template' });
    const message = within(dialog).getByLabelText(/Message \(include/);
    const before = api.state().records.find(record => record.kind === 'templates')!.data.text;
    await user.clear(message); await user.paste(`${before} {{unknown}}`);
    expect(within(dialog).getByText(/Unknown placeholder \{\{unknown\}\}\. Use only/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert');
    expect(api.state().records.find(record => record.kind === 'templates')!.data.text).toBe(before);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('guided synthetic CSV imports', () => {
  it('maps a file with custom headers, previews quoted fields, then reports imports and skips', async () => {
    const user = userEvent.setup(); renderApp('/collections');
    await user.click(await screen.findByRole('button', { name: 'Import sample data' }));
    await user.selectOptions(screen.getByLabelText('Import as'), 'customers');
    const csv = 'Full name,External ref,Consent\n"Sample, Person",CSV-GUIDED-1,"Synthetic\nconsent"';
    await user.upload(screen.getByLabelText('Choose CSV file'), new File([csv], 'synthetic.csv', { type: 'text/csv' }));
    await waitFor(() => expect((screen.getByLabelText('CSV content') as HTMLTextAreaElement).value).toBe(csv));
    // The columns are matched from the file's header before any check, and a check needs the row ID column.
    await screen.findByRole('group', { name: 'Match columns' });
    expect(screen.getByRole('button', { name: 'Check data' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Choose the row ID column under Match columns before checking: every row needs a source row ID.')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Row ID column *'), 'External ref');
    expect((screen.getByLabelText('Map Full name') as HTMLSelectElement).value).toBe('name');
    await user.selectOptions(screen.getByLabelText('Map External ref'), 'reference');
    await user.selectOptions(screen.getByLabelText('Map Consent'), 'consentProvenance');
    expect(screen.getByRole('button', { name: 'Import data' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByText('Checked and ready. Review the preview, then select Import data.');
    expect(screen.getByText('Sample, Person')).toBeTruthy();
    expect((await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, 'target-size': { enabled: false }, 'scrollable-region-focusable': { enabled: false } } })).violations).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Import data' }));
    await screen.findByText(/1 imported · 0 skipped as already imported · 0 rows to fix/);
    expect(api.state().records.filter(record => record.reference === 'CSV-GUIDED-1')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByText(/0 imported · 1 skipped as already imported · 0 rows to fix/);
    expect(screen.getByRole('button', { name: 'Import data' }).hasAttribute('disabled')).toBe(true);
  });

  it('keeps invalid batches uncommitted, and rechecks after CSV changes', async () => {
    const user = userEvent.setup(); renderApp('/collections');
    await user.click(await screen.findByRole('button', { name: 'Import sample data' }));
    await user.selectOptions(screen.getByLabelText('Import as'), 'customers');
    const input = screen.getByLabelText('CSV content');
    await user.click(input); await user.paste('row_id,name,reference,consentProvenance\nr1,Valid,CSV-VALID,Synthetic\nr2,Invalid,CSV-BAD,');
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByText(/0 imported · 0 skipped as already imported · 1 row to fix · 1 valid row/);
    expect(screen.getByRole('button', { name: 'Import data' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Download errors CSV' })).toBeTruthy();
    expect(api.state().records.some(record => record.reference === 'CSV-VALID')).toBe(false);
    await user.clear(input); await user.paste('row_id,name,reference,consentProvenance\nr1,Corrected,CSV-VALID,Synthetic');
    expect(screen.getByRole('button', { name: 'Import data' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByText('Checked and ready. Review the preview, then select Import data.');
    expect(screen.getByRole('button', { name: 'Import data' }).hasAttribute('disabled')).toBe(false);
  });

  it('neutralises spreadsheet formulas and quotes in exported error CSV', () => {
    expect(safeCsvCell(' =HYPERLINK("example")')).toBe('"\' =HYPERLINK(""example"")"');
    expect(safeCsvCell('\t@SUM(A1)')).toBe('"\'\t@SUM(A1)"');
    const csv = importErrorCsv([{ row: 2, status: 'invalid', message: '=malicious()', detail: '@detail()' }, { row: 3, status: 'valid', message: 'Ready' }]);
    expect(csv).toContain('"\'=malicious()"');
    expect(csv.split('\r\n')).toEqual(['\uFEFF"Row","Status","What to fix","Technical detail"', '"2","invalid","\'=malicious()","\'@detail()"']);
    expect(csv).not.toContain('Ready');
    expect(csv.startsWith('\uFEFF')).toBe(true);
  });
});

describe('exception resolution context', () => {
  it('identifies the customer and amount and separates recording an outcome from allocating funds', async () => {
    const exception = api.state().records.find(record => record.kind === 'exceptions' && record.customerId && record.data.type === 'unallocated_payment')!;
    const customer = api.state().records.find(record => record.id === exception.customerId)!;
    const beforePayments = structuredClone(api.state().records.filter(record => ['payments', 'allocations'].includes(record.kind)));
    const user = userEvent.setup(); renderApp('/exceptions');
    const row = (await screen.findByText(customer.name)).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
    expect(within(dialog).getByText(`${customer.name} · ${customer.reference}`)).toBeTruthy();
    expect(within(dialog).getByText(formatKobo(exception.amountKobo))).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Review customer history' }).getAttribute('href')).toContain(`record=${exception.data.linkedRecordId}`);
    expect(within(dialog).getByRole('link', { name: 'Review reconciliation' })).toBeTruthy();
    expect(within(dialog).getByText(/It does not allocate a payment, issue a refund/)).toBeTruthy();
    await user.selectOptions(within(dialog).getByLabelText(/How was this resolved/), 'held_credit');
    expect(within(dialog).getByText('Record outcome: Kept as unallocated credit')).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Reason *'), 'Reviewed sample evidence; keep this unallocated credit.');
    await user.click(within(dialog).getByRole('button', { name: 'Resolve exception' }));
    await waitFor(() => expect(api.state().records.find(record => record.id === exception.id)?.status).toBe('resolved'));
    expect(api.state().records.filter(record => ['payments', 'allocations'].includes(record.kind))).toEqual(beforePayments);
  });
});
