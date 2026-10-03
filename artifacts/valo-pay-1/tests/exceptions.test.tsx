import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { makeRecord } from "../../api-server/src/domain/records";
import { raiseException, reconcile } from "../../api-server/src/domain/reconciliation";
import { providerFeeKobo } from "@workspace/valo-pay-1-schema";
import { countedTwiceEffect, otherCurrencyLinesEffect } from "@/components/exception-context";
import { permissionReason } from '@/lib/permissions';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

/** An exception's notes as the list shows them in one paragraph: its lines, each choice included, joined by spaces. */
const inOneLine = (notes: unknown) => String(notes).replace(/\s+/g, ' ').trim();

describe("exceptions", () => {
  it("shows a note's choices each on its own line, on the list and on the case", async () => {
    const notes = "The outcome of this payment is unknown.\nResolve this exception as one of these:\nConfirmed successful: the money arrived.\nConfirmed failed: the money did not arrive.\nEither way, the checkout stops holding the instalment.";
    const exception = api.mutate(state => { const record = state.records.find(item => item.kind === "exceptions" && item.status === "open")!; record.data.notes = notes; return record; });
    renderApp("/exceptions");
    const listed = await screen.findByText(inOneLine(notes));
    // The text keeps its line breaks, and the paragraph shows them as lines.
    expect(listed.textContent).toBe(notes);
    expect(listed.className).toContain("whitespace-pre-line");
    renderApp(`/cases/${exception.id}`);
    const onCase = (await screen.findAllByText(inOneLine(notes))).find(element => element !== listed)!;
    expect(onCase.className).toContain("whitespace-pre-line");
  });

  it('keeps Compliance review available without offering a generic exception edit or create', async () => {
    api.role = 'Compliance reviewer';
    renderApp('/exceptions');
    await screen.findByRole('tab', { name: 'All open (4)' });
    expect(screen.queryByRole('button', { name: 'Edit exception' })).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Open case' })).toHaveLength(4);
    expect(screen.getByText('You can view exceptions and work on their cases. Only Admin, Operations or Finance can edit or resolve an exception.')).toBeTruthy();
    expect(permissionReason({ role: 'Compliance reviewer', actor: 'reviewer' }, { kind: 'exceptions' })).toBe('Only Admin, Operations or Finance can edit exceptions. Your role is Compliance reviewer. Change your demo role in Settings.');
    // A staff pilot's role is not a demo role, so the refusal does not send the reader to Settings.
    expect(permissionReason({ role: 'Compliance reviewer', actor: 'reviewer', accessMode: 'staff' }, { kind: 'exceptions' })).toBe('Only Admin, Operations or Finance can edit exceptions. Your role is Compliance reviewer.');
    // Under a disabled button the reason says who can, once; the bar above the page shows the role and links to Change demo role.
    expect(permissionReason({ role: 'Compliance reviewer', actor: 'reviewer' }, { kind: 'exceptions' }, { brief: true })).toBe('Only Admin, Operations or Finance can edit exceptions.');
    // A single role is named as the standard lists it, with no article.
    expect(permissionReason({ role: 'Finance', actor: 'finance' }, { action: 'kill_switch' })).toBe('Only Admin can turn the emergency stop on or off. Your role is Finance. Change your demo role in Settings.');
    expect(api.calls.some(call => call.method === 'POST')).toBe(false);
  });

  // Review of the language pass, F15: an exception Valo Pay 1 closed because its cause went away says so in its status and
  // names no outcome, while one a person resolved shows Resolved and the outcome they recorded.
  it('shows an exception Valo Pay 1 closed as Closed automatically, and a resolved one with its outcome', async () => {
    const [cleared, resolved] = api.mutate(state => {
      const exceptions = state.records.filter(record => record.kind === 'exceptions');
      const gap = exceptions.find(record => record.data.type === 'imported_consent_gap')!;
      const other = exceptions.find(record => record.id !== gap.id)!;
      other.status = 'closed'; other.data.resolutionCode = 'condition_cleared';
      gap.status = 'resolved'; gap.data.resolutionCode = 'gap_accepted_in_writing';
      return [other, gap];
    });
    renderApp('/exceptions?view=resolved');
    await screen.findByRole('tab', { name: 'Resolved (2)' });
    const row = (record: { id: string }) => document.getElementById(`record-${record.id}`)!;
    await waitFor(() => expect(row(cleared)).toBeTruthy());
    expect(within(row(cleared)).getByText('Closed automatically')).toBeTruthy();
    expect(row(cleared).textContent).not.toContain('Outcome:');
    expect(within(row(resolved)).getByText('Resolved')).toBeTruthy();
    expect(row(resolved).textContent).toContain('Outcome: Gap accepted in writing');
  });

  it('preserves terminal exception details and offers case history instead of generic edits', async () => {
    api.mutate(state => {
      const exceptions = state.records.filter(record => record.kind === 'exceptions');
      exceptions[0]!.status = 'resolved';
      exceptions[1]!.status = 'closed';
    });
    renderApp('/exceptions?view=resolved');
    await screen.findByRole('tab', { name: 'Resolved (2)' });
    expect(screen.queryByRole('button', { name: 'Edit exception' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resolve exception' })).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Open case' })).toHaveLength(2);
    for (const status of ['resolved', 'closed']) {
      expect(permissionReason({ role: 'Admin', actor: 'admin' }, { kind: 'exceptions', record: { status } })).toContain('You cannot edit a resolved or closed exception');
    }
    expect(permissionReason({ role: 'Finance', actor: 'finance' }, { kind: 'exceptions', record: { status: 'open' } })).toBeNull();
  });

  it("filters all open, high severity and resolved exceptions with live counts", async () => {
    const user = userEvent.setup();
    renderApp("/exceptions");
    const open = await screen.findByRole("tab", { name: "All open (4)" });
    expect(open.getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole('table')).getByText("Missing consent evidence")).toBeTruthy();
    expect(within(screen.getByRole('table')).getAllByText("Unallocated payment")).toHaveLength(2);

    await user.click(screen.getByRole("tab", { name: "High severity (1)" }));
    expect(screen.getByRole('tabpanel', { name: 'High severity (1)' })).toBeTruthy();
    expect(within(screen.getByRole('table')).getByText("Missing consent evidence")).toBeTruthy();
    expect(within(screen.getByRole('table')).queryByText("Unallocated payment")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Resolved (0)" }));
    expect(await screen.findByText("No resolved exceptions yet")).toBeTruthy();
  });

  it('keeps the issue evidence and a return to the filtered queue in customer review', async () => {
    const user = userEvent.setup();
    const exception = api.state().records.find(record => record.kind === 'exceptions' && record.customerId && record.data.type === 'unallocated_payment')!;
    const customer = api.state().records.find(record => record.id === exception.customerId)!;
    renderApp('/exceptions?view=open&owner=Finance&type=unallocated_payment');
    const row = (await screen.findByText(customer.name)).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Resolve exception' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
    const context = within(dialog).getByRole('region', { name: 'Exception context' });
    expect(context.textContent).toContain(String(exception.data.notes));
    const destination = within(context).getByRole('link', { name: 'Open Customer history' }).getAttribute('href')!;
    const params = new URL(destination, 'https://test.invalid').searchParams;
    const returnParams = new URL(params.get('returnTo')!, 'https://test.invalid');
    expect(returnParams.pathname).toBe('/exceptions');
    expect(returnParams.searchParams.get('owner')).toBe('Finance');
    expect(returnParams.searchParams.get('type')).toBe('unallocated_payment');
    expect(returnParams.searchParams.get('lender')).toBe(api.merchantIds[0]);
    expect(api.calls.some(call => call.method === 'POST')).toBe(false);
  });

  it('offers joining held evidence to its payment only where it was held for its connection alone', async () => {
    const user = userEvent.setup();
    const finance = () => ({ actor: 'Sandbox Finance', role: 'Finance', now: api.now });
    const [line, clash] = api.mutate(state => {
      const due = state.records.find(record => record.kind === 'due-items' && record.reference === 'DEMO-LOAN-1005')!;
      const other = state.records.find(record => record.kind === 'customers' && record.id !== due.customerId)!;
      makeRecord(state, 'observations', { name: 'Webhook', status: 'unresolved', reference: 'PSK-SET-1', amountKobo: 2_500_000, customerId: due.customerId, data: { source: 'webhook', eventId: 'w1', provider: 'Sandbox Rail' } });
      reconcile(state, finance());
      // The settlement file spells the connection its own way; another payer's evidence under the same reference conflicts.
      const held = makeRecord(state, 'observations', { name: 'Settlement line', status: 'unresolved', reference: 'PSK-SET-1', amountKobo: 2_487_500, customerId: due.customerId, data: { source: 'settlement', eventId: 's1', provider: 'Sandbox Rail Settlements', grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: 'B-1' } });
      const conflicting = makeRecord(state, 'observations', { name: 'Card', status: 'unresolved', reference: 'PSK-SET-1', amountKobo: 2_500_000, customerId: other.id, data: { source: 'card', eventId: 'c1', provider: 'Sandbox Rail' } });
      reconcile(state, finance());
      return [held, conflicting];
    });
    renderApp('/exceptions?view=open&type=suspected_duplicate');
    const codesFor = async (evidence: { id: string }) => {
      const exception = api.state().records.find(record => record.kind === 'exceptions' && record.data.linkedRecordId === evidence.id)!;
      const row = (await screen.findByText(inOneLine(exception.data.notes))).closest('tr')!;
      await user.click(within(row).getByRole('button', { name: 'Resolve exception' }));
      const dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
      const labels = within(within(dialog).getByLabelText(/^Outcome/)).getAllByRole('option').map(option => option.textContent);
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Resolve exception' })).toBeNull());
      return labels;
    };
    expect(await codesFor(line)).toEqual(expect.arrayContaining(['Same payment; evidence joined to it', 'Not money; evidence set aside', 'Separate payments']));
    const conflictCodes = await codesFor(clash);
    expect(conflictCodes).toContain('Not money; evidence set aside');
    expect(conflictCodes).not.toContain('Same payment; evidence joined to it');
  });

  // Third review of the audit fixes, finding 3: the dialog said resolving only records an outcome, whatever the
  // reconciliation then did with the evidence, and the page never showed the service's answer or moved focus to it.
  it('says what each resolution of held evidence does, then shows the service\'s answer and moves focus to it', async () => {
    const user = userEvent.setup();
    const finance = () => ({ actor: 'Sandbox Finance', role: 'Finance', now: api.now });
    const line = api.mutate(state => {
      const due = state.records.find(record => record.kind === 'due-items' && record.reference === 'DEMO-LOAN-1005')!;
      makeRecord(state, 'observations', { name: 'Webhook', status: 'unresolved', reference: 'PSK-SET-1', amountKobo: 2_500_000, customerId: due.customerId, data: { source: 'webhook', eventId: 'w1', provider: 'Sandbox Rail' } });
      reconcile(state, finance());
      const held = makeRecord(state, 'observations', { name: 'Settlement line', status: 'unresolved', reference: 'PSK-SET-1', amountKobo: 2_487_500, customerId: due.customerId, data: { source: 'settlement', eventId: 's1', provider: 'Sandbox Rail Settlements', grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: 'B-1' } });
      reconcile(state, finance());
      return held;
    });
    const exception = api.state().records.find(record => record.kind === 'exceptions' && record.data.linkedRecordId === line.id)!;
    renderApp('/exceptions?view=open&type=suspected_duplicate');
    const row = (await screen.findByText(inOneLine(exception.data.notes))).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Resolve exception' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
    const code = within(dialog).getByLabelText(/^Outcome/);
    const outcome = () => within(dialog).getByText(/^Record outcome:/).parentElement!.textContent!;
    const generic = 'It does not allocate a payment, issue a refund, reissue a mandate or move money.';
    await user.selectOptions(code, 'same_payment');
    expect(outcome()).toContain('The next reconciliation joins this evidence to the payment this exception names');
    expect(outcome()).not.toContain(generic);
    await user.selectOptions(code, 'not_money');
    expect(outcome()).toContain('The next reconciliation sets this evidence aside permanently');
    await user.selectOptions(code, 'distinct_payments');
    expect(outcome()).toContain('The next reconciliation records this evidence as a separate payment.');
    await user.selectOptions(code, 'confirmed_duplicate_refund');
    expect(outcome()).toContain('The next reconciliation records this evidence as a separate payment, held until its refund is recorded.');
    expect(outcome()).not.toContain(generic);

    await user.selectOptions(code, 'same_payment');
    await user.type(within(dialog).getByLabelText(/^Reason/), 'The settlement file names the same collection.');
    await user.click(within(dialog).getByRole('button', { name: 'Resolve exception' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Resolve exception' })).toBeNull());
    const answer = await screen.findByRole('status', { name: 'Resolution recorded' });
    expect(answer.textContent).toContain('Exception resolution recorded. The next reconciliation adds this payment evidence to payment PSK-SET-1. No second payment is created.');
    // The resolved exception leaves the open queue with its Resolve button, so reading continues from the answer.
    await waitFor(() => expect(screen.queryByText(inOneLine(exception.data.notes))).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(answer));
  });

  it('says what each resolution of a reversal waiting for its payment does, and shows the answer', async () => {
    const user = userEvent.setup();
    const reversal = api.mutate((state, ctx) => {
      const waiting = makeRecord(state, 'observations', { name: 'Unseen reversal', status: 'unresolved', reference: 'NEVER-SEEN-1', amountKobo: 500_000, customerId: '', data: { source: 'webhook', eventId: 'r1', provider: 'Sandbox Rail', reversed: true, occurredAt: new Date(Date.parse(api.now) - 3 * 86_400_000).toISOString() } });
      reconcile(state, { ...ctx, actor: 'Sandbox Finance', role: 'Finance' });
      return waiting;
    });
    const exception = api.state().records.find(record => record.kind === 'exceptions' && record.data.linkedRecordId === reversal.id)!;
    expect(exception.data.type).toBe('provider_status_mismatch');
    renderApp(`/exceptions?record=${exception.id}`);
    await user.click(await screen.findByRole('button', { name: 'Resolve exception' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
    const code = within(dialog).getByLabelText(/^Outcome/);
    // Only the two codes that decide it are offered, each named for what it does to the reversal rather than by the
    // generic mismatch's labels, and the box says to leave the exception open while Finance checks.
    expect(within(code).getAllByRole('option').map(option => option.textContent)).toEqual(['Choose an option', 'Provider status accepted; reversal waits for its payment', 'Valo Pay 1 status kept; reversal set aside permanently']);
    // A payment that arrives meanwhile is reversed only through the reversal's own connection (fourth review, finding 4),
    // and only when it agrees with the reversal: one naming another payer, currency or amount is held too (its review).
    const before = within(dialog).getByText('Record an outcome after reviewing the evidence.').parentElement!.textContent;
    expect(before).toContain('Leave this exception open: Do this while you ask the provider which payment the reversal belongs to. If that payment arrives through the same connection and matches, the reversal applies to it. If it arrives through another connection, or names a different payer, currency or amount, the reversal is held for you as a new exception. Either way, this exception then closes.');
    expect(before).not.toContain('if its payment arrives meanwhile, the reversal applies to it');
    expect(before).not.toContain('through the same connection, the reversal applies to it');
    const outcome = () => within(dialog).getByText(/^Record outcome:/).parentElement!.textContent!;
    await user.selectOptions(code, 'provider_state_adopted');
    expect(within(dialog).getByText(/^Record outcome:/).textContent).toBe('Record outcome: Provider status accepted; reversal waits for its payment');
    expect(outcome()).toContain('The reversal keeps waiting for its payment, and no new exception is raised. When reconciliation records that payment, it reverses it.');
    await user.selectOptions(code, 'platform_state_confirmed');
    expect(within(dialog).getByText(/^Record outcome:/).textContent).toBe('Record outcome: Valo Pay 1 status kept; reversal set aside permanently');
    expect(outcome()).toContain('The next reconciliation sets the reversal aside permanently. It reverses nothing, even if its payment arrives later.');
    expect(outcome()).not.toContain('It does not allocate a payment');
    await user.type(within(dialog).getByLabelText(/^Reason/), 'The provider confirmed no such collection.');
    await user.click(within(dialog).getByRole('button', { name: 'Resolve exception' }));
    const answer = await screen.findByRole('status', { name: 'Resolution recorded' });
    expect(answer.textContent).toMatch(/Exception resolution recorded\. This reversal evidence is set aside at the next reconciliation/);
    // Its Resolve button goes with the resolution, so focus moves to the answer; the exception, shown alone, names its resolution the same way.
    await waitFor(() => expect(document.activeElement).toBe(answer));
    expect(await screen.findByText('Outcome: Valo Pay 1 status kept; reversal set aside permanently')).toBeTruthy();
  });

  it('keeps the generic labels and words for a provider status mismatch that is not a waiting reversal', async () => {
    const user = userEvent.setup();
    const mismatch = api.mutate((state, ctx) => raiseException(state, ctx, 'provider_status_mismatch', { notes: 'The provider shows the mandate active; the platform shows it pending activation.' }));
    renderApp(`/exceptions?record=${mismatch.id}`);
    await user.click(await screen.findByRole('button', { name: 'Resolve exception' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
    const code = within(dialog).getByLabelText(/^Outcome/);
    expect(within(code).getAllByRole('option').map(option => option.textContent)).toEqual(['Choose an option', 'Provider status accepted', 'Valo Pay 1 status kept', 'Escalated to provider']);
    await user.selectOptions(code, 'provider_state_adopted');
    expect(within(dialog).getByText(/^Record outcome:/).textContent).toBe('Record outcome: Provider status accepted');
    expect(within(dialog).getByText(/^Record outcome:/).parentElement!.textContent).toContain('It does not allocate a payment, issue a refund, reissue a mandate or move money.');
  });

  // Third review, a residual: an exception raised for money in another currency holds that money's minor units, and the
  // row and the resolve dialog showed them as naira (₦1,000.00 for a USD 1,000.00 payment).
  it('shows an exception about money in another currency in that currency, in its row and its resolve dialog', async () => {
    const user = userEvent.setup();
    const exception = api.mutate((state, ctx) => {
      const ada = state.records.find(record => record.kind === 'customers' && record.name === 'Ada Okonkwo')!;
      const card = makeRecord(state, 'observations', { name: 'USD card', status: 'unresolved', reference: 'CARD-USD-1', amountKobo: 100_000, customerId: ada.id, data: { source: 'card', eventId: 'usd-1', provider: 'Sandbox Rail', currency: 'USD' } });
      reconcile(state, { ...ctx, actor: 'Sandbox Finance', role: 'Finance' });
      return state.records.find(record => record.kind === 'exceptions' && record.data.linkedRecordId === card.data.paymentId)!;
    });
    expect([exception.amountKobo, exception.data.currency]).toEqual([100_000, 'USD']);
    renderApp(`/exceptions?record=${exception.id}`);
    const row = (await screen.findByRole('button', { name: 'Resolve exception' })).closest('tr')!;
    const shown = (element: Element) => element.textContent!.replace(/ /g, ' ');
    expect(shown(row)).toContain('USD 1,000.00');
    expect(shown(row)).not.toContain('₦1,000.00');
    await user.click(within(row).getByRole('button', { name: 'Resolve exception' }));
    const context = within(await screen.findByRole('dialog', { name: 'Resolve exception' })).getByRole('region', { name: 'Exception context' });
    expect(shown(within(context).getByText('Amount').nextElementSibling!)).toBe('USD 1,000.00');
  });

  // Third review, a residual: a Finance resolution of an exception that carries a report of a collection counted in two
  // settlement batches (countedTwice) settles that report too, and the dialog said only that it records the outcome.
  it('says that resolving an exception that carries a counted-twice report settles that report too', async () => {
    const user = userEvent.setup();
    const carrier = api.mutate((state, ctx) => {
      const finance = { ...ctx, actor: 'Sandbox Finance', role: 'Finance' };
      const [first, second] = state.records.filter(record => record.kind === 'due-items' && record.status === 'scheduled');
      const line = (due: typeof first, reference: string, batchReference: string, eventId: string, feeKobo: number) => makeRecord(state, 'observations', { name: 'Settlement line', status: 'unresolved', reference, amountKobo: due!.amountKobo - feeKobo, customerId: due!.customerId, data: { source: 'settlement', eventId, provider: 'Sandbox Rail', batchReference, grossAmountKobo: due!.amountKobo, feeKobo } });
      line(first, 'PSK-X1', 'B-1', 'x1', providerFeeKobo(first!.amountKobo));
      // B-2's fees differ from the schedule, so it is in variance with an exception open for it.
      line(second, 'PSK-X2', 'B-2', 'x2', providerFeeKobo(second!.amountKobo) + 50_000);
      reconcile(state, finance);
      // The provider lists collection PSK-X1, which B-1 counts, again in B-2: B-2's open exception carries the report.
      line(first, 'PSK-X1', 'B-2', 'x1-again', providerFeeKobo(first!.amountKobo));
      reconcile(state, finance);
      const batch = state.records.find(record => record.kind === 'settlement-batches' && record.reference === 'B-2')!;
      return state.records.find(record => record.kind === 'exceptions' && record.data.linkedRecordId === batch.id)!;
    });
    expect((carrier.data.countedTwice as string[]).length).toBe(1);
    renderApp(`/exceptions?record=${carrier.id}`);
    await user.click(await screen.findByRole('button', { name: 'Resolve exception' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
    const settles = 'This exception also includes the provider’s report of a payment counted in two settlement batches. Resolving the exception also closes that report, whatever outcome you choose, and it will not be raised again. Check both payouts with the provider first.';
    expect(within(dialog).getByText('Record an outcome after reviewing the evidence.').parentElement!.textContent).toContain(settles);
    await user.selectOptions(within(dialog).getByLabelText(/^Outcome/), 'provider_corrected');
    const outcome = within(dialog).getByText(/^Record outcome:/).parentElement!.textContent!;
    expect(outcome).toContain(settles);
    expect(outcome).toContain('It does not allocate a payment, issue a refund, reissue a mandate or move money.');
    // An exception that carries no such report says nothing of one, and one that carries several names how many.
    expect(countedTwiceEffect({ ...carrier, data: { ...carrier.data, countedTwice: [] } })).toBeUndefined();
    expect(countedTwiceEffect({ ...carrier, data: { ...carrier.data, countedTwice: ['a', 'b'] } })).toContain('includes 2 provider reports of payments counted in two settlement batches. Resolving the exception also closes those reports');
  });

  // Decision on currencies in settlement batches: a line in another currency than its batch is reported, and an
  // exception already open for the batch carries the report (otherCurrencyLines) and settles it when resolved.
  it('says that resolving an exception that carries a line in another currency settles that report too', async () => {
    const user = userEvent.setup();
    const carrier = api.mutate((state, ctx) => {
      const finance = { ...ctx, actor: 'Sandbox Finance', role: 'Finance' };
      const [due] = state.records.filter(record => record.kind === 'due-items' && record.status === 'scheduled');
      // B-3's fees differ from the schedule, so it is in variance with an exception open for it; then a dollar line names it.
      makeRecord(state, 'observations', { name: 'Settlement line', status: 'unresolved', reference: 'PSK-N3', amountKobo: due!.amountKobo - providerFeeKobo(due!.amountKobo) - 50_000, customerId: due!.customerId, data: { provider: state.merchant.provider, source: 'settlement', grossAmountKobo: due!.amountKobo, feeKobo: providerFeeKobo(due!.amountKobo) + 50_000, batchReference: 'B-3', eventId: 'n3', occurredAt: api.now } });
      reconcile(state, finance);
      makeRecord(state, 'observations', { name: 'Settlement line', status: 'unresolved', reference: 'PSK-U3', amountKobo: 99_500, customerId: due!.customerId, data: { provider: state.merchant.provider, source: 'settlement', grossAmountKobo: 100_000, feeKobo: 500, batchReference: 'B-3', eventId: 'u3', occurredAt: api.now, currency: 'USD' } });
      reconcile(state, finance);
      const batch = state.records.find(record => record.kind === 'settlement-batches' && record.reference === 'B-3')!;
      return state.records.find(record => record.kind === 'exceptions' && record.data.linkedRecordId === batch.id)!;
    });
    expect((carrier.data.otherCurrencyLines as string[]).length).toBe(1);
    renderApp(`/exceptions?record=${carrier.id}`);
    await user.click(await screen.findByRole('button', { name: 'Resolve exception' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
    const settles = 'This exception also includes a report of a settlement line in a different currency from its batch. The batch does not count that line. Resolving the exception also closes the report, whatever outcome you choose, and it will not be raised again. First ask the provider which batch pays out the line.';
    expect(within(dialog).getByText('Record an outcome after reviewing the evidence.').parentElement!.textContent).toContain(settles);
    expect(otherCurrencyLinesEffect({ ...carrier, data: { ...carrier.data, otherCurrencyLines: [] } })).toBeUndefined();
    expect(otherCurrencyLinesEffect({ ...carrier, data: { ...carrier.data, otherCurrencyLines: ['a', 'b'] } })).toContain('includes 2 reports of settlement lines in a different currency from their batch');
  });

  it('shows a stored exception without a severity as having none, never as low', async () => {
    // An earlier edit could clear it; the queue then ranks it below low and the High filter leaves it out.
    const exception = api.mutate((state) => {
      const record = state.records.find((item) => item.kind === 'exceptions' && item.status === 'open' && item.data.severity === 'medium')!;
      delete record.data.severity;
      return record;
    });
    renderApp(`/exceptions?record=${exception.id}`);
    const row = (await screen.findByRole('button', { name: 'Edit exception' })).closest('tr')!;
    expect(row.textContent).toContain('No severity set');
    expect(row.textContent).not.toMatch(/\blow\b/i);
  });

  it('never clears a severity: the edit dialog requires one', async () => {
    const user = userEvent.setup();
    const exception = api.state().records.find((record) => record.kind === 'exceptions' && record.status === 'open' && record.data.severity === 'high' && !record.data.case)!;
    renderApp(`/exceptions?record=${exception.id}`);
    await user.click(await screen.findByRole('button', { name: 'Edit exception' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit exception' });
    const severity = within(dialog).getByLabelText(/^Severity/) as HTMLSelectElement;
    expect(severity.value).toBe('high');
    await user.selectOptions(severity, '');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByText('Severity is required. Choose an option.')).toBeTruthy();
    expect(document.activeElement).toBe(severity);
    expect(api.calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    expect(api.state().records.find((record) => record.id === exception.id)!.data.severity).toBe('high');
    // Choosing one saves it.
    await user.selectOptions(severity, 'medium');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.state().records.find((record) => record.id === exception.id)!.data.severity).toBe('medium');
  });

  // Review fix to FIN-03: a settlement batch held for its provider identity had no way out in the application. Finance or
  // an administrator now resolves its exception as provider identity confirmed, choosing one of the identities it was held
  // for, and that is the only outcome it offers: any other would close it while the batch stays held.
  const identities = [JSON.stringify(['connection-a', 'SHARED']), JSON.stringify(['connection-b', 'SHARED'])];
  const heldBatch = (review = false, extra: Record<string, unknown> = {}, carried?: string[]) => api.mutate((state, ctx) => {
    const batch = makeRecord(state, 'settlement-batches', { name: 'Settlement batch SHARED', status: 'variance', reference: 'SHARED', data: { batchReference: 'SHARED', provider: 'connection-a', providerConnection: 'connection-a', currency: 'NGN', lineObservationIds: [], linePaymentIds: [], grossKobo: 0, feeKobo: 0, netKobo: 0, providerIdentityReview: { detectedAt: api.now, identities, observationIds: [], previous: { status: 'reconciled', grossKobo: 0, feeKobo: 0, netKobo: 0, currency: 'NGN', statementObservationId: null, statementNetKobo: null } }, ...extra } });
    const hold = raiseException(state, ctx, 'settlement_variance', { linkedRecordId: batch.id, notes: 'Historical settlement evidence mixes or conflicts with provider connections.', condition: `settlement_variance:${batch.id}:provider_identity` });
    if (carried) hold.data.countedTwice = carried;
    if (!review) return hold;
    // An earlier build resolved the hold with another code; reconciliation raises a renewed review of that decision.
    Object.assign(hold, { status: 'resolved' });
    Object.assign(hold.data, { resolutionCode: 'accepted_variance', resolvedBy: 'Earlier Finance', resolvedAt: api.now });
    return makeRecord(state, 'exceptions', { name: 'Review earlier settlement identity decision', status: 'open', data: { type: 'settlement_variance', owner: 'Finance', severity: 'medium', linkedRecordId: batch.id, condition: `settlement_variance:${batch.id}:provider_identity:review:${hold.id}`, notes: 'That resolution keeps its meaning, but the batch stays held until Finance or an administrator confirms whose payout it is.', legacyIdentityReview: { priorExceptionId: hold.id, priorStatus: 'resolved', priorResolutionCode: 'accepted_variance', priorResolvedBy: 'Earlier Finance', priorResolvedAt: api.now } } });
  });

  it('confirms whose payout a held settlement batch is, choosing one of the identities it was held for, as its only outcome', async () => {
    const user = userEvent.setup();
    const hold = heldBatch();
    renderApp(`/exceptions?record=${hold.id}`);
    await user.click(await screen.findByRole('button', { name: 'Resolve exception' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
    const code = within(dialog).getByLabelText(/^Outcome/);
    expect(within(code).getAllByRole('option').map(option => option.textContent)).toEqual(['Choose an option', 'Connection confirmed']);
    const identity = await within(dialog).findByLabelText(/Connection that paid out this batch/);
    await waitFor(() => expect(within(identity).getAllByRole('option').map(option => option.textContent)).toEqual(['Choose an option', 'connection-a (batch SHARED)', 'connection-b (batch SHARED)']));
    const outcome = () => within(dialog).getByText(/^Record outcome:|^Record an outcome/).parentElement!.textContent!;
    expect(outcome()).toContain('This settlement batch is on hold. Its evidence is not counted until Finance or an Admin confirms which connection paid it out.');
    expect(outcome()).toContain('Connection confirmed: Choose this with the connection the providers confirmed. The next reconciliation then releases the batch.');
    expect(outcome()).toContain('Leave this exception open: Do this if the providers cannot say which connection it was. When the person who manages this data has corrected it, the next reconciliation releases the batch and closes this exception.');
    await user.selectOptions(code, 'provider_identity_confirmed');
    expect(outcome()).toContain('The next reconciliation releases this settlement batch as a payout of the connection you choose.');
    expect(outcome()).toContain('Settlement lines for other connections move to their own batches, and bank statement lines for them are left to link to their own.');
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Both providers confirmed whose payout this is.');
    await user.click(within(dialog).getByRole('button', { name: 'Resolve exception' }));
    expect(await within(dialog).findByText('Choose the connection the providers confirmed for this batch.')).toBeTruthy();
    expect(api.calls.some(call => call.method === 'POST')).toBe(false);
    await user.selectOptions(identity, identities[1]!);
    await user.click(within(dialog).getByRole('button', { name: 'Resolve exception' }));
    const answer = await screen.findByRole('status', { name: 'Resolution recorded' });
    expect(answer.textContent).toContain('The next reconciliation releases settlement batch SHARED as the payout of connection-b');
    const stored = api.state().records.find(record => record.id === hold.id)!;
    expect([stored.status, stored.data.resolutionCode, stored.data.confirmedProviderIdentity]).toEqual(['resolved', 'provider_identity_confirmed', identities[1]]);
  });

  it('offers the same confirmation for a renewed review of an earlier decision on a held batch, saying the earlier one keeps its meaning', async () => {
    const user = userEvent.setup();
    api.role = 'Finance';
    const review = heldBatch(true);
    renderApp(`/exceptions?record=${review.id}`);
    await user.click(await screen.findByRole('button', { name: 'Resolve exception' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
    const code = within(dialog).getByLabelText(/^Outcome/);
    expect(within(code).getAllByRole('option').map(option => option.textContent)).toEqual(['Choose an option', 'Connection confirmed']);
    const outcome = () => within(dialog).getByText(/^Record outcome:|^Record an outcome/).parentElement!.textContent!;
    expect(outcome()).toContain('An earlier resolution of this batch’s hold still stands, but the batch stays on hold. Its evidence is not counted until Finance or an Admin confirms which connection paid it out.');
    expect(outcome()).toContain('Leave this review open: Do this if the providers cannot say which connection it was. When the person who manages this data has corrected it, the next reconciliation releases the batch and closes this review.');
    const identity = await within(dialog).findByLabelText(/Connection that paid out this batch/);
    await waitFor(() => expect(within(identity).getAllByRole('option')).toHaveLength(3));
    await user.selectOptions(code, 'provider_identity_confirmed');
    await user.selectOptions(identity, identities[0]!);
    await user.type(within(dialog).getByLabelText(/^Reason/), 'The providers confirmed connection-a pays it out.');
    await user.click(within(dialog).getByRole('button', { name: 'Resolve exception' }));
    const answer = await screen.findByRole('status', { name: 'Resolution recorded' });
    expect(answer.textContent).toContain('The next reconciliation releases settlement batch SHARED as the payout of connection-a');
    expect(api.state().records.find(record => record.id === review.id)!.data.confirmedProviderIdentity).toBe(identities[0]);
  });

  // Review fix: a batch released while its hold's exception, from an earlier build, still carries a report of a collection
  // counted in two batches: the exception stays open for that report and offers the codes that mean something for it.
  it('offers the settlement codes, not the confirmation, on a released batch\'s hold exception that still carries a report', async () => {
    const user = userEvent.setup();
    const hold = api.mutate((state, ctx) => {
      const batch = makeRecord(state, 'settlement-batches', { name: 'Settlement batch SHARED', status: 'reconciled', reference: 'SHARED', data: { batchReference: 'SHARED', provider: 'connection-a', providerConnection: 'connection-a', providerIdentityKey: identities[0], currency: 'NGN', lineObservationIds: [], linePaymentIds: [], grossKobo: 0, feeKobo: 0, netKobo: 0, providerIdentityReview: { detectedAt: api.now, identities, observationIds: [], previous: { status: 'reconciled', grossKobo: 0, feeKobo: 0, netKobo: 0, currency: 'NGN', statementObservationId: null, statementNetKobo: null } }, providerIdentityRelease: { releasedAt: api.now, identity: identities[0], heldLineIds: [] } } });
      const exception = raiseException(state, ctx, 'settlement_variance', { linkedRecordId: batch.id, notes: 'Historical settlement evidence mixes or conflicts with provider connections.', condition: `settlement_variance:${batch.id}:provider_identity` });
      exception.data.countedTwice = [`settlement_variance:${batch.id}:line:line-1`];
      return exception;
    });
    renderApp(`/exceptions?record=${hold.id}`);
    await user.click(await screen.findByRole('button', { name: 'Resolve exception' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
    const code = within(dialog).getByLabelText(/^Outcome/);
    await waitFor(() => expect(within(code).getAllByRole('option').map(option => option.textContent)).toEqual(['Choose an option', 'Fee schedule updated', 'Provider corrected', 'Difference accepted']));
    expect(within(dialog).queryByLabelText(/Connection that paid out this batch/)).toBeNull();
    const outcome = within(dialog).getByText('Record an outcome after reviewing the evidence.').parentElement!.textContent!;
    expect(outcome).not.toContain('confirms which connection paid it out');
    expect(outcome).toContain('This exception also includes the provider’s report of a payment counted in two settlement batches.');
    await user.selectOptions(code, 'accepted_variance');
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Both payouts checked with the provider.');
    await user.click(within(dialog).getByRole('button', { name: 'Resolve exception' }));
    await screen.findByRole('status', { name: 'Resolution recorded' });
    expect(api.state().records.find(record => record.id === hold.id)!.data.resolutionCode).toBe('accepted_variance');
  });

  // Re-review fix: a confirmation settles which connection's payout a batch is, not a collision between two batches. The
  // dialog offers only the connections no other batch records or claims, as the service accepts, or says why none can be.
  it('offers only the connections no other batch records or claims, and says why none can be confirmed when each is claimed', async () => {
    const user = userEvent.setup();
    api.role = 'Finance';
    const claim = (identity: string) => ({ identity, batchId: 'other-batch', reference: 'SHARED', handEntered: true });
    const partly = heldBatch(false, { providerIdentityClaimedBy: [claim(identities[0]!)] });
    const { unmount } = renderApp(`/exceptions?record=${partly.id}`);
    await user.click(await screen.findByRole('button', { name: 'Resolve exception' }));
    let dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
    const identity = await within(dialog).findByLabelText(/Connection that paid out this batch/);
    await waitFor(() => expect(within(identity).getAllByRole('option').map(option => option.textContent)).toEqual(['Choose an option', 'connection-b (batch SHARED)']));
    unmount();
    const fully = heldBatch(false, { providerIdentityClaimedBy: identities.map(claim) });
    renderApp(`/exceptions?record=${fully.id}`);
    await user.click(await screen.findByRole('button', { name: 'Resolve exception' }));
    dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
    const box = () => within(dialog).getByText('Record an outcome after reviewing the evidence.').parentElement!.textContent!;
    await waitFor(() => expect(box()).toContain('You cannot confirm a connection for this settlement batch yet. Other batches name the same connections: settlement batch SHARED (entered by hand) also names connection-a (batch SHARED); settlement batch SHARED (entered by hand) also names connection-b (batch SHARED). Confirming a connection cannot settle two batches that claim one payout. Ask the person who manages this data to correct the reference or provider of the duplicate batch. The next reconciliation then releases the correct batch and closes this exception.'));
    expect(within(within(dialog).getByLabelText(/^Outcome/)).getAllByRole('option').map(option => option.textContent)).toEqual(['Choose an option']);
    expect(within(dialog).queryByLabelText(/Connection that paid out this batch/)).toBeNull();
  });

  // Re-review fix: confirming whose payout a held batch is settles no report its exception carries; the report comes back.
  it('says a confirmation settles no report a held batch\'s exception carries, which comes back on its own after the release', async () => {
    const user = userEvent.setup();
    api.role = 'Finance';
    const hold = heldBatch(false, {}, ['settlement_variance:batch:counted:payment-1']);
    renderApp(`/exceptions?record=${hold.id}`);
    await user.click(await screen.findByRole('button', { name: 'Resolve exception' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve exception' });
    await user.selectOptions(within(dialog).getByLabelText(/^Outcome/), 'provider_identity_confirmed');
    await waitFor(() => expect(within(dialog).getByText(/^Record outcome:/).parentElement!.textContent).toContain('This exception also includes the provider’s report of a payment counted in two settlement batches. Confirming the connection does not settle it. After the batch is released, the report comes back as its own exception. Resolve it after you have checked with the provider.'));
    const box = within(dialog).getByText(/^Record outcome:/).parentElement!.textContent!;
    expect(box).not.toContain('Resolving the exception also closes that report');
    expect(box).toContain('The batch’s amounts before fees, fee and after fees leave out the lines that move, unless someone typed them by hand. The expected fee always leaves them out.');
  });

  for (const review of [false, true]) {
    it(`does not let Operations resolve ${review ? 'a renewed review of a held batch' : 'a held batch\'s exception'}, which the service refuses from that role`, async () => {
      api.role = 'Operations';
      const exception = heldBatch(review);
      renderApp(`/exceptions?record=${exception.id}`);
      const resolve = await screen.findByRole('button', { name: 'Resolve exception' });
      expect(resolve.getAttribute('aria-disabled')).toBe('true');
      expect(screen.getByText('Only Admin or Finance can resolve this exception. Resolving it confirms whose payout the settlement batch is.')).toBeTruthy();
      await userEvent.setup().click(resolve);
      expect(screen.queryByRole('dialog', { name: 'Resolve exception' })).toBeNull();
      expect(api.calls.some(call => call.method === 'GET' && call.path.includes('/v1/records/settlement-batches'))).toBe(false);
    });
  }
});
