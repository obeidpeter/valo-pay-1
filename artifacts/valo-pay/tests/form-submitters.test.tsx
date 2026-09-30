import { randomUUID } from 'node:crypto';
import { useState, type FormEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { watchFormSubmitters } from './form-submitters';
import { Button } from '@/components/ui/button';
import { PageButtons, RecordPagination } from '@/components/record-pagination';
import { useRecordPagination } from '@/lib/use-record-pagination';

// Third review of the audit fixes, finding 1: Previous and Next in the allocation and mandate pickers were submit buttons
// of their dialog's form, so paging a picker with the form complete sent the allocation or created the mandate.
let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

const press = async (user: ReturnType<typeof userEvent.setup>, control: HTMLElement) => { control.focus(); await user.keyboard('{Enter}'); };

describe('the check every test runs on the forms it renders', () => {
  it('names each control that can submit its form without being marked as its submit button, and nothing else', () => {
    // A document of its own, so this deliberate fault is not the test's own.
    const other = document.implementation.createHTMLDocument('Form check');
    const watch = watchFormSubmitters(other);
    watch.start();
    other.body.innerHTML = '<form><h2>Choices</h2><button>Next page</button><button type="button">Cancel</button><button type="reset">Clear</button>'
      + '<button type="submit">Save</button><button type="SUBMIT">Save again</button><button type="later">Unknown type</button></form>'
      + '<button>Outside any form</button><button form="named">Names its form</button><form id="named"></form>';
    expect(watch.take()).toEqual([
      'button "Next page" in the form under "the page"',
      'button "Unknown type" in the form under "the page"',
      'button "Names its form" in the form under "the page"',
    ]);
    // A control whose type changes to submit is seen too.
    const late = other.createElement('button');
    late.type = 'button'; late.textContent = 'Later';
    other.getElementById('named')!.append(late);
    watch.start();
    late.removeAttribute('type');
    expect(watch.take()).toContain('button "Later" in the form under "the page"');
  });
});

describe('the shared Button', () => {
  it('does not submit the form it is in unless it is marked as the form\'s submit button', async () => {
    const user = userEvent.setup();
    const submitted = vi.fn((event: FormEvent) => event.preventDefault());
    render(<form onSubmit={submitted}><Button variant="outline">Look further</Button><Button type="submit">Save</Button></form>);
    const further = screen.getByRole('button', { name: 'Look further' });
    expect(further.getAttribute('type')).toBe('button');
    await user.click(further);
    await press(user, further);
    expect(submitted).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(submitted).toHaveBeenCalledTimes(1);
  });
});

describe('a pager inside a form', () => {
  it('pages without submitting the form: RecordPagination and PageButtons, by pointer and by keyboard', async () => {
    const user = userEvent.setup();
    const submitted = vi.fn((event: FormEvent) => event.preventDefault());
    function Choices() {
      const pagination = useRecordPagination('choices');
      return <RecordPagination pagination={pagination} total={60} label="choices" />;
    }
    function Steps() {
      const [step, setStep] = useState(0);
      return <PageButtons label="steps" atStart={step === 0} atEnd={step === 2} onPrevious={() => setStep(step - 1)} onNext={() => setStep(step + 1)} previous="Previous steps" next="Next steps"><span>Step {step + 1}</span></PageButtons>;
    }
    render(<form onSubmit={submitted}><Choices /><Steps /><Button type="submit">Save</Button></form>);
    await user.click(screen.getByRole('button', { name: 'Next page of choices' }));
    await screen.findByText('26–50 of 60 choices');
    await press(user, screen.getByRole('button', { name: 'Next page of choices' }));
    await screen.findByText('51–60 of 60 choices');
    await press(user, screen.getByRole('button', { name: 'Previous page of choices' }));
    await screen.findByText('26–50 of 60 choices');
    await user.click(screen.getByRole('button', { name: 'Next steps' }));
    await screen.findByText('Step 2');
    await press(user, screen.getByRole('button', { name: 'Next steps' }));
    await screen.findByText('Step 3');
    await press(user, screen.getByRole('button', { name: 'Previous steps' }));
    await screen.findByText('Step 2');
    expect(submitted).not.toHaveBeenCalled();
  });
});

describe('a picker in a complete form', () => {
  const writes = (path: RegExp) => api.calls.filter(call => call.method !== 'GET' && path.test(call.path));

  /** Sixty more open instalments, so the allocation picker has three pages of choices. */
  const sixtyInstalments = () => api.mutate(state => {
    const due = state.records.find(record => record.kind === 'due-items' && record.status === 'scheduled')!;
    state.records.push(...Array.from({ length: 60 }, (_, index) => ({ ...structuredClone(due), id: randomUUID(), reference: `PAGER-DUE-${index}` })));
  });
  /** Opens Allocate for the transfer that names no payer and completes the form on the first page of choices. */
  async function completeAllocation(user: ReturnType<typeof userEvent.setup>) {
    renderApp('/reconciliation');
    const payments = (await screen.findByRole('heading', { name: 'Unallocated payments' })).parentElement!.parentElement!;
    const row = (await within(payments).findByText('SBX-UNIDENTIFIED-001')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Allocate payment' }));
    const dialog = await screen.findByRole('dialog', { name: 'Allocate payment' });
    await within(dialog).findByText(/^1–25 of \d+ instalment choices$/);
    const instalment = within(dialog).getByLabelText(/^Instalment/) as HTMLSelectElement;
    await user.selectOptions(instalment, instalment.options[1]!.value);
    const amount = within(dialog).getByLabelText(/^Amount to allocate/);
    await user.clear(amount);
    await user.type(amount, '100.00');
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Looking further through the choices');
    return dialog;
  }

  it('paging the allocation picker by keyboard or pointer sends no allocation', async () => {
    const user = userEvent.setup();
    sixtyInstalments();
    const dialog = await completeAllocation(user);
    await press(user, within(dialog).getByRole('button', { name: 'Next page of instalment choices' }));
    await within(dialog).findByText(/^26–50 of \d+ instalment choices$/);
    await user.click(within(dialog).getByRole('button', { name: 'Next page of instalment choices' }));
    await within(dialog).findByText(/^51–\d+ of \d+ instalment choices$/);
    await user.click(within(dialog).getByRole('button', { name: 'Previous page of instalment choices' }));
    await within(dialog).findByText(/^26–50 of \d+ instalment choices$/);
    await press(user, within(dialog).getByRole('button', { name: 'Previous page of instalment choices' }));
    await within(dialog).findByText(/^1–25 of \d+ instalment choices$/);
    expect(writes(/^\/v1\/actions$/)).toEqual([]);
    expect(dialog.isConnected).toBe(true);
    // The form was complete all along: its own button sends it, once.
    await user.click(within(dialog).getByRole('button', { name: 'Allocate payment' }));
    await waitFor(() => expect(writes(/^\/v1\/actions$/).map(call => (call.body as { action: string }).action)).toEqual(['manual_allocate']));
  });

  it('paging the mandate customer picker by keyboard or pointer creates no mandate', async () => {
    const user = userEvent.setup();
    api.mutate(state => {
      const sample = state.records.find(record => record.kind === 'customers')!;
      state.records.push(...Array.from({ length: 60 }, (_, index) => ({ ...structuredClone(sample), id: randomUUID(), name: `Pager customer ${String(index).padStart(2, '0')}`, reference: `PAGER-${index}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() })));
    });
    renderApp('/mandates');
    await user.click(await screen.findByRole('button', { name: 'Create synthetic mandate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create synthetic mandate' });
    await within(dialog).findByText(/^1–25 of \d+ customer choices$/);
    const customer = within(dialog).getByLabelText(/Customer/) as HTMLSelectElement;
    await user.selectOptions(customer, customer.options[1]!.value);
    await user.type(within(dialog).getByLabelText(/Mandate name/), 'Mandate made by paging');
    await user.type(within(dialog).getByLabelText(/Debit limit/), '500.00');
    await user.type(within(dialog).getByLabelText(/Provider reference/), 'SYN-PAGER-MANDATE');
    await user.type(within(dialog).getByLabelText(/Consent evidence reference/), 'SYN-PAGER-CONSENT');
    await user.selectOptions(within(dialog).getByLabelText(/^Policy/), api.state().records.find(record => record.kind === 'policies')!.id);
    await press(user, within(dialog).getByRole('button', { name: 'Next page of customer choices' }));
    await within(dialog).findByText(/^26–50 of \d+ customer choices$/);
    await user.click(within(dialog).getByRole('button', { name: 'Previous page of customer choices' }));
    await within(dialog).findByText(/^1–25 of \d+ customer choices$/);
    expect(writes(/^\/v1\/records\/mandates$/)).toEqual([]);
    expect(dialog.isConnected).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Create mandate' }));
    await waitFor(() => expect(writes(/^\/v1\/records\/mandates$/)).toHaveLength(1));
  });

  it('Enter in the allocation picker\'s search looks for choices and sends nothing', async () => {
    const user = userEvent.setup();
    sixtyInstalments();
    const dialog = await completeAllocation(user);
    await user.type(within(dialog).getByRole('searchbox', { name: 'Find an instalment' }), 'PAGER-DUE-1{Enter}');
    await waitFor(() => expect(api.calls.some(call => call.path === '/v1/records/due-items' && call.query.search === 'PAGER-DUE-1')).toBe(true));
    await within(dialog).findByText(/^1–\d+ of \d+ instalment choices$/);
    expect(writes(/^\/v1\/actions$/)).toEqual([]);
    expect(dialog.isConnected).toBe(true);
  });

  it('Enter in the mandate customer picker\'s search looks for customers and sends nothing', async () => {
    const user = userEvent.setup();
    renderApp('/mandates');
    await user.click(await screen.findByRole('button', { name: 'Create synthetic mandate' }));
    const create = await screen.findByRole('dialog', { name: 'Create synthetic mandate' });
    const customer = await within(create).findByLabelText(/Customer/) as HTMLSelectElement;
    await waitFor(() => expect(customer.options.length).toBeGreaterThan(1));
    await user.selectOptions(customer, customer.options[1]!.value);
    await user.type(within(create).getByLabelText(/Mandate name/), 'Mandate made by searching');
    await user.type(within(create).getByLabelText(/Debit limit/), '500.00');
    await user.type(within(create).getByLabelText(/Provider reference/), 'SYN-SEARCH-MANDATE');
    await user.type(within(create).getByLabelText(/Consent evidence reference/), 'SYN-SEARCH-CONSENT');
    await user.selectOptions(within(create).getByLabelText(/^Policy/), api.state().records.find(record => record.kind === 'policies')!.id);
    await user.type(within(create).getByRole('searchbox', { name: 'Search customers' }), 'Ada{Enter}');
    await waitFor(() => expect(api.calls.some(call => call.path === '/v1/records/customers' && call.query.search === 'Ada')).toBe(true));
    expect(writes(/^\/v1\/records\/mandates$/)).toEqual([]);
    expect(create.isConnected).toBe(true);
  });
});
