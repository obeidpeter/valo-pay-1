// A button that removes itself must not leave focus on the page body, where
// a keyboard or screen-reader user starts again from the top: focus moves to
// the first field, back to the control that started the edit, or to the
// message that says what happened (audit of 23 September, item 6).
import { afterEach, beforeEach, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { queryClient } from "@/App";

let api: FakeApi;
beforeEach(() => { api = installFakeApi({ now: "2026-09-21T10:00:00.000Z" }); });
afterEach(() => api.uninstall());

it("moves focus into the settings form on Edit, and back to Edit after Cancel or Save", async () => {
  const user = userEvent.setup();
  renderApp("/settings");
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  expect(document.activeElement).toBe(screen.getByLabelText("Instruction approval"));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit" })));

  await user.click(screen.getByRole("button", { name: "Edit" }));
  const contact = screen.getByLabelText("Lender contact details for customer notices");
  await user.type(contact, " (updated)");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Settings saved");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit" })));
});

it("moves focus to the result when a pay-by-bank step removes its own button", async () => {
  const user = userEvent.setup();
  renderApp("/pay-by-bank");
  await screen.findByRole("heading", { name: "Pay by Bank", level: 1 });
  const due = api.state().records.find((record) => record.reference === "DEMO-LOAN-1005")!;
  await user.selectOptions(screen.getByLabelText("Customer and instalment"), due.id);
  await user.click(screen.getByRole("button", { name: /Create sample checkout/ }));
  await user.click(await screen.findByRole("button", { name: "Review & authorise" }));
  const dialog = screen.getByRole("dialog");
  await user.type(within(dialog).getByLabelText("Reason"), "Review sample payment details");
  await user.click(within(dialog).getByRole("button", { name: "Confirm sample action" }));
  await user.click(await screen.findByRole("button", { name: "Simulate browser return" }));
  const result = await screen.findByText(/^Browser return recorded\./);
  await waitFor(() => expect(document.activeElement).toBe(result));
  expect(screen.queryByRole("button", { name: "Simulate browser return" })).toBeNull();
});

it("moves focus to the page content when End presentation removes the guide", async () => {
  const user = userEvent.setup();
  renderApp("/presentation");
  await user.click(await screen.findByRole("button", { name: "Start presentation guide" }));
  const guide = screen.getByRole("region", { name: "Presentation guide" });
  await user.click(within(guide).getByRole("button", { name: "End presentation" }));
  expect(screen.queryByRole("region", { name: "Presentation guide" })).toBeNull();
  expect(document.activeElement).toBe(document.getElementById("main"));
});

it("moves focus to what Approve turning it off or Keep the stop on did when their box goes", async () => {
  const user = userEvent.setup();
  // A staff administrator, and another administrator's request to lift the lender's stop waiting.
  const send = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const response = await send(input, options);
    if (new URL(String(input instanceof Request ? input.url : input), "http://localhost").pathname !== "/api/v1/workspace") return response;
    return new Response(JSON.stringify({ ...(await response.json()), accessMode: "staff", actor: "Clerk:user_a" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const waiting = () => api.mutate((state) => { state.merchant.killSwitch = true; state.settings.emergencyStopReleases = { lender: { requestedBy: "Clerk:user_b", requestedAt: api.now, reason: "The incident is closed.", policyId: null } }; });
  waiting();
  renderApp("/settings");
  for (const [button, said] of [
    ["Approve turning it off", "Lender emergency stop is off. No collection instruction was sent."],
    ["Keep the stop on", "Lender emergency stop is on. No collection instruction was sent."],
  ] as const) {
    const pressed = await screen.findByRole("button", { name: button });
    await user.type(screen.getByLabelText("Reason for changing the emergency stop"), "Second administrator's decision on the request");
    await user.click(pressed);
    // The answer settles the request, so the box and the button go once the settings are read again.
    await waitFor(() => expect(pressed.isConnected).toBe(false));
    const result = screen.getByText(said);
    await waitFor(() => expect(document.activeElement).toBe(result));
    waiting();
    await queryClient.invalidateQueries();
  }
});
