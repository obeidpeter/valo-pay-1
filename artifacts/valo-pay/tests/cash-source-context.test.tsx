import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, within } from "./harness";
import { makeRecord } from "../../api-server/src/domain/records";
import { runCashAction } from "../../api-server/src/domain/connected-cash-service";
import type { CashAccount } from "../../api-server/src/domain/connected-cash";

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi({ role: "Operations", now: "2026-09-21T10:00:00Z" });
  api.mutate((state) => {
    makeRecord(state, "connected-consents", {
      status: "active",
      createdAt: api.now,
      data: {
        purpose: "merchant_account_read",
        version: 1,
        subjectId: "sme",
        entityId: `${state.merchant.id}:sme`,
        expiresAt: "2026-10-21T10:00:00Z",
      },
    });
    runCashAction(state, { role: "Operations", actor: "Sandbox Operations", now: api.now }, {
      action: "cash.initialize", data: {}, reason: "Prepare synthetic source context",
    });
  });
});
afterEach(() => api.uninstall());

function updateAccounts(change: (accounts: CashAccount[]) => void) {
  api.mutate((state) => {
    const workspace = state.records.find((record) => record.kind === "connected-cash-workspace")!;
    change(workspace.data.workspace.accounts);
  });
}

function metric(name: string) {
  return within(screen.getByText(name, { exact: true }).parentElement!);
}

describe("Cash balance source context", () => {
  it("distinguishes bank timestamps from retrieval near balances and names each source definition", async () => {
    updateAccounts((accounts) => {
      accounts[0].balanceAsOf = "2026-09-21T09:30:00Z";
      accounts[0].fetchedAt = "2026-09-21T09:58:00Z";
      accounts[1].fetchedAt = "2026-09-21T09:59:00Z";
    });
    renderApp("/cash-desk");
    const context = await screen.findByRole("region", { name: "Sample balance sources" });
    expect(within(context).getByText("No source warnings reported")).toBeTruthy();
    expect(within(context).getByText("2 business accounts included")).toBeTruthy();
    expect(within(context).getByText("Oldest sample bank timestamp")).toBeTruthy();
    expect(within(context).getByText("21 Sept 2026, 10:30 WAT")).toBeTruthy();
    expect(within(context).getByText("Latest retrieval time")).toBeTruthy();
    expect(within(context).getByText("21 Sept 2026, 10:59 WAT")).toBeTruthy();
    expect(within(context).getByText(/A later retrieval does not make an older bank balance current/)).toBeTruthy();
    expect(screen.getAllByText("Bank-reported booked and available balance")).toHaveLength(2);
    expect(screen.getAllByText("Complete in this sample")).toHaveLength(2);
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("keeps stale and partial-source warnings visible even when the source was retrieved just now", async () => {
    updateAccounts((accounts) => {
      accounts[0].balanceAsOf = "2026-09-20T10:00:00Z";
      accounts[0].fetchedAt = api.now;
      accounts[0].coverageComplete = false;
      accounts[0].availableMinor = null;
      accounts[0].pendingMinor = null;
    });
    renderApp("/cash-desk");
    const context = await screen.findByRole("region", { name: "Sample balance sources" });
    expect(within(context).getByText("Review source limits")).toBeTruthy();
    expect(within(context).getByText("One or more bank balances are stale.")).toBeTruthy();
    expect(within(context).getByText("Transaction coverage has gaps; this is not a completed close.")).toBeTruthy();
    expect(within(context).getByText("Available balance is not supplied for every account.")).toBeTruthy();
    expect(within(context).getByText("20 Sept 2026, 11:00 WAT")).toBeTruthy();
    expect(within(context).getByText("21 Sept 2026, 11:00 WAT")).toBeTruthy();
    expect(within(context).queryByText("No source warnings reported")).toBeNull();
    expect(screen.getByText("Partial — some transactions may be missing")).toBeTruthy();
    expect(metric("Available cash").getByText("Unavailable")).toBeTruthy();
    expect(metric("Available cash").queryByText("₦0.00")).toBeNull();
    const account = screen.getByRole("heading", { name: /Operating account/ }).closest("article")!;
    expect(within(account).getAllByText("Unavailable")).toHaveLength(2);
  });

  it("does not present an omitted account total as zero after read permission is withdrawn", async () => {
    api.mutate((state) => {
      state.records.find((record) => record.kind === "connected-consents")!.status = "revoked";
    });
    renderApp("/cash-desk");
    const context = await screen.findByRole("region", { name: "Sample balance sources" });
    expect(within(context).getByText("No account balances are available for this view.")).toBeTruthy();
    expect(within(context).getAllByText("Unavailable")).toHaveLength(2);
    expect(within(context).getByText(/2 accounts omitted/)).toBeTruthy();
    expect(metric("Booked cash").getByText("Unavailable")).toBeTruthy();
    expect(metric("Available cash").getByText("Unavailable")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Operating account/ })).toBeNull();
  });

  it("preserves genuine reported zero balances and provides a route to accounting without implying posting", async () => {
    updateAccounts((accounts) => accounts.forEach((account) => {
      account.bookedMinor = 0;
      account.availableMinor = 0;
      account.pendingMinor = 0;
    }));
    const user = userEvent.setup();
    renderApp("/cash-desk");
    await screen.findByRole("region", { name: "Sample balance sources" });
    expect(metric("Booked cash").getByText("₦0.00")).toBeTruthy();
    expect(metric("Available cash").getByText("₦0.00")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Review accounting drafts" });
    expect(link.getAttribute("href")).toBe("/cash-desk?view=accounting");
    expect(screen.getByText(/An accounting draft or export has not been posted/)).toBeTruthy();
    await user.click(link);
    expect(await screen.findByRole("heading", { name: "Receipts ready for Finance" })).toBeTruthy();
    expect(window.location.search).toBe("?view=accounting");
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });
});
