import { useState } from 'react';
import type { ImportResult } from '@workspace/api-client-react';
import { importFieldLabel, importRowIdLabel, koboToNaira } from '@workspace/valopay-schema';
import { Button } from '@/components/ui/button';
import { ScrollFrame } from '@/components/scroll-frame';
import { readableLabel } from '@/components/record-label';
import { formatCount, formatNumber } from '@/lib/formatters';

/*
 * What both import screens share: the row results with their rows-to-fix filter,
 * the errors CSV and the way back to the CSV to correct it, the summary line,
 * and sample files headed in the operator's words (importFieldLabel).
 */

type Row = ImportResult['rows'][number];

/** Escape CSV cells and neutralise spreadsheet formula prefixes, including leading whitespace. */
export function safeCsvCell(value: unknown): string {
  const text = String(value ?? '');
  const safe = /^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
/** The rows to fix: what to fix in the operator's words, and the service's technical detail beside it, so nothing is hidden. */
export function importErrorCsv(rows: Row[]): string {
  return '\uFEFF' + [['Row', 'Status', 'What to fix', 'Technical detail'], ...rows.filter(row => row.status === 'invalid').map(row => [row.row, row.status, row.message, row.detail ?? ''])].map(row => row.map(safeCsvCell).join(',')).join('\r\n');
}
export function downloadCsv(contents: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
}
/** A row's outcome in the same words on both screens: a duplicate row is one already imported, an invalid one needs fixing. */
export function importRowStatus(status: string): string {
  return status === 'duplicate' ? 'Already imported' : status === 'invalid' ? 'Needs fixing' : readableLabel(status);
}
/** A check's or an import's totals in the same words on both screens. */
export function importSummary(result: { imported: number; skipped?: number; invalid: number; valid: number; rows: Row[] }): string {
  const skipped = result.skipped ?? result.rows.filter(row => row.status === 'duplicate').length;
  return `${formatNumber(result.imported)} imported · ${formatNumber(skipped)} skipped as already imported · ${formatCount(result.invalid, 'row')} to fix · ${formatCount(result.valid, 'valid row')}`;
}
/**
 * A one-row sample file for a kind, headed in the operator's words: the source
 * row ID (Source row ID, or the header a screen's row ID column defaults to),
 * then each field's shared label. Amounts are given in the chosen unit.
 */
export function sampleImportCsv(kind: string, rowId: string, values: Array<[string, string]>, unit: 'naira' | 'kobo' | '' = 'kobo', rowIdHeader = importRowIdLabel): string {
  const header = [rowIdHeader, ...values.map(([field]) => importFieldLabel(kind, field))];
  const row = [rowId, ...values.map(([field, value]) => field === 'amountKobo' && value && unit === 'naira' ? koboToNaira(Number(value)) : value)];
  return `${header.join(',')}\n${row.join(',')}`;
}
/** Each sample column's field, as a mapping from its header; the row ID column is the row's identity only. */
export function sampleMapping(kind: string, values: Array<[string, string]>, rowIdHeader = importRowIdLabel): Record<string, string> {
  return Object.fromEntries([[rowIdHeader, ''], ...values.map(([field]) => [importFieldLabel(kind, field), field])]);
}

/**
 * Row results that open on the rows to fix when there are any, with the errors
 * CSV and Edit CSV, which moves focus to the CSV. Give it a key per result so
 * a new check starts from its own rows to fix.
 */
export function ImportRowResults({ rows, label, filename, onCorrect, className }: { rows: Row[]; label: string; filename: string; onCorrect?: () => void; className: string }) {
  const toFix = rows.some(row => row.status === 'invalid');
  const [onlyErrors, setOnlyErrors] = useState(toFix);
  return <>
    {toFix && <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => downloadCsv(importErrorCsv(rows), filename)}>Download errors CSV</Button>
      <Button type="button" variant="outline" size="sm" aria-pressed={onlyErrors} onClick={() => setOnlyErrors(value => !value)}>{onlyErrors ? 'Show all row results' : 'Show rows to fix'}</Button>
      {onCorrect && <Button type="button" variant="ghost" size="sm" onClick={onCorrect}>Edit CSV</Button>}
    </div>}
    <ScrollFrame label={label} className={className}>
      {rows.filter(row => !onlyErrors || row.status === 'invalid').map(row => <p className="border-b py-1.5 last:border-0" key={row.row}><strong>Row {row.row} · {importRowStatus(row.status)}:</strong> {row.message}</p>)}
    </ScrollFrame>
  </>;
}
