import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { fireEvent } from '@testing-library/react';
import { makeRecord } from "../../api-server/src/domain/records";
import { executeAction } from "../../api-server/src/domain";
import { formatKobo, formatNumber } from "@/lib/formatters";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => { api.uninstall(); vi.restoreAllMocks(); });

describe("reports", () => {
  it('explains blocked pricing without turning unavailable revenue into zero or claiming no signed terms', async () => {
    const user = userEvent.setup();
    const baseFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      if (!String(input).includes('/api/v1/reports')) return response;
      const body = await response.json();
      Object.assign(body.billing, { pricingReady: false, pricingExplanation: 'Review the signed discount period.', nextInvoicePricingReady: false, nextInvoicePricingExplanation: 'Review discount dates for the next invoice.', totalKobo: null, lines: [] });
      Object.assign(body.billing.unitEconomics, { pricingReady: false, licenceKobo: null, usageFeeKobo: null, recurringKobo: null, annualisedRecurringRevenueKobo: null, grossMargin: null });
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    };
    renderApp('/reports?view=billing');
    await screen.findByText('Commercial terms need review');
    const issue = screen.getByRole('button', { name: 'Issue invoice' });
    expect((issue as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById(issue.getAttribute('aria-describedby')!)!.textContent).toContain('Review discount dates for the next invoice');
    expect(screen.getByRole('link', { name: 'Open Go-live evidence' }).getAttribute('href')).toBe('/evidence');
    expect(screen.getByText('Current statement total').parentElement!.textContent).toContain('Needs review');
    await user.click(screen.getByText('Statement lines (0)'));
    expect(screen.getByText(/Statement lines are hidden until/)).toBeTruthy();
    expect(screen.queryByText(/No signed partner terms apply/)).toBeNull();
    await user.click(screen.getByText('Revenue and costs'));
    expect(screen.getByText(/Usage fees: Not recorded. Licence fees: Not recorded/)).toBeTruthy();
    expect(screen.getByText(/Recurring revenue at an annual rate: Not recorded/)).toBeTruthy();
    await user.click(issue);
    expect(screen.queryByRole('dialog', { name: 'Issue the monthly invoice?' })).toBeNull();
  });

  it('names the cause the service gives when design-partner terms cannot price the next invoice', async () => {
    api.setNow('2027-04-03T09:00:00.000Z');
    // Dates saved without ticking “Full-price terms are signed”: the cause is the flag, not the dates.
    api.mutate(state => { const terms = state.records.find(record => record.kind === 'commercial')!; Object.assign(terms.data, { signed: true, designPartner: true, signedFullPriceTerms: false, effectiveDate: '2027-01-01', discountStartDate: '2027-01-01', fullPriceStartDate: '2028-01-01', discountTermsReference: 'SYN-CAUSE' }); });
    renderApp('/reports?view=billing');
    const box = (await screen.findByText('Commercial terms need review')).parentElement!;
    const cause = 'These design-partner terms cannot price a new invoice yet. The full-price terms are not recorded as signed: tick “Full-price terms are signed” once they are, so that the discount dates can be proposed.';
    expect(box.textContent).toContain(`Next invoice: ${cause}`);
    expect(box.textContent).not.toMatch(/Review the discount dates/);
    expect((screen.getByRole('button', { name: 'Issue invoice' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists issued invoices charged at another rate than the terms in effect give, says why and what to do, and keeps invoicing available', async () => {
    api.setNow('2027-05-02T09:00:00.000Z');
    api.mutate((state, ctx) => {
      const terms = state.records.find(record => record.kind === 'commercial')!;
      // The confirmed agreement: 50% from March 2027 to February 2028, proposed by one person and confirmed by another.
      Object.assign(terms.data, { signed: true, designPartner: true, signedFullPriceTerms: true, effectiveDate: '2027-01-01', discountStartDate: '2027-03-01', fullPriceStartDate: '2028-03-01', discountTermsReference: 'SYN-AGREEMENT',
        discountReview: { reviewedBy: 'Clerk:user_first', reviewedAt: '2027-04-20T09:00:00.000Z', proposedPrincipal: 'first', discountStartDate: '2027-03-01', fullPriceStartDate: '2028-03-01', termsReference: 'SYN-AGREEMENT', confirmedBy: 'Clerk:user_second', confirmedPrincipal: 'second', confirmedAt: '2027-04-21T09:00:00.000Z' } });
      // January to March were invoiced under the earlier calendar-2027 rule, at half price.
      ['2027-01', '2027-02', '2027-03'].forEach((period, index) => makeRecord(state, 'invoices', { name: `Invoice ${period}`, status: 'issued', reference: `INV-${period}-00${index + 1}`, createdAt: ctx.now,
        data: { period, issuedAt: ctx.now, issuedBy: 'Sandbox Finance', sequence: index + 1, usageLines: [], adjustments: [], terms: { commercialId: terms.id, prospect: terms.name, contractedLicenceKobo: 60_000_000, designPartner: true, effectiveDate: '2027-01-01' },
          designPartnerDiscount: { rate: 0.5, kobo: -30_000_000 }, totals: { netKobo: 30_000_000, vatBps: 750, vatKobo: 2_250_000, totalKobo: 32_250_000, creditNote: false } } }));
    });
    renderApp('/reports?view=billing');
    const box = (await screen.findByText('Issued invoices that differ from the terms in effect')).parentElement!;
    const rows = within(within(box).getByRole('table')).getAllByRole('row').map(row => Array.from(row.querySelectorAll('th,td')).map(cell => cell.textContent));
    const name = api.state().records.find(record => record.kind === 'commercial')!.name;
    // Each difference says why, in the service's words: the terms compared with, when they took effect, and the whole-month rule.
    const why = (reference: string, month: string) => `${reference} for ${month} charged the 50% design-partner discount. A month takes the terms in effect by its end: for ${month} those are “${name}”, design-partner terms in effect from 2027-01-01, whose confirmed agreement SYN-AGREEMENT gives the full public price.`;
    expect(rows).toEqual([['Invoice', 'Billing month', 'Rate charged', 'Rate in the terms in effect'],
      ['INV-2027-01-001', '2027-01', '50% discount', 'Full public price'], [why('INV-2027-01-001', '2027-01')],
      ['INV-2027-02-002', '2027-02', '50% discount', 'Full public price'], [why('INV-2027-02-002', '2027-02')]]);
    expect(box.textContent).toContain("An issued invoice is never changed, and Valo Pay has no way to correct an issued invoice's discount");
    expect(box.textContent).toContain('Agree any difference with the lender outside Valo Pay');
    expect((screen.getByRole('button', { name: 'Issue invoice' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('Commercial terms need review')).toBeNull();
  });

  it('says which terms each rate difference was compared with and when they took effect, such as a bridge signed partway through a month', async () => {
    api.setNow('2027-09-02T09:00:00.000Z');
    api.mutate((state, ctx) => {
      // The pilot's terms, with no dates, billed June at half price; a bridge signed on 15 June, discount from July, was confirmed in August.
      const pilot = state.records.find(record => record.kind === 'commercial')!;
      Object.assign(pilot.data, { signed: true, designPartner: true, signedFullPriceTerms: true, effectiveDate: '2027-01-01' });
      makeRecord(state, 'commercial', { name: 'Bridge signed 15 June', status: 'signed', createdAt: '2027-08-10T09:00:00.000Z', data: { signed: true, designPartner: true, signedFullPriceTerms: true, licenceKobo: 60_000_000, effectiveDate: '2027-06-15', discountStartDate: '2027-07-01', fullPriceStartDate: '2028-01-01', discountTermsReference: 'SYN-BRIDGE',
        discountReview: { reviewedBy: 'Clerk:user_first', reviewedAt: '2027-08-10T09:00:00.000Z', proposedPrincipal: 'first', discountStartDate: '2027-07-01', fullPriceStartDate: '2028-01-01', termsReference: 'SYN-BRIDGE', confirmedBy: 'Clerk:user_second', confirmedPrincipal: 'second', confirmedAt: '2027-08-11T09:00:00.000Z' } } });
      makeRecord(state, 'invoices', { name: 'Invoice 2027-06', status: 'issued', reference: 'INV-2027-06-001', createdAt: ctx.now,
        data: { period: '2027-06', issuedAt: ctx.now, issuedBy: 'Sandbox Finance', sequence: 1, usageLines: [], adjustments: [], terms: { commercialId: pilot.id, prospect: pilot.name, contractedLicenceKobo: 60_000_000, designPartner: true, effectiveDate: '2027-01-01' },
          designPartnerDiscount: { rate: 0.5, kobo: -30_000_000 }, totals: { netKobo: 30_000_000, vatBps: 750, vatKobo: 2_250_000, totalKobo: 32_250_000, creditNote: false } } });
    });
    renderApp('/reports?view=billing');
    const box = (await screen.findByText('Issued invoices that differ from the terms in effect')).parentElement!;
    const rows = within(within(box).getByRole('table')).getAllByRole('row').map(row => Array.from(row.querySelectorAll('th,td')).map(cell => cell.textContent));
    expect(rows.slice(1)).toEqual([['INV-2027-06-001', '2027-06', '50% discount', 'Full public price'],
      ['INV-2027-06-001 for 2027-06 charged the 50% design-partner discount. A month takes the terms in effect by its end: for 2027-06 those are “Bridge signed 15 June”, design-partner terms in effect from 2027-06-15, whose confirmed agreement SYN-BRIDGE gives the full public price.']]);
    expect(box.textContent).toContain('While the design-partner terms in effect for a month are not confirmed, its invoices are not compared; confirming their discount dates compares them.');
  });

  it('keeps older report responses without pricing metadata usable', async () => {
    const baseFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      if (!String(input).includes('/api/v1/reports')) return response;
      const body = await response.json();
      for (const key of ['pricingReady', 'pricingExplanation', 'nextInvoicePricingReady', 'nextInvoicePricingExplanation']) delete body.billing[key];
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    };
    renderApp('/reports?view=billing');
    await screen.findByText('Current statement total');
    expect((screen.getByRole('button', { name: 'Issue invoice' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('Commercial terms need review')).toBeNull();
  });
  it('checks a selected source business date without backdating the financial close', async () => {
    const user = userEvent.setup();
    renderApp('/reports');
    await screen.findByText('No daily close yet');
    fireEvent.change(screen.getByLabelText('Source business date (optional)'), { target: { value: '2020-01-02' } });
    await user.click(screen.getByRole('button', { name: 'Run daily close' }));
    await screen.findByText('Daily close completed');
    const close = api.state().records.find(record => record.kind === 'closes')!;
    expect(close.data.sourceBusinessDate).toBe('2020-01-02');
    expect(close.data.closedAt.slice(0, 10)).not.toBe('2020-01-02');
    expect(close.data.reviewBasis.sourceCompleteness.businessDate).toBe('2020-01-02');
  });
  it("runs a daily close from the page and shows the REC-07 chips, the trigger and the schedule", async () => {
    const user = userEvent.setup();
    renderApp("/reports");
    expect(await screen.findByText("No daily close yet")).toBeTruthy();
    expect(screen.getByText(/^Next daily close: .+ WAT, then every day at this time\.$/)).toBeTruthy();
    expect(screen.getByText("Counts from the first daily close.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Run daily close" }));
    // The close is written by the real domain and read back through the reports contract.
    await user.click(await screen.findByText('View close details'));
    expect(await screen.findByText(/^manual$/)).toBeTruthy();
    const action = api.calls.find((call) => call.method === "POST" && call.path === "/v1/actions");
    expect(action?.body).toMatchObject({ action: "daily_close" });
    expect(action?.status).toBe(200);
    const closes = api.state().records.filter((record) => record.kind === "closes");
    expect(closes).toHaveLength(1);
    expect(closes[0]!.data.schedule.trigger).toBe("manual");
    for (const label of ["Unmatched at start", "Payment records received", "Exceptions", "Retry decisions"]) expect(within(screen.getByRole("list", { name: "Recorded daily closes" })).getByText(label)).toBeTruthy();
    expect(screen.getByText(String(closes[0]!.data.summary))).toBeTruthy();
    expect(screen.getByText(/Since the first daily close on/)).toBeTruthy();
    expect(screen.queryByText("No daily close yet")).toBeNull();
  });

  // Second review of the audit fixes, console finding 1: a close's money in another currency is listed in that currency.
  /** A USD 1,000.00 card payment's evidence, which reconciliation holds as a payment for Finance. */
  const usdPayment = () => api.mutate(state => makeRecord(state, "observations", {
    name: "card CARD-USD-1", status: "unresolved", reference: "CARD-USD-1", amountKobo: 100_000,
    customerId: state.records.find(record => record.kind === "customers")!.id,
    data: { provider: state.merchant.provider, source: "card", eventId: "usd-1", occurredAt: api.now, currency: "USD" },
  }));
  /** The recorded close's measures, by label, as View close details shows them. */
  async function closeDetails(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByText("View close details"));
    const list = await screen.findByText("Unmatched at start");
    const measures = list.closest("dl")!;
    return (label: string) => within(measures).getByText(label, { selector: "dt" }).nextElementSibling!.textContent;
  }
  const usd = (text: string) => text.replace("USD ", "USD\u00a0");

  it("lists a close's money in another currency beside its naira, as the API counts it", async () => {
    const user = userEvent.setup();
    usdPayment();
    // Reconciliation holds the USD payment before the close, so the close opens with it waiting too.
    api.mutate((state, ctx) => executeAction(state, ctx, { action: "run_reconciliation" }));
    renderApp("/reports");
    await user.click(await screen.findByRole("button", { name: "Run daily close" }));
    await screen.findByText("Daily close completed");
    const report = api.state().records.find(record => record.kind === "closes")!.data.report;
    // The seeded naira transfer and the USD card payment both wait for Finance, before the close and after it.
    for (const money of [report.openingUnallocated, report.unallocated]) {
      expect(money.kobo).toBeGreaterThan(0);
      expect(money.otherCurrencies).toEqual({ USD: { count: 1, amount: 100_000 } });
    }
    const measure = await closeDetails(user);
    expect(measure("Unmatched at start")).toBe(usd(`${formatNumber(report.openingUnallocated.count)} · ${formatKobo(report.openingUnallocated.kobo)} and USD 1,000.00 (1 payment)`));
    expect(measure("Unmatched at close")).toBe(usd(`${formatNumber(report.unallocated.count)} · ${formatKobo(report.unallocated.kobo)} and USD 1,000.00 (1 payment) · ${formatNumber(report.unallocated.olderThan24Hours)} older than 24 hours`));
  });

  it("never shows a lone payment in another currency as nothing waiting", async () => {
    const user = userEvent.setup();
    renderApp("/reports");
    await user.click(await screen.findByRole("button", { name: "Run daily close" }));
    await screen.findByText("Daily close completed");
    // The API's shape once every currency is counted: one USD payment waits, and no naira.
    const usdOnly = { count: 1, kobo: 0, otherCurrencies: { USD: { count: 1, amount: 100_000 } } };
    api.mutate(state => { const report = state.records.find(record => record.kind === "closes")!.data.report; report.openingUnallocated = usdOnly; report.unallocated = { ...usdOnly, olderThan24Hours: 1 }; });
    const measure = await closeDetails(user);
    expect(measure("Unmatched at start")).toBe(usd("1 · ₦0.00 and USD 1,000.00 (1 payment)"));
    expect(measure("Unmatched at close")).toBe(usd("1 · ₦0.00 and USD 1,000.00 (1 payment) · 1 older than 24 hours"));
  });

  // Decision on currencies in settlement batches: a close sums the naira batches' fee differences only, and lists a batch
  // in another currency apart, whose fees are not checked while no fee schedule exists for its currency.
  it("lists a settlement batch in another currency apart from the naira fee differences", async () => {
    const user = userEvent.setup();
    api.mutate(state => {
      const customerId = state.records.find(record => record.kind === "customers")!.id;
      makeRecord(state, "observations", { name: "Settlement line", status: "unresolved", reference: "PSK-USD-9", amountKobo: 99_500, customerId, data: { provider: state.merchant.provider, source: "settlement", grossAmountKobo: 100_000, feeKobo: 500, batchReference: "B-USD-9", eventId: "usd-line-9", occurredAt: api.now, currency: "USD" } });
      makeRecord(state, "observations", { name: "Statement credit", status: "unresolved", reference: "STMT-USD-9", amountKobo: 1_000, data: { provider: state.merchant.provider, source: "statement", batchReference: "B-USD-9", eventId: "usd-credit-9", occurredAt: api.now, currency: "USD" } });
    });
    renderApp("/reports");
    await user.click(await screen.findByRole("button", { name: "Run daily close" }));
    await screen.findByText("Daily close completed");
    const variances = api.state().records.find(record => record.kind === "closes")!.data.report.variances;
    expect([variances.count, variances.otherCurrencies, variances.batches[0].currency]).toEqual([1, { USD: { count: 1, amount: 0 } }, "USD"]);
    const measure = await closeDetails(user);
    expect(measure("Settlement differences")).toBe(`1 · ${formatKobo(0)} and 1 batch in USD, fees not checked`);
  });

  it("lists receipts in another currency beside a payment method's naira value", async () => {
    const user = userEvent.setup();
    const baseFetch = globalThis.fetch;
    // The billing statement's shape once receipts in another currency are listed beside the naira value.
    globalThis.fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      if (!String(input).includes("/api/v1/reports")) return response;
      const body = await response.json();
      body.billing.channelBreakdown.card = { count: 2, kobo: 250_000, billable: 0, reason: "Not charged.", otherCurrencies: { USD: { count: 1, amount: 100_000 } } };
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    };
    renderApp("/reports?view=billing");
    const receipts = (await screen.findByText("Payments by method")).closest("details")!;
    await user.click(receipts.querySelector("summary")!);
    const row = within(receipts).getByText("Card").closest("tr")!;
    await waitFor(() => expect([...row.querySelectorAll("td")].map(cell => cell.textContent)).toEqual(["Card", "2", usd("₦2,500.00 and USD 1,000.00 (1 payment)"), "0"]));
  });

  it("says when the automatic close is off", async () => {
    api.mutate((state) => { state.settings.scheduledCloseEnabled = false; });
    renderApp("/reports");
    expect(await screen.findByText("Automatic daily close is off for this lender. Run closes manually.")).toBeTruthy();
  });

  it('distinguishes no accuracy measurement from a measured zero and offers the next action', async () => {
    renderApp('/reports');
    const accuracy = await screen.findByText('Accuracy of reviewed allocations');
    const card = accuracy.parentElement!;
    expect(within(card).getByText('Not measured yet')).toBeTruthy();
    expect(within(card).queryByText('0.0%')).toBeNull();
    expect(within(card).getByRole('link', { name: 'Review matches' }).getAttribute('href')).toBe('/reconciliation#precision-audit');
    expect(screen.getByText(/Current totals for this lender.+All figures use sample data/)).toBeTruthy();
  });

  it('takes experiment rates in per cent, saves them as exact fractions and shows them back in per cent', async () => {
    api.mutate(state => { state.records.find(record => record.kind === 'policies')!.status = 'approved'; });
    const user = userEvent.setup();
    renderApp('/reports?view=evidence');
    const draft = (await screen.findByText('Recovery measurement · pre-registration')).closest('div.border')! as HTMLElement;
    await user.click(within(draft).getByRole('button', { name: 'Edit' }));
    let dialog = await screen.findByRole('dialog', { name: 'Edit experiment' });
    const baseline = () => within(dialog).getByLabelText(/^Baseline recovery rate \(%\)/) as HTMLInputElement;
    const share = () => within(dialog).getByLabelText(/^Comparison group share \(%\)/) as HTMLInputElement;
    // Saved as 0.4 and 0.5, shown in per cent.
    expect([baseline().value, share().value]).toEqual(['40', '50']);
    await user.clear(baseline()); await user.type(baseline(), '7.125');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Enter a percentage from 0 to 100 with no more than 2 decimal places, for example 0.3 or 40.')).toBeTruthy();
    expect(api.state().records.find(record => record.kind === 'experiments')!.data.baselineRate).toBe(0.4);
    // 7 per cent is 0.07 exactly, never 0.07 times a rounding error.
    await user.clear(baseline()); await user.type(baseline(), '7');
    await user.clear(share()); await user.type(share(), '20');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit experiment' })).toBeNull());
    const saved = api.state().records.find(record => record.kind === 'experiments')!;
    expect([saved.data.baselineRate, saved.data.holdoutShare]).toEqual([0.07, 0.2]);
    await user.click(within(draft).getByRole('button', { name: 'Edit' }));
    dialog = await screen.findByRole('dialog', { name: 'Edit experiment' });
    expect([baseline().value, share().value]).toEqual(['7', '20']);
  });

  it('shows the daily-close failure and a safe way to check for a completed record before retrying', async () => {
    const user = userEvent.setup();
    api.failNext(/^\/v1\/actions$/, 'offline', 'POST');
    renderApp('/reports');
    await user.click(await screen.findByRole('button', { name: 'Run daily close' }));
    expect(await screen.findByText('Request not confirmed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh close records' })).toBeTruthy();
    expect(api.state().records.filter(record => record.kind === 'closes')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Run daily close' }));
    expect(await screen.findByText('Daily close completed')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View close record' }).getAttribute('href')).toBe('/reports?view=operations#daily-closes');
  });

  it('checks a daily close whose answer was lost with Check original request, which never runs a second close', async () => {
    const user = userEvent.setup();
    // The close reaches Valo Pay and runs, but its answer is lost; the same request sent again gets the saved answer.
    const send = globalThis.fetch, keys: string[] = [], replies = new Map<string, Response>();
    globalThis.fetch = async (input, options) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes('/api/v1/actions') || options?.method !== 'POST') return send(input, options);
      const key = new Headers(options.headers).get('Idempotency-Key')!;
      keys.push(key);
      if (replies.has(key)) return replies.get(key)!.clone();
      const response = await send(input, options);
      replies.set(key, response.clone());
      throw new TypeError('Failed to fetch');
    };
    try {
      renderApp('/reports');
      await user.click(await screen.findByRole('button', { name: 'Run daily close' }));
      const notice = (await screen.findByText(/^We do not know yet whether Valo Pay ran this close\. Select Check original request to find out\. It does not run a second close\./)).closest('[role="alert"]') as HTMLElement;
      expect(within(notice).getByText('Request not confirmed')).toBeTruthy();
      expect(within(notice).getByRole('button', { name: 'Refresh close records' })).toBeTruthy();
      await user.click(within(notice).getByRole('button', { name: 'Check original request' }));
      const done = await screen.findByText('Daily close completed');
      // The check sent the original request again, with its key, and Valo Pay ran one close.
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      expect(api.state().records.filter(record => record.kind === 'closes')).toHaveLength(1);
      // The button went with the notice it was in; reading continues from the outcome.
      await waitFor(() => expect(document.activeElement).toBe(done.closest('[role="status"]')));
    } finally { globalThis.fetch = send; }
  });

  it('invoices every month in order and names the month to issue first', async () => {
    api.setNow('2027-04-03T09:00:00.000Z');
    // This assertion concerns invoice ordering. Use signed full-price terms so it does not depend on discount review.
    api.mutate(state => { const terms = state.records.find(record => record.kind === 'commercial')!; terms.data.signed = true; terms.data.designPartner = false; terms.data.effectiveDate = '2027-01-01'; });
    const user = userEvent.setup();
    renderApp('/reports?view=billing');
    expect(await screen.findByText(/^No invoices yet\. The next invoice covers 2027-01\./)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Issue invoice' }));
    const dialog = await screen.findByRole('dialog', { name: 'Issue the monthly invoice?' });
    expect(within(dialog).getByText('Leave blank to invoice the previous month, or enter a month as YYYY-MM, for example 2027-01. Months are invoiced in order, and a month with nothing to bill gets a zero invoice. The next invoice covers 2027-01.')).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/^Billing month/), '2027-03');
    await user.type(within(dialog).getByLabelText('Reason *'), 'Month-end invoice');
    await user.click(within(dialog).getByRole('button', { name: 'Issue invoice' }));
    expect(await within(dialog).findByText(/issue the invoice for 2027-01 first, the month the signed terms took effect\.$/)).toBeTruthy();
    expect(api.state().records.some(record => record.kind === 'invoices')).toBe(false);
  });

  it('keeps billing exports reachable when the browser blocks the new tab', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'open').mockReturnValue(null);
    api.failNext(/^\/v1\/exports$/, 'offline', 'POST');
    renderApp('/reports?view=billing');
    await user.click(await screen.findByRole('button', { name: 'Export billing CSV' }));
    expect(await screen.findByText('Request not confirmed')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Check original request' }));
    expect(await screen.findByRole('link', { name: 'Open billing CSV' })).toBeTruthy();
  });
});
