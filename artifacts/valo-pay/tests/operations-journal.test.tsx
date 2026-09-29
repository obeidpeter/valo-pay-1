// Backlog item UX-B02-X3 and decision 3: Operations says enough to match an entry to the form that was lost, opens the
// saved result of every record kind that has a page, and the console shows the count of requests not confirmed on the
// Request history link (the Operations page), where a person who reloads sees it.
import { afterEach, beforeEach, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
/** Serves the journal and its pending count from `items`, and everything else from the fake API. */
function journal(items: Array<Record<string, unknown>>, pending = items.filter((item) => item.status === "pending").length) {
  const send = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString(), "http://localhost");
    if (url.pathname === "/api/v1/operations") return json({ items, total: items.length, offset: 0 });
    if (url.pathname === "/api/v1/operations/pending") return json({ pending });
    return send(input, options);
  };
}
const entry = (id: string, status: string, rest: Record<string, unknown> = {}) => ({
  id, label: `Save ${id}`, actor: "Sandbox Admin", role: "Admin", status, createdAt: api.now, updatedAt: api.now,
  message: status === "completed" ? "The service saved this request." : "Completion has not been confirmed. Check the original request.",
  recordId: null, recordKind: null, summary: null, ...rest,
});
const card = (heading: string) => screen.getByRole("heading", { name: heading }).closest("article") as HTMLElement;

it("names what each request asked and the record it names, never more", async () => {
  journal([
    entry("pending-change", "pending", { summary: { action: "Change a record", targetKind: "customers", targetId: "cus-1", details: [{ name: "Status", value: "inactive" }] } }),
    entry("pending-action", "pending", { summary: { action: "Mandate suspend", targetKind: "mandates", targetId: "mnd-1", details: [] } }),
    entry("pending-revoke", "pending", { summary: { action: "Connected banking: consent.revoke", targetKind: "connected-consents", targetId: "cst-1", details: [] } }),
    entry("pending-export", "pending", { summary: { action: "Retry an export", targetKind: "exports", targetId: "exp-1", details: [] } }),
    entry("pending-run", "pending", { summary: { action: "Approve a retention run", targetKind: "retention-runs", targetId: "run-1", details: [] } }),
    entry("sealed", "pending"),
  ]);
  renderApp("/operations");
  await screen.findByRole("heading", { name: "Change a record" });
  const change = card("Change a record");
  expect(change.textContent).toContain("Customers cus-1");
  expect(change.textContent).toContain("Status: inactive");
  expect(within(change).getByRole("link", { name: "Open the record" }).getAttribute("href")).toBe("/customers/cus-1");
  const action = card("Mandate suspend");
  expect(within(action).getByRole("link", { name: "Open the record" }).getAttribute("href")).toBe(`/mandates?record=mnd-1&lender=${api.merchantIds[0]}#record-mnd-1`);
  expect(within(card("Connected banking: consent.revoke")).getByRole("link", { name: "Open the record" }).getAttribute("href")).toBe("/connections");
  // The export or run itself, not the newest one its page lists.
  expect(within(card("Retry an export")).getByRole("link", { name: "Open the record" }).getAttribute("href")).toBe("/exports?job=exp-1");
  expect(within(card("Approve a retention run")).getByRole("link", { name: "Open the record" }).getAttribute("href")).toBe("/lifecycle?run=run-1");
  // A sealed request has no summary: its label stands in.
  expect(card("Save sealed").textContent).not.toContain("Open the record");
});

it("opens the saved result of every record kind that has a page", async () => {
  const lender = api.merchantIds[0]!;
  const pages: Array<[string, string | null]> = [
    ["customers", "/customers/r-customers"],
    ["exceptions", "/cases/r-exceptions"],
    ["mandates", `/mandates?record=r-mandates&lender=${lender}#record-r-mandates`],
    ["due-items", `/reconciliation?dueItem=r-due-items&lender=${lender}#record-r-due-items`],
    ["import-batches", "/imports?batch=r-import-batches"],
    ["import-corrections", "/imports"],
    // Saved exports and Data retention open one export or run by its ID; their lists begin with the newest.
    ["exports", "/exports?job=r-exports"],
    ["closes", "/reports?view=operations#daily-closes"],
    ["close-reviews", "/close-review"],
    ["payments", "/reconciliation"],
    ["allocations", "/reconciliation"],
    ["policies", "/policies"],
    ["templates", "/policies"],
    ["reviews", "/evidence"],
    ["evidence", "/evidence"],
    ["source-profiles", "/sources"],
    ["provider-events", "/sources"],
    ["retention-runs", "/lifecycle?run=r-retention-runs"],
    ["work-events", "/work"],
    // Connected-banking permissions are granted and revoked on Permissions & readiness, not on Pay-by-bank.
    ["connected-consents", "/connections"],
    ["connected-intents", "/pay-by-bank"],
    ["connected-credit-assessments", "/credit-desk"],
    ["connected-cash-forecasts", "/cash-desk"],
    ["costs", null],
  ];
  journal(pages.map(([kind]) => entry(kind, "completed", { recordId: `r-${kind}`, recordKind: kind })));
  renderApp("/operations");
  await screen.findByRole("heading", { name: "Save customers" });
  for (const [kind, href] of pages) {
    const link = within(card(`Save ${kind}`)).queryByRole("link", { name: "Open saved result" });
    expect(link?.getAttribute("href") ?? null, kind).toBe(href);
  }
});

it("shows the count of requests not confirmed on the Request history link", async () => {
  journal([entry("one", "pending"), entry("two", "pending")]);
  renderApp("/overview");
  const links = await screen.findAllByRole("link", { name: "Request history, 2 requests not confirmed" });
  expect(links[0]!.getAttribute("href")).toBe("/operations");
});

it("shows no count when nothing waits", async () => {
  renderApp("/overview");
  await waitFor(() => expect(api.calls.some((call) => call.path === "/v1/operations/pending")).toBe(true));
  expect(screen.getAllByRole("link", { name: "Request history" }).length).toBeGreaterThan(0);
  expect(screen.queryAllByRole("link", { name: /not confirmed/ })).toEqual([]);
});

// Fix review: a check or cancel from Operations that the service refuses can settle the request for good: a check
// refused for good cancels it, and a cancel is refused once the request completed. The list and the count on the
// Request history link are read again at once, not on the list's next refresh or when the window next takes focus.
const refusals = [
  { button: "Check original request", path: "retry", settled: "cancelled", error: "A reference already exists." },
  { button: "Cancel if unfinished", path: "cancel", settled: "completed", error: "This request already completed. Refresh Operations to see its saved result." },
] as const;
for (const refusal of refusals) it(`reads the list and the count again once ${refusal.path === "retry" ? "a check" : "a cancel"} from Operations is refused`, async () => {
  const user = userEvent.setup();
  let status = "pending", listReads = 0, countReads = 0;
  const send = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString(), "http://localhost");
    if (url.pathname === "/api/v1/operations") { listReads += 1; return json({ items: [entry("op-1", status)], total: 1, offset: 0 }); }
    if (url.pathname === "/api/v1/operations/pending") { countReads += 1; return json({ pending: status === "pending" ? 1 : 0 }); }
    if (url.pathname === `/api/v1/operations/op-1/${refusal.path}`) {
      status = refusal.settled;
      return new Response(JSON.stringify({ error: refusal.error, ...(refusal.settled === "cancelled" ? { operation: "cancelled" } : {}), requestId: "r" }), { status: 409, headers: { "Content-Type": "application/json" } });
    }
    return send(input, options);
  };
  renderApp("/operations");
  await screen.findAllByRole("link", { name: "Request history, 1 request not confirmed" });
  const [listed, counted] = [listReads, countReads];
  await user.click(await screen.findByRole("button", { name: refusal.button }));
  await screen.findByText(refusal.error);
  await waitFor(() => expect(screen.queryAllByRole("link", { name: /not confirmed/ })).toEqual([]), { timeout: 2000 });
  await screen.findByText(refusal.settled);
  expect([listReads > listed, countReads > counted]).toEqual([true, true]);
});
