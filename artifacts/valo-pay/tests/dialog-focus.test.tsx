import { useLayoutEffect, useRef } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDialogActivationTracking, useDialogFocusReturn } from '@/lib/focus';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { makeRecord } from '../../api-server/src/domain/records';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); vi.spyOn(window, 'confirm').mockReturnValue(true); });
afterEach(() => api.uninstall());

// jsdom does not lay out elements. Supply geometry for this visibly rendered
// control only, so the activation tracker still rejects hidden elements.
function visible(element: HTMLElement) {
  vi.spyOn(element, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 120, 40)] as unknown as DOMRectList);
}

function FocusHarness({ open, removeOpener = false }: { open: boolean; removeOpener?: boolean }) {
  useDialogActivationTracking();
  const restore = useDialogFocusReturn(open);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (open) input.current?.focus(); }, [open]);
  return <main id="main" tabIndex={-1}>
    {!removeOpener && <button type="button">Unrelated action</button>}
    {open && <><input ref={input} aria-label="Dialog field" /><button type="button" onClick={() => restore()}>Restore focus</button></>}
  </main>;
}

describe('dialog opener restoration across browser click behavior', () => {
  it.each([
    { path: '/customers', button: 'Add customer', title: 'Add customer' },
    { path: '/evidence', button: 'Record review', title: 'Record review' },
  ])('returns $title to an opener that the browser did not focus on click', async ({ path, button, title }) => {
    const user = userEvent.setup();
    renderApp(path);
    const opener = await screen.findByRole('button', { name: button });
    visible(opener);
    screen.getByRole('main').focus();
    expect(document.activeElement).not.toBe(opener);
    // fireEvent reproduces Safari's click without the focusing pointer default.
    fireEvent.click(opener.querySelector('svg') || opener);
    const dialog = await screen.findByRole('dialog', { name: title });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('preserves keyboard opener focus without a pointer activation', async () => {
    const user = userEvent.setup();
    renderApp('/customers');
    const opener = await screen.findByRole('button', { name: 'Add customer' });
    opener.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: 'Add customer' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('does not focus unrelated clicks or reuse them for a later programmatic opening', async () => {
    const view = render(<FocusHarness open={false} />);
    const unrelated = screen.getByRole('button', { name: 'Unrelated action' });
    visible(unrelated);
    const main = screen.getByRole('main');
    main.focus();
    fireEvent.click(unrelated);
    expect(document.activeElement).toBe(main);
    await act(async () => { await new Promise<void>(resolve => window.setTimeout(resolve, 0)); });
    view.rerender(<FocusHarness open />);
    expect(document.activeElement).toBe(screen.getByLabelText('Dialog field'));
    fireEvent.click(screen.getByRole('button', { name: 'Restore focus' }));
    expect(document.activeElement).toBe(main);
  });

  it('falls back to main if the opening control was removed by the action', () => {
    const view = render(<FocusHarness open={false} />);
    const opener = screen.getByRole('button', { name: 'Unrelated action' });
    visible(opener);
    fireEvent.click(opener);
    view.rerender(<FocusHarness open />);
    view.rerender(<FocusHarness open removeOpener />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore focus' }));
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });
});

describe('connected review dialogs hand focus back after confirming', () => {
  it('returns Pay-by-bank focus to the opener after Go back, and to the result when confirming removed the opener', async () => {
    const user = userEvent.setup();
    renderApp('/pay-by-bank');
    await screen.findByRole('heading', { name: 'Pay-by-bank', level: 1 });
    const due = api.state().records.find((r) => r.reference === 'DEMO-LOAN-1005')!;
    await user.selectOptions(screen.getByLabelText('Customer and instalment'), due.id);
    await user.click(screen.getByRole('button', { name: /Create sample checkout/ }));
    const cancel = await screen.findByRole('button', { name: 'Cancel checkout' });
    await user.click(cancel);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Go back' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(cancel));

    // Authorising removes the button that opened the review: focus goes to the result, not the page body.
    await user.click(screen.getByRole('button', { name: 'Review & authorise' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Reason'), 'Review sample payment details');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm sample action' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Review & authorise' })).toBeNull();
    await waitFor(() => expect(document.activeElement?.textContent).toMatch(/^Sample bank authorisation recorded\./));
    expect(document.activeElement?.getAttribute('role')).toBe('status');
  });

  it('returns Cash Desk focus to the result when setting up removed its button, and to the opener that stays', async () => {
    api.uninstall();
    api = installFakeApi({ role: 'Operations', now: '2026-09-21T10:00:00Z' });
    api.mutate((state) => {
      for (const purpose of ['merchant_account_read', 'erp_draft', 'payroll_prepare']) makeRecord(state, 'connected-consents', {
        status: 'active', createdAt: api.now, data: { purpose, subjectId: 'sme', entityId: `${state.merchant.id}:sme`, version: 1, validFrom: api.now, expiresAt: '2026-10-21T10:00:00Z' },
      });
    });
    const user = userEvent.setup();
    const confirmIn = async (note: string) => {
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByRole('textbox', { name: 'Review note' }), note);
      await user.click(within(dialog).getByRole('button', { name: 'Confirm and save' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    };
    renderApp('/cash-desk');
    await user.click(await screen.findByRole('button', { name: /Set up sample Cash Desk/ }));
    await confirmIn('Set up the sample workspace for review');
    expect(screen.queryByRole('button', { name: /Set up sample Cash Desk/ })).toBeNull();
    await waitFor(() => expect(document.activeElement?.textContent).toMatch(/^Sample Cash Desk set up\./));

    const save = await screen.findByRole('button', { name: /Save forecast/ });
    await user.click(save);
    await confirmIn('Save the planning assumptions for review');
    await waitFor(() => expect(document.activeElement).toBe(save));
    expect(screen.getByText(/^New sample forecast saved\./)).toBeTruthy();
  });
});
