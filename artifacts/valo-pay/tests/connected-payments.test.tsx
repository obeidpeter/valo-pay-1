import { afterEach, beforeEach, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, within, waitFor } from "./harness";
let api: FakeApi;
beforeEach(() => {
  api = installFakeApi({ now: "2026-09-21T10:00:00.000Z" });
});
afterEach(() => api.uninstall());
it("walks through authorisation, unconfirmed browser return and a canonical receipt", async () => {
  const user = userEvent.setup();
  renderApp("/pay-by-bank");
  await screen.findByRole("heading", { name: "Pay-by-bank", level: 1 });
  const due = api
    .state()
    .records.find((r) => r.reference === "DEMO-LOAN-1005")!;
  await user.selectOptions(
    screen.getByLabelText("Customer and instalment"),
    due.id,
  );
  await user.click(
    screen.getByRole("button", { name: /Create sample checkout/ }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Review & authorise" }),
  );
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/does not calculate or charge payment fees/)).toBeTruthy();
  await user.type(
    within(dialog).getByLabelText("Reason"),
    "Review sample payment details",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Confirm sample action" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Simulate browser return" }),
  );
  await waitFor(() =>
    expect(
      api.state().records.find((r) => r.kind === "connected-intents")?.status,
    ).toBe("pending"),
  );
  expect(screen.getByRole("heading", { name: "Await a verified receipt" })).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Payment steps" })).getByText("3. Verified receipt").closest("li")!.textContent).not.toContain("Recorded");
  expect(
    api
      .state()
      .records.filter(
        (r) => r.kind === "payments" && r.data.paymentMethod === "pay_by_bank",
      ),
  ).toHaveLength(0);
  await user.click(
    screen.getByRole("button", { name: "Simulate confirmed receipt" }),
  );
  await screen.findByRole("link", { name: "View reconciliation" });
  expect(screen.getByRole("heading", { name: "Receipt recorded for reconciliation" })).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Payment steps" })).getByText("3. Verified receipt").closest("li")!.textContent).toContain("Recorded");
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
it("records and revokes one purpose without pretending to connect a bank", async () => {
  const user = userEvent.setup();
  renderApp("/connections");
  await screen.findByRole("heading", {
    name: "Permissions & readiness",
    level: 1,
  });
  await user.selectOptions(
    screen.getByLabelText("Subject"),
    api.state().records.find((r) => r.kind === "customers")!.id,
  );
  await user.type(
    screen.getByLabelText("Reason for granting permission"),
    "Review a sample credit application",
  );
  await user.click(
    screen.getByRole("button", { name: "Grant sample permission" }),
  );
  const revoke = await screen.findByRole("button", {
    name: "Review revocation",
  });
  await user.click(revoke);
  const review = screen.getByRole("region", { name: "Permission to revoke" });
  expect(review.textContent).toContain("Read applicant accounts");
  expect(review.textContent).toContain("Other purposes stay unchanged");
  expect(document.activeElement).toBe(
    screen.getByLabelText("Reason for revoking permission"),
  );
  await user.type(
    screen.getByLabelText("Reason for revoking permission"),
    "Applicant withdrew this sample permission",
  );
  await user.click(screen.getByRole("button", { name: "Revoke permission" }));
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
  expect(await screen.findByText("We could not load pay-by-bank")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(
    await screen.findByRole("heading", { name: "Pay-by-bank", level: 1 }),
  ).toBeTruthy();
});
