import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';

// Usability backlog UX-EX1 and UX-EX2 and the owner's decisions of September 2026: Import batches has the wizard's
// rows to fix, errors CSV and correction focus, both screens and their samples use the shared field labels, and the
// quick import's sample carries a row ID column the wizard recognises before its first check.
let api: FakeApi;
const downloads: Blob[] = [];
beforeEach(() => {
  api = installFakeApi();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  downloads.length = 0;
  Object.assign(URL, { createObjectURL: (blob: Blob) => { downloads.push(blob); return 'blob:download'; }, revokeObjectURL: () => {} });
});
afterEach(() => api.uninstall());

async function batch(csv: string, sourceBatchId = 'rows-001') {
  const user = userEvent.setup();
  renderApp('/imports');
  await user.type(await screen.findByRole('textbox', { name: 'Batch name' }), 'Rows to fix');
  await user.type(screen.getByRole('textbox', { name: 'Source name' }), 'Loan system export');
  await user.type(screen.getByRole('textbox', { name: 'Source batch ID' }), sourceBatchId);
  await user.click(screen.getByRole('textbox', { name: 'CSV content' }));
  await user.paste(csv);
  await user.click(screen.getByRole('button', { name: 'Save and check batch' }));
  await screen.findByRole('region', { name: 'Saved batch results' });
  return user;
}

describe('Import batches check results', () => {
  it('open on the rows to fix, download them with their detail and return focus to the CSV', async () => {
    const user = await batch('source_row_id,name,consentProvenance\nrow-1,Valid customer,Synthetic consent\nrow-2,Blank consent,');
    const results = screen.getByRole('region', { name: 'Saved batch results' });
    await waitFor(() => expect(document.activeElement).toBe(within(results).getByRole('heading', { name: 'Saved check results' })));
    expect(within(results).getByText('0 imported · 0 skipped as already imported · 1 row to fix · 1 valid row')).toBeTruthy();
    expect(within(results).getByText('Consent source or reference (column consentProvenance): Enter a value; it is blank on this row.')).toBeTruthy();
    expect(within(results).queryByText(/Row 2 · Valid/)).toBeNull();
    await user.click(within(results).getByRole('button', { name: 'Show all row results' }));
    expect(within(results).getByText(/Row 2 · Valid/)).toBeTruthy();
    await user.click(within(results).getByRole('button', { name: 'Download errors CSV' }));
    expect((await downloads[0]!.text()).replace(/^\uFEFF/, '').split('\r\n')).toEqual([
      '"Row","Status","What to fix","Technical detail"',
      '"3","invalid","Consent source or reference (column consentProvenance): Enter a value; it is blank on this row.","consentProvenance: String must contain at least 1 character(s)"',
    ]);
    await user.click(within(results).getByRole('button', { name: 'Edit CSV' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'CSV content' }));
    // The mapping offers each field in the shared words.
    expect(within(screen.getByRole('combobox', { name: 'consentProvenance' })).getByRole('option', { name: 'Consent source or reference' })).toBeTruthy();
  });

  it('call a row imported before already imported, as the quick import does', async () => {
    const csv = 'source_row_id,name,consentProvenance\nrow-1,Imported once,Synthetic consent';
    const user = await batch(csv, 'once-001');
    await user.click(screen.getByRole('button', { name: 'Import checked batch' }));
    await screen.findByRole('heading', { name: 'Batch imported' });
    await user.click(screen.getByRole('button', { name: 'Start another batch' }));
    await user.type(await screen.findByRole('textbox', { name: 'Batch name' }), 'The same rows again');
    await user.type(screen.getByRole('textbox', { name: 'Source name' }), 'Loan system export');
    await user.type(screen.getByRole('textbox', { name: 'Source batch ID' }), 'once-002');
    await user.click(screen.getByRole('textbox', { name: 'CSV content' }));
    await user.paste(csv);
    await user.click(screen.getByRole('button', { name: 'Save and check batch' }));
    const results = await screen.findByRole('region', { name: 'Saved batch results' });
    expect(await within(results).findByText('0 imported · 1 skipped as already imported · 0 rows to fix · 0 valid rows')).toBeTruthy();
    expect(within(results).getByText(/Row 2 · Already imported:/)).toBeTruthy();
    expect(api.state().records.filter(record => record.name === 'Imported once')).toHaveLength(1);
  });

  it('warn when the row ID column is a reference left as the source identity only', async () => {
    const user = userEvent.setup();
    renderApp('/imports');
    await user.type(await screen.findByRole('textbox', { name: 'Batch name' }), 'Keyed by reference');
    await user.type(screen.getByRole('textbox', { name: 'Source name' }), 'Loan system export');
    await user.type(screen.getByRole('textbox', { name: 'Source batch ID' }), 'keyed-001');
    await user.clear(screen.getByRole('textbox', { name: 'Source row ID column' }));
    await user.type(screen.getByRole('textbox', { name: 'Source row ID column' }), 'Reference');
    await user.click(screen.getByRole('textbox', { name: 'CSV content' }));
    await user.paste('Reference,name,consentProvenance\nREF-B-1,Keyed by reference,Synthetic consent');
    await user.click(screen.getByRole('button', { name: 'Save and check batch' }));
    const results = await screen.findByRole('region', { name: 'Saved batch results' });
    expect(await within(results).findByText(/^No column is mapped to Reference, so each record gets a generated reference\. Not mapped to a field: Reference, which looks like the reference\./)).toBeTruthy();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reference' }), 'reference');
    await user.click(screen.getByRole('button', { name: 'Save and check batch' }));
    expect(await within(results).findByText('0 imported · 0 skipped as already imported · 0 rows to fix · 1 valid row')).toBeTruthy();
    expect(within(results).queryByText(/generated reference/)).toBeNull();
  });

  it('fill the sample in the shared words with its mapping, so it checks cleanly', async () => {
    const user = userEvent.setup();
    renderApp('/imports');
    await user.click(await screen.findByRole('button', { name: 'Use sample' }));
    expect((screen.getByRole('textbox', { name: 'CSV content' }) as HTMLTextAreaElement).value.split('\n')[0]).toBe('source_row_id,Full name,Loan software reference,Consent source or reference,Bank name,Masked account number');
    expect((screen.getByRole('textbox', { name: 'Source row ID column' }) as HTMLInputElement).value).toBe('source_row_id');
    // An edited sample keeps its mapping while it keeps its columns.
    await user.type(screen.getByRole('textbox', { name: 'CSV content' }), '2');
    await user.click(screen.getByRole('button', { name: 'Save and check batch' }));
    const results = await screen.findByRole('region', { name: 'Saved batch results' });
    expect(await within(results).findByText('0 imported · 0 skipped as already imported · 0 rows to fix · 1 valid row')).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'Consent source or reference' }) as HTMLSelectElement).value).toBe('consentProvenance');
  });
});

describe('the quick import on Collections', () => {
  it('downloads a sample in the shared words whose row ID column and fields are matched before the first check', async () => {
    const user = userEvent.setup();
    renderApp('/collections');
    await user.click(await screen.findByRole('button', { name: 'Import sample data' }));
    await user.selectOptions(screen.getByLabelText('Import as'), 'due-items');
    await user.selectOptions(screen.getByLabelText('Amounts in your CSV *'), 'naira');
    await user.click(screen.getByRole('button', { name: 'Download sample CSV' }));
    const sample = (await downloads[0]!.text()).replace(/^\uFEFF/, '');
    expect(sample).toBe('Source row ID,Name,Reference,Customer reference or ID,Amount,Due date,Mandate reference or ID,Collection owner,Override reason\nsample-instalment-001,Sample instalment,SAMPLE-D001,DEMO-C1001,10000.00,2028-12-01,,lms,');
    await user.click(screen.getByLabelText('CSV content'));
    await user.paste(sample);
    expect((screen.getByLabelText('Row ID column *') as HTMLSelectElement).value).toBe('Source row ID');
    expect((screen.getByLabelText('Map Source row ID') as HTMLSelectElement).value).toBe('');
    expect(within(screen.getByLabelText('Map Source row ID')).getByRole('option', { name: 'Row ID only' })).toBeTruthy();
    expect((screen.getByLabelText('Map Customer reference or ID') as HTMLSelectElement).value).toBe('customerId');
    expect((screen.getByLabelText('Map Collection owner') as HTMLSelectElement).value).toBe('owner');
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByText('Checked and ready. Review the preview, then select Import data.');
    await user.click(screen.getByRole('button', { name: 'Import data' }));
    await screen.findByRole('heading', { name: 'Import results' });
    const saved = api.state().records.find(record => record.reference === 'SAMPLE-D001')!;
    expect([saved.amountKobo, saved.data.importIdentity.source, saved.data.importIdentity.rowId]).toEqual([1_000_000, 'Quick import', 'sample-instalment-001']);
    // The same sample again is recognised by its row ID and changes nothing.
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    expect(await screen.findByText('0 imported · 1 skipped as already imported · 0 rows to fix · 0 valid rows')).toBeTruthy();
  });

  it('reads the header after blank lines, as the importer does, so the file can be checked', async () => {
    const user = userEvent.setup();
    renderApp('/collections');
    await user.click(await screen.findByRole('button', { name: 'Import sample data' }));
    await user.selectOptions(screen.getByLabelText('Import as'), 'customers');
    await user.click(screen.getByLabelText('CSV content'));
    // A header the browser cannot read says what to fix rather than asking for a row ID column it cannot offer.
    await user.paste('"Unclosed,header\nr1,Synthetic consent');
    expect(screen.getByText('2. Start the CSV with a header row that names each column, with every quote closed.')).toBeTruthy();
    expect(screen.queryByLabelText('Row ID column *')).toBeNull();
    await user.clear(screen.getByLabelText('CSV content'));
    await user.paste('\n\nrow_id,name,consentProvenance\nr1,After blank lines,Synthetic consent');
    expect((screen.getByLabelText('Row ID column *') as HTMLSelectElement).value).toBe('row_id');
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    expect(await screen.findByText('Checked and ready. Review the preview, then select Import data.')).toBeTruthy();
  });

  it('keeps a reference chosen as the row ID column as the reference, and warns when it is left as the row ID only', async () => {
    const user = userEvent.setup();
    renderApp('/collections');
    await user.click(await screen.findByRole('button', { name: 'Import sample data' }));
    await user.selectOptions(screen.getByLabelText('Import as'), 'customers');
    await user.click(screen.getByLabelText('CSV content'));
    await user.paste('Loan software reference,Full name,Consent source or reference\nREF-ROW-1,Keyed by its reference,Synthetic consent');
    await user.selectOptions(screen.getByLabelText('Row ID column *'), 'Loan software reference');
    expect((screen.getByLabelText('Map Loan software reference') as HTMLSelectElement).value).toBe('reference');
    // Left as the row ID only, it fills no reference, and the check says so before anything is imported.
    await user.selectOptions(screen.getByLabelText('Map Loan software reference'), '');
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    const results = await screen.findByRole('region', { name: 'Check results' });
    expect(within(results).getByRole('heading', { name: 'Check before you import' })).toBeTruthy();
    expect(within(results).getByText(/Not mapped to a field: Loan software reference, which looks like the reference\./)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Map Loan software reference'), 'reference');
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByText('Checked and ready. Review the preview, then select Import data.');
    await user.click(screen.getByRole('button', { name: 'Import data' }));
    await screen.findByRole('heading', { name: 'Import results' });
    const saved = api.state().records.find(record => record.name === 'Keyed by its reference')!;
    expect([saved.reference, saved.data.importIdentity.rowId]).toEqual(['REF-ROW-1', 'REF-ROW-1']);
  });

  it('names the columns of a refused file in its row errors', async () => {
    const user = userEvent.setup();
    renderApp('/collections');
    await user.click(await screen.findByRole('button', { name: 'Import sample data' }));
    await user.selectOptions(screen.getByLabelText('Amounts in your CSV *'), 'naira');
    await user.click(screen.getByLabelText('CSV content'));
    await user.paste('row_id,name,customer,amount,owner\nr1,Undated,NOPE-C,0,someone');
    await user.selectOptions(screen.getByLabelText('Map customer'), 'customerId');
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    const results = await screen.findByRole('region', { name: 'Check results' });
    expect(within(results).getByText(/Customer reference or ID \(column customer\): No customer has the reference or ID “NOPE-C” in this lender\. Amount: Enter an amount above ₦0 in naira, for example 1,000\.50\./)).toBeTruthy();
    expect(within(results).getByText(/No column is mapped to Due date\. Map the column that holds it\./)).toBeTruthy();
    expect(within(results).getByText(/Collection owner \(column owner\): “someone” is not one of the choices\. Use Valo Pay \(valopay\), Loan management system \(lms\), Lender team \(merchant_manual\) or Provider automatic collection \(provider_auto\)\./)).toBeTruthy();
  });
});
