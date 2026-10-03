import { describe, expect, it } from 'vitest';
import { formErrorMessage, serverFieldErrors } from '../src/components/form-field';

const fields = [
  { name: 'feeKobo', label: 'Fee (kobo)' },
  { name: 'grossKobo', label: 'Gross amount (kobo)' },
];

describe('general form errors', () => {
  it.each(['feeKobo', 'data.feeKobo'])('uses the visible label for %s', (key) => {
    expect(formErrorMessage(`${key}: Enter a whole number of kobo.`, fields)).toBe('Fee (kobo): Enter a whole number of kobo.');
  });

  it('keeps every correction readable when several fields are invalid', () => {
    expect(formErrorMessage('Invalid settlement-batches data: grossKobo: Enter a number.; data.feeKobo: Enter a whole number of kobo.', fields))
      .toBe('Check these values: Gross amount (kobo): Enter a number.; Fee (kobo): Enter a whole number of kobo.');
  });

  it('preserves unknown CSV columns and identifiers that contain a field name', () => {
    const message = 'CSV row 7: externalReference: DEMO-feeKobo:001; unknownColumn: This value is not recognised.';
    expect(formErrorMessage(message, fields)).toBe(message);
  });
});

describe('server field errors', () => {
  const resolve = (path: string) => (path.startsWith('files.') ? path : null);
  it('counts the problems the service found but did not name', () => {
    const details = Array.from({ length: 20 }, (_, index) => ({ field: `files.${index}.kind`, message: 'Unknown kind' }));
    const sorted = serverFieldErrors({ data: { error: 'Validation failed.', details, detailCount: 120 } }, resolve);
    expect(Object.keys(sorted.fields)).toHaveLength(20);
    expect(sorted.general).toEqual(['Validation failed.', '100 more problems were found. Correct these and save again to see them.']);
  });

  it('adds nothing when every problem is named', () => {
    const sorted = serverFieldErrors({ data: { error: 'Validation failed.', details: [{ field: 'files.0.kind', message: 'Unknown kind' }], detailCount: 1 } }, resolve);
    expect(sorted.general).toEqual([]);
  });
});
