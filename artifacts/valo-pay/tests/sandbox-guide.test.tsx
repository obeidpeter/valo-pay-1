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
    // Overview keeps Your next step and shows no tips of its own; the tips appear on the other pages.
    await screen.findByRole('region', { name: 'Where to start' });
    expect(screen.queryByRole('region', { name: 'Tips' })).toBeNull();
    await user.click(screen.getByRole('link', { name: 'Customers' }));
    const guide = await screen.findByRole('region', { name: 'Tips' });
    expect(within(guide).getByRole('button', { name: /^Tips/ }).getAttribute('aria-expanded')).toBe('false');
    await user.click(within(guide).getByRole('button', { name: /^Tips/ }));
    expect(within(guide).getByText('Tip 1 of 5. Reading a tip does not complete a task.')).toBeTruthy();
    expect(within(guide).queryByRole('button', { name: /completed this step/ })).toBeNull();
    await user.click(within(guide).getByRole('button', { name: 'Next tip' }));
    expect(within(guide).getByRole('link', { name: 'Open Matches to review' }).getAttribute('href')).toBe('/reconciliation?view=review');
    await user.click(within(guide).getByRole('link', { name: 'Open Matches to review' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Reconciliation' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Tips' })).getByText('Tip 2 of 5. Reading a tip does not complete a task.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Hide for now' }));
    expect(screen.getByRole('button', { name: /^Tips/ }).getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Tips/ }));
    await user.click(screen.getByRole('link', { name: 'Customers' }));
    await user.click(await screen.findByRole('button', { name: /^Tips/ }));
    expect(screen.getByText('Tip 2 of 5. Reading a tip does not complete a task.')).toBeTruthy();
    expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
  });

  it('keeps reading position scoped to the selected lender and never presents it as completed operational work', async () => {
    const user = userEvent.setup();
    renderApp('/customers');
    await user.click(await screen.findByRole('button', { name: /^Tips/ }));
    for (let i = 0; i < 4; i++) await user.click(screen.getByRole('button', { name: 'Next tip' }));
    await user.click(screen.getByRole('button', { name: 'Finish reading' }));
    expect(screen.getByText(/It does not show that any task or check is done/)).toBeTruthy();
    expect(screen.queryByText('Checklist complete')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Active lender', { selector: '#lender-sidebar' }), api.merchantIds[1]!);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Tips/ }).getAttribute('aria-expanded')).toBe('false'));
    await user.click(screen.getByRole('button', { name: /^Tips/ }));
    expect(screen.getByText('Tip 1 of 5. Reading a tip does not complete a task.')).toBeTruthy();
    expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
  });

  it.each(['Read-only', 'Operations'])('does not invite %s to confirm matches or export customer evidence', async role => {
    api.role = role;
    const user = userEvent.setup();
    renderApp('/customers');
    await user.click(await screen.findByRole('button', { name: /^Tips/ }));
    await user.click(screen.getByRole('button', { name: 'Next tip' }));
    expect(screen.getByText(/Admin or Finance must confirm or reject the match/)).toBeTruthy();
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole('button', { name: 'Next tip' }));
    expect(screen.getByText(/Only Admin, Finance or a Compliance reviewer can export a customer dispute pack/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Read the export guide' }).getAttribute('href')).toBe('/help?topic=exports&returnTo=%2Fcustomers');
    expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
  });

  // The service lets a Compliance reviewer claim a case and record its next action (coordinateCase), not resolve it.
  it.each([
    ['Compliance reviewer', /Claim an exception that has no owner, then record a next step or a handover\. Admin, Operations or Finance must record how it was resolved\./],
    ['Read-only', /Your role cannot resolve this exception\. Ask its owner to record the next step\./],
  ])('tells %s what it may do with an exception', async (role, advice) => {
    api.role = role;
    const user = userEvent.setup();
    renderApp('/customers');
    await user.click(await screen.findByRole('button', { name: /^Tips/ }));
    for (let i = 0; i < 2; i++) await user.click(screen.getByRole('button', { name: 'Next tip' }));
    const guide = screen.getByRole('region', { name: 'Tips' });
    expect(within(guide).getByRole('heading', { name: 'Follow an exception to its next step' })).toBeTruthy();
    expect(within(guide).getByText(advice)).toBeTruthy();
    expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
  });
});
