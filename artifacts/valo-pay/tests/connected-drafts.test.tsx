// The connected pages' forms are drafts like any other console form (audit
// item 30): leaving one typed but not sent asks first, and a draft that was
// sent, or put back as it was, lets the person leave without a question.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor } from "./harness";
import { makeRecord } from "../../api-server/src/domain/records";

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi({ now: "2026-09-21T10:00:00.000Z" });
});
afterEach(() => {
  api.uninstall();
  vi.restoreAllMocks();
});

const leave = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getAllByRole("link", { name: "Audit log" })[0]!);

describe("connected page drafts", () => {
  it.each([
    ["/credit-desk", "Credit Desk", "Reason for this assessment"],
    ["/pay-by-bank", "Pay by Bank", "Amount (₦)"],
    ["/cash-desk", "Cash Desk", "Planning buffer (₦)"],
    ["/connections", "Permissions and readiness", "Reason for granting permission"],
  ])("%s asks before a typed draft is left, and leaves once the person agrees", async (route, title, field) => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderApp(route);
    await screen.findByRole("heading", { name: title, level: 1 });
    await user.type(screen.getByLabelText(field), "5");
    await leave(user);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe(route);
    expect((screen.getByLabelText(field) as HTMLInputElement).value).toMatch(/5$/);
    confirm.mockReturnValue(true);
    await leave(user);
    await screen.findByRole("heading", { name: "Audit log", level: 1 });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("lets the person leave an untouched page, and a sent assessment releases its draft", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderApp("/credit-desk");
    await screen.findByRole("heading", { name: "Credit Desk", level: 1 });
    await user.clear(screen.getByLabelText("Loan amount (₦)"));
    await user.type(screen.getByLabelText("Loan amount (₦)"), "250000");
    await user.type(screen.getByLabelText("Reason for this assessment"), "Check the capacity for a larger sample loan");
    await user.click(screen.getByRole("button", { name: /Run assessment/ }));
    await screen.findByText(/Sample assessment saved as a new version/);
    // The inputs stay for the next run, and they are no longer a draft.
    expect((screen.getByLabelText("Loan amount (₦)") as HTMLInputElement).value).toBe("250000");
    await leave(user);
    await screen.findByRole("heading", { name: "Audit log", level: 1 });
    expect(confirm).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole("link", { name: "Cash Desk" })[0]!);
    await screen.findByRole("heading", { name: "Cash Desk", level: 1 });
    await leave(user);
    await screen.findByRole("heading", { name: "Audit log", level: 1 });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("releases a revocation reason the person cancelled, and a sent grant", async () => {
    api.role = "Operations";
    api.mutate((state) =>
      makeRecord(state, "connected-consents", {
        name: "Read business accounts",
        status: "active",
        createdAt: api.now,
        data: { purpose: "merchant_account_read", version: 1, subjectId: "sme", entityId: `${state.merchant.id}:sme`, expiresAt: "2026-10-21T10:00:00Z", authority: "simulated" },
      }),
    );
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderApp("/connections");
    await user.click(await screen.findByRole("button", { name: "Review revocation" }));
    await user.type(screen.getByLabelText("Reason for revoking permission"), "The SME withdrew this sample permission");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.selectOptions(screen.getByLabelText("Purpose"), "erp_draft");
    await user.type(screen.getByLabelText("Reason for granting permission"), "Prepare sample accounting drafts for the SME");
    await user.click(screen.getByRole("button", { name: "Grant sample permission" }));
    await screen.findByText("Sample permission recorded.");
    await waitFor(() => expect(api.state().records.filter((r) => r.kind === "connected-consents")).toHaveLength(2));
    await leave(user);
    await screen.findByRole("heading", { name: "Audit log", level: 1 });
    expect(confirm).not.toHaveBeenCalled();
  });
});
