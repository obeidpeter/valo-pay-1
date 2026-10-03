import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent } from './harness';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe('effective daily-close status', () => {
  it.each(['/overview', '/reports', '/settings'])('shows manual-only service status at %s even when the lender requested scheduling', async (path) => {
    api.scheduler.state = 'off';
    renderApp(path);
    expect(await screen.findByText('Automatic daily closes are switched off in Valo Pay 1. Run a daily close on Reports when you need one.')).toBeTruthy();
    expect(screen.queryByText(/^Next daily close:/)).toBeNull();
    expect(api.state().settings.scheduledCloseEnabled).toBe(true);
  });

  it.each(['/overview', '/reports', '/settings'])('says daily closes run automatically on a schedule at %s instead of asking for manual closes', async (path) => {
    api.scheduler.state = 'external';
    renderApp(path);
    expect(await screen.findByText('Daily closes run automatically on a schedule.')).toBeTruthy();
    expect(screen.queryByText(/Run a daily close on Reports/)).toBeNull();
    expect(screen.queryByText(/^Next daily close:/)).toBeNull();
  });

  it('warns of a close the scheduled job has not run, with the missed-close alert', async () => {
    api.scheduler.state = 'external';
    api.mutate(state => { state.settings.nextCloseAt = new Date(Date.parse(api.now) - 45 * 60_000).toISOString(); });
    renderApp('/overview');
    expect(await screen.findByText(/^The \d\d:\d\d WAT daily close did not run for this lender\. It is 45 minutes late\. Run a daily close on Reports\. If this keeps happening, contact the Valo Pay 1 team\./)).toBeTruthy();
    expect(screen.getByText('Scheduled daily close missed')).toBeTruthy();
    expect(screen.getByText(/Business date still to close:/)).toBeTruthy();
  });

  it('keeps saving a requested schedule distinct from starting the service', async () => {
    const user = userEvent.setup();
    api.scheduler.state = 'off';
    renderApp('/settings');
    await screen.findByText('Automatic daily closes are switched off in Valo Pay 1. Run a daily close on Reports when you need one.');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByText('When this is on, Valo Pay 1 runs the daily close at this time each day. Saving this does not run a close now. A missed close runs as soon as Valo Pay 1 can.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Automatic daily closes are switched off in Valo Pay 1. Run a daily close on Reports when you need one.')).toBeTruthy();
    expect(screen.queryByText(/^Next daily close:/)).toBeNull();
  });

  it('shows a failed service check with a recovery action rather than promising an automatic run', async () => {
    api.scheduler.lastErrorAt = api.now;
    renderApp('/reports');
    expect(await screen.findByText(/Automatic daily closes could not finish their latest check/)).toBeTruthy();
    expect(screen.getByText(/^Last failed check:/)).toBeTruthy();
    expect(screen.queryByText(/^Next daily close:/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Run daily close' })).toBeTruthy();
  });

  it('does not present a stale service check as a confirmed future close', async () => {
    api.scheduler.lastSuccessAt = new Date(Date.parse(api.now) - 300_000).toISOString();
    renderApp('/overview');
    expect(await screen.findByText(/Automatic daily closes have stopped checking on time/)).toBeTruthy();
    expect(screen.queryByText(/^Next daily close:/)).toBeNull();
  });

  it('labels a close waiting to run as due instead of calling it a future run', async () => {
    api.mutate(state => { state.settings.nextCloseAt = new Date(Date.parse(api.now) - 120_000).toISOString(); });
    renderApp('/overview');
    expect(await screen.findByText(/The daily close was due .+ Valo Pay 1 is waiting for the automatic close/)).toBeTruthy();
    expect(screen.queryByText(/^Next daily close:/)).toBeNull();
  });

  it('explains an automatic close paused because nobody changed the sandbox', async () => {
    api.mutate(state => { state.settings.scheduledCloseEnabled = false; state.settings.closePausedForInactivityAt = api.now; });
    renderApp('/settings');
    expect(await screen.findByText(/Automatic daily closes were paused on .+ because nothing changed in this sandbox for 7 days/)).toBeTruthy();
    expect(screen.queryByText('Automatic daily closes are off for this lender. Run a daily close on Reports when you need one.')).toBeNull();
  });

  it('shows a failing automatic close with its next attempt instead of only calling it missed', async () => {
    api.mutate(state => {
      const cursor = new Date(Date.parse(api.now) - 40 * 60_000).toISOString();
      state.settings.nextCloseAt = cursor;
      state.settings.closeRetry = { cursor, failures: 3, retryAt: new Date(Date.parse(api.now) + 8 * 60_000).toISOString(), lastFailedAt: api.now };
    });
    renderApp('/overview');
    expect(await screen.findByText(/The automatic daily close for this lender failed 3 times\. Next attempt: .+ Run a daily close on Reports/)).toBeTruthy();
    expect(screen.queryByText(/daily close did not run/)).toBeNull();
  });
});
