import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';

// Audit item 11: a CSV whose name is in full_name passed as valid, the mapping showed Skip column, and commit saved the
// customer named after its reference. The console now suggests the field and the check says when a value falls back.
const csv = 'source_row_id,full_name,reference,consentProvenance\nrow-1,Named in an unmapped column,UNMAPPED-C1,Synthetic consent';
const warning = "No column is mapped to Name, so each record’s name is taken from its reference (or its row number without one). Not mapped to a field: full_name, which looks like the name. Map the column that holds the name, or import anyway to save the fallback.";
let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());
const customer = () => api.state().records.find(record => record.kind === 'customers' && record.reference === 'UNMAPPED-C1');

async function savedBatch() {
  const user = userEvent.setup();
  renderApp('/imports');
  await user.type(await screen.findByRole('textbox', { name: 'Batch name' }), 'Mapped customers');
  await user.type(screen.getByRole('textbox', { name: 'Source name' }), 'Loan system export');
  await user.type(screen.getByRole('textbox', { name: 'Source batch ID' }), 'map-001');
  await user.click(screen.getByRole('textbox', { name: 'CSV content' }));
  await user.paste(csv);
  await user.click(screen.getByRole('button', { name: 'Save and check batch' }));
  await screen.findByRole('region', { name: 'Saved batch results' });
  return user;
}

describe('import batches', () => {
  it('reports the name fallback, suggests full_name as the name and saves the name once mapped', async () => {
    const user = await savedBatch();
    const results = screen.getByRole('region', { name: 'Saved batch results' });
    expect(within(results).getByRole('heading', { name: 'Check before you import' })).toBeTruthy();
    expect(within(results).getByText(warning)).toBeTruthy();
    // The suggestion is shown as the mapping and is an unsaved change: the check above is the previous one.
    expect((screen.getByRole('combobox', { name: 'full_name' }) as HTMLSelectElement).value).toBe('name');
    expect(screen.getByText('Suggested from the column names: full_name as Full name. Save and check the batch to use it, or choose another option.')).toBeTruthy();
    expect(within(results).getByRole('heading', { name: 'Previous check' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Import checked batch' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Save and check batch' }));
    await within(results).findByRole('heading', { name: 'Saved check results' });
    expect(within(results).queryByRole('heading', { name: 'Check before you import' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Import checked batch' }));
    await screen.findByRole('heading', { name: 'Batch imported' });
    expect(customer()?.name).toBe('Named in an unmapped column');
  });

  it('takes an unsaved suggestion back when the file changes, so a corrected header saves', async () => {
    const user = await savedBatch();
    expect(screen.getByText(/^Suggested from the column names/)).toBeTruthy();
    const area = screen.getByRole('textbox', { name: 'CSV content' });
    await user.clear(area);
    await user.click(area);
    await user.paste(csv.replace('full_name', 'name'));
    expect(screen.queryByText(/^Suggested from the column names/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save and check batch' }));
    const results = screen.getByRole('region', { name: 'Saved batch results' });
    await within(results).findByRole('heading', { name: 'Saved check results' });
    expect(within(results).queryByRole('heading', { name: 'Check before you import' })).toBeNull();
    expect(api.calls.filter(call => call.path.startsWith('/v1/pilot/batches') && call.method === 'POST').map(call => call.status)).toEqual([200, 200]);
  });

  it('suggests no field another column already fills, the row identity column included', async () => {
    // reference is the row identity and fills the reference itself, so customer_reference, which would suggest it, stays as it is.
    const user = userEvent.setup();
    renderApp('/imports');
    await user.type(await screen.findByRole('textbox', { name: 'Batch name' }), 'Identity as reference');
    await user.type(screen.getByRole('textbox', { name: 'Source name' }), 'Loan system export');
    await user.type(screen.getByRole('textbox', { name: 'Source batch ID' }), 'map-002');
    const identity = screen.getByRole('textbox', { name: 'Source row ID column' });
    await user.clear(identity);
    await user.type(identity, 'reference');
    await user.click(screen.getByRole('textbox', { name: 'CSV content' }));
    await user.paste('reference,customer_reference,full_name,consentProvenance\nREF-1,CUS-1,Named in an unmapped column,Synthetic consent');
    await user.click(screen.getByRole('button', { name: 'Save and check batch' }));
    await screen.findByRole('region', { name: 'Saved batch results' });
    expect((screen.getByRole('combobox', { name: 'reference' }) as HTMLSelectElement).value).toBe('reference');
    // A header that names no field shows as Skip column.
    expect((screen.getByRole('combobox', { name: 'customer_reference' }) as HTMLSelectElement).value).toBe('');
    expect((screen.getByRole('combobox', { name: 'full_name' }) as HTMLSelectElement).value).toBe('name');
    expect(screen.getByText('Suggested from the column names: full_name as Full name. Save and check the batch to use it, or choose another option.')).toBeTruthy();
  });

  it('asks before committing a check that warns, and commits only when told to', async () => {
    const user = await savedBatch();
    await user.selectOptions(screen.getByRole('combobox', { name: 'full_name' }), '');
    await user.click(screen.getByRole('button', { name: 'Save and check batch' }));
    const results = screen.getByRole('region', { name: 'Saved batch results' });
    await within(results).findByRole('heading', { name: 'Saved check results' });
    expect(within(results).getByText(warning)).toBeTruthy();
    const commit = screen.getByRole('button', { name: 'Import checked batch' });
    await user.click(commit);
    let dialog = await screen.findByRole('dialog', { name: 'Import with default values?' });
    expect(within(dialog).getByText(warning)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Review the mapping' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(commit);
    expect(api.calls.some(call => call.path.endsWith('/commit'))).toBe(false);
    await user.click(commit);
    dialog = await screen.findByRole('dialog', { name: 'Import with default values?' });
    await user.click(within(dialog).getByRole('button', { name: 'Import anyway' }));
    await screen.findByRole('heading', { name: 'Batch imported' });
    expect(customer()?.name).toBe('UNMAPPED-C1');
    expect(screen.getByRole('heading', { name: 'Imported with default values' })).toBeTruthy();
  });
});

describe('sample data import on Collections', () => {
  async function checked(file: string) {
    const user = userEvent.setup();
    renderApp('/collections');
    await user.click(await screen.findByRole('button', { name: 'Import sample data' }));
    await user.selectOptions(screen.getByLabelText('Import as'), 'customers');
    await user.click(screen.getByLabelText('CSV content'));
    await user.paste(file);
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByRole('heading', { name: 'Check results' });
    return user;
  }
  const file = 'row_id,full_name,reference,consentProvenance\nr1,Named in an unmapped column,UNMAPPED-C1,Synthetic consent';

  it('matches full_name to the name before the first check, so the check has nothing to warn about', async () => {
    const user = await checked(file);
    const results = screen.getByRole('region', { name: 'Check results' });
    expect(within(results).queryByRole('heading', { name: 'Check before you import' })).toBeNull();
    expect((screen.getByLabelText('Map full_name') as HTMLSelectElement).value).toBe('name');
    expect(api.calls.find(call => call.path === '/v1/imports')?.body).toMatchObject({ identityColumn: 'row_id', mapping: { row_id: '', full_name: 'name', reference: 'reference', consentProvenance: 'consentProvenance' } });
    await user.click(screen.getByRole('button', { name: 'Import data' }));
    await screen.findByText(/Import complete\./);
    expect(customer()?.name).toBe('Named in an unmapped column');
  });

  it('asks before importing a check that warns', async () => {
    const user = await checked(file);
    await user.selectOptions(screen.getByLabelText('Map full_name'), '');
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import data' })).toHaveProperty('disabled', false));
    await user.click(screen.getByRole('button', { name: 'Import data' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import with default values?' });
    expect(api.calls.some(call => call.path === '/v1/imports' && (call.body as { commit?: boolean }).commit)).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Import with default values' }));
    await screen.findByText(/Import complete\./);
    expect(customer()?.name).toBe('UNMAPPED-C1');
  });
});
