import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe('guided sandbox exploration', () => {
  it('lets people navigate, retain reading position and dismiss without performing an operation', async () => {
    const user = userEvent.setup();
    renderApp('/overview');
    const guide = await screen.findByRole('region', { name: 'Sandbox guide' });
    expect(within(guide).getByRole('button', { name: /Sandbox guide/ }).getAttribute('aria-expanded')).toBe('false');
    await user.click(within(guide).getByRole('button', { name: /Sandbox guide/ }));
    expect(within(guide).getByText('Tip 1 of 5 · Reading does not complete a task')).toBeTruthy();
    expect(within(guide).queryByRole('button', { name: /completed this step/ })).toBeNull();
    await user.click(within(guide).getByRole('button', { name: 'Next tip' }));
    expect(within(guide).getByRole('link', { name: 'Review proposed matches' }).getAttribute('href')).toBe('/reconciliation?view=review');
    await user.click(within(guide).getByRole('link', { name: 'Review proposed matches' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Reconciliation' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Sandbox guide' })).getByText('Tip 2 of 5 · Reading does not complete a task')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close for now' }));
    expect(screen.getByRole('button', { name: /Sandbox guide/ }).getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Sandbox guide/ }));
    await user.click(screen.getByRole('link', { name: 'Overview' }));
    await user.click(await screen.findByRole('button', { name: /Sandbox guide/ }));
    expect(screen.getByText('Tip 2 of 5 · Reading does not complete a task')).toBeTruthy();
    expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
  });

  it('keeps reading position scoped to the selected lender and never presents it as completed operational work', async () => {
    const user = userEvent.setup();
    renderApp('/overview');
    await user.click(await screen.findByRole('button', { name: /Sandbox guide/ }));
    for (let i = 0; i < 4; i++) await user.click(screen.getByRole('button', { name: 'Next tip' }));
    await user.click(screen.getByRole('button', { name: 'Finish reading' }));
    expect(screen.getByText(/does not confirm that operational tasks or readiness checks passed/)).toBeTruthy();
    expect(screen.queryByText('Checklist complete')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Active lender', { selector: '#lender-sidebar' }), api.merchantIds[1]!);
    await waitFor(() => expect(screen.getByRole('button', { name: /Sandbox guide/ }).getAttribute('aria-expanded')).toBe('false'));
    await user.click(screen.getByRole('button', { name: /Sandbox guide/ }));
    expect(screen.getByText('Tip 1 of 5 · Reading does not complete a task')).toBeTruthy();
    expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
  });

  it.each(['Read-only', 'Operations'])('does not invite %s to confirm matches or export customer evidence', async role => {
    api.role = role;
    const user = userEvent.setup();
    renderApp('/overview');
    await user.click(await screen.findByRole('button', { name: /Sandbox guide/ }));
    await user.click(screen.getByRole('button', { name: 'Next tip' }));
    expect(screen.getByText(/Admin or Finance must confirm or reject the match/)).toBeTruthy();
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole('button', { name: 'Next tip' }));
    expect(screen.getByText(/Admin, Finance or a Compliance reviewer must request or download/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Read the evidence guide' }).getAttribute('href')).toBe('/help?topic=exports&returnTo=%2Foverview');
    expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
  });
});
