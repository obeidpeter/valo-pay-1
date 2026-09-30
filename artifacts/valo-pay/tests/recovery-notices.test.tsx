// Backlog item UX-B02-X2 and decision 2: recovery stays manual, through Operations, and every notice about a change the
// operations journal records says so. A request the service received stays in Operations after its dialog is closed or
// the page reloaded, and the notice links there; the demo role switch, which the journal does not record, does not.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { queueExport } from "../../api-server/src/lib/export-jobs";
import { cancelInterrupted, unreceivedRecovery } from './unreceived-recovery';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); unreceivedRecovery(api); });
afterEach(() => api.uninstall());

const KEPT = "If the service received the request, it stays in Operations after you close this form or reload the page, where you can check it.";
/** Whether `notice` says the request stays in Operations and links there. */
function keptInOperations(notice: HTMLElement) {
  expect(notice.textContent).toContain(KEPT);
  expect(within(notice).getByRole("link", { name: "Open Operations" }).getAttribute("href")).toBe("/operations");
  return notice;
}
/** The export control's notice about a request whose outcome is unconfirmed. */
const exportNotice = () => screen.getByText(/^Other export requests wait until this one is confirmed/).parentElement as HTMLElement;
/** The alert holding `text`, which says the request stays in Operations and links there. */
const pointsToOperations = (text: string | RegExp) => keptInOperations(screen.getByText(text).closest('[role="alert"]') as HTMLElement);

describe("unconfirmed changes the journal records point to Operations", () => {
  it("in the record dialog, whose close confirmation says so too", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderApp("/customers");
    await screen.findByText("Ada Okonkwo");
    await user.click(screen.getByRole("button", { name: "Add customer" }));
    const dialog = await screen.findByRole("dialog", { name: "Add customer" });
    await user.type(within(dialog).getByLabelText(/^Full name/), "Lost answer customer");
    await user.type(within(dialog).getByLabelText(/^Loan software reference/), "LOST-ANSWER-1");
    await user.type(within(dialog).getByLabelText(/^Consent source or reference/), "Synthetic consent");
    api.failNext(/^\/v1\/records\/customers$/, "offline", "POST");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await within(dialog).findByText("Outcome not confirmed");
    const notice = pointsToOperations("Outcome not confirmed");
    expect(notice.textContent).not.toMatch(/not saved after closing or reloading/);
    await user.click(within(dialog).getAllByRole("button", { name: "Close" }).find((button) => button.textContent === "Close")!);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("If the service received the request, it stays in Operations, where you can check it before starting again."));
    expect(screen.getByRole("dialog", { name: "Add customer" })).toBe(dialog);
  });

  it("in the review dialog, whose close confirmation says so too", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderApp("/evidence");
    await user.click(await screen.findByRole("button", { name: "Record review" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Review notes" }), "Checked the sample mandates this fortnight.");
    api.failNext(/^\/v1\/records\/reviews$/, "offline", "POST");
    await user.click(within(dialog).getByRole("button", { name: "Record review" }));
    await within(dialog).findByText("Request not confirmed");
    pointsToOperations("Request not confirmed");
    await user.click(within(dialog).getAllByRole("button", { name: "Close" }).find((button) => button.textContent === "Close")!);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("If it arrived, it is listed in Request history."));
  });

  it("in the mandate dialog", async () => {
    const user = userEvent.setup();
    renderApp("/mandates");
    await user.click(await screen.findByRole("button", { name: "Create synthetic mandate" }));
    const dialog = await screen.findByRole("dialog", { name: "Create synthetic mandate" });
    await user.type(within(dialog).getByLabelText(/Mandate name/), "Lost answer mandate");
    await user.selectOptions(within(dialog).getByLabelText(/Customer/), api.state().records.find((r) => r.kind === "customers")!.id);
    await user.type(within(dialog).getByLabelText(/Debit limit/), "2000");
    await user.type(within(dialog).getByLabelText(/Provider reference/), "SYN-LOST-MANDATE");
    await user.type(within(dialog).getByLabelText(/Consent evidence reference/), "SYN-CONSENT-LOST");
    await user.selectOptions(within(dialog).getByLabelText(/^Policy/), api.state().records.find((r) => r.kind === "policies")!.id);
    api.failNext(/^\/v1\/records\/mandates$/, "offline", "POST");
    await user.click(within(dialog).getByRole("button", { name: "Create mandate" }));
    await screen.findByText("Mandate creation outcome unconfirmed");
    pointsToOperations("Mandate creation outcome unconfirmed");
  });

  it("in the export control, for a new export", async () => {
    const user = userEvent.setup();
    renderApp("/reports?view=billing");
    api.failNext(/^\/v1\/exports$/, "offline", "POST");
    await user.click(await screen.findByRole("button", { name: "Export billing CSV" }));
    await screen.findByRole("button", { name: "Check original request" });
    keptInOperations(exportNotice());
  });

  it("in the export control, for a retry of a saved export", async () => {
    const user = userEvent.setup();
    const id = api.mutate((state, ctx) => {
      const job = queueExport(state, ctx, { kind: "gate-pack", format: "pdf" }, "sample/private");
      const record = state.records.find((candidate) => candidate.id === job.id)!;
      record.status = "failed";
      record.data.lastError = "Generation could not finish.";
      return job.id;
    });
    renderApp(`/exports?job=${id}`);
    api.failNext(new RegExp(`^/v1/exports/${id}/retry$`), "offline", "POST");
    await user.click(await screen.findByRole("button", { name: "Retry export" }));
    await screen.findByRole("button", { name: "Check original request" });
    keptInOperations(exportNotice());
  });

  it("in the quick import", async () => {
    const user = userEvent.setup();
    renderApp("/collections");
    await user.click(await screen.findByRole("button", { name: "Import sample data" }));
    await user.selectOptions(screen.getByLabelText("Import as"), "customers");
    await user.click(screen.getByLabelText("CSV content"));
    await user.paste("row_id,name,consentProvenance\nr1,Lost answer import,Synthetic");
    await user.click(screen.getByRole("button", { name: "Check data" }));
    await screen.findByRole("heading", { name: "Check results" });
    api.failNext(/^\/v1\/imports$/, "offline", "POST");
    await user.click(screen.getByRole("button", { name: "Import data" }));
    await screen.findByText("Import outcome not confirmed");
    pointsToOperations("Import outcome not confirmed");
  });

  it("on Reports, for a daily close, but not for its refusal", async () => {
    const user = userEvent.setup();
    renderApp("/reports");
    api.failNext(/^\/v1\/actions$/, { status: 403, error: "Daily close requires the Operations role." }, "POST");
    await user.click(await screen.findByRole("button", { name: "Run daily close" }));
    const refused = (await screen.findByText("Daily close requires the Operations role.")).closest('[role="alert"]') as HTMLElement;
    expect(refused.textContent).not.toContain(KEPT);
    expect(within(refused).queryByRole("link", { name: "Open Operations" })).toBeNull();
    api.failNext(/^\/v1\/actions$/, "offline", "POST");
    await user.click(screen.getByRole("button", { name: "Run daily close" }));
    await screen.findByText(/We do not know yet whether Valo Pay ran this close/);
    pointsToOperations("Request not confirmed");
  });

  it("on Reconciliation, for a run", async () => {
    const user = userEvent.setup();
    renderApp("/reconciliation");
    api.failNext(/^\/v1\/actions$/, "offline", "POST");
    await user.click(await screen.findByRole("button", { name: "Run reconciliation" }));
    await screen.findByText("Reconciliation could not be completed");
    pointsToOperations("Reconciliation could not be completed");
  });

  it("on the audit log, for a check", async () => {
    const user = userEvent.setup();
    renderApp("/audit");
    api.failNext(/^\/v1\/actions$/, "offline", "POST");
    await user.click(await screen.findByRole("button", { name: "Check audit log" }));
    const toast = (await screen.findAllByText("Audit log could not be checked")).map((title) => title.closest("li")).find(Boolean) as HTMLElement;
    keptInOperations(toast);
    // The notice store outlives a render, so the notice is dismissed here rather than left for the next case.
    await user.click(within(toast).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText("Audit log could not be checked")).toBeNull());
  });

  it("in the settings notices for journaled actions, but not the demo role switch", async () => {
    const user = userEvent.setup();
    renderApp("/settings");
    await screen.findByText("07:00 WAT");
    // A settings save.
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const amount = screen.getByLabelText("Notification cost alert (₦ per collection)");
    await user.clear(amount);
    await user.type(amount, "10.29");
    api.failNext(/^\/v1\/settings$/, "offline", "PATCH");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Settings outcome unconfirmed");
    pointsToOperations("Settings outcome unconfirmed");
    // The live-instruction block test and the emergency stop.
    api.failNext(/^\/v1\/actions$/, "offline", "POST");
    await user.click(screen.getByRole("button", { name: "Test live-instruction block" }));
    await screen.findByText(/The block-test response is unconfirmed/);
    pointsToOperations(/The block-test response is unconfirmed/);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    for (const notice of [/The block-test response is unconfirmed/, "Settings outcome unconfirmed"]) {
      const alert = screen.getByText(notice).closest('[role="alert"]') as HTMLElement;
      await user.click(within(alert).getByRole("button", { name: "Discard original request" }));
      await waitFor(() => expect(screen.queryByText(notice)).toBeNull());
    }
    await cancelInterrupted(user);
    await user.type(screen.getByLabelText("Reason for changing the emergency stop"), "Stop sample operations for a review");
    api.failNext(/^\/v1\/actions$/, "offline", "POST");
    await user.click(screen.getByRole("button", { name: "Activate emergency stop" }));
    await screen.findByText(/The emergency-stop response is unconfirmed/);
    const stop = pointsToOperations(/The emergency-stop response is unconfirmed/);
    await user.click(within(stop).getByRole("button", { name: "Discard original request" }));
    await waitFor(() => expect(screen.queryByText(/The emergency-stop response is unconfirmed/)).toBeNull());
    // The role switch is not journaled: its notice keeps the retry and names no Operations.
    await user.selectOptions(screen.getByLabelText("Demo role"), "Finance");
    api.failNext(/^\/v1\/actions$/, "offline", "POST");
    await user.click(screen.getByRole("button", { name: "Switch role" }));
    const role = (await screen.findByText(/The role-change response is unconfirmed/)).closest('[role="alert"]') as HTMLElement;
    expect(role.textContent).not.toMatch(/Operations/);
    expect(within(role).queryByRole("link", { name: "Open Operations" })).toBeNull();
  });
});
