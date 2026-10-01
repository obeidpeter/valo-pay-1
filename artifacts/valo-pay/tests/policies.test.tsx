import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';

let api: FakeApi;
beforeEach(() => { api = installFakeApi({ role: 'Compliance reviewer' }); });
afterEach(() => api.uninstall());

describe('policy and template review', () => {
  it('separates policy and template failures and lets each request be retried', async () => {
    api.failNext(/^\/v1\/records\/policies$/, { status: 503, error: 'Policies temporarily unavailable.' });
    api.failNext(/^\/v1\/records\/templates$/, { status: 503, error: 'Templates temporarily unavailable.' });
    const user = userEvent.setup();
    renderApp('/policies');
    const policyAlert = (await screen.findByText('We could not load retry policies')).closest('[role="alert"]')!;
    const templateAlert = (await screen.findByText('We could not load message templates')).closest('[role="alert"]')!;
    expect(screen.queryByText('No retry policies yet')).toBeNull();
    expect(screen.queryByText('No message templates yet')).toBeNull();
    await user.click(within(policyAlert as HTMLElement).getByRole('button', { name: 'Try again' }));
    await screen.findByText('Standard lender retry policy · version 1');
    expect(screen.getByText('We could not load message templates')).toBeTruthy();
    await user.click(within(templateAlert as HTMLElement).getByRole('button', { name: 'Try again' }));
    await screen.findByText(/Example Lender: Your payment of ₦25,000.00/);
  });

  it('tests a submitted version on the instalments its policy governs before anyone approves it', async () => {
    api.mutate(state => {
      const previous = state.records.find(record => record.kind === 'policies')!;
      previous.status = 'approved';
      state.records.push({ ...structuredClone(previous), id: 'policy-next', status: 'submitted', data: { ...previous.data, version: 2, previousVersionId: previous.id, spacingHours: 72 } });
    });
    const user = userEvent.setup();
    renderApp('/policies');
    const row = (await screen.findByText('Standard lender retry policy · version 2')).closest('.p-6') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Test this version' }));
    const dialog = await screen.findByRole('dialog', { name: 'Test this version' });
    await user.type(within(dialog).getByLabelText('Reason *'), 'What would version 2 do?');
    await user.click(within(dialog).getByRole('button', { name: 'Test this version' }));
    expect(await within(dialog).findByText(/^Version 2 is not approved: this shows what it would do if it were approved and applied\./)).toBeTruthy();
    expect(within(dialog).queryByText('No instalments use this policy yet.')).toBeNull();
    expect(api.calls.find(call => (call.body as { action?: string })?.action === 'backtest_policy')?.body).toMatchObject({ recordId: 'policy-next' });
    expect(api.state().records.find(record => record.id === 'policy-next')?.status).toBe('submitted');
  });

  it('shows changed limits, spacing and both notice periods before a policy is approved', async () => {
    api.mutate(state => {
      const previous = state.records.find(record => record.kind === 'policies')!;
      previous.status = 'approved';
      state.records.push({ ...structuredClone(previous), id: 'policy-next', status: 'submitted', data: { ...previous.data, version: 2, previousVersionId: previous.id, maxAttempts: 4, spacingHours: 72, firstNoticeHours: 72, retryNoticeHours: 48 } });
    });
    const user = userEvent.setup();
    renderApp('/policies');
    await user.click(await screen.findByRole('button', { name: 'Approve policy' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve policy' });
    expect(within(dialog).getByText(/Previous version: 1/)).toBeTruthy();
    expect(within(dialog).getAllByText('Changed')).toHaveLength(4);
    expect(within(dialog).getByText('This version: 4')).toBeTruthy();
    expect(within(dialog).getAllByText('This version: 72 hours')).toHaveLength(2);
    expect(within(dialog).getByText('This version: 48 hours')).toBeTruthy();
    expect(within(dialog).getByText(/Example Lender: We may try to collect each payment up to 4 times/)).toBeTruthy();
    expect(api.calls.some(call => (call.body as { action?: string })?.action === 'approve_policy')).toBe(false);
    await user.type(within(dialog).getByLabelText('Reason *'), 'Reviewed changes and notice periods.');
    await user.click(within(dialog).getByRole('button', { name: 'Approve policy' }));
    await waitFor(() => expect(api.state().records.find(record => record.id === 'policy-next')?.status).toBe('approved'));
  });

  it('renders previous and proposed message wording with synthetic values before approval', async () => {
    api.mutate(state => {
      const previous = state.records.find(record => record.kind === 'templates')!;
      previous.status = 'approved';
      state.records.push({ ...structuredClone(previous), id: 'template-next', status: 'submitted', data: { ...previous.data, version: 2, previousVersionId: previous.id, text: '{{merchant}}: We plan to collect {{amount}} on {{date}}. Need help? {{contact}}.' } });
    });
    const user = userEvent.setup();
    renderApp('/policies');
    await user.click(await screen.findByRole('button', { name: 'Approve template' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve template' });
    expect(within(dialog).getByText(/Previous version: 1/)).toBeTruthy();
    expect(within(dialog).getByText(/Example Lender: Your payment of ₦25,000.00 is due on 25 September 2026/)).toBeTruthy();
    expect(within(dialog).getByText(/Example Lender: We plan to collect ₦25,000.00 on 25 September 2026/)).toBeTruthy();
    expect(within(dialog).getByText('This version: message changed')).toBeTruthy();
    expect(api.calls.some(call => (call.body as { action?: string })?.action === 'approve_template')).toBe(false);
  });

  it('does not invent a baseline when a linked prior version is missing', async () => {
    api.mutate(state => {
      const policy = state.records.find(record => record.kind === 'policies')!;
      policy.status = 'submitted';
      policy.data.previousVersionId = 'unavailable-version';
      policy.data.version = 2;
    });
    const user = userEvent.setup();
    renderApp('/policies');
    await user.click(await screen.findByRole('button', { name: 'Approve policy' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve policy' });
    expect(within(dialog).getByText(/The previous version is not available/)).toBeTruthy();
    expect(within(dialog).queryByText('Changed')).toBeNull();
  });

  it('creates a linked draft successor through the existing version action', async () => {
    api.role = 'Admin';
    api.mutate(state => { state.records.find(record => record.kind === 'policies')!.status = 'approved'; });
    const previous = api.state().records.find(record => record.kind === 'policies')!;
    const user = userEvent.setup();
    renderApp('/policies');
    await user.click(await screen.findByRole('button', { name: 'Draft next version' }));
    const dialog = await screen.findByRole('dialog', { name: 'Draft next version' });
    await user.type(within(dialog).getByLabelText('Reason *'), 'Prepare the next review.');
    await user.click(within(dialog).getByRole('button', { name: 'Draft next version' }));
    await screen.findByText('Standard lender retry policy · version 2');
    expect(api.state().records.find(record => record.kind === 'policies' && record.data.version === 2)?.data.previousVersionId).toBe(previous.id);
  });

  it('leaves the version number to the API when a policy is drafted or edited', async () => {
    api.role = 'Admin';
    const seeded = api.state().records.find(record => record.kind === 'policies')!;
    const user = userEvent.setup();
    renderApp('/policies');
    await user.click(await screen.findByRole('button', { name: 'Edit draft' }));
    let dialog = await screen.findByRole('dialog', { name: 'Edit policy draft' });
    expect(within(dialog).queryByLabelText(/^Version/)).toBeNull();
    const spacing = within(dialog).getByLabelText(/^Time between attempts/);
    await user.clear(spacing); await user.type(spacing, '72');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.state().records.find(record => record.id === seeded.id)?.data.spacingHours).toBe(72));
    expect(api.state().records.find(record => record.id === seeded.id)?.data.version).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Draft a policy' }));
    dialog = await screen.findByRole('dialog', { name: 'Draft a policy' });
    expect(within(dialog).queryByLabelText(/^Version/)).toBeNull();
    await user.type(within(dialog).getByLabelText(/^Policy name/), 'Short-term loan policy');
    for (const [label, value] of [[/^Maximum attempts/, '3'], [/^Time between attempts/, '48'], [/^Notice before first attempt/, '48'], [/^Notice before each retry/, '24'], [/^How this policy meets each required rule/, 'Synthetic mapping for review.']] as const) {
      await user.type(within(dialog).getByLabelText(label), value);
    }
    await user.click(within(dialog).getByRole('button', { name: 'Draft a policy' }));
    await waitFor(() => expect(api.state().records.find(record => record.kind === 'policies' && record.name === 'Short-term loan policy')?.data.version).toBe(1));
    await waitFor(() => expect(screen.getAllByText(/ · version 1$/)).toHaveLength(2));
  });

  it('updates the synthetic template preview while editing without interpreting markup', async () => {
    api.role = 'Admin';
    const user = userEvent.setup();
    renderApp('/policies');
    await user.click(await screen.findByRole('button', { name: 'Edit template' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit template' });
    const text = within(dialog).getByLabelText(/^Message/);
    await user.clear(text);
    await user.paste('<script>sample</script> {{merchant}}');
    expect(within(dialog).getByText('<script>sample</script> Example Lender')).toBeTruthy();
    expect(dialog.querySelector('script')).toBeNull();
  });
});
