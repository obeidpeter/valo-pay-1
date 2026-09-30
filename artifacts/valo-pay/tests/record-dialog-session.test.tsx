import { act } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';

// Model an external parent/scope change, not a user dismissing an in-flight
// request. Keep the real dialog mounted so a late callback has the opportunity
// to interfere with a later session if its session guard regresses.
const controlledDialog = vi.hoisted(() => ({ setOpen: undefined as ((open: boolean) => void) | undefined }));
vi.mock('@/components/record-dialog', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/record-dialog')>();
  return {
    ...actual,
    RecordDialog: (props: ComponentProps<typeof actual.RecordDialog>) => {
      controlledDialog.setOpen = props.onOpenChange;
      return <actual.RecordDialog {...props} />;
    },
  };
});

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); vi.spyOn(window, 'confirm').mockReturnValue(true); });
afterEach(() => api.uninstall());

describe('record dialog request sessions', () => {
  it.each([
    { outcome: 'success', switchLender: true },
    { outcome: 'error', switchLender: true },
    { outcome: 'success', switchLender: false },
    { outcome: 'error', switchLender: false },
  ])('ignores a late $outcome in a newer dialog (switch lender: $switchLender)', async ({ outcome, switchLender }) => {
    const user = userEvent.setup();
    renderApp('/customers');
    await screen.findByText('Ada Okonkwo');
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    const firstDialog = await screen.findByRole('dialog', { name: 'Add customer' });
    await user.type(within(firstDialog).getByLabelText(/^Full name/), 'First lender saved customer');
    await user.type(within(firstDialog).getByLabelText(/^Loan software reference/), 'FIRST-SAVED');
    await user.type(within(firstDialog).getByLabelText(/^Consent source or reference/), 'Synthetic consent for session test');
    const release = api.hold(/^\/v1\/records\/customers$/);
    if (outcome === 'error') api.failNext(/^\/v1\/records\/customers$/, { status: 400, error: 'First request rejected.', details: [{ field: 'reference', message: 'The first request reference was rejected.' }] }, 'POST');
    await user.click(within(firstDialog).getByRole('button', { name: 'Add customer' }));
    await within(firstDialog).findByRole('button', { name: 'Saving…' });
    await act(async () => { controlledDialog.setOpen!(false); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    if (switchLender) await user.selectOptions(screen.getAllByLabelText('Active lender')[0]!, api.merchantIds[1]!);
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    const currentDialog = await screen.findByRole('dialog', { name: 'Add customer' });
    const currentName = within(currentDialog).getByLabelText(/^Full name/);
    const currentReference = within(currentDialog).getByLabelText(/^Loan software reference/);
    await user.type(currentName, 'Keep this unfinished form');
    await user.type(currentReference, 'UNSAVED-NEW-FORM');
    await act(async () => { release(); });
    await waitFor(() => expect(api.calls.some(call => call.path === '/v1/records/customers' && call.method === 'POST')).toBe(true));
    expect(screen.getByRole('dialog', { name: 'Add customer' })).toBe(currentDialog);
    expect((currentName as HTMLInputElement).value).toBe('Keep this unfinished form');
    expect((currentReference as HTMLInputElement).value).toBe('UNSAVED-NEW-FORM');
    expect(within(currentDialog).queryByRole('alert')).toBeNull();
    expect(currentReference.getAttribute('aria-invalid')).toBeNull();
    expect(within(currentDialog).getByRole('button', { name: 'Add customer' }).hasAttribute('disabled')).toBe(false);
    const writes = api.calls.filter(call => call.path === '/v1/records/customers' && call.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.query.merchantId).toBe(api.merchantIds[0]);
    expect(writes[0]!.status).toBe(outcome === 'success' ? 200 : 400);
    if (outcome === 'success') {
      expect(api.state(api.merchantIds[0]).records.some(record => record.reference === 'FIRST-SAVED')).toBe(true);
      // The completed write still invalidates active list data despite the old form having closed.
      await waitFor(() => expect(api.calls.filter(call => call.path === '/v1/records/customers' && call.method === 'GET').length).toBeGreaterThan(1));
    }
  });

  it('keeps the pending request open through Cancel, close and Escape, then closes after the result', async () => {
    const user = userEvent.setup();
    renderApp('/customers');
    await screen.findByText('Ada Okonkwo');
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add customer' });
    await user.type(within(dialog).getByLabelText(/^Full name/), 'Pending sample customer');
    await user.type(within(dialog).getByLabelText(/^Loan software reference/), 'PENDING-CUSTOMER');
    await user.type(within(dialog).getByLabelText(/^Consent source or reference/), 'Synthetic consent');
    const release = api.hold(/^\/v1\/records\/customers$/);
    await user.click(within(dialog).getByRole('button', { name: 'Add customer' }));
    const saving = await within(dialog).findByRole('button', { name: 'Saving…' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(cancel).toHaveProperty('disabled', true);
    expect(close).toHaveProperty('disabled', true);
    expect(saving).toHaveProperty('disabled', true);
    await user.click(cancel);
    await user.click(close);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Add customer' })).toBe(dialog);
    expect(window.confirm).not.toHaveBeenCalled();
    await act(async () => { release(); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.filter(call => call.path === '/v1/records/customers' && call.method === 'POST')).toHaveLength(1);
    expect(api.state().records.filter(record => record.reference === 'PENDING-CUSTOMER')).toHaveLength(1);
  });
});
