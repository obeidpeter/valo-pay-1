import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queryClient } from '@/App';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, within, waitFor } from './harness';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());
const start = () => screen.getByRole('region', { name: 'Where to start' });

describe('role-aware starting point', () => {
  it.each([
    ['Admin', 'Review matches', '/reconciliation?view=review'],
    ['Finance', 'Review matches', '/reconciliation?view=review'],
    ['Operations', 'Open overdue exceptions', '/exceptions?view=overdue'],
    ['Compliance reviewer', 'Open Policies and templates', '/policies'],
    ['Read-only', 'Open Customers', '/customers'],
  ])('gives %s a safe destination without changing authority', async (role, label, href) => {
    api.role = role;
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Overview' });
    expect(within(start()).getByRole('link', { name: label }).getAttribute('href')).toBe(href);
    expect(within(start()).getByText(`Your next step · ${role}`)).toBeTruthy();
    expect(api.role).toBe(role);
    expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
    expect(api.calls.filter(call => call.path === '/v1/pilot/progress')).toEqual([]);
  });

  it('loads server-derived progress only on request, resumes it, and never marks a clicked step complete', async () => {
    const user = userEvent.setup();
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Overview' });
    await user.click(within(start()).getByRole('button', { name: 'Show first steps' }));
    expect(await within(start()).findByText('Step 1 · Not started')).toBeTruthy();
    expect(within(start()).getByText('Step 2 · Waiting for review')).toBeTruthy();
    expect(within(start()).getByText('Step 3 · Not started')).toBeTruthy();
    expect(within(start()).getByText(/Progress is saved for this lender from its records/)).toBeTruthy();
    await user.click(within(start()).getByRole('button', { name: 'Hide first steps' }));
    await user.click(within(start()).getByRole('button', { name: 'Show first steps' }));
    expect(await within(start()).findByText('Step 1 · Not started')).toBeTruthy();
    const calls = api.calls.filter(call => call.path === '/v1/pilot/progress');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query.merchantId).toBe(api.merchantIds[0]);
    expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
    expect(Object.entries(localStorage).filter(([key]) => key.startsWith('valopay-start-')).map(([, value]) => value)).toEqual(['open']);
  });

  it('explains an unavailable progress read and permits a safe read retry', async () => {
    const user = userEvent.setup();
    api.failNext(/^\/v1\/pilot\/progress$/, 'offline');
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Overview' });
    await user.click(within(start()).getByRole('button', { name: 'Show first steps' }));
    expect(await within(start()).findByRole('alert')).toBeTruthy();
    expect(within(start()).getByText(/no step is shown as done/)).toBeTruthy();
    expect(within(start()).queryByText('Step 1 · Not started')).toBeNull();
    await user.click(within(start()).getByRole('button', { name: 'Check progress again' }));
    expect(await within(start()).findByText('Step 1 · Not started')).toBeTruthy();
  });

  it('advances import progress only after the saved batch is committed', async () => {
    const user = userEvent.setup();
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Overview' });
    await user.click(within(start()).getByRole('button', { name: 'Show first steps' }));
    await within(start()).findByText('Step 1 · Not started');
    await user.click(within(start()).getAllByRole('link', { name: 'Open Import batches' })[0]!);
    await user.click(await screen.findByRole('button', { name: 'Use sample' }));
    await user.click(screen.getByRole('button', { name: 'Save and check batch' }));
    await screen.findByRole('heading', { name: 'Saved check results' });
    await user.click(screen.getByRole('link', { name: 'Overview' }));
    expect(await screen.findByText('Step 1 · In progress')).toBeTruthy();
    expect(within(start()).queryByText('Step 1 · Imported')).toBeNull();
    await user.click(within(start()).getAllByRole('link', { name: 'Open Import batches' })[0]!);
    await user.click(await screen.findByRole('button', { name: /Customers sample.*Pilot sample/ }));
    await user.click(await screen.findByRole('button', { name: 'Import checked batch' }));
    await screen.findByRole('heading', { name: 'Batch imported' });
    await user.click(screen.getByRole('link', { name: 'Overview' }));
    expect(await screen.findByText('Step 1 · Imported')).toBeTruthy();
    expect(api.calls.filter(call => call.method === 'POST' && /\/commit$/.test(call.path))).toHaveLength(1);
    expect(JSON.stringify(localStorage)).not.toContain('PILOT-C001');
  });

  it('directs a read-only user to import guidance while identifying the authorised operator', async () => {
    api.role = 'Read-only';
    const user = userEvent.setup();
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Overview' });
    await user.click(within(start()).getByRole('button', { name: 'Show first steps' }));
    expect(await within(start()).findByText(/Admin, Operations or Finance must import records/)).toBeTruthy();
    expect(within(start()).getByRole('link', { name: 'Read the import guide' }).getAttribute('href')).toBe('/help?topic=imports&returnTo=%2Foverview');
    expect(within(start()).getByText(/You do not need bank details/)).toBeTruthy();
    expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
  });

  it('opens the access guide, not the first-task guide, from both of its access links', async () => {
    api.role = 'Unrecognised sample role';
    const user = userEvent.setup();
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Overview' });
    expect(within(start()).getByRole('link', { name: 'Read the access guide' }).getAttribute('href')).toBe('/help?topic=access&returnTo=%2Foverview');
    await user.click(within(start()).getByRole('button', { name: 'Show first steps' }));
    // The next step and the checklist's own link both read the access guide, in the same words.
    const links = within(start()).getAllByRole('link', { name: 'Read the access guide' });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link.getAttribute('href')).toBe('/help?topic=access&returnTo=%2Foverview');
    const access = links[1]!;
    await user.click(access);
    expect(await screen.findByRole('heading', { name: 'Sign in or accept an invitation', level: 2 })).toBeTruthy();
    expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
  });

  it('does not retain previous lender progress after access is removed', async () => {
    const user = userEvent.setup();
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Overview' });
    await user.click(within(start()).getByRole('button', { name: 'Show first steps' }));
    await within(start()).findByText('Step 1 · Not started');
    api.merchantIds = [];
    api.role = 'Read-only';
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['workspace'] }); });
    expect(await screen.findByText('No lender to show yet')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Where to start' })).toBeNull();
    expect(screen.queryByText('Step 1 · Not started')).toBeNull();
    expect(screen.getByRole('link', { name: 'Read about lender access' }).getAttribute('href')).toBe('/help?topic=access');
  });

  it.each(['Admin', 'Read-only'])('explains an empty account for %s without fetching another lender', async role => {
    api.role = role;
    api.merchantIds = [];
    renderApp('/overview');
    expect(await screen.findByText('No lender to show yet')).toBeTruthy();
    const access = screen.getByRole('region', { name: 'Lender access' });
    expect(within(access).getByRole('link').getAttribute('href')).toBe(role === 'Admin' ? '/pilot' : '/help?topic=access');
    expect(api.calls.filter(call => ['/v1/overview', '/v1/pilot/progress'].includes(call.path))).toEqual([]);
  });

  it('keeps the checklist preference separate when changing lender', async () => {
    const user = userEvent.setup();
    renderApp('/overview');
    await screen.findByRole('heading', { name: 'Overview' });
    await user.click(within(start()).getByRole('button', { name: 'Show first steps' }));
    await within(start()).findByText('Step 1 · Not started');
    await user.selectOptions(screen.getByLabelText('Active lender', { selector: '#lender-sidebar' }), api.merchantIds[1]!);
    await waitFor(() => expect(within(start()).getByRole('button', { name: 'Show first steps' }).getAttribute('aria-expanded')).toBe('false'));
    expect(api.calls.filter(call => call.path === '/v1/pilot/progress')).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText('Active lender', { selector: '#lender-sidebar' }), api.merchantIds[0]!);
    expect(await within(start()).findByRole('button', { name: 'Hide first steps' })).toBeTruthy();
  });
});
