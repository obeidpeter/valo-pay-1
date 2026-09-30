import { act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { queryClient } from '@/App';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe('protected console drafts', () => {
  it('lets a dirty dialog keep its draft on Escape and cancel, or deliberately discard it', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderApp('/customers'); await screen.findByText('Ada Okonkwo');
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(/^Full name/);
    await user.type(name, 'Unsaved sample customer');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect((name as HTMLInputElement).value).toBe('Unsaved sample customer');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(confirm).toHaveBeenCalledTimes(2);
    confirm.mockReturnValue(true);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    expect((screen.getByLabelText(/^Full name/) as HTMLInputElement).value).toBe('');
  });

  it('guards settings navigation, lender changes and tab closing without storing the draft', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderApp('/settings'); await screen.findByText('07:00 WAT');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByLabelText('Lender contact details for customer notices'), ' private draft');
    const before = window.location.pathname;
    await user.click(screen.getAllByRole('link', { name: 'Overview' })[0]!);
    expect(window.location.pathname).toBe(before);
    await user.selectOptions(screen.getAllByLabelText('Active lender')[0]!, api.merchantIds[1]!);
    expect((screen.getAllByLabelText('Active lender')[0] as HTMLSelectElement).value).toBe(api.merchantIds[0]);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
    expect(JSON.stringify(localStorage)).not.toContain('private draft');
    confirm.mockReturnValue(true);
    await user.selectOptions(screen.getAllByLabelText('Active lender')[0]!, api.merchantIds[1]!);
    await screen.findByRole('button', { name: 'Edit' });
    expect(screen.queryByDisplayValue(/private draft/)).toBeNull();
  });

  it.each(['success', 'error'])('keeps a new lender settings draft when an old save finishes with %s', async outcome => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/settings'); await screen.findByText('07:00 WAT');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const first = screen.getByPlaceholderText('07:00');
    await user.clear(first); await user.type(first, '08:15');
    const originalFetch = globalThis.fetch;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = async (input, options) => {
      const response = await originalFetch(input, options);
      if (options?.method === 'PATCH') await held;
      return response;
    };
    if (outcome === 'error') api.failNext(/^\/v1\/settings$/, { status: 409, error: 'Earlier draft is outdated. Refresh and review it.' }, 'PATCH');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Saving…' });
    await user.selectOptions(screen.getAllByLabelText('Active lender')[0]!, api.merchantIds[1]!);
    await screen.findByRole('button', { name: 'Edit' });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const current = screen.getByPlaceholderText('07:00');
    await user.clear(current); await user.type(current, '10:30');
    await act(async () => { release(); });
    expect(screen.queryByText('Settings saved')).toBeNull();
    expect(screen.queryByText('Settings not saved')).toBeNull();
    expect((current as HTMLInputElement).value).toBe('10:30');
  });

  it('keeps the current page and draft when browser Back is declined, then permits an intentional discard', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Overview' });
    await user.click(screen.getAllByRole('link', { name: 'Settings' })[0]!);
    await screen.findByText('07:00 WAT');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByLabelText('Lender contact details for customer notices'), ' keep this');
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    expect(screen.getByDisplayValue(/keep this/)).toBeTruthy();
    confirm.mockReturnValue(true);
    await act(async () => { window.history.back(); });
    await screen.findByRole('heading', { name: 'Overview' });
    expect(window.location.pathname).toBe('/overview');
  });

  it('retains an outdated record draft after the server rejects its original revision', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderApp('/policies');
    const edit = await screen.findAllByRole('button', { name: 'Edit template' });
    await user.click(edit[0]!);
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getAllByRole('textbox')[0]!;
    fireEvent.change(input, { target: { value: 'Keep these reviewed edits' } });
    api.failNext(/^\/v1\/records\//, { status: 409, error: 'This record changed after you opened it. Refresh and review the latest version.' }, 'PATCH');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await within(dialog).findByText('This record changed after you opened it. Refresh and review the latest version.');
    expect((input as HTMLInputElement).value).toBe('Keep these reviewed edits');
    const sent = api.calls.find(call => call.method === 'PATCH');
    expect((sent?.body as Record<string, unknown>).expectedUpdatedAt).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Discard draft and refresh' }));
    expect((input as HTMLInputElement).value).toBe('Keep these reviewed edits');
    confirm.mockReturnValue(true);
    await user.click(within(dialog).getByRole('button', { name: 'Discard draft and refresh' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.filter(call => call.method === 'GET' && /^\/v1\/records\//.test(call.path)).length).toBeGreaterThan(2);
  });

  it('keeps the Settings revision from edit start when another user changes settings in the background', async () => {
    const user = userEvent.setup();
    const originalFetch = globalThis.fetch;
    const revisions: string[] = [];
    globalThis.fetch = async (input, options) => {
      const response = await originalFetch(input, options);
      if (String(input).includes('/settings') && options?.method !== 'PATCH' && response.ok) revisions.push((await response.clone().json()).revision);
      return response;
    };
    renderApp('/settings'); await screen.findByText('07:00 WAT');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const input = screen.getByPlaceholderText('07:00');
    await user.clear(input); await user.type(input, '10:15');
    api.mutate(state => { state.settings.contactRoute = 'Another user changed this'; });
    await act(async () => { await queryClient.invalidateQueries(); });
    expect(revisions[0]).toBeTruthy();
    expect(revisions.at(-1)).not.toBe(revisions[0]);
    api.failNext(/^\/v1\/settings$/, { status: 409, error: 'Settings changed after this form opened. Refresh and review the latest settings.' }, 'PATCH');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Settings changed after this form opened. Refresh and review the latest settings.');
    expect((input as HTMLInputElement).value).toBe('10:15');
    expect(api.calls.find(call => call.method === 'PATCH')?.body).toMatchObject({ expectedRevision: revisions[0], closeTime: '10:15' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Discard draft and refresh' }));
    await screen.findByRole('button', { name: 'Edit' });
    expect(screen.getByText('Another user changed this')).toBeTruthy();
  });
});
