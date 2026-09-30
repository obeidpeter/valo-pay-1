import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { queryClient, queryDefaults } from "@/App";
import { customerTimeline } from "../../api-server/src/domain/timeline";
import { makeRecord } from "../../api-server/src/domain/records";
import { reconcile } from "../../api-server/src/domain/reconciliation";
import { importCsv } from "../../api-server/src/lib/valopay-import";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("customer timeline", () => {
  it("shows the customer, the derived position and generates a dispute pack", async () => {
    const user = userEvent.setup();
    const opened = vi.fn();
    window.open = opened as typeof window.open;
    const ada = api.state().records.find((record) => record.kind === "customers" && record.name === "Ada Okonkwo")!;
    renderApp(`/customers/${ada.id}`);
    expect(await screen.findByRole("heading", { name: "Ada Okonkwo" })).toBeTruthy();
    expect(screen.getByText("DEMO-C1001")).toBeTruthy();
    expect(screen.getByText("Balance summary")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Export dispute pack (PDF)" }));
    expect(await screen.findByText("Dispute pack ready")).toBeTruthy();
    const request = api.calls.find((call) => call.method === "POST" && call.path === "/v1/exports");
    expect(request?.body).toEqual({ kind: "dispute-pack", format: "pdf", customerId: ada.id });
    const record = api.state().records.find((item) => item.kind === "exports")!;
    expect(record.customerId).toBe(ada.id);
    await waitFor(() => expect(opened).toHaveBeenCalledWith(`/api/v1/exports/${record.id}/download?merchantId=${api.merchantIds[0]}`, "_blank"));
    // Radix also announces a new notice through a hidden copy for a moment, so the text may be present twice.
    expect(screen.getAllByText(new RegExp(`SHA-256 checksum: ${String(record.data.checksum).slice(0, 16)}`)).length).toBeGreaterThanOrEqual(1);
  });

  // Third review of the audit fixes: the customer's positions list money in another currency beside the naira credit
  // (unallocatedOtherCurrencies, shaped like a close's otherCurrencies), which the page shows as close evidence does.
  it("shows the customer's unapplied money in another currency beside the naira credit, and a payment in its own currency", async () => {
    const ada = api.state().records.find((record) => record.kind === "customers" && record.name === "Ada Okonkwo")!;
    api.mutate((state) => {
      const payment = state.records.find((record) => record.kind === "payments" && record.customerId === ada.id)!;
      const unapplied = (id: string, reference: string, amountKobo: number, currency: string) => state.records.push({ ...structuredClone(payment), id, reference, status: "unallocated", amountKobo, createdAt: api.now, data: { ...structuredClone(payment.data), currency, channel: "card", allocatedKobo: 0 } });
      unapplied("usd-card-payment", "SBX-USD-CARD", 100_000, "USD");
      unapplied("eur-card-payment-1", "SBX-EUR-CARD-1", 2_000, "EUR");
      unapplied("eur-card-payment-2", "SBX-EUR-CARD-2", 3_000, "EUR");
    });
    renderApp(`/customers/${ada.id}`);
    const position = (await screen.findByText("Balance summary")).parentElement!;
    expect(position.textContent).toContain("Unallocated payments");
    // The service derives the money beside the naira (the position the fake API serves is the domain's), and the page shows it as it comes.
    expect(customerTimeline(api.state(), ada.id).position.unallocatedOtherCurrencies).toEqual({ EUR: { count: 2, amount: 5_000 }, USD: { count: 1, amount: 100_000 } });
    // Each currency is an item of its own under the label, by code, as close evidence writes it.
    const others = screen.getByRole("list", { name: "Unallocated, other currencies" });
    expect(within(others).getAllByRole("listitem").map((item) => item.textContent!.replace(/\u00a0/g, " "))).toEqual(["EUR 50.00 (2 payments)", "USD 1,000.00 (1 payment)"]);
    // The payment itself is listed in its own currency, never as naira.
    const listed = (await screen.findByRole("heading", { name: "Payments" })).closest("section")!;
    expect(listed.textContent!.replace(/\u00a0/g, " ")).toContain("SBX-USD-CARDUSD 1,000.00");
    expect(listed.textContent).not.toContain("₦1,000.00");
  });

  // Third review, a residual: an exception raised for money in another currency holds that money's minor units, and the
  // customer's history and the case page showed them as naira (₦20.00 for EUR 20.00, ₦1,000.00 for USD 1,000.00).
  it("shows an exception about money in another currency in that currency in the customer's history", async () => {
    const ada = api.state().records.find((record) => record.kind === "customers" && record.name === "Ada Okonkwo")!;
    const [euros, dollars] = api.mutate((state, ctx) => {
      const card = (reference: string, amountKobo: number, currency: string) => makeRecord(state, "observations", { name: `${currency} card`, status: "unresolved", reference, amountKobo, customerId: ada.id, data: { source: "card", eventId: reference, provider: "Sandbox Rail", currency } });
      const eur = card("CARD-EUR-1", 2_000, "EUR"), usd = card("CARD-USD-1", 100_000, "USD");
      reconcile(state, { ...ctx, actor: "Sandbox Finance", role: "Finance" });
      return [eur, usd].map((evidence) => state.records.find((record) => record.kind === "exceptions" && record.data.linkedRecordId === evidence.data.paymentId)!);
    });
    renderApp(`/customers/${ada.id}`);
    await screen.findByRole("heading", { name: "Customer history" });
    const events = document.querySelectorAll("main ol > li");
    const eventOf = (exception: { id: string }) => [...events].find((item) => item.querySelector(`[title="${exception.id}"]`))!;
    expect([eventOf(euros), eventOf(dollars)].map((item) => item.textContent!.replace(/ /g, " ").match(/Unallocated payment(.*?)Open/)?.[1])).toEqual(["EUR 20.00", "USD 1,000.00"]);
    expect(eventOf(euros).textContent).not.toContain("₦20.00");
  });

  // Review of the integration fixes, finding 1: only payment evidence reads a row's currency, so an instalment imported
  // with a currency column holds kobo, but the page showed it in the column's currency ("JPY 100,000,000" for ₦1,000,000.00).
  it("shows an instalment imported with a currency column in naira, as its amount is", async () => {
    const ada = api.state().records.find((record) => record.kind === "customers" && record.name === "Ada Okonkwo")!;
    const due = api.mutate((state, ctx) => {
      const csv = 'row_id,name,reference,customerId,amount,dueDate,owner,currency\nd1,Yen column,DUE-CUR-JPY,DEMO-C1001,"1,000,000",2099-01-01,lms,JPY';
      expect(importCsv(state, ctx, { kind: "due-items", csv, syntheticOnly: true, commit: true, amountUnit: "naira", identityColumn: "row_id" }).imported).toBe(1);
      return state.records.find((record) => record.kind === "due-items" && record.reference === "DUE-CUR-JPY")!;
    });
    expect([due.amountKobo, due.data.currency]).toEqual([100_000_000, "JPY"]);
    renderApp(`/customers/${ada.id}?record=${due.id}`);
    const selected = await screen.findByRole("region", { name: "Selected collection record" });
    await waitFor(() => expect(selected.textContent).toContain("DUE-CUR-JPY"));
    expect(selected.textContent).toContain("₦1,000,000.00 · Scheduled");
    expect(selected.textContent).not.toMatch(/JPY\s\d/);
    const event = [...document.querySelectorAll("main ol > li")].find((item) => item.querySelector(`[title="${due.id}"]`))!;
    expect(event.textContent).toContain("₦1,000,000.00");
    expect(event.textContent).not.toMatch(/JPY\s\d/);
  });

  it("shows a case's amount in the currency of the money it is about", async () => {
    const exception = api.mutate((state, ctx) => {
      const ada = state.records.find((record) => record.kind === "customers" && record.name === "Ada Okonkwo")!;
      const card = makeRecord(state, "observations", { name: "USD card", status: "unresolved", reference: "CARD-USD-2", amountKobo: 100_000, customerId: ada.id, data: { source: "card", eventId: "usd-2", provider: "Sandbox Rail", currency: "USD" } });
      reconcile(state, { ...ctx, actor: "Sandbox Finance", role: "Finance" });
      return state.records.find((record) => record.kind === "exceptions" && record.data.linkedRecordId === card.data.paymentId)!;
    });
    renderApp(`/cases/${exception.id}`);
    const panel = (await screen.findByRole("heading", { name: "Exception details" })).closest("section")!;
    expect(panel.textContent!.replace(/ /g, " ")).toContain("USD 1,000.00");
    expect(panel.textContent).not.toContain("₦1,000.00");
  });

  it("says when the lender has no customer with the reference, inside the console", async () => {
    renderApp("/customers/not-a-customer");
    expect(await screen.findByRole("heading", { level: 1, name: "Customer not found" })).toBeTruthy();
    expect(screen.getByText("not-a-customer")).toBeTruthy();
    expect(api.calls.find((call) => call.path.endsWith("/history"))?.status).toBe(404);
    // The sidebar stays as the way out, and each action names where it goes.
    expect(screen.getByRole("link", { name: /Audit log/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Customers" }).getAttribute("href")).toBe("/customers");
    expect(screen.getByRole("link", { name: "Open Overview" }).getAttribute("href")).toBe("/overview");
    await waitFor(() => expect(document.title).toBe("Customer not found · Valo Pay"));
  });

  it("says when the lender has no case with the ID, at once and after one request", async () => {
    // The app's own retry rule, without its delay: a 404 is shown at once, never repeated.
    const testDefaults = queryClient.getDefaultOptions();
    queryClient.setDefaultOptions({ queries: { ...queryDefaults.queries, retryDelay: 0 } });
    try {
      renderApp("/cases/no-such-case");
      expect(await screen.findByRole("heading", { level: 1, name: "Case not found" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: /^Case(: .+)?$/ })).toBeNull();
      expect(screen.getByText("no-such-case")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(screen.getByRole("link", { name: "Back to Exceptions" }).getAttribute("href")).toBe("/exceptions");
      expect(screen.getByRole("link", { name: "Open Overview" }).getAttribute("href")).toBe("/overview");
      await waitFor(() => expect(document.title).toBe("Case not found · Valo Pay"));
      expect(api.calls.filter((call) => call.path === "/v1/pilot/cases/no-such-case").map((call) => call.status)).toEqual([404]);
    } finally {
      queryClient.setDefaultOptions(testDefaults);
    }
  });

  it("keeps a temporary case loading failure retryable", async () => {
    api.failNext(/^\/v1\/pilot\/cases\/no-such-case$/, { status: 503, error: "The service is busy. Try again in a moment." });
    renderApp("/cases/no-such-case");
    expect(await screen.findByText(/^The service is busy\. Try again in a moment\./)).toBeTruthy();
    // Before the exception loads, the heading is the page's name alone.
    expect(screen.getByRole("heading", { level: 1, name: "Case" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
