import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextCloseInstant } from "@workspace/valopay-schema";
import { makeRecord } from "../../api-server/src/domain";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("settings", () => {
  it('edits the notification cost in naira and sends exact kobo', async () => {
    const user = userEvent.setup();
    renderApp('/settings');
    await screen.findByText('07:00 WAT');
    expect(screen.getByText('₦8.00')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const amount = screen.getByRole('textbox', { name: 'Notification cost alert (₦ per collection)' });
    expect((amount as HTMLInputElement).value).toBe('8.00');
    await user.clear(amount); await user.type(amount, '1,000.50');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('₦1,000.50')).toBeTruthy();
    expect(api.state().settings.notificationCostAlertKobo).toBe(100050);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
  });

  it('keeps a retry action visible when collection settings fail to load', async () => {
    const user = userEvent.setup();
    api.failNext(/^\/v1\/settings$/, 'offline');
    renderApp('/settings');
    const error = await screen.findByText('Unable to load collection settings');
    await user.click(within(error.closest('[role="alert"]')!).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('07:00 WAT')).toBeTruthy();
    expect(screen.queryByText('Unable to load collection settings')).toBeNull();
  });

  it("edits the daily close time, and shows the server's rejection of an invalid one", async () => {
    const user = userEvent.setup();
    renderApp("/settings");
    expect(await screen.findByText("07:00 WAT")).toBeTruthy();
    expect(screen.getByText(/^Next daily close: /)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const input = screen.getByPlaceholderText("07:00");
    await user.clear(input);
    await user.type(input, "09:30");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("09:30 WAT")).toBeTruthy();
    const patch = api.calls.find((call) => call.method === "PATCH" && call.path === "/v1/settings");
    expect(patch?.body).toMatchObject({ closeTime: "09:30", scheduledCloseEnabled: true });
    expect(patch?.status).toBe(200);
    expect(api.state().settings.closeTime).toBe("09:30");
    expect(api.state().settings.nextCloseAt).toBe(nextCloseInstant(api.now, "09:30"));
    expect(screen.getByText("Settings saved")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const again = screen.getByPlaceholderText("07:00");
    await user.clear(again);
    await user.type(again, "25:00");
    await user.click(screen.getByRole("button", { name: "Save" }));
    // The console checks the format itself before asking the server, and says so at the field.
    expect(await screen.findByText("Enter the close time as HH:MM in West Africa Time, for example 07:00.")).toBeTruthy();
    expect(again.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(again);
    expect(api.calls.filter((call) => call.method === "PATCH" && call.path === "/v1/settings").length).toBe(1);
    // A refusal only the server can make is shown in the section, under the field it names.
    api.failNext(/^\/v1\/settings$/, { status: 400, error: "closeTime must be a WAT time as HH:MM, for example 07:00 (REC-01)." });
    await user.clear(again);
    await user.type(again, "10:00");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Settings not saved")).toBeTruthy();
    expect(screen.getByText("Enter the close time as HH:MM in West Africa Time, for example 07:00.")).toBeTruthy();
    expect(again.getAttribute("aria-describedby")).toBe("settings-closeTime-error");
    expect(api.state().settings.closeTime).toBe("09:30");
    expect(api.calls.filter((call) => call.method === "PATCH" && call.path === "/v1/settings").at(-1)?.status).toBe(400);
  });

  it("explains the Admin requirement before another persona starts editing", async () => {
    const user = userEvent.setup();
    api.role = "Finance";
    renderApp("/settings");
    await screen.findByText("07:00 WAT");
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(edit.getAttribute("aria-describedby")!)?.textContent).toBe("Requires Admin.");
    await user.click(edit);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(api.calls.some(call => call.path === '/v1/settings' && call.method === 'PATCH')).toBe(false);
  });

  it("lists what a hand-back will do before it is confirmed, then announces the result and shows the emergency stop on", async () => {
    const user = userEvent.setup();
    // Two instalments Valo Pay collects, one scheduled attempt, and a cutover contract naming the lender team as fallback.
    const [first, second] = api.mutate((state) => {
      const dues = state.records.filter((record) => record.kind === "due-items").slice(0, 2);
      for (const due of dues) due.data.owner = "valopay";
      state.records.find((record) => record.kind === "cutovers")!.data.fallbackOwner = "merchant_manual";
      makeRecord(state, "attempts", { name: "Scheduled retry", status: "scheduled", customerId: dues[0]!.customerId, amountKobo: dues[0]!.amountKobo, createdAt: api.now, data: { dueItemId: dues[0]!.id, number: 2, source: "valo" } });
      return dues.map((due) => due.id);
    });
    renderApp("/settings");
    await screen.findByText("07:00 WAT");
    expect(screen.queryByText(/Emergency stop active/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Return collection ownership" }));
    const dialog = await screen.findByRole("dialog", { name: "Return collection ownership" });
    const summary = within(dialog).getByRole("region", { name: "Hand-back summary" });
    // The consequences and the numbers are on screen before anything is confirmed.
    const figure = (term: string) => within(summary).getByText(term).nextElementSibling?.textContent;
    await waitFor(() => expect(figure("Instalments Valo Pay collects now")).toBe("2 instalments"));
    await waitFor(() => expect(figure("Scheduled attempts to cancel")).toBe("1 attempt"));
    await waitFor(() => expect(figure("Collection returns to")).toBe("Lender team"));
    expect(figure("Emergency stop")).toBe("Turns on for this lender");
    expect(summary.textContent).toContain("Every instalment Valo Pay collects returns to the lender team");
    expect(summary.textContent).toContain("Turn it off separately, in Emergency controls");
    expect(api.calls.some((call) => call.method === "POST" && call.path === "/v1/actions")).toBe(false);

    // The service still requires a reason.
    await user.click(within(dialog).getByRole("button", { name: "Return collection" }));
    expect(await within(dialog).findByText("Enter a reason. It is saved in the audit log.")).toBeTruthy();
    expect(api.calls.some((call) => call.method === "POST" && call.path === "/v1/actions")).toBe(false);
    await user.type(within(dialog).getByLabelText(/^Reason/), "Lender asked to take collection back");
    await user.click(within(dialog).getByRole("button", { name: "Return collection" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The result is announced with the service's own message and counts (a notice is also announced through a short-lived copy).
    expect(await screen.findAllByText("Collection ownership returned")).toBeTruthy();
    const [announced] = screen.getAllByText(/^Collection ownership returned to the configured fallback owner\./);
    expect(announced!.textContent).toContain("2 instalments returned to the lender team; 1 scheduled attempt cancelled.");
    expect(announced!.textContent).toContain("The emergency stop is now on for this lender.");
    // The page shows the stop on, and the service agrees.
    expect(await screen.findByText(/Emergency stop active/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn off emergency stop" })).toBeTruthy();
    const state = api.state();
    expect(state.merchant.killSwitch).toBe(true);
    expect(state.records.filter((record) => [first, second].includes(record.id)).map((record) => record.data.owner)).toEqual(["merchant_manual", "merchant_manual"]);
    expect(state.records.filter((record) => record.kind === "attempts" && record.status === "scheduled")).toEqual([]);
  });

  it("lifts the emergency stop at once in the sandbox, and says a pilot needs a second administrator", async () => {
    const user = userEvent.setup();
    api.mutate((state) => { state.merchant.killSwitch = true; });
    renderApp("/settings");
    expect(await screen.findByText(/In a pilot, turning the stop off needs a second administrator’s approval\. In this sandbox one person plays every role, so it takes effect at once\./)).toBeTruthy();
    await user.type(screen.getByLabelText("Reason for changing the emergency stop"), "The rehearsal incident is over.");
    await user.click(screen.getByRole("button", { name: "Turn off emergency stop" }));
    // The page says what the request did, in the service's words.
    expect((await screen.findByText("Lender emergency stop is off. No collection instruction was sent.")).getAttribute("role")).toBe("status");
    expect(api.state().merchant.killSwitch).toBe(false);
  });

  it("shows a pilot's request to lift the stop, which only another administrator approves", async () => {
    const user = userEvent.setup();
    // A staff workspace, signed in as one administrator; another asked to lift the stop.
    const send = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
      const response = await send(input, options);
      if (new URL(String(input instanceof Request ? input.url : input), "http://localhost").pathname !== "/api/v1/workspace") return response;
      return new Response(JSON.stringify({ ...(await response.json()), accessMode: "staff", actor: "Clerk:user_a" }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    api.mutate((state) => { state.merchant.killSwitch = true; state.settings.emergencyStopReleases = { lender: { requestedBy: "Clerk:user_b", requestedAt: api.now, reason: "The incident is closed.", policyId: null } }; });
    renderApp("/settings");
    expect(await screen.findByText(/Clerk:user_b asked to turn the emergency stop off on .*: “The incident is closed\.”\. The stop stays on until another administrator approves it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Turn off emergency stop|Ask to turn off emergency stop/ })).toBeNull();
    await user.type(screen.getByLabelText("Reason for changing the emergency stop"), "Checked the incident notes with Operations.");
    await user.click(screen.getByRole("button", { name: "Approve turning it off" }));
    await screen.findByText("Lender emergency stop is off. No collection instruction was sent.");
    expect(api.state().merchant.killSwitch).toBe(false);
    expect(api.state().settings.emergencyStopReleases).toBeUndefined();
    globalThis.fetch = send;
  });

  it("never offers a pilot administrator the approval of their own request to lift the stop", async () => {
    const send = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
      const response = await send(input, options);
      if (new URL(String(input instanceof Request ? input.url : input), "http://localhost").pathname !== "/api/v1/workspace") return response;
      return new Response(JSON.stringify({ ...(await response.json()), accessMode: "staff", actor: "Clerk:user_a" }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    api.mutate((state) => { state.merchant.killSwitch = true; state.settings.emergencyStopReleases = { lender: { requestedBy: "Clerk:user_a", requestedAt: api.now, reason: "The incident is closed.", policyId: null } }; });
    renderApp("/settings");
    expect(await screen.findByText("You asked for this, so another administrator must approve it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve turning it off" })).toBeNull();
    expect(screen.getByRole("button", { name: "Keep the stop on" })).toBeTruthy();
    globalThis.fetch = send;
  });
});
