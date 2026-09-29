import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, within, waitFor } from './harness';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe('beginner navigation and access recovery', () => {
  it('finds pages by task words without searching records or changing permissions', async () => {
    const user = userEvent.setup();
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Operations overview' });
    const pageSearch = screen.getByRole('searchbox', { name: 'Find a page' });
    await user.type(pageSearch, 'payment match');
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(nav).getByRole('link', { name: 'Reconciliation' })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: 'Team & access' })).toBeNull();
    expect(within(nav).getByRole('status').textContent).toContain('not records');
    await user.click(within(nav).getByRole('link', { name: 'Reconciliation' }));
    await screen.findByRole('heading', { name: 'Reconciliation' });
    expect((screen.getByRole('searchbox', { name: 'Find a page' }) as HTMLInputElement).value).toBe('');
    expect(api.calls.filter(call => call.method !== 'GET')).toEqual([]);
  });

  it('keeps help reachable with no navigation matches and restores the full menu', async () => {
    const user = userEvent.setup();
    renderApp('/cash-desk?view=payroll');
    await screen.findByRole('heading', { name: 'Cash Desk' });
    const pageSearch = screen.getByRole('searchbox', { name: 'Find a page' });
    await user.type(pageSearch, 'unknownpage');
    expect(screen.getByText(/No pages match/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Help & glossary' }).getAttribute('href')).toBe('/help');
    const taskHelp = screen.getByRole('link', { name: /^Help:.*payroll/i });
    expect(taskHelp.getAttribute('href')).toContain('topic=payroll');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('link', { name: 'Overview' })).toBeTruthy();
  });

  it('does not promote administrator-only retention controls to other roles', async () => {
    api.role = 'Finance';
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Operations overview' });
    expect(screen.queryByRole('link', { name: 'Data retention' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Team & access' })).toBeTruthy();
    expect(api.calls.some(call => call.path.includes('lifecycle'))).toBe(false);
  });

  it('clears a menu search first and lets Escape close the menu when it is empty', async () => {
    const user = userEvent.setup();
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Operations overview' });
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Menu' });
    const search = within(drawer).getByRole('searchbox', { name: 'Find a page' });
    await user.type(search, 'payments');
    await user.keyboard('{Escape}');
    expect((search as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull());
  });

  it('explains access refusal and offers help without claiming saved work was lost', async () => {
    api.failNext(/^\/v1\/workspace$/, { status: 403, error: 'Your membership is not active.' });
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Your account cannot open this workspace' });
    expect(screen.getByText(/Ask its administrator to review your invitation/)).toBeTruthy();
    const help = screen.getByRole('link', { name: /^Help: Sign in/ });
    expect(help.getAttribute('href')).toContain('topic=access');
    expect(screen.queryByRole('link', { name: 'Reconciliation' })).toBeNull();
    expect(screen.getByText(/If you had just saved a change, check Operations/)).toBeTruthy();
    await waitFor(() => expect(api.calls.filter(call => call.path === '/v1/workspace')).toHaveLength(1));
  });
});
