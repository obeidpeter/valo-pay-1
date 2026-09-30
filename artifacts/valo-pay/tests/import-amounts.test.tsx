import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { render } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { SourceCompletenessPanel } from '@/components/source-manifest-editor';
import { csvAmountToKobo, majorToMinor, minorToMajor, moneyText } from '@workspace/valopay-schema';
import { importCsv } from '../../api-server/src/lib/valopay-import';
import { makeRecord } from '../../api-server/src/domain/records';
import { ctxAt, wat } from '../../api-server/tests/helpers';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); vi.spyOn(window, 'confirm').mockReturnValue(true); });
afterEach(() => api.uninstall());

describe('CSV amount units', () => {
  it('requires a source unit, shows naira, and requires another check when the unit changes', async () => {
    const user = userEvent.setup(); renderApp('/collections');
    await user.click(await screen.findByRole('button', { name: 'Import sample data' }));
    await user.selectOptions(screen.getByLabelText('Import as'), 'observations');
    await user.type(screen.getByLabelText('CSV content'), 'row_id,name,reference,amount,source,narration\nr1,Sample receipt,CSV-NAIRA,18000.50,webhook,Synthetic payment');
    expect(screen.getByRole('button', { name: 'Check data' })).toHaveProperty('disabled', true);
    await user.selectOptions(screen.getByLabelText('Amounts in your CSV *'), 'naira');
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByText('Checked and ready. Review the preview, then select Import data.');
    const preview = screen.getByRole('heading', { name: /^Preview · first/ }).parentElement!;
    expect(within(preview).getByText('₦18,000.50')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Amounts in your CSV *'), 'kobo');
    expect(screen.getByRole('button', { name: 'Import data' })).toHaveProperty('disabled', true);
    expect(screen.queryByText('₦18,000.50')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByText(/Enter kobo as a whole number/);
    expect(screen.getByRole('button', { name: 'Import data' })).toHaveProperty('disabled', true);
    await user.selectOptions(screen.getByLabelText('Amounts in your CSV *'), 'naira');
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByText('Checked and ready. Review the preview, then select Import data.');
    await user.click(screen.getByRole('button', { name: 'Import data' }));
    await waitFor(() => expect(api.state().records.find(record => record.reference === 'CSV-NAIRA')?.amountKobo).toBe(1800050));
  });

  it('shows a receipt of ₦0 as a row to fix and accepts a blank optional fee', async () => {
    const user = userEvent.setup(); renderApp('/collections');
    await user.click(await screen.findByRole('button', { name: 'Import sample data' }));
    await user.selectOptions(screen.getByLabelText('Import as'), 'observations');
    await user.type(screen.getByLabelText('CSV content'), 'row_id,name,reference,amount,source,feeKobo\nr1,Zero receipt,CSV-ZERO,0,webhook,\nr2,Blank fee,CSV-BLANK-FEE,100.00,webhook,');
    await user.selectOptions(screen.getByLabelText('Amounts in your CSV *'), 'naira');
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    expect(await screen.findByText('0 imported · 0 skipped as already imported · 1 row to fix · 1 valid row')).toBeTruthy();
    expect(screen.getByText('Amount: Enter the amount received. Payment evidence must be for more than ₦0.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import data' })).toHaveProperty('disabled', true);
    expect(api.state().records.some(record => ['CSV-ZERO', 'CSV-BLANK-FEE'].includes(record.reference))).toBe(false);
  });

  it('converts every row on the server, preserves exact decimals, and retains kobo API compatibility', () => {
    const ctx = ctxAt(wat('2027-07-01T09:00:00'), 'Admin');
    const input = { kind: 'observations', syntheticOnly: true, commit: true, identityColumn: 'reference', csv: 'name,reference,amountKobo,source\nSample,CSV-KOBO,100050,webhook' };
    const state = structuredClone(api.state());
    expect(importCsv(state, ctx, input).imported).toBe(1);
    expect(state.records.find(record => record.reference === 'CSV-KOBO')?.amountKobo).toBe(100050);
    const naira = importCsv(state, ctx, { ...input, amountUnit: 'naira', csv: 'name,reference,amount,source\nSample,CSV-DECIMAL,"1,000.50",webhook' });
    expect(naira.preview[0]?.amountKobo).toBe(100050);
    expect(state.records.find(record => record.reference === 'CSV-DECIMAL')?.amountKobo).toBe(100050);
    const withFees = importCsv(state, ctx, { ...input, amountUnit: 'naira', csv: 'name,reference,amount,grossAmountKobo,feeKobo,source\nSample,CSV-FEES,980.50,1000.50,20.00,webhook' });
    expect(withFees.imported).toBe(1);
    expect(state.records.find(record => record.reference === 'CSV-FEES')?.data).toMatchObject({ grossAmountKobo: 100050, feeKobo: 2000 });
    const invalid = importCsv(state, ctx, { ...input, amountUnit: 'naira', csv: 'name,reference,amount,source\nValid,CSV-NOT-COMMITTED,1000,webhook\nInvalid,CSV-EXTRA-DECIMAL,1000.001,webhook' });
    expect(invalid.invalid).toBe(1);
    expect(invalid.imported).toBe(0);
    expect(state.records.some(record => record.reference === 'CSV-NOT-COMMITTED')).toBe(false);
  });

  it('rejects ambiguous, fractional kobo and unsafe values without floating-point rounding', () => {
    expect(csvAmountToKobo('90071992547409.91', 'naira')).toBe(Number.MAX_SAFE_INTEGER);
    expect(csvAmountToKobo('0.29', 'naira')).toBe(29);
    expect(csvAmountToKobo('0', 'kobo')).toBe(0);
    for (const value of ['', '-1', '1e3', '1.234', '1,00.50', '90071992547409.92']) expect(() => csvAmountToKobo(value, 'naira')).toThrow();
    for (const value of ['', '-1', '1e3', '100.50', '100,000', '9007199254740992']) expect(() => csvAmountToKobo(value, 'kobo')).toThrow();
  });

  // Fourth review: amounts in major units were multiplied by 100 whatever the row's currency, so JPY 1000 was stored as
  // 100000 and KWD 1.5 as 150. Each row's currency now gives its decimals, by ISO 4217.
  it('converts major units with each row\'s currency decimals and refuses more decimals than the currency has', () => {
    const ctx = ctxAt(wat('2027-07-01T09:00:00'), 'Admin');
    const state = structuredClone(api.state());
    const run = (csv: string) => {
      const rows = csv.split('\n').length - 1;
      return importCsv(state, ctx, { kind: 'observations', syntheticOnly: true, commit: true, amountUnit: 'naira', csv, identities: { source: 'currency-rows', batchId: `currency-${csv.length}`, ids: Array.from({ length: rows }, (_, index) => `${csv.length}-${index}`) } });
    };
    const imported = run('name,reference,amount,source,currency\nYen,CSV-JPY,"1,000",card,JPY\nDinar,CSV-KWD,1.5,card,KWD\nDollars,CSV-USD,10.00,card,usd\nFomento,CSV-CLF,0.0001,card,CLF\nNaira,CSV-NGN,"1,000.50",card,');
    expect([imported.imported, imported.invalid]).toEqual([5, 0]);
    const stored = (reference: string) => state.records.find(record => record.reference === reference)!;
    expect(['CSV-JPY', 'CSV-KWD', 'CSV-USD', 'CSV-CLF', 'CSV-NGN'].map(reference => stored(reference).amountKobo)).toEqual([1000, 1500, 1000, 1, 100050]);
    expect(['CSV-JPY', 'CSV-KWD'].map(reference => moneyText(stored(reference).amountKobo, String(stored(reference).data.currency)))).toEqual(['JPY 1,000', 'KWD 1.500']);
    const refused = run('name,reference,amount,source,currency\nYen,CSV-JPY-HALF,1000.5,card,JPY\nDinar,CSV-KWD-MORE,1.2345,card,KWD\nGold,CSV-XAU,1.5,card,XAU\nDollars,CSV-USD-OK,10.00,card,USD');
    expect([refused.imported, refused.invalid]).toEqual([0, 3]);
    expect(refused.rows.map(row => row.message).slice(0, 3)).toEqual([
      expect.stringMatching(/JPY with no decimal places/),
      expect.stringMatching(/KWD with no more than 3 decimal places/),
      expect.stringMatching(/XAU.*minor unit/),
    ]);
    // The minor units a row states are taken as they are, whatever its currency.
    const minor = importCsv(state, ctx, { kind: 'observations', syntheticOnly: true, commit: true, amountUnit: 'kobo', csv: 'name,reference,amount,source,currency\nYen,CSV-JPY-MINOR,1000,card,JPY', identities: { source: 'currency-rows', batchId: 'minor', ids: ['minor-1'] } });
    expect([minor.imported, stored('CSV-JPY-MINOR').amountKobo]).toEqual([1, 1000]);
  });

  // The preview is where the conversion is checked before importing, so each amount shows in its row's currency.
  it('previews each converted amount in its row\'s currency', async () => {
    const user = userEvent.setup(); renderApp('/collections');
    await user.click(await screen.findByRole('button', { name: 'Import sample data' }));
    await user.selectOptions(screen.getByLabelText('Import as'), 'observations');
    await user.type(screen.getByLabelText('CSV content'), 'row_id,name,reference,amount,source,currency\nr1,Yen,CSV-JPY,1000,card,JPY\nr2,Dollars,CSV-USD,10.00,card,usd\nr3,Naira,CSV-NGN,18000.50,card,');
    await user.selectOptions(screen.getByLabelText('Amounts in your CSV *'), 'naira');
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByText('Checked and ready. Review the preview, then select Import data.');
    const preview = screen.getByRole('heading', { name: /^Preview · first/ }).parentElement!;
    expect(within(preview).getByRole('columnheader', { name: 'Amount to import' })).toBeTruthy();
    expect(within(preview).getAllByRole('row').slice(1).map(row => row.lastElementChild?.textContent)).toEqual(['JPY\u00a01,000', 'USD\u00a010.00', '₦18,000.50']);
    expect(document.getElementById('import-unit-help')?.textContent).toMatch(/The preview shows each amount in its currency\.$/);
    expect(within(preview).getByText(/^Source amounts: Major units \(₦, or the row's currency\)\./)).toBeTruthy();
    // The sample file's unit is named as the unit control offers it, not by its raw value.
    expect(screen.getByRole('button', { name: 'Download sample CSV' }).parentElement?.textContent).toMatch(/Download sample CSV to get started, with its amounts in the unit chosen above: Major units \(₦, or the row's currency\)\.$/);
  });

  // Integration fix: Import batches and Sources showed every converted amount as naira (JPY 1,000 as ₦10.00) and added
  // the rows' currencies into one source total. Each row now shows in its currency, and each total sums the naira rows
  // with the money in other currencies beside it, never in it.
  it('shows a batch\'s amounts in each row\'s currency and never adds currencies into one total', async () => {
    const user = userEvent.setup();
    const view = renderApp('/imports');
    await user.type(await screen.findByRole('textbox', { name: 'Batch name' }), 'Currency rows');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Record type' }), 'observations');
    await user.type(screen.getByRole('textbox', { name: 'Source name' }), 'Card processor');
    await user.type(screen.getByRole('textbox', { name: 'Source batch ID' }), 'currency-001');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Amounts in the source file' }), 'naira');
    await user.click(screen.getByRole('textbox', { name: 'CSV content' }));
    await user.paste('source_row_id,reference,customerId,amount,ccy,source,eventId\no1,BATCH-JPY-1,DEMO-C1001,"1,000",JPY,webhook,evt-b-j1\no2,BATCH-USD-1,DEMO-C1001,10.00,usd,webhook,evt-b-u1\no3,BATCH-NGN-1,DEMO-C1001,10.00,NGN,webhook,evt-b-n1\no4,BATCH-NGN-2,DEMO-C1001,5.00,,webhook,evt-b-n2');
    await user.click(screen.getByRole('button', { name: 'Save and check batch' }));
    let results = await screen.findByRole('region', { name: 'Saved batch results' });
    const rowsShown = async () => [...(await within(results).findByText('Converted amounts · first rows')).parentElement!.querySelectorAll('p')].map(row => row.textContent);
    // The currency column is found as the service finds it: a column the mapping leaves out names its own field, so ccy is no currency until mapped.
    expect(await rowsShown()).toEqual(['Row 2: ₦1,000.00', 'Row 3: ₦10.00', 'Row 4: ₦10.00', 'Row 5: ₦5.00']);
    await user.selectOptions(screen.getByLabelText('ccy'), 'currency');
    await user.click(screen.getByRole('button', { name: 'Save and check batch' }));
    await waitFor(() => expect(api.state().records.find(record => record.kind === 'import-batches')?.data.mapping.ccy).toBe('currency'));
    results = await screen.findByRole('region', { name: 'Saved batch results' });
    await waitFor(async () => expect((await rowsShown())[0]).toBe('Row 2: JPY\u00a01,000'));
    expect(await rowsShown()).toEqual(['Row 2: JPY\u00a01,000', 'Row 3: USD\u00a010.00', 'Row 4: ₦10.00', 'Row 5: ₦5.00']);
    expect(within(results).getByText(/source total$/).textContent).toBe('4 source rows · ₦15.00, JPY\u00a01,000 (1 row) and USD\u00a010.00 (1 row) source total');
    await user.click(screen.getByRole('button', { name: 'Commit checked batch' }));
    await screen.findByRole('heading', { name: 'Import complete' });
    results = screen.getByRole('region', { name: 'Saved batch results' });
    expect(await rowsShown()).toEqual(['Row 2: JPY\u00a01,000', 'Row 3: USD\u00a010.00', 'Row 4: ₦10.00', 'Row 5: ₦5.00']);
    expect(within(results).getByText(/newly imported total$/).textContent).toBe('4 newly imported rows · ₦15.00, JPY\u00a01,000 (1 row) and USD\u00a010.00 (1 row) newly imported total');
    view.unmount();
    renderApp('/sources');
    const row = (await screen.findByRole('link', { name: 'Currency rows' })).closest('tr')!;
    expect([...row.querySelectorAll('td')].slice(1, 3).map(cell => cell.textContent)).toEqual(['4₦15.00, JPY\u00a01,000 (1 row) and USD\u00a010.00 (1 row)', '4₦15.00, JPY\u00a01,000 (1 row) and USD\u00a010.00 (1 row)']);
  });

  it('says what a declared file received in each currency', () => {
    const file = { id: 'f1', source: 'Card processor', sourceBatchId: 'currency-001', kind: 'observations', expectedRows: 4, expectedAmountKobo: 1500, batchId: null, batchStatus: 'committed', businessDate: '2026-09-22', receivedRows: 4, receivedAmountKobo: 1500, receivedOtherCurrencies: { USD: { count: 1, amount: 1000 } }, status: 'incomplete', problems: [] };
    render(<Router hook={memoryLocation({ path: '/sources' }).hook}><SourceCompletenessPanel completeness={{ businessDate: '2026-09-22', completeFiles: 0, expectedFiles: 1, status: 'incomplete', issues: [], files: [file], manifest: null }} /></Router>);
    expect(screen.getByText(/^Received:/).textContent).toBe('Received: 4 rows · ₦15.00 and USD\u00a010.00 (1 row)');
    expect(screen.getByText(/^Declared:/).textContent).toBe('Declared: 4 rows · ₦15.00');
  });

  // Review of the integration fixes, finding 2: a batch committed before totals were kept by currency keeps the totals it
  // was committed with, which may add every row's smallest unit, but Sources and the completeness panel said no total does.
  it('says that a batch committed before totals were kept by currency may add currencies into its totals', async () => {
    api.mutate(state => makeRecord(state, 'import-batches', { name: 'Older currency rows', status: 'committed', createdAt: wat('2026-09-01T10:00:00'), data: {
      kind: 'observations', source: 'Card processor', sourceBatchId: 'older-001', amountUnit: 'naira', identityColumn: 'source_row_id', mapping: {}, committedAt: wat('2026-09-01T10:05:00'),
      csv: 'source_row_id,reference,customerId,amount,currency,source,eventId\no1,OLD-JPY-1,DEMO-C1001,"1,000",JPY,webhook,evt-o-j1\no2,OLD-USD-1,DEMO-C1001,10.00,USD,webhook,evt-o-u1\no3,OLD-NGN-1,DEMO-C1001,10.00,NGN,webhook,evt-o-n1',
      // As an earlier build stored it: JPY 1,000, USD 10.00 and NGN 10.00 added into one "naira" total.
      sourceQuality: { profileId: null, profileVersion: null, sourceRows: 3, sourceAmountKobo: 3_000, importedRows: 3, importedAmountKobo: 3_000, duplicateRows: 0, conflictRows: 0, invalidRows: 0, status: 'checked', issues: [] },
    } }));
    const view = renderApp('/sources');
    const row = (await screen.findByRole('link', { name: 'Older currency rows' })).closest('tr')!;
    expect([...row.querySelectorAll('td')].slice(1, 3).map(cell => cell.textContent)).toEqual(['3₦30.00', '3₦30.00']);
    const totals = within(screen.getByRole('heading', { name: 'Source totals & import evidence' }).closest('section')!).getByText(/^Source totals include/).textContent!;
    expect(totals).toContain('never added to it. A batch committed by an earlier build keeps the totals it was committed with, which may add rows in other currencies.');
    view.unmount();
    const file = { id: 'f1', source: 'Card processor', sourceBatchId: 'older-001', kind: 'observations', expectedRows: 3, expectedAmountKobo: 3_000, batchId: null, batchStatus: 'committed', businessDate: '2026-09-01', receivedRows: 3, receivedAmountKobo: 3_000, status: 'complete', problems: [] };
    render(<Router hook={memoryLocation({ path: '/sources' }).hook}><SourceCompletenessPanel completeness={{ businessDate: '2026-09-01', completeFiles: 1, expectedFiles: 1, status: 'complete', issues: [], files: [file], manifest: null }} /></Router>);
    expect(screen.getByText(/^A file counts only when/).textContent).toContain('stays incomplete for Finance to review. A file whose batch was committed by an earlier build is compared with the total it was committed with, which may add rows in other currencies.');
  });

  it('reads and writes a form amount in its currency\'s major unit exactly', () => {
    expect([majorToMinor('1,000', 'JPY'), majorToMinor('1.5', 'kwd'), majorToMinor('1,000.50', 'USD'), majorToMinor('1,000.50'), majorToMinor('90071992547409.91', 'USD')]).toEqual([1000, 1500, 100050, 100050, Number.MAX_SAFE_INTEGER]);
    for (const [value, currency] of [['1.5', 'JPY'], ['1.2345', 'KWD'], ['1.234', 'USD'], ['1', 'XAU'], ['-1', 'USD'], ['9007199254740992', 'JPY']]) expect(() => majorToMinor(value!, currency)).toThrow();
    expect([minorToMajor(1000, 'JPY'), minorToMajor(1500, 'KWD'), minorToMajor(100050, 'USD'), minorToMajor(100050), minorToMajor(1, 'CLF')]).toEqual(['1000', '1.500', '1000.50', '1000.50', '0.0001']);
  });
});
