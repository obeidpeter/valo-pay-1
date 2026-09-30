import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { makeRecord } from '../../api-server/src/domain/records';
import { executeAction } from '../../api-server/src/domain';
import { connectedRevision, runConnectedAction } from '../../api-server/src/domain/connected';
import type { Context, DomainState, ValopayRecord } from '../../api-server/src/domain/types';

// The console offers only what the service allows. Reconciliation records a hold for a renewed review of an
// earlier reversal decision on the payments and instalments it concerns (data.legacyReversalReviewIds); the
// service then refuses to allocate, confirm, release or check out, and only Finance or an administrator may
// resolve the review. Each reason the console gives is the service's own. A hold may keep an instalment's status
// (paid, or unpaid after its final attempt) or pause one still being collected in dispute
// (legacyReversalReviewPause), so the console reads the hold from the field, never from the status.
let api: FakeApi;
beforeEach(() => { api = installFakeApi({ now: '2026-09-21T10:00:00.000Z' }); });
afterEach(() => api.uninstall());

const byReference = (reference: string, kind: string) => api.state().records.find(record => record.kind === kind && record.reference === reference)!;
/** What the service says to a request, on a copy of the lender: its refusal's words, or 'accepted'. */
const serviceSays = (role: string, run: (state: DomainState, ctx: Context) => unknown) => {
  try { run(structuredClone(api.state()), { actor: `Sandbox ${role}`, role, now: api.now } as Context); }
  catch (error) { return (error as Error).message; }
  return 'accepted';
};
/** An instalment's status as a hold leaves it: kept when paid or unpaid after its final attempt, else paused in dispute. */
const heldStatus = (reference: string, status: 'unpaid_final' | 'paused') => api.mutate(state => {
  const due = state.records.find(record => record.kind === 'due-items' && record.reference === reference)!;
  if (status === 'paused') { due.data.legacyReversalReviewPause = { status: due.status, pausedAt: api.now }; due.status = 'in_dispute'; }
  else due.status = status;
});
const reasonFor = (button: HTMLElement) => document.getElementById(button.getAttribute('aria-describedby') || '')?.textContent;
/** An open renewed review, and the holds reconciliation records for it on the records it names. */
function holdFor(references: Array<[string, string]>) {
  return api.mutate(state => {
    const due = state.records.find(record => record.kind === 'due-items' && record.reference === 'DEMO-LOAN-1005')!;
    const review = makeRecord(state, 'exceptions', { name: 'Review earlier reversal decision', status: 'open', customerId: due.customerId, amountKobo: due.amountKobo, data: {
      type: 'provider_status_mismatch', owner: 'Finance', severity: 'high', linkedRecordId: 'earlier-reversal-evidence', linkedKind: 'observations',
      condition: 'reversal_unseen:earlier-reversal-evidence:review:earlier-decision', notes: 'Earlier decision recorded without a rule version.',
      legacyResolutionReview: { priorExceptionId: 'earlier-decision', priorObservation: { status: 'resolved', resolutionKey: null, resolvedTo: null, paymentId: null } },
    } });
    for (const [kind, reference] of references) state.records.find(record => record.kind === kind && record.reference === reference)!.data.legacyReversalReviewIds = [review.id];
    return review;
  });
}

describe('renewed reversal reviews', () => {
  it('offers Resolve to Finance and administrators only, and tells Operations why not', async () => {
    const review = holdFor([]);
    const resolve = (role: string) => serviceSays(role, (state, ctx) => executeAction(state, ctx, { action: 'resolve_exception', recordId: review.id, reason: 'Provider evidence checked for the renewed review.', data: { resolutionCode: 'provider_state_adopted' } }));
    expect(resolve('Operations')).toBe('Operations is not permitted to make this change.');
    api.role = 'Operations';
    renderApp('/exceptions?view=open&type=provider_status_mismatch');
    const row = (await screen.findByText('Earlier decision recorded without a rule version.')).closest('tr')!;
    const button = within(row).getByRole('button', { name: 'Resolve' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(reasonFor(button)).toBe('Only Admin or Finance can record a second review of an earlier reversal decision.');
    await userEvent.setup().click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
    for (const role of ['Finance', 'Admin']) expect(resolve(role)).toBe('accepted');
  });
});

describe('held payments and instalments', () => {
  it('does not offer Allocate for a held payment, in the service\'s words, nor a held instalment in the allocation picker', async () => {
    const user = userEvent.setup();
    const payment = api.mutate(state => {
      const payer = state.records.find(record => record.kind === 'due-items' && record.reference === 'DEMO-LOAN-1006')!;
      return makeRecord(state, 'payments', { name: 'Held receipt', status: 'unallocated', reference: 'SBX-HELD-PAY', customerId: payer.customerId, amountKobo: 100_000, data: { providerReference: 'SBX-HELD-PAY', currency: 'NGN', channel: 'direct_debit', collectionStatus: 'succeeded', settlementStatus: 'unsettled', reversalStatus: 'none', refundStatus: 'none', allocatedKobo: 0 } });
    });
    holdFor([['payments', 'SBX-HELD-PAY'], ['due-items', 'DEMO-LOAN-1005']]);
    // A hold may leave the instalment unpaid after its final attempt, a status that could otherwise take a payment.
    heldStatus('DEMO-LOAN-1005', 'unpaid_final');
    const open = byReference('DEMO-LOAN-1006', 'due-items'), held = byReference('DEMO-LOAN-1005', 'due-items');
    const allocate = (paymentId: string, due: ValopayRecord) => serviceSays('Finance', (state, ctx) => executeAction(state, ctx, { action: 'manual_allocate', recordId: paymentId, reason: 'Checking what the service says', data: { dueItemId: due.id, amountKobo: 100 } }));
    api.role = 'Finance';
    renderApp('/reconciliation');
    const payments = (await screen.findByRole('heading', { name: 'Unallocated payments' })).parentElement!.parentElement!;
    const row = (await within(payments).findByText('SBX-HELD-PAY')).closest('tr')!;
    const button = within(row).getByRole('button', { name: 'Allocate' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(reasonFor(button)).toBe(allocate(payment.id, open));
    expect(reasonFor(button)).toBe('This payment is held for renewed Finance review of an earlier reversal decision. Resolve that review and run reconciliation before allocating it.');
    // The unidentified receipt may take any customer's instalment, but the service refuses a held one, so the picker
    // does not offer it, whatever its status, and counts only the choices the service accepts.
    const unidentified = byReference('SBX-UNIDENTIFIED-001', 'payments');
    expect(allocate(unidentified.id, held)).toBe('This instalment is held for renewed Finance review of an earlier reversal decision. Resolve that review and run reconciliation before allocating a payment.');
    const other = within(payments).getByText('SBX-UNIDENTIFIED-001').closest('tr')!;
    await user.click(within(other).getByRole('button', { name: 'Allocate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Allocate payment' });
    await waitFor(() => expect(within(dialog).getByRole('option', { name: /DEMO-LOAN-1006/ })).toBeTruthy());
    expect(within(dialog).queryByRole('option', { name: /DEMO-LOAN-1005/ })).toBeNull();
    expect(within(dialog).getByText(/held for a renewed reversal review cannot take a payment and are not listed/)).toBeTruthy();
  });

  it.each([
    ['its payment and instalment are', [['payments', 'SBX-PAY-1003'], ['due-items', 'DEMO-LOAN-1003']]],
    ['its instalment is', [['due-items', 'DEMO-LOAN-1003']]],
    ['its payment is', [['payments', 'SBX-PAY-1003']]],
  ] as Array<[string, Array<[string, string]>]>)('does not offer Confirm for a proposed match when %s held, and says why as the service does', async (_what, held) => {
    holdFor(held);
    const proposal = api.state().records.find(record => record.kind === 'allocations' && record.status === 'proposed')!;
    const confirm = serviceSays('Finance', (state, ctx) => executeAction(state, ctx, { action: 'confirm_allocation', recordId: String(proposal.data.paymentId), reason: 'Checking what the service says', data: { proposalId: proposal.id, proposalUpdatedAt: proposal.updatedAt } }));
    expect(confirm).toBe('This instalment is held for renewed Finance review of an earlier reversal decision. Resolve that review and run reconciliation before allocating a payment.');
    api.role = 'Finance';
    renderApp('/reconciliation');
    const matches = (await screen.findByRole('heading', { name: 'Proposed matches' })).parentElement!.parentElement!;
    const row = (await within(matches).findByText('SBX-PAY-1003')).closest('tr')!;
    const button = within(row).getByRole('button', { name: 'Confirm' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(reasonFor(button)).toBe(confirm);
    // Rejecting a proposal applies no money, so the service allows it and it stays offered.
    expect(within(row).getByRole('button', { name: 'Reject' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('does not offer Release from dispute for a held instalment, and says why as the service does', async () => {
    holdFor([['due-items', 'DEMO-LOAN-1005']]);
    heldStatus('DEMO-LOAN-1005', 'paused');
    const due = byReference('DEMO-LOAN-1005', 'due-items');
    const release = serviceSays('Finance', (state, ctx) => executeAction(state, ctx, { action: 'release_dispute', recordId: due.id, reason: 'Checking what the service says' }));
    expect(release).toBe('Resolve the renewed reversal review and run reconciliation before releasing this instalment.');
    api.role = 'Finance';
    renderApp('/collections');
    const row = (await screen.findByText('DEMO-LOAN-1005')).closest('tr')!;
    const button = within(row).getByRole('button', { name: 'Release from dispute' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(reasonFor(button)).toBe(release);
  });

  it('does not offer a pay-by-bank checkout, or its authorisation, for a held instalment, and says why as the service does', async () => {
    const user = userEvent.setup();
    const due = byReference('DEMO-LOAN-1005', 'due-items');
    const intent = api.mutate(state => makeRecord(state, 'connected-intents', { name: `Pay ${due.name}`, status: 'created', amountKobo: due.amountKobo, customerId: due.customerId, data: { dueItemId: due.id, currency: 'NGN', beneficiary: state.merchant.name, beneficiaryId: state.merchant.id, rail: 'simulated_bank_authorised_a2a', expiresAt: '2026-09-21T10:15:00.000Z', createdBy: 'Sandbox Finance', events: [{ at: api.now, status: 'created', detail: 'Earlier checkout' }] } }));
    holdFor([['due-items', 'DEMO-LOAN-1005']]);
    // A hold may leave the instalment unpaid after its final attempt, a status pay-by-bank lists, so the page marks it as held.
    heldStatus('DEMO-LOAN-1005', 'unpaid_final');
    const connected = (action: string, recordId: string, data: Record<string, unknown>) => serviceSays('Finance', (state, ctx) => runConnectedAction(state, ctx, { action, reason: 'Checking what the service says', recordId, data, expectedRevision: connectedRevision(state) } as never));
    const create = connected('payment.create', '', { dueItemId: due.id, amountKobo: 1000 }), authorise = connected('payment.authorise', intent.id, {});
    expect(create).toBe('This instalment is held for renewed Finance review of an earlier reversal decision. Resolve that review and run reconciliation before creating a checkout.');
    expect(authorise).toBe('This instalment is held for renewed Finance review of an earlier reversal decision. Resolve that review and run reconciliation before authorising a checkout.');
    api.role = 'Finance';
    renderApp('/pay-by-bank');
    await screen.findByRole('heading', { name: 'Pay-by-bank', level: 1 });
    expect(within(screen.getByLabelText('Customer and instalment')).getByRole('option', { name: /DEMO-LOAN-1005 · held for review/ })).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Customer and instalment'), due.id);
    expect((screen.getByRole('button', { name: /Create sample checkout/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(create)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Review & authorise' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(authorise)).toBeTruthy();
    // Another instalment is offered as before.
    await user.selectOptions(screen.getByLabelText('Customer and instalment'), byReference('DEMO-LOAN-1006', 'due-items').id);
    expect((screen.getByRole('button', { name: /Create sample checkout/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(create)).toBeNull();
  });
});
