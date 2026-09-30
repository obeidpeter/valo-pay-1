import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, it, expect } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { customerTimeline } from "../../api-server/src/domain/timeline";
import { formatKobo } from "@/lib/formatters";
let api: FakeApi;
beforeEach(() => {
  api = installFakeApi();
});
afterEach(() => api.uninstall());

it.each([
  ["/exceptions", "No exceptions match your search"],
  ["/mandates", "No mandates match your search"],
  ["/collections", "No instalments match your search"],
])(
  "%s distinguishes a nonmatching search from an empty queue and restores results",
  async (route, noMatch) => {
    const user = userEvent.setup();
    renderApp(route + "?q=nonexistent-search&page=9");
    await screen.findByText(noMatch);
    expect(screen.queryByText("All clear: no open exceptions")).toBeNull();
    expect(screen.queryByText("No mandates yet")).toBeNull();
    expect(screen.queryByText("No instalments yet")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() =>
      expect(screen.queryByText(noMatch)).toBeNull(),
    );
    await waitFor(() =>
      expect(document.querySelectorAll("tbody tr").length).toBeGreaterThan(1),
    );
    expect(new URLSearchParams(window.location.search).has("q")).toBe(false);
    expect(new URLSearchParams(window.location.search).has("page")).toBe(false);
  },
);

it("clear search preserves exception owner, status and type filters", async () => {
  const user = userEvent.setup();
  renderApp(
    "/exceptions?q=nonexistent-search&view=resolved&owner=Finance&type=unallocated_payment",
  );
  await screen.findByText("No exceptions match your search");
  await user.click(screen.getByRole("button", { name: "Clear search" }));
  const params = new URLSearchParams(window.location.search);
  expect(params.get("view")).toBe("resolved");
  expect(params.get("owner")).toBe("Finance");
  expect(params.get("type")).toBe("unallocated_payment");
});

it("searches reconciliation by a linked payment reference, resets pages and preserves the view", async () => {
  const proposal = api
    .state()
    .records.find((r) => r.kind === "allocations" && r.status === "proposed")!;
  const payment = api
    .state()
    .records.find((r) => r.id === proposal.data.paymentId)!;
  const user = userEvent.setup();
  renderApp("/reconciliation?view=review&proposals-page=9&payments-page=7");
  await screen.findByRole("button", { name: "Confirm match" });
  await user.type(
    screen.getByLabelText("Search reconciliation"),
    payment.reference,
  );
  await user.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() =>
    expect(
      api.calls.some(
        (c) =>
          c.path === "/v1/reconciliation/proposals" &&
          c.query.q === payment.reference &&
          c.query.offset === "0",
      ),
    ).toBe(true),
  );
  await screen.findByRole("button", { name: "Confirm match" });
  await user.clear(screen.getByLabelText("Search reconciliation"));
  await user.type(
    screen.getByLabelText("Search reconciliation"),
    "nonexistent-search",
  );
  await user.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText("No matches to review for this search");
  expect(screen.queryByText("No matches to review")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Clear search" }));
  await screen.findByRole("button", { name: "Confirm match" });
  expect(new URLSearchParams(window.location.search).get("view")).toBe(
    "review",
  );
  expect(
    api.calls
      .filter((c) => c.path.startsWith("/v1/reconciliation/"))
      .every((c) => Number(c.query.limit) <= 100),
  ).toBe(true);
});

it("requests bounded history pages while keeping full balances and an off-page selected record", async () => {
  const customer = api.state().records.find((r) => r.kind === "customers")!;
  api.mutate((state) => {
    const base = state.records.find(
      (r) => r.kind === "due-items" && r.customerId === customer.id,
    )!;
    for (let i = 0; i < 65; i++)
      state.records.push({
        ...base,
        id: randomUUID(),
        name: "Paged instalment " + i,
        reference: "HISTORY-" + i,
        createdAt: new Date(Date.UTC(2024, 0, i + 1)).toISOString(),
      });
  });
  const full = customerTimeline(api.state(), customer.id);
  const selected = full.events.at(-1)!;
  const user = userEvent.setup();
  renderApp(
    `/customers/${customer.id}?record=${selected.id}&returnTo=${encodeURIComponent("/collections?view=overdue&lender=" + api.merchantIds[0])}`,
  );
  await screen.findByRole("heading", { name: customer.name });
  const selectedCard = screen.getByRole("region", {
    name: "Selected collection record",
  });
  expect(selectedCard.textContent).toContain(selected.reference);
  expect(
    screen.getByText(`${full.events.length} events in the full history`),
  ).toBeTruthy();
  const position = screen.getByRole("heading", {
    name: "Customer position",
  }).parentElement!;
  const before = position.textContent;
  expect(before).toContain(formatKobo(full.position.outstandingKobo));
  await user.click(
    screen.getByRole("button", { name: "Next page of history events" }),
  );
  await waitFor(() =>
    expect(
      within(
        screen.getByRole("navigation", { name: "history events pagination" }),
      ).getByText(/26–50 of/),
    ).toBeTruthy(),
  );
  expect(position.textContent).toBe(before);
  expect(
    screen.getByRole("region", { name: "Selected collection record" })
      .textContent,
  ).toContain(selected.reference);
  const calls = api.calls.filter((c) => c.path.endsWith("/history"));
  expect(calls.some((c) => c.query.eventsOffset === "25")).toBe(true);
  expect(
    calls.every(
      (c) => c.query.eventsLimit === "25" && c.query.dueItemsLimit === "25",
    ),
  ).toBe(true);
  expect(api.calls.some((c) => c.path.endsWith("/timeline"))).toBe(false);
  expect(
    screen
      .getByRole("link", { name: "Back to Collections" })
      .getAttribute("href"),
  ).toBe("/collections?view=overdue&lender=" + api.merchantIds[0]);
});
