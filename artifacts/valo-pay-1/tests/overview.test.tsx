import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen } from "./harness";
import { formatDate } from "@/lib/formatters";
import { executeAction } from "../../api-server/src/domain";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("overview", () => {
  it("shows the sandbox banner, the next scheduled close and the alerts the seeded lender carries", async () => {
    renderApp("/overview");
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(screen.getByText("Sample data only. Valo Pay 1 never holds money. Live payments and bank connections are switched off.")).toBeTruthy();
    const nextClose = String(api.state().settings.nextCloseAt);
    expect(screen.getByText(/Last daily close: Not closed yet/)).toBeTruthy();
    expect(screen.getByText(`Next daily close: ${formatDate(nextClose)}, then every day at this time.`)).toBeTruthy();
    // NFR-OBS-02: no close has run, and one seeded exception is past its deadline.
    expect(screen.getByText("No daily closes yet")).toBeTruthy();
    expect(screen.getByText("Exceptions past their deadline")).toBeTruthy();
    expect(screen.getByText("Reconciled collections")).toBeTruthy();
    expect(screen.getByText("Awaiting activation")).toBeTruthy();
  });

  it("clears the alerts once the books are closed and nothing is overdue", async () => {
    let closedAt = "";
    api.mutate((state, ctx) => {
      for (const exception of state.records.filter((record) => record.kind === "exceptions")) exception.data.dueBy = "2099-01-01T00:00:00.000Z";
      closedAt = String(executeAction(state, ctx, { action: "daily_close" }).record!.data.closedAt);
    });
    renderApp("/overview");
    expect(await screen.findByText(/No alerts need attention./)).toBeTruthy();
    expect(screen.getByText(new RegExp(`Last daily close: ${escape(formatDate(closedAt))}`))).toBeTruthy();
    expect(screen.queryByText("No daily closes yet")).toBeNull();
  });
});
