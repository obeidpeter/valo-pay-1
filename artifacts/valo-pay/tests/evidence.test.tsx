import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRecord, validateRecord } from '../../api-server/src/domain';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { fireEvent } from '@testing-library/react';
import { formatDate } from '@/lib/formatters';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => { api.uninstall(); vi.restoreAllMocks(); });

const agreement = { discountStartDate: '2027-02-01', fullPriceStartDate: '2028-02-01', discountTermsReference: 'SYNTHETIC-AGREEMENT-2027' };
/** The seeded terms, signed as a design partner's with the agreement's dates, saved through the record API's checks by the current persona: a proposal. */
function proposeAgreement() {
  api.mutate((state, ctx) => {
    const terms = state.records.find(record => record.kind === 'commercial')!;
    Object.assign(terms.data, { signed: true, designPartner: true, signedFullPriceTerms: true, ...agreement });
    validateRecord(state, ctx, 'commercial', terms, true);
  });
}
/** The commercial commitments table, where each row's note is. */
const commitmentsTable = async () => within((await screen.findByRole('heading', { name: 'Commercial commitments' })).closest('section')!).getByRole('table');

describe('evidence register and operational reviews', () => {
  it.each([
    ['wrong shape', [], /Valo Pay cannot read the saved proposal or confirmation of these discount dates/],
    ['missing reviewer', { reviewedBy: '', reviewedAt: '2026-09-29T09:00:00Z', discountStartDate: '2027-02-01', fullPriceStartDate: '2028-02-01', termsReference: 'SYNTHETIC-TERMS' }, /Valo Pay cannot read the saved proposal or confirmation of these discount dates/],
    ['stale dates', { reviewedBy: 'Sandbox Admin', reviewedAt: '2026-09-29T09:00:00Z', discountStartDate: '2027-01-01', fullPriceStartDate: '2028-02-01', termsReference: 'SYNTHETIC-TERMS' }, /The discount dates or agreement reference changed after they were proposed/],
  ])('does not describe an unverified legacy discount review as ready, and says why (%s)', async (_label, discountReview, cause) => {
    api.mutate(state => {
      const terms = state.records.find(record => record.kind === 'commercial')!;
      Object.assign(terms.data, { signed: true, designPartner: true, signedFullPriceTerms: true, discountStartDate: '2027-02-01', fullPriceStartDate: '2028-02-01', discountTermsReference: 'SYNTHETIC-TERMS', discountReview });
    });
    renderApp('/evidence');
    const section = (await screen.findByRole('heading', { name: 'Commercial commitments' })).closest('section')!;
    expect(await within(section).findByText(cause)).toBeTruthy();
    expect(within(section).queryByText(/^Discount from/)).toBeNull();
    expect(screen.queryByText('Page error')).toBeNull();
  });
  it('keeps a legacy design-partner agreement editable without inventing discount dates or a review', async () => {
    const user = userEvent.setup();
    api.mutate(state => {
      const terms = state.records.find(record => record.kind === 'commercial')!;
      Object.assign(terms.data, { signed: true, designPartner: true, signedFullPriceTerms: true });
      for (const key of ['discountStartDate', 'fullPriceStartDate', 'discountTermsReference', 'discountReview']) delete terms.data[key];
    });
    renderApp('/evidence');
    const section = (await screen.findByRole('heading', { name: 'Commercial commitments' })).closest('section')!;
    const missing = /The discount start date, the full-price start date and the signed agreement reference are missing\. Enter them from the signed agreement\./;
    expect(await within(section).findByText(missing)).toBeTruthy();
    await user.click(within(section).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit commercial terms' });
    expect((within(dialog).getByLabelText('50% discount starts on') as HTMLInputElement).value).toBe('');
    expect((within(dialog).getByLabelText('Full-price billing starts on') as HTMLInputElement).value).toBe('');
    expect(within(dialog).getByText(/Leave dates blank until the agreement has been reviewed/)).toBeTruthy();
    await user.clear(within(dialog).getByLabelText(/^Lender name/));
    await user.type(within(dialog).getByLabelText(/^Lender name/), 'Updated legacy agreement');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const saved = api.state().records.find(record => record.kind === 'commercial')!;
    expect(saved.name).toBe('Updated legacy agreement');
    expect(saved.data.discountReview).toBeUndefined();
    expect(saved.data.discountStartDate).toBeUndefined();
    expect(saved.data.fullPriceStartDate).toBeUndefined();
    expect(within(within(section).getByRole('table')).getByText(missing)).toBeTruthy();
  });

  it('submits explicit signed flags and dates while the service alone records the proposal: who, which person and when', async () => {
    const user = userEvent.setup();
    api.mutate(state => {
      const terms = state.records.find(record => record.kind === 'commercial')!;
      Object.assign(terms.data, { signed: false, designPartner: false, signedFullPriceTerms: false });
      for (const key of ['discountStartDate', 'fullPriceStartDate', 'discountTermsReference', 'discountReview']) delete terms.data[key];
    });
    renderApp('/evidence');
    const section = (await screen.findByRole('heading', { name: 'Commercial commitments' })).closest('section')!;
    await user.click(await within(section).findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit commercial terms' });
    for (const label of ['Signed', 'Design-partner agreement', 'Full-price terms are signed']) await user.click(within(dialog).getByRole('checkbox', { name: label }));
    fireEvent.change(within(dialog).getByLabelText('50% discount starts on'), { target: { value: '2027-02-01' } });
    fireEvent.change(within(dialog).getByLabelText('Full-price billing starts on'), { target: { value: '2028-02-01' } });
    await user.type(within(dialog).getByLabelText('Signed agreement reference for these dates'), 'SYNTHETIC-AGREEMENT-2027');
    expect(within(dialog).queryByLabelText(/Reviewed by|Review time|Review date/)).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const submitted = api.calls.findLast(call => call.method === 'PATCH' && call.path.includes('/records/commercial/'))!;
    expect(submitted.body).toMatchObject({ data: { signed: true, designPartner: true, signedFullPriceTerms: true, discountStartDate: '2027-02-01', fullPriceStartDate: '2028-02-01', discountTermsReference: 'SYNTHETIC-AGREEMENT-2027' } });
    expect((submitted.body as { data: Record<string, unknown> }).data).not.toHaveProperty('discountReview');
    expect(api.state().records.find(record => record.kind === 'commercial')!.data.discountReview).toEqual({ reviewedBy: 'Sandbox Admin', reviewedAt: api.now, proposedPrincipal: 'synthetic-console-person-1', discountStartDate: '2027-02-01', fullPriceStartDate: '2028-02-01', termsReference: 'SYNTHETIC-AGREEMENT-2027' });
    // Saved, the dates are a proposal: the form's answer and the row say they await a second person, and who proposed them.
    const awaiting = /The discount dates are waiting for confirmation\. A different Admin or Finance team member must check them against the signed agreement/;
    expect(within(section).getByRole('status').textContent).toMatch(/^Terms saved\. These design-partner terms cannot be used on a new invoice yet\. The discount dates are waiting for confirmation/);
    const table = within(section).getByRole('table');
    expect(within(table).getByText(awaiting)).toBeTruthy();
    expect(within(table).getByText(`Proposed by Sandbox Admin · ${formatDate(api.now)}`)).toBeTruthy();
  });

  it('says at save time that saved dates cannot price an invoice while the full-price terms are not ticked, naming that and not the dates', async () => {
    const user = userEvent.setup();
    renderApp('/evidence');
    const section = (await screen.findByRole('heading', { name: 'Commercial commitments' })).closest('section')!;
    await user.click(await within(section).findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit commercial terms' });
    // The form says what ticking the full-price terms and saving the dates do, and records nobody's name it does not keep.
    expect(within(dialog).getByText('Tick once the full-price terms are signed. Until then the discount dates are not proposed and cannot price an invoice.')).toBeTruthy();
    expect(within(dialog).getByText(/^Saving signed design-partner terms with these dates proposes them: the service records your demo role or staff account and the time\. A different Admin or Finance user must then confirm them before a new invoice is priced\./)).toBeTruthy();
    expect(within(dialog).queryByText(/records your name/)).toBeNull();
    await user.click(within(dialog).getByRole('checkbox', { name: /^Signed/ }));
    fireEvent.change(within(dialog).getByLabelText('50% discount starts on'), { target: { value: agreement.discountStartDate } });
    fireEvent.change(within(dialog).getByLabelText('Full-price billing starts on'), { target: { value: agreement.fullPriceStartDate } });
    await user.type(within(dialog).getByLabelText('Signed agreement reference for these dates'), agreement.discountTermsReference);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.state().records.find(record => record.kind === 'commercial')!.data.discountReview).toBeUndefined();
    const flag = 'These design-partner terms cannot be used on a new invoice yet. The full-price terms are not recorded as signed. Tick “Full-price terms are signed” once they are, so the discount dates can be proposed.';
    expect(within(section).getByRole('status').textContent).toBe(`Terms saved. ${flag}`);
    expect(within(within(section).getByRole('table')).getByText(flag)).toBeTruthy();
  });

  it('does not flag an unsigned design-partner prospect, whose terms bill nothing, in its row or when it is saved', async () => {
    const user = userEvent.setup();
    renderApp('/evidence');
    const table = await commitmentsTable();
    expect(await within(table).findByText('Not signed')).toBeTruthy();
    expect(within(table).queryByText(/need review|cannot be used on a new invoice|waiting for confirmation/)).toBeNull();
    expect(within(table).queryByRole('button', { name: 'Confirm discount dates' })).toBeNull();
    // Saved unchanged, the prospect is still unsigned: nothing is said about pricing an invoice.
    const section = (await screen.findByRole('heading', { name: 'Commercial commitments' })).closest('section')!;
    await user.click(within(table).getByRole('button', { name: 'Edit' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Edit commercial terms' })).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.some(call => call.method === 'PATCH' && call.path.includes('/records/commercial/') && call.status === 200)).toBe(true);
    expect(within(section).getByRole('status').textContent).toBe('');
    expect(within(table).queryByText(/cannot be used on a new invoice/)).toBeNull();
  });

  it('does not flag terms that later terms from the same date replaced, which bill no month', async () => {
    api.mutate((state, ctx) => {
      // Terms signed before contract dates existed, which may not even be saveable, replaced through Add terms from the same date and confirmed by two people.
      const old = state.records.find(record => record.kind === 'commercial')!;
      Object.assign(old.data, { signed: true, designPartner: true, signedFullPriceTerms: true, effectiveDate: '2027-01-01' });
      makeRecord(state, 'commercial', { name: 'Replacement terms', status: 'signed', createdAt: new Date(Date.parse(old.createdAt) + 60_000).toISOString(), data: { signed: true, designPartner: true, signedFullPriceTerms: true, effectiveDate: '2027-01-01', licenceKobo: 60_000_000, ...agreement,
        discountReview: { reviewedBy: 'Clerk:user_first', reviewedAt: ctx.now, proposedPrincipal: 'first-person', discountStartDate: agreement.discountStartDate, fullPriceStartDate: agreement.fullPriceStartDate, termsReference: agreement.discountTermsReference,
          confirmedBy: 'Clerk:user_second', confirmedPrincipal: 'second-person', confirmedAt: ctx.now } } });
    });
    renderApp('/evidence');
    const table = await commitmentsTable();
    const row = (name: string) => within(table).getByText(name).closest('tr')!;
    expect(await within(table).findByText(`Discount from ${formatDate('2027-02-01')}; full price from ${formatDate('2028-02-01')}.`)).toBeTruthy();
    expect(row('Replacement terms').textContent).toContain('Confirmed by Clerk:user_second');
    const replaced = row(api.state().merchant.name);
    expect(replaced.textContent).toContain('Signed');
    expect(replaced.textContent).not.toMatch(/cannot be used on a new invoice|missing/);
  });

  it('shows who proposed and who confirmed the discount dates, and when, beside the confirmed dates', async () => {
    api.mutate(state => {
      const terms = state.records.find(record => record.kind === 'commercial')!;
      Object.assign(terms.data, { signed: true, designPartner: true, signedFullPriceTerms: true, ...agreement, discountReview: {
        reviewedBy: 'Clerk:user_first', reviewedAt: '2026-09-28T09:00:00.000Z', proposedPrincipal: 'first-person', discountStartDate: agreement.discountStartDate, fullPriceStartDate: agreement.fullPriceStartDate, termsReference: agreement.discountTermsReference,
        confirmedBy: 'Clerk:user_second', confirmedPrincipal: 'second-person', confirmedAt: '2026-09-29T10:30:00.000Z' } });
    });
    renderApp('/evidence');
    const table = await commitmentsTable();
    expect(await within(table).findByText(`Discount from ${formatDate('2027-02-01')}; full price from ${formatDate('2028-02-01')}.`)).toBeTruthy();
    expect(within(table).getByText(`Proposed by Clerk:user_first · ${formatDate('2026-09-28T09:00:00.000Z')}`)).toBeTruthy();
    expect(within(table).getByText(`Confirmed by Clerk:user_second · ${formatDate('2026-09-29T10:30:00.000Z')}`)).toBeTruthy();
    expect(within(table).queryByRole('button', { name: 'Confirm discount dates' })).toBeNull();
  });

  it('tells a visitor who proposed the dates that switching demo roles cannot confirm them', async () => {
    const user = userEvent.setup();
    proposeAgreement();
    api.role = 'Finance';
    renderApp('/evidence');
    const table = await commitmentsTable();
    const confirm = await within(table).findByRole('button', { name: 'Confirm discount dates' });
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(confirm.getAttribute('aria-describedby')!.split(' ').at(-1)!)!.textContent).toBe('A different person must confirm these discount dates. Every demo role here is you, so switching roles cannot confirm them. In a staff pilot, a second Admin or Finance user confirms them.');
    await user.click(confirm);
    expect(screen.queryByRole('dialog', { name: 'Confirm discount dates' })).toBeNull();
    expect(api.state().records.find(record => record.kind === 'commercial')!.data.discountReview.confirmedBy).toBeUndefined();
  });

  it('lets a second staff member confirm the proposed dates they checked, and shows who confirmed them', async () => {
    const user = userEvent.setup();
    proposeAgreement();
    // A staff pilot: the service knows each person by their account. This browser is now a second person's.
    const actor = 'Clerk:user_second';
    const baseFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      if (!String(input).includes('/api/v1/workspace')) return response;
      return new Response(JSON.stringify({ ...(await response.json()), accessMode: 'staff', actor }), { status: response.status, headers: response.headers });
    };
    api.principalId = 'synthetic-console-person-2'; api.role = 'Finance';
    renderApp('/evidence');
    const table = await commitmentsTable();
    await user.click(await within(table).findByRole('button', { name: 'Confirm discount dates' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm discount dates' });
    expect(within(dialog).getByText(`Check these against the signed agreement before you confirm: 50% discount from ${formatDate('2027-02-01')}; full price from ${formatDate('2028-02-01')}; signed agreement reference SYNTHETIC-AGREEMENT-2027.`)).toBeTruthy();
    expect(within(dialog).getByText(`Proposed by Sandbox Admin · ${formatDate(api.now)}`)).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Reason *'), 'Checked against the signed agreement');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm discount dates' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const sent = api.calls.findLast(call => call.method === 'POST' && call.path === '/v1/actions')!;
    expect(sent.body).toMatchObject({ action: 'confirm_discount_terms', data: agreement, reason: 'Checked against the signed agreement' });
    expect(api.state().records.find(record => record.kind === 'commercial')!.data.discountReview).toMatchObject({ confirmedBy: 'Sandbox Finance', confirmedPrincipal: 'synthetic-console-person-2', confirmedAt: api.now });
    const section = (await screen.findByRole('heading', { name: 'Commercial commitments' })).closest('section')!;
    expect(within(section).getByRole('status').textContent).toMatch(/^Discount dates confirmed: 50% discount from 1 Feb 2027, full price from 1 Feb 2028 \(agreement SYNTHETIC-AGREEMENT-2027\), proposed by Sandbox Admin\./);
    expect(await within(table).findByText(`Confirmed by Sandbox Finance · ${formatDate(api.now)}`)).toBeTruthy();
    expect(within(table).queryByRole('button', { name: 'Confirm discount dates' })).toBeNull();
  });

  it('tells a staff member who proposed the dates that a different person must confirm them', async () => {
    proposeAgreement();
    const baseFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      if (!String(input).includes('/api/v1/workspace')) return response;
      return new Response(JSON.stringify({ ...(await response.json()), accessMode: 'staff' }), { status: response.status, headers: response.headers });
    };
    renderApp('/evidence');
    const confirm = await within(await commitmentsTable()).findByRole('button', { name: 'Confirm discount dates' });
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(confirm.getAttribute('aria-describedby')!.split(' ').at(-1)!)!.textContent).toBe('You proposed these discount dates. A different Admin or Finance user must confirm them.');
  });

  it('preserves a refused partial or mid-month discount draft until the dates and agreement reference are corrected', async () => {
    const user = userEvent.setup();
    api.mutate(state => {
      const terms = state.records.find(record => record.kind === 'commercial')!;
      Object.assign(terms.data, { signed: true, designPartner: true, signedFullPriceTerms: true });
      for (const key of ['discountStartDate', 'fullPriceStartDate', 'discountTermsReference', 'discountReview']) delete terms.data[key];
    });
    renderApp('/evidence');
    const section = (await screen.findByRole('heading', { name: 'Commercial commitments' })).closest('section')!;
    await user.click(await within(section).findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit commercial terms' });
    const start = within(dialog).getByLabelText('50% discount starts on') as HTMLInputElement;
    const fullPrice = within(dialog).getByLabelText('Full-price billing starts on') as HTMLInputElement;
    const reference = within(dialog).getByLabelText('Signed agreement reference for these dates') as HTMLInputElement;
    fireEvent.change(start, { target: { value: '2027-02-15' } });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/Enter both discount dates and the signed agreement reference/)).toBeTruthy();
    expect(start.value).toBe('2027-02-15');
    fireEvent.change(fullPrice, { target: { value: '2028-02-01' } });
    await user.type(reference, 'SYNTHETIC-CORRECTED-AGREEMENT');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/Each discount date must be the first day of a month, because a monthly invoice uses one price for the whole month/)).toBeTruthy();
    expect([start.value, fullPrice.value, reference.value]).toEqual(['2027-02-15', '2028-02-01', 'SYNTHETIC-CORRECTED-AGREEMENT']);
    expect(api.state().records.find(record => record.kind === 'commercial')!.data.discountReview).toBeUndefined();
    fireEvent.change(start, { target: { value: '2027-02-01' } });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.state().records.find(record => record.kind === 'commercial')!.data.discountReview).toMatchObject({ discountStartDate: '2027-02-01', termsReference: 'SYNTHETIC-CORRECTED-AGREEMENT' });
  });
  it('keeps evidence for every decision visible, searchable and editable after saving', async () => {
    const user = userEvent.setup();
    api.mutate((state, ctx) => {
      for (const gateId of ['P1', 'F1', 'F2', 'F3', 'F4', 'T1b', 'T2']) makeRecord(state, 'evidence', {
        name: `${gateId} sample evidence`, status: 'recorded', createdAt: ctx.now,
        data: { gateId, reference: `sample-${gateId}`, owner: 'Adéyẹmí', evidenceDate: '2026-09-01', notes: 'Sample document reference' },
      });
    });
    renderApp('/evidence');
    const register = await screen.findByRole('region', { name: 'Evidence register' });
    expect(await within(register).findByText('T2 sample evidence')).toBeTruthy();
    for (const gate of ['F1', 'F2', 'F3', 'F4', 'T1b']) expect(within(register).getByText(`${gate} sample evidence`)).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'Search evidence' }), 'ADEYEMI');
    expect(within(register).getByText('T2 sample evidence')).toBeTruthy();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter evidence by requirement' }), 'T2');
    expect(within(register).queryByText('F1 sample evidence')).toBeNull();
    await user.click(within(register).getByRole('button', { name: 'Edit evidence: T2 sample evidence' }));
    const dialog = screen.getByRole('dialog');
    const title = within(dialog).getByRole('textbox', { name: /^Evidence title/ });
    await user.clear(title); await user.type(title, 'Updated recovery evidence');
    await user.click(within(dialog).getByRole('button', { name: /Save/ }));
    expect(await within(register).findByText('Updated recovery evidence')).toBeTruthy();
    expect(api.state().records.find(record => record.name === 'Updated recovery evidence')?.data.gateId).toBe('T2');
    expect(screen.getByText('Requirements missing')).toBeTruthy();
  });

  it('records when signed terms take effect, the month from which they bill', async () => {
    const user = userEvent.setup();
    renderApp('/evidence');
    const section = (await screen.findByRole('heading', { name: 'Commercial commitments' })).closest('section')!;
    await user.click(await within(section).findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit commercial terms' });
    expect(within(dialog).getByText(/^Each invoice month is billed from the latest signed terms in effect by its end, for the whole month\./)).toBeTruthy();
    await user.click(within(dialog).getByRole('checkbox', { name: /^Signed/ }));
    fireEvent.change(within(dialog).getByLabelText(/^Takes effect on/), { target: { value: '2027-07-15' } });
    await user.click(within(dialog).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(api.state().records.find(record => record.kind === 'commercial')?.data).toMatchObject({ signed: true, effectiveDate: '2027-07-15' }));
  });

  it('shows load failures instead of saying commercial commitments and reviews are empty', async () => {
    const user = userEvent.setup();
    api.failNext(/^\/v1\/records\/commercial$/, { status: 503, error: 'Service temporarily unavailable.' });
    api.failNext(/^\/v1\/records\/reviews$/, 'offline');
    renderApp('/evidence');
    const commercial = await screen.findByText('Unable to load commercial commitments');
    const reviews = await screen.findByText('Unable to load reviews');
    expect(screen.queryByText('No commercial commitments')).toBeNull();
    expect(screen.queryByText('No reviews logged')).toBeNull();
    await user.click(within(commercial.closest('[role="alert"]')!).getByRole('button', { name: 'Try again' }));
    await user.click(within(reviews.closest('[role="alert"]')!).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText('Unable to load commercial commitments')).toBeNull());
    expect(await screen.findByText('No reviews logged')).toBeTruthy();
  });

  it('says, before the first review, that a review is recorded in the signed-in person\'s name, as its dialog records it', async () => {
    renderApp('/evidence');
    const empty = (await screen.findByText('No reviews logged')).closest('tr')!;
    // The dialog no longer takes a reviewer, so the row must not ask for one.
    expect(empty.textContent).not.toMatch(/name the reviewer/i);
    expect(empty.textContent).toContain('The review is recorded in your name, with the time the service saves it.');
  });

  it('reports export failures and leaves an Open link when the browser blocks the new tab', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'open').mockReturnValue(null);
    api.failNext(/^\/v1\/exports$/, 'offline', 'POST');
    renderApp('/evidence');
    const exportButton = await screen.findByRole('button', { name: 'Export evidence pack' });
    await user.click(exportButton);
    expect(await screen.findByText('Evidence pack request could not be confirmed')).toBeTruthy();
    expect(exportButton.hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Retry original request' }));
    const link = await screen.findByRole('link', { name: 'Open evidence pack' });
    expect(link.getAttribute('href')).toMatch(/\/exports\//);
    expect(window.open).toHaveBeenCalledWith(link.getAttribute('href'), '_blank');
  });

  it('records the named tasks in the reviewer\'s own name at the service\'s time, keeping partial reviews distinct from complete reviews', async () => {
    const user = userEvent.setup();
    renderApp('/evidence');
    await user.click(await screen.findByRole('button', { name: 'Log review' }));
    const dialog = screen.getByRole('dialog');
    // MEA-05: nobody types a reviewer or a date; the review is the signed-in person's, at the time the service saves it.
    expect(within(dialog).queryByLabelText(/Reviewer name|Review date/)).toBeNull();
    expect(within(dialog).getByText(/Sandbox Admin \(you\)/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Save review' }));
    expect(await screen.findByText('Describe what was checked and any tasks still outstanding.')).toBeTruthy();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Mandate operations' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Payment matching' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Review notes' }), 'Checked mandates and matches; retries and dispute records still need review.');
    await user.click(within(dialog).getByRole('button', { name: 'Save review' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const record = api.state().records.find(record => record.kind === 'reviews');
    expect(record?.data).toMatchObject({ confirmedJobs: ['mandates', 'reconciliation'], reviewer: 'Sandbox Admin', reviewedAt: api.now });
    expect(await screen.findByText('Mandate operations, Payment matching')).toBeTruthy();
    expect(screen.getByText('Review recorded')).toBeTruthy();
  });
});
