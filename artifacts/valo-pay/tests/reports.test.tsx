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
    expect(screen.getByRole('link', { name: 'Review commercial terms in Go-live evidence' }).getAttribute('href')).toBe('/evidence');
    expect(screen.getByText('Current statement total').parentElement!.textContent).toContain('Needs review');
    await user.click(screen.getByText('Statement lines · 0'));
    expect(screen.getByText(/Statement lines are withheld until/)).toBeTruthy();
    expect(screen.queryByText(/No signed partner terms apply/)).toBeNull();
    await user.click(screen.getByText('Revenue and costs'));
    expect(screen.getByText(/Usage fees: Not available. Licence fees: Not available/)).toBeTruthy();
    expect(screen.getByText(/Recurring revenue at an annual rate: Not available/)).toBeTruthy();
    await user.click(issue);
    expect(screen.queryByRole('dialog', { name: 'Issue the monthly invoice' })).toBeNull();
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
    const receipts = (await screen.findByText("Receipts by payment method")).closest("details")!;
    await user.click(receipts.querySelector("summary")!);
    const row = within(receipts).getByText("Card").closest("tr")!;
    await waitFor(() => expect([...row.querySelectorAll("td")].map(cell => cell.textContent)).toEqual(["Card", "2", usd("₦2,500.00 and USD 1,000.00 (1 receipt)"), "0"]));
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
    expect(screen.getByText(/Current workspace totals.+All figures use sample data/)).toBeTruthy();
  });

  it('shows the daily-close failure and a safe way to check for a completed record before retrying', async () => {
    const user = userEvent.setup();
    api.failNext(/^\/v1\/actions$/, 'offline', 'POST');
    renderApp('/reports');
    await user.click(await screen.findByRole('button', { name: 'Run daily close' }));
    expect(await screen.findByText('Daily close could not be confirmed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh close records' })).toBeTruthy();
    expect(api.state().records.filter(record => record.kind === 'closes')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Run daily close' }));
    expect(await screen.findByText('Daily close completed')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View close record' }).getAttribute('href')).toBe('/reports?view=operations#daily-closes');
  });

  it('invoices every month in order and names the month to issue first', async () => {
    api.setNow('2027-04-03T09:00:00.000Z');
    // This assertion concerns invoice ordering. Use signed full-price terms so it does not depend on discount review.
    api.mutate(state => { const terms = state.records.find(record => record.kind === 'commercial')!; terms.data.signed = true; terms.data.designPartner = false; terms.data.effectiveDate = '2027-01-01'; });
    const user = userEvent.setup();
    renderApp('/reports?view=billing');
    expect(await screen.findByText(/^No invoice has been issued\. The next covers 2027-01\./)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Issue invoice' }));
    const dialog = await screen.findByRole('dialog', { name: 'Issue the monthly invoice' });
    expect(within(dialog).getByText('Months are invoiced in order, a month with nothing to bill for zero. The next invoice covers 2027-01.')).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/^Invoice month/), '2027-03');
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
    expect(await screen.findByText('Billing export request could not be confirmed')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry original request' }));
    expect(await screen.findByRole('link', { name: 'Open billing CSV' })).toBeTruthy();
  });
});
