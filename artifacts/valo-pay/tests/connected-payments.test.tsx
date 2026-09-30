import { afterEach, beforeEach, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, within, waitFor } from "./harness";
let api: FakeApi;
beforeEach(() => {
  api = installFakeApi({ now: "2026-09-21T10:00:00.000Z" });
});
afterEach(() => api.uninstall());
it("walks through authorisation, an unconfirmed return from the bank and a confirmed payment", async () => {
  const user = userEvent.setup();
  renderApp("/pay-by-bank");
  await screen.findByRole("heading", { name: "Pay by Bank", level: 1 });
  const due = api
    .state()
    .records.find((r) => r.reference === "DEMO-LOAN-1005")!;
  await user.selectOptions(
    screen.getByLabelText("Customer and instalment"),
    due.id,
  );
  await user.click(
    screen.getByRole("button", { name: /Create checkout/ }),
  );
  const authorise = await screen.findByRole("button", { name: "Simulate authorisation" });
  // The new checkout's status reads in the shared words, in the list, on the checkout and in its timeline.
  expect(screen.getAllByText("Awaiting authorisation")).toHaveLength(3);
  await user.click(authorise);
  const dialog = screen.getByRole("dialog", { name: "Simulate the customer’s authorisation?" });
  expect(within(dialog).getByText(/does not calculate or charge payment fees/)).toBeTruthy();
  expect(within(dialog).getByText(/Sample data only\. No money will move\./)).toBeTruthy();
  await user.type(
    within(dialog).getByLabelText("Reason"),
    "Review sample payment details",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Simulate authorisation" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Simulate return from bank" }),
  );
  await waitFor(() =>
    expect(
      api.state().records.find((r) => r.kind === "connected-intents")?.status,
    ).toBe("pending"),
  );
  expect(screen.getByRole("heading", { name: "Wait for the payment to be confirmed" })).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Checkout steps" })).getByText("3. Payment confirmed").closest("li")!.textContent).not.toContain("Recorded");
  expect(
    api
      .state()
      .records.filter(
        (r) => r.kind === "payments" && r.data.paymentMethod === "pay_by_bank",
      ),
  ).toHaveLength(0);
  await user.click(
    screen.getByRole("button", { name: "Simulate confirmed payment" }),
  );
  await screen.findByRole("link", { name: "Open Reconciliation" });
  expect(screen.getByRole("heading", { name: "Payment confirmed" })).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Checkout steps" })).getByText("3. Payment confirmed").closest("li")!.textContent).toContain("Recorded");
  expect(
    api
      .state()
      .records.filter(
        (r) => r.kind === "payments" && r.data.paymentMethod === "pay_by_bank",
      ),
  ).toHaveLength(1);
  expect(
    api.state().records.find((r) => r.id === due.id)!.data.outstandingKobo,
  ).toBe(0);
});
it("records and withdraws one purpose without pretending to connect a bank", async () => {
  const user = userEvent.setup();
  renderApp("/connections");
  await screen.findByRole("heading", {
    name: "Permissions and readiness",
    level: 1,
  });
  await user.selectOptions(
    screen.getByLabelText("Who it covers"),
    api.state().records.find((r) => r.kind === "customers")!.id,
  );
  await user.type(
    screen.getByLabelText("Reason for granting permission"),
    "Review a sample credit application",
  );
  await user.click(
    screen.getByRole("button", { name: "Grant permission" }),
  );
  const revoke = await screen.findByRole("button", {
    name: "Withdraw",
  });
  await user.click(revoke);
  const review = screen.getByRole("region", { name: "Permission to withdraw" });
  expect(review.textContent).toContain("Read applicant accounts");
  expect(review.textContent).toContain("Other purposes stay unchanged");
  expect(document.activeElement).toBe(
    screen.getByLabelText("Reason for withdrawing permission"),
  );
  await user.type(
    screen.getByLabelText("Reason for withdrawing permission"),
    "Applicant withdrew this sample permission",
  );
  await user.click(screen.getByRole("button", { name: "Withdraw permission" }));
  await waitFor(() =>
    expect(
      api.state().records.find((r) => r.kind === "connected-consents")?.status,
    ).toBe("revoked"),
  );
  expect(screen.getAllByText("Not enabled for live use").length).toBe(10);
});
it("shows request failures and keeps read-only actions disabled", async () => {
  api.failNext(/^\/v1\/connected$/, {
    status: 503,
    error: "Temporary connection failure",
  });
  renderApp("/pay-by-bank");
  expect(await screen.findByText("Unable to load Pay by Bank")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(
    await screen.findByRole("heading", { name: "Pay by Bank", level: 1 }),
  ).toBeTruthy();
});
it("shows a reason's minimum under the field and refuses a short one in the page's own words", async () => {
  const user = userEvent.setup();
  renderApp("/pay-by-bank");
  await screen.findByRole("heading", { name: "Pay by Bank", level: 1 });
  await user.click(screen.getByRole("button", { name: /Create checkout/ }));
  await user.click(await screen.findByRole("button", { name: "Cancel checkout" }));
  const dialog = screen.getByRole("dialog", { name: "Cancel this checkout?" });
  const reason = within(dialog).getByLabelText("Reason");
  expect(within(dialog).getByText("At least 8 characters. Saved in the audit log.")).toBeTruthy();
  const sent = () => api.calls.filter((c) => c.method === "POST" && c.path.includes("/connected/actions")).length;
  const before = sent();
  await user.type(reason, "Too sho");
  await user.click(within(dialog).getByRole("button", { name: "Cancel checkout" }));
  expect(within(dialog).getByText("Enter a reason (at least 8 characters).")).toBeTruthy();
  expect(reason.getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(reason);
  expect(sent()).toBe(before);
  await user.type(reason, "rt of time for this sample");
  await user.click(within(dialog).getByRole("button", { name: "Cancel checkout" }));
  await waitFor(() =>
    expect(api.state().records.find((r) => r.kind === "connected-intents")?.status).toBe("cancelled"),
  );
  expect(screen.getByRole("status").textContent).toContain("No money moved.");
});
