import { afterEach, beforeEach, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi({ role: 'Finance', now: '2028-12-02T12:00:00.000Z' });
  // Test fixture only: begin with an authorised, empty synthetic lender.
  // Every business record below is created through the actual import UI/API.
  api.mutate(state => { state.records = []; });
});
afterEach(() => api.uninstall());

it('takes an empty lender from corrected sample imports to a reviewed payment and an unresolved case', async () => {
  const user = userEvent.setup();
  const untouchedLender = JSON.stringify(api.state(api.merchantIds[1]));
  const writes = () => api.calls.filter(call => call.method === 'POST');
  const records = (kind: string) => api.state().records.filter(record => record.kind === kind);
  const csv = () => screen.getByLabelText('CSV content') as HTMLTextAreaElement;
  async function replaceCsv(value: string) {
    await user.click(csv());
    await user.keyboard('{Control>}a{/Control}');
    await user.paste(value);
    expect(csv().value).toBe(value);
  }
  async function saveAndCheck() {
    await user.click(screen.getByRole('button', { name: 'Save and check batch' }));
    await screen.findByRole('heading', { name: 'Saved check results' });
    expect(screen.getByText(/Your source and mapping are saved. No business records are imported/)).toBeTruthy();
  }
  async function commitOnce() {
    const before = writes().filter(call => /\/commit$/.test(call.path)).length;
    expect(screen.getByRole('button', { name: 'Commit checked batch' })).toHaveProperty('disabled', false);
    await user.click(screen.getByRole('button', { name: 'Commit checked batch' }));
    await screen.findByRole('heading', { name: 'Import complete' });
    expect(screen.queryByRole('button', { name: 'Commit checked batch' })).toBeNull();
    expect(writes().filter(call => /\/commit$/.test(call.path))).toHaveLength(before + 1);
  }
  async function startSample(kind: string) {
    await user.click(screen.getByRole('button', { name: 'Start another batch' }));
    await user.selectOptions(screen.getByLabelText('Record type'), kind);
    await user.click(screen.getByRole('button', { name: 'Use sample' }));
  }

  renderApp('/overview');
  await screen.findByRole('heading', { name: 'Overview' });
  await user.click(screen.getByRole('button', { name: 'Get started · 3 steps' }));
  const start = screen.getByRole('region', { name: 'Where to start' });
  await within(start).findByText('Step 1 · Not started');
  await user.click(within(start).getAllByRole('link', { name: 'Open this task' })[0]!);

  // The real format-matched sample is deliberately given one correctable omission.
  await user.click(await screen.findByRole('button', { name: 'Use sample' }));
  const customerSample = csv().value;
  expect(customerSample).toContain('PILOT-C001');
  await replaceCsv(customerSample.replace('Synthetic pilot consent', ''));
  await saveAndCheck();
  expect(screen.getByRole('button', { name: 'Commit checked batch' })).toHaveProperty('disabled', true);
  expect(screen.getByText(/Row 2 · Invalid/)).toBeTruthy();
  expect(screen.getByText(/Consent source or reference.*Enter a value; it is blank on this row/)).toBeTruthy();
  expect(records('customers')).toHaveLength(0);

  // Saved correction work survives leaving the page; it is still not an import.
  await user.click(screen.getByRole('link', { name: 'Overview' }));
  await screen.findByText('Step 1 · Needs attention');
  await user.click(screen.getByRole('link', { name: 'Import batches' }));
  await user.click(await screen.findByRole('button', { name: /Customers sample.*Pilot sample/ }));
  await screen.findByRole('heading', { name: 'Saved check results' });
  expect(csv().value).toBe(customerSample.replace('Synthetic pilot consent', ''));
  await user.click(screen.getByRole('button', { name: 'Correct CSV' }));
  expect(document.activeElement).toBe(csv());
  await replaceCsv(customerSample);
  await saveAndCheck();
  expect(records('customers')).toHaveLength(0);
  await commitOnce();
  expect(records('customers')).toHaveLength(1);

  await startSample('due-items');
  expect(csv().value).toContain('PILOT-C001');
  await saveAndCheck();
  expect(records('due-items')).toHaveLength(0);
  await commitOnce();
  expect(records('due-items')[0]).toMatchObject({ reference: 'PILOT-D001', amountKobo: 2_500_000 });

  await startSample('observations');
  const [header, sourceRow] = csv().value.split('\n');
  const first = sourceRow!.split(',');
  // Keep the sample payer, but remove the instalment reference. The existing R5
  // rule proposes an equal-amount receipt near the due date for Finance review.
  const payer = first.indexOf('PILOT-C001');
  const reference = first.indexOf('PILOT-O001');
  const amount = first.findIndex(value => Number(value) === 25_000);
  expect(payer).toBeGreaterThan(0);
  expect(reference).toBeGreaterThan(0);
  expect(amount).toBeGreaterThan(0);
  const instalment = first.indexOf('PILOT-D001');
  expect(instalment).toBeGreaterThan(0);
  first[instalment] = '';
  const narration = first.findIndex(value => value.includes('synthetic transfer'));
  expect(narration).toBeGreaterThan(0);
  first[narration] = 'Sample transfer without repayment reference';
  const unmatched = [...first];
  unmatched[0] = 'payment-002';
  unmatched[reference] = 'PILOT-O002';
  unmatched[amount] = '32000.00';
  unmatched[payer] = '';
  const observedAt = '2028-12-01T08:00:00.000Z';
  await replaceCsv(`${header},occurredAt\n${first.join(',')},${observedAt}\n${unmatched.join(',')},${observedAt}`);
  await saveAndCheck();
  expect(records('observations')).toHaveLength(0);
  await commitOnce();
  expect(records('observations')).toHaveLength(2);
  expect(records('payments')).toHaveLength(0);

  // Importing evidence and matching a payment are intentionally separate actions.
  await user.click(screen.getAllByRole('link', { name: 'Reconciliation' })[0]!);
  await screen.findByText('PILOT-O001');
  await user.click(screen.getByRole('button', { name: 'Run reconciliation' }));
  await screen.findByRole('status', { name: 'Reconciliation result' });
  const confirm = await screen.findByRole('button', { name: 'Confirm match' });
  expect(records('allocations')[0]?.status).toBe('proposed');
  expect(records('payments').find(record => record.reference === 'PILOT-O001')?.customerId).toBe(records('customers')[0]!.id);
  await user.click(confirm);
  const dialog = await screen.findByRole('dialog', { name: 'Confirm match' });
  const evidence = within(dialog).getByRole('region', { name: 'Match evidence' });
  expect(evidence.textContent).toContain('PILOT-O001');
  expect(evidence.textContent).toContain('PILOT-D001');
  expect(evidence.textContent).toContain('Amount and payer match one instalment within five days of its due date; Finance confirmation required.');
  expect(evidence.textContent).toContain('Rule: R5');
  expect(evidence.textContent).toContain('Settlement:');
  await user.click(within(dialog).getByRole('button', { name: 'Confirm match' }));
  expect(document.activeElement).toBe(within(dialog).getByLabelText('Reason *'));
  expect(writes().some(call => (call.body as { action?: string })?.action === 'confirm_allocation')).toBe(false);
  await user.type(within(dialog).getByLabelText('Reason *'), 'Reviewed the sample statement, payer and due date against the linked instalment.');
  await user.click(within(dialog).getByRole('button', { name: 'Confirm match' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(records('payments').find(record => record.reference === 'PILOT-O001')).toMatchObject({ status: 'allocated', customerId: records('customers')[0]!.id });
  expect(records('due-items')[0]?.data.outstandingKobo).toBe(0);
  expect(writes().filter(call => (call.body as { action?: string })?.action === 'confirm_allocation')).toHaveLength(1);

  await user.click(screen.getByRole('link', { name: 'Customers' }));
  await user.click(await screen.findByRole('link', { name: 'View history for Pilot customer' }));
  await screen.findByRole('heading', { name: 'Pilot customer', level: 1 });
  const paymentPanel = screen.getByRole('heading', { name: 'Payments' }).parentElement!.parentElement!;
  expect(await within(paymentPanel).findByText('PILOT-O001')).toBeTruthy();
  expect(within(paymentPanel).getByText('Allocated')).toBeTruthy();

  // The separate unidentified receipt remains unresolved, with a recoverable case.
  await user.click(screen.getByRole('link', { name: 'Exceptions' }));
  const caseLink = await screen.findByRole('link', { name: 'Open case' });
  const caseRow = caseLink.closest('tr')!;
  expect(within(caseRow).getByText('Unallocated payment')).toBeTruthy();
  expect(within(caseRow).getByText('No certain or confirmed allocation after 24 hours.')).toBeTruthy();
  await user.click(caseLink);
  await screen.findByRole('heading', { name: 'Case: Unallocated payment', level: 1 });
  expect(screen.getByText(/Recording a handover does not allocate a payment or resolve the exception/)).toBeTruthy();
  expect(records('exceptions').filter(record => record.status === 'open')).toHaveLength(1);
  expect(records('payments').find(record => record.reference === 'PILOT-O002')?.status).toBe('unallocated');
  expect(api.role).toBe('Finance');
  expect(writes().filter(call => /\/commit$/.test(call.path))).toHaveLength(3);
  expect(writes().filter(call => call.status >= 400)).toEqual([]);
  expect(JSON.stringify(api.state(api.merchantIds[1]))).toBe(untouchedLender);
  expect(JSON.stringify(localStorage)).not.toMatch(/PILOT-C001|PILOT-D001|PILOT-O001/);
}, 30_000);
