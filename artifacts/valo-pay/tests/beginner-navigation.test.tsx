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
    expect(within(nav).queryByRole('link', { name: 'Team and access' })).toBeNull();
    expect(within(nav).getByText(/This searches page names, not records\./)).toBeTruthy();
    await user.click(within(nav).getByRole('link', { name: 'Reconciliation' }));
    await screen.findByRole('heading', { name: 'Reconciliation' });
    expect((screen.getByRole('searchbox', { name: 'Find a page' }) as HTMLInputElement).value).toBe('');
    expect(api.calls.filter(call => call.method !== 'GET')).toEqual([]);
  });

  it('keeps the page search live region in place before the first search, so its first count is announced', async () => {
    const user = userEvent.setup();
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Operations overview' });
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    // A screen reader announces a change to a live region, not a region that arrives with its first message.
    const region = nav.querySelector('[role="status"], [aria-live="polite"]');
    expect(region?.textContent).toBe('');
    await user.type(within(nav).getByRole('searchbox', { name: 'Find a page' }), 'payroll');
    expect(nav.querySelector('[role="status"], [aria-live="polite"]')).toBe(region);
    expect(region?.textContent).toBe('1 page found. This searches page names, not records.');
  });

  it('returns focus to the page search when Clear page search removes itself', async () => {
    const user = userEvent.setup();
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Operations overview' });
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    const pageSearch = within(nav).getByRole('searchbox', { name: 'Find a page' });
    await user.type(pageSearch, 'payroll');
    await user.click(within(nav).getByRole('button', { name: 'Clear page search' }));
    expect((pageSearch as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(pageSearch);
  });

  it('returns focus to the drawer’s page search, not the drawer, when its search is cleared from the keyboard', async () => {
    const user = userEvent.setup();
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Operations overview' });
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Menu' });
    const search = within(drawer).getByRole('searchbox', { name: 'Find a page' });
    await user.type(search, 'payroll');
    await user.tab();
    expect(document.activeElement).toBe(within(drawer).getByRole('button', { name: 'Clear page search' }));
    await user.keyboard('{Enter}');
    expect((search as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(search);
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeTruthy();
  });

  it('keeps help reachable with no navigation matches and restores the full menu', async () => {
    const user = userEvent.setup();
    renderApp('/cash-desk?view=payroll');
    await screen.findByRole('heading', { name: 'Cash Desk' });
    const pageSearch = screen.getByRole('searchbox', { name: 'Find a page' });
    await user.type(pageSearch, 'unknownpage');
    expect(screen.getByText(/No pages match/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Help' }).getAttribute('href')).toBe('/help');
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
    expect(screen.getByRole('link', { name: 'Team and access' })).toBeTruthy();
    expect(api.calls.some(call => call.path.includes('lifecycle'))).toBe(false);
  });

  it('clears a menu search first and lets Escape close the menu when it is empty', async () => {
    const user = userEvent.setup();
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Operations overview' });
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
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
    expect(screen.getByText(/ask an Admin there to check your invitation/)).toBeTruthy();
    const help = screen.getByRole('link', { name: /^Help: Sign in/ });
    expect(help.getAttribute('href')).toContain('topic=access');
    expect(screen.queryByRole('link', { name: 'Reconciliation' })).toBeNull();
    expect(screen.getByText(/If you had just saved a change, check Request history/)).toBeTruthy();
    await waitFor(() => expect(api.calls.filter(call => call.path === '/v1/workspace')).toHaveLength(1));
  });
});
