import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { cancelInterrupted, unreceivedRecovery } from './unreceived-recovery';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); unreceivedRecovery(api); vi.spyOn(window, 'confirm').mockReturnValue(true); });
afterEach(() => api.uninstall());

async function customerImport(csv: string) {
  const user = userEvent.setup();
  renderApp('/collections');
  await user.click(await screen.findByRole('button', { name: 'Import sample data' }));
  await user.selectOptions(screen.getByLabelText('Import as'), 'customers');
  await user.click(screen.getByLabelText('CSV content'));
  await user.paste(csv);
  await user.click(screen.getByRole('button', { name: 'Check data' }));
  await screen.findByRole('heading', { name: 'Check results' });
  return user;
}

describe('UX-I01 import outcome and correction guidance', () => {
  it('explains a duplicate-only check as complete without suggesting an unavailable import', async () => {
    const user = await customerImport('row_id,name,reference,consentProvenance\nr1,Imported once,UX-I01-ONCE,Synthetic');
    await user.click(screen.getByRole('button', { name: 'Import data' }));
    await screen.findByRole('heading', { name: 'Import results' });
    const commits = api.calls.filter(call => call.path === '/v1/imports' && (call.body as { commit?: boolean }).commit).length;
    await user.click(screen.getByRole('button', { name: 'Check data' }));
    await screen.findByRole('heading', { name: 'Check results' });
    expect(within(screen.getByRole('region', { name: 'Check results' })).getByText(/Row 2 · Already imported:/)).toBeTruthy();
    expect(screen.getByText('This was a check only. No records were saved.')).toBeTruthy();
    expect(screen.getByText('All rows already exist, so there is nothing new to import. Existing records have not changed.')).toBeTruthy();
    expect(screen.queryByText('Checked and ready. Review the preview, then select Import data.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Import data' })).toHaveProperty('disabled', true);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Check results' }));
    expect(api.calls.filter(call => call.path === '/v1/imports' && (call.body as { commit?: boolean }).commit)).toHaveLength(commits);
    expect(api.state().records.filter(record => record.reference === 'UX-I01-ONCE')).toHaveLength(1);
  });

  it('starts with row errors, exposes all results on demand and returns focus to the retained CSV', async () => {
    const csv = 'row_id,name,reference,consentProvenance\nr1,Valid,UX-I01-VALID,Synthetic\nr2,Invalid,UX-I01-INVALID,';
    const user = await customerImport(csv);
    const results = screen.getByRole('region', { name: 'Check results' });
    expect(within(results).getByText(/Row 3 · Invalid/)).toBeTruthy();
    expect(within(results).getByText('Consent source or reference (column consentProvenance): Enter a value; it is blank on this row.')).toBeTruthy();
    expect(within(results).queryByText(/Row 2 · Valid/)).toBeNull();
    expect(api.state().records.some(record => record.reference === 'UX-I01-VALID')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Show all row results' }));
    expect(within(results).getByText(/Row 2 · Valid/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Correct CSV' }));
    expect(document.activeElement).toBe(screen.getByLabelText('CSV content'));
    expect(screen.getByLabelText('CSV content')).toHaveProperty('value', csv);
    const referenceMap = screen.getByLabelText('Map reference');
    expect(within(referenceMap).getByRole('option', { name: 'Full name' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/Every row needs a source row ID\. A row already imported with the same ID and data is skipped\./)).toBeTruthy();
  });

  it('recovers a lost committed import response with the same key and blocks a changed batch', async () => {
    const user = await customerImport('row_id,name,consentProvenance\nr1,Reference-free sample,Synthetic');
    const originalFetch = globalThis.fetch;
    const committed = new Map<string, Response>();
    const keys: string[] = [];
    globalThis.fetch = async (input, options) => {
      if (!String(input).includes('/imports') || !JSON.parse(String(options?.body)).commit) return originalFetch(input, options);
      const key = new Headers(options?.headers).get('Idempotency-Key')!;
      keys.push(key);
      if (committed.has(key)) return committed.get(key)!.clone();
      const response = await originalFetch(input, options);
      committed.set(key, response.clone());
      throw new TypeError('Connection interrupted after commit');
    };
    await user.click(screen.getByRole('button', { name: 'Import data' }));
    await screen.findByText('Request not confirmed');
    expect(screen.getByLabelText('CSV content')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Import as')).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Check data' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Clear import' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Check original request' }));
    await screen.findByRole('heading', { name: 'Import results' });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(api.state().records.filter(record => record.name === 'Reference-free sample')).toHaveLength(1);
    expect(screen.queryByText('Request not confirmed')).toBeNull();
  });

  it('discards a lost import deliberately, which frees the wizard for a new import under a new key', async () => {
    const user = await customerImport('row_id,name,consentProvenance\nr1,Discarded import sample,Synthetic');
    const send = globalThis.fetch;
    const keys: string[] = [];
    globalThis.fetch = async (input, options) => {
      if (options?.method === 'POST' && String(input).includes('/imports') && JSON.parse(String(options.body)).commit) keys.push(new Headers(options.headers).get('Idempotency-Key')!);
      return send(input, options);
    };
    api.failNext(/^\/v1\/imports$/, 'offline', 'POST');
    await user.click(screen.getByRole('button', { name: 'Import data' }));
    const notice = (await screen.findByText('Request not confirmed')).closest('[role=alert]') as HTMLElement;
    expect(screen.getByLabelText('CSV content')).toHaveProperty('disabled', true);
    await user.click(within(notice).getByRole('button', { name: 'Discard original request' }));
    await waitFor(() => expect(screen.queryByText('Request not confirmed')).toBeNull());
    expect(screen.getByLabelText('CSV content')).toHaveProperty('disabled', false);
    await cancelInterrupted(user);
    await user.click(screen.getByRole('button', { name: 'Import data' }));
    await screen.findByRole('heading', { name: 'Import results' });
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect(api.state().records.filter(record => record.name === 'Discarded import sample')).toHaveLength(1);
  });
});

describe('UX-I02 shared form recovery and UX-I03 review correction', () => {
  it('starts a consequential review at its title before moving to any invalid reason', async () => {
    const user = userEvent.setup(); renderApp('/reconciliation?view=review');
    const opener = await screen.findByRole('button', { name: 'Confirm match' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Confirm match' });
    expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: 'Confirm match' }));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm match' }));
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Reason *'));
    expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('links each error to its field, keeps other values and returns keyboard focus to the opener', async () => {
    const user = userEvent.setup(); renderApp('/customers');
    const opener = await screen.findByRole('button', { name: 'Add customer' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Full name/), 'Retained sample name');
    await user.click(within(dialog).getByRole('button', { name: 'Add customer' }));
    const correction = within(dialog).getByRole('button', { name: /Consent source or reference: Consent source or reference is required/ });
    await user.click(correction);
    expect(document.activeElement).toBe(within(dialog).getByLabelText(/^Consent source or reference/));
    expect(within(dialog).getByLabelText(/^Full name/)).toHaveProperty('value', 'Retained sample name');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('does not offer stale-record discard for an existing-reference conflict', async () => {
    const user = userEvent.setup(); renderApp('/customers');
    await user.click(await screen.findByRole('button', { name: 'Add customer' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Full name/), 'Sample name');
    await user.type(within(dialog).getByLabelText(/^Loan software reference/), 'UX-CONFLICT');
    await user.type(within(dialog).getByLabelText(/^Consent source or reference/), 'Synthetic consent');
    api.failNext(/^\/v1\/records\/customers$/, { status: 409, error: 'Reference already exists. Use an idempotency key for safe replay.' }, 'POST');
    await user.click(within(dialog).getByRole('button', { name: 'Add customer' }));
    await within(dialog).findByText('Reference already exists. Use an idempotency key for safe replay.');
    expect(within(dialog).queryByRole('button', { name: 'Discard draft and refresh' })).toBeNull();
    expect(within(dialog).getByLabelText(/^Loan software reference/)).toHaveProperty('value', 'UX-CONFLICT');
  });

  it('associates server errors with checkbox controls as well as text controls', async () => {
    api.mutate(state => { state.records.find(record => record.kind === 'policies')!.status = 'draft'; });
    const user = userEvent.setup(); renderApp('/policies');
    await user.click(await screen.findByRole('button', { name: 'Edit draft' }));
    const dialog = await screen.findByRole('dialog');
    api.failNext(/^\/v1\/records\/policies\//, { status: 400, error: 'Validation failed', details: [{ field: 'data.partialAllowed', message: 'Review whether partial collections are allowed.' }] }, 'PATCH');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    const box = within(dialog).getByRole('checkbox', { name: 'Allow partial collections' });
    await waitFor(() => expect(box.getAttribute('aria-invalid')).toBe('true'));
    expect(box.getAttribute('aria-describedby')).toContain('record-partialAllowed-error');
    expect(document.activeElement).toBe(box);
    await user.click(box);
    expect(box.getAttribute('aria-invalid')).toBeNull();
  });

  it('clears corrected review errors and returns focus after cancelling a partial review', async () => {
    const user = userEvent.setup(); renderApp('/evidence');
    const opener = await screen.findByRole('button', { name: 'Log review' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save review' }));
    await user.click(within(dialog).getByRole('button', { name: /Review notes: Describe what was checked/ }));
    const note = within(dialog).getByLabelText('Review notes');
    expect(document.activeElement).toBe(note);
    await user.type(note, 'Sample checks still in progress.');
    expect(note.getAttribute('aria-invalid')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /Review notes: Describe what was checked/ })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('locks an uncertain customer submission and requires an informed choice to close it', async () => {
    const user = userEvent.setup(); renderApp('/customers');
    await user.click(await screen.findByRole('button', { name: 'Add customer' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Full name/), 'Recovery sample');
    await user.type(within(dialog).getByLabelText(/^Loan software reference/), 'UX-RECOVERY');
    await user.type(within(dialog).getByLabelText(/^Consent source or reference/), 'Synthetic consent');
    api.failNext(/^\/v1\/records\/customers$/, 'offline', 'POST');
    await user.click(within(dialog).getByRole('button', { name: 'Add customer' }));
    await within(dialog).findByText('Outcome not confirmed');
    expect(within(dialog).getByRole('button', { name: 'Add customer' })).toHaveProperty('disabled', true);
    expect(within(dialog).getByLabelText(/^Full name/).closest('fieldset')).toHaveProperty('disabled', true);
    vi.mocked(window.confirm).mockReturnValue(false);
    await user.keyboard('{Escape}');
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Closing does not cancel the request'));
    expect(screen.getByRole('dialog')).toBe(dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Retry same request' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.state().records.filter(record => record.reference === 'UX-RECOVERY')).toHaveLength(1);
  });

  it('retains an uncertain partial review and recovers its exact submitted tasks', async () => {
    const user = userEvent.setup(); renderApp('/evidence');
    await user.click(await screen.findByRole('button', { name: 'Log review' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Payment matching' }));
    await user.type(within(dialog).getByLabelText('Review notes'), 'Sample matching reviewed; other tasks remain.');
    api.failNext(/^\/v1\/records\/reviews$/, 'offline', 'POST');
    await user.click(within(dialog).getByRole('button', { name: 'Save review' }));
    await within(dialog).findByText('Review outcome not confirmed');
    expect(within(dialog).getByRole('button', { name: 'Save review' })).toHaveProperty('disabled', true);
    await user.click(within(dialog).getByRole('button', { name: 'Retry same review' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.state().records.filter(record => record.kind === 'reviews')).toHaveLength(1);
    expect(api.state().records.find(record => record.kind === 'reviews')?.data.confirmedJobs).toEqual(['reconciliation']);
  });

  it('shows a refused replay without claiming the original write failed or releasing its key', async () => {
    const user = userEvent.setup(); renderApp('/customers');
    await user.click(await screen.findByRole('button', { name: 'Add customer' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Full name/), 'Already committed sample');
    await user.type(within(dialog).getByLabelText(/^Loan software reference/), 'UX-REPLAY-FORBIDDEN');
    await user.type(within(dialog).getByLabelText(/^Consent source or reference/), 'Synthetic consent');
    const originalFetch = globalThis.fetch;
    const attempts: Array<{ key: string | null; payload: string }> = [];
    let committed: Response;
    const guidance = 'Your role no longer allows this request. Ask an administrator to restore access before retrying.';
    globalThis.fetch = async (input, options) => {
      if (options?.method !== 'POST' || !String(input).includes('/records/customers')) return originalFetch(input, options);
      attempts.push({ key: new Headers(options.headers).get('Idempotency-Key'), payload: String(options.body) });
      if (attempts.length === 1) {
        committed = (await originalFetch(input, options)).clone();
        throw new TypeError('Connection interrupted after commit');
      }
      if (attempts.length === 2) return new Response(JSON.stringify({ error: guidance }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      return committed.clone();
    };
    await user.click(within(dialog).getByRole('button', { name: 'Add customer' }));
    await within(dialog).findByText('Outcome not confirmed');
    expect(api.state().records.filter(record => record.reference === 'UX-REPLAY-FORBIDDEN')).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Retry same request' }));
    await within(dialog).findByText(guidance);
    expect(within(dialog).getByText('Outcome not confirmed')).toBeTruthy();
    expect(within(dialog).getByText('Latest response')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Add customer' })).toHaveProperty('disabled', true);
    const name = within(dialog).getByLabelText(/^Full name/);
    expect(name.closest('fieldset')).toHaveProperty('disabled', true);
    await user.type(name, 'changed');
    expect(name).toHaveProperty('value', 'Already committed sample');
    await user.click(within(dialog).getByRole('button', { name: 'Retry same request' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(attempts).toHaveLength(3);
    expect(attempts[0]!.key).toBeTruthy();
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[2]).toEqual(attempts[0]);
    expect(api.state().records.filter(record => record.reference === 'UX-REPLAY-FORBIDDEN')).toHaveLength(1);
  });

  it('shows review replay guidance while retaining its unknown outcome and submitted tasks', async () => {
    const user = userEvent.setup(); renderApp('/evidence');
    await user.click(await screen.findByRole('button', { name: 'Log review' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Payment matching' }));
    await user.type(within(dialog).getByLabelText('Review notes'), 'Matching reviewed; remaining tasks pending.');
    const originalFetch = globalThis.fetch;
    const attempts: Array<{ key: string | null; payload: string }> = [];
    let committed: Response;
    const guidance = 'This role cannot record a review. Ask an administrator to restore access before retrying.';
    globalThis.fetch = async (input, options) => {
      if (options?.method !== 'POST' || !String(input).includes('/records/reviews')) return originalFetch(input, options);
      attempts.push({ key: new Headers(options.headers).get('Idempotency-Key'), payload: String(options.body) });
      if (attempts.length === 1) {
        committed = (await originalFetch(input, options)).clone();
        throw new TypeError('Connection interrupted after commit');
      }
      if (attempts.length === 2) return new Response(JSON.stringify({ error: guidance }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      return committed.clone();
    };
    await user.click(within(dialog).getByRole('button', { name: 'Save review' }));
    await within(dialog).findByText('Review outcome not confirmed');
    await user.click(within(dialog).getByRole('button', { name: 'Retry same review' }));
    await within(dialog).findByText(guidance);
    expect(within(dialog).getByText('Review outcome not confirmed')).toBeTruthy();
    expect(within(dialog).getByText('Latest response')).toBeTruthy();
    expect(within(dialog).queryByText('Review not saved')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Save review' })).toHaveProperty('disabled', true);
    expect(within(dialog).getByLabelText('Review notes').closest('fieldset')).toHaveProperty('disabled', true);
    await user.click(within(dialog).getByRole('button', { name: 'Retry same review' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(attempts).toHaveLength(3);
    expect(attempts[0]!.key).toBeTruthy();
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[2]).toEqual(attempts[0]);
    const reviews = api.state().records.filter(record => record.kind === 'reviews');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.data.confirmedJobs).toEqual(['reconciliation']);
  });
});
