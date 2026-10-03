import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe('recognisable operational records', () => {
  it('shows the customer and references behind a proposed match, while retaining its record IDs', async () => {
    const proposal = api.state().records.find(record => record.kind === 'allocations' && record.status === 'proposed')!;
    const customer = api.state().records.find(record => record.id === proposal.customerId)!;
    const payment = api.state().records.find(record => record.id === proposal.data.paymentId)!;
    const dueItem = api.state().records.find(record => record.id === proposal.data.dueItemId)!;
    renderApp('/reconciliation');
    const customerLink = await screen.findByRole('link', { name: customer.name });
    expect(customerLink.getAttribute('href')).toMatch(new RegExp(`^/customers/${customer.id}\\?`));
    const row = customerLink.closest('tr')!;
    await within(row).findByText(payment.reference);
    expect(within(row).getByText(dueItem.reference)).toBeTruthy();
    expect(row.textContent).toContain(payment.id);
    expect(row.textContent).toContain(dueItem.id);
  });

  it('allocates a payment using a named instalment without requiring the operator to copy a UUID', async () => {
    const user = userEvent.setup();
    const dueItem = api.state().records.find(record => record.kind === 'due-items' && record.status === 'scheduled')!;
    renderApp('/reconciliation');
    await user.click(await screen.findByRole('button', { name: 'Allocate payment' }));
    const instalment = await screen.findByLabelText(/Instalment/);
    await waitFor(() => expect(within(instalment).getByRole('option', { name: new RegExp(dueItem.reference) })).toBeTruthy());
    await user.selectOptions(instalment, dueItem.id);
    const amount = screen.getByLabelText(/Amount to allocate \(₦\)/);
    await user.clear(amount);
    await user.type(amount, '1000.00');
    await user.type(screen.getByLabelText(/Reason/), 'Matched the synthetic payment evidence to this instalment.');
    await user.click(screen.getByRole('button', { name: 'Allocate payment' }));
    await waitFor(() => expect(api.calls.some(call => {
      const body = call.body as { action?: string; data?: { dueItemId?: string; amountKobo?: number } };
      return body?.action === 'manual_allocate' && body.data?.dueItemId === dueItem.id && body.data.amountKobo === 100000;
    })).toBe(true));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('names the customer and reads the status on the mandates and collections tables', async () => {
    const mandate = api.state().records.find(record => record.kind === 'mandates' && record.status === 'pending_activation')!;
    const customer = api.state().records.find(record => record.id === mandate.customerId)!;
    const mandatesPage = renderApp('/mandates');
    const link = (await screen.findAllByRole('link', { name: customer.name }))[0];
    expect(link.getAttribute('href')).toMatch(new RegExp(`^/customers/${customer.id}\\?`));
    const row = link.closest('tr')!;
    expect(within(row).getByText('Awaiting activation')).toBeTruthy();
    const workflowLabels: Record<string, string> = { transfer_to_activate: 'Activate with a bank transfer', hosted_consent: 'Consent through the provider', paper_mandate: 'Paper mandate' };
    expect(within(row).getByText(workflowLabels[String(mandate.data.workflow)]!)).toBeTruthy();
    expect(row.textContent).toContain(customer.id);
    expect(screen.queryByText('pending_activation')).toBeNull();

    const due = api.state().records.find(record => record.kind === 'due-items' && record.status === 'in_collection')!;
    const payer = api.state().records.find(record => record.id === due.customerId)!;
    mandatesPage.unmount();
    renderApp('/collections');
    const dueRow = (await screen.findByText(due.reference)).closest('tr')!;
    expect(within(dueRow).getByRole('link', { name: payer.name }).getAttribute('href')).toMatch(new RegExp(`^/customers/${payer.id}\\?`));
    expect(within(dueRow).getByText('Collection in progress')).toBeTruthy();
  });
});
