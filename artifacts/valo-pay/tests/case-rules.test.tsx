import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";

// The case form offers what coordinateCase accepts: only the assignee or an
// Admin changes a case someone holds, a case goes only to someone on the
// lender's case list, the follow-up is in the future and the next action and
// note are at least 3 characters. Its link opens this exception in Exceptions.
let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

const exception = () => api.state().records.find((r) => r.kind === "exceptions" && r.status === "open")!;
function assign(id: string, assignee: string, assigneeName: string) {
  api.mutate((state) => {
    const record = state.records.find((r) => r.id === id)!;
    record.status = "in_progress";
    record.data.case = { assignee, assigneeName, nextAction: "Check the payer", nextActionAt: "2030-01-01T09:00:00.000Z", evidenceIds: [] };
  });
}
const writes = () => api.calls.filter((call) => call.method !== "GET");
const leaving = () => {
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  return unload.defaultPrevented;
};

it("protects a follow-up-only edit on navigation and releases the guard when it is reverted", async () => {
  const user = userEvent.setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const item = exception();
  assign(item.id, "Sandbox Admin", "Sandbox Admin");
  renderApp(`/cases/${item.id}`);
  const followUp = await screen.findByLabelText<HTMLInputElement>("Follow-up time (WAT)");
  const original = followUp.value;
  expect(leaving()).toBe(false);
  fireEvent.change(followUp, { target: { value: "2030-01-02T11:30" } });
  expect(leaving()).toBe(true);
  await user.click(screen.getByRole("link", { name: "Back to Exceptions" }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(window.location.pathname).toBe(`/cases/${item.id}`);
  expect(followUp.value).toBe("2030-01-02T11:30");
  fireEvent.change(followUp, { target: { value: original } });
  expect(leaving()).toBe(false);
  fireEvent.change(followUp, { target: { value: "2030-01-02T11:30" } });
  confirm.mockReturnValue(true);
  await user.click(screen.getByRole("link", { name: "Back to Exceptions" }));
  await screen.findByRole("heading", { name: "Exceptions" });
  expect(window.location.pathname).toBe("/exceptions");
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(writes()).toEqual([]);
});

it("keeps a follow-up-only draft when refresh is cancelled and adopts the latest time on confirmed refresh", async () => {
  const user = userEvent.setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const item = exception();
  assign(item.id, "Sandbox Admin", "Sandbox Admin");
  renderApp(`/cases/${item.id}`);
  const followUp = await screen.findByLabelText<HTMLInputElement>("Follow-up time (WAT)");
  fireEvent.change(followUp, { target: { value: "2030-01-02T11:30" } });
  const reads = () => api.calls.filter((call) => call.method === "GET" && call.path === `/v1/pilot/cases/${item.id}`).length;
  const before = reads();
  await user.click(screen.getByRole("button", { name: "Refresh case" }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(reads()).toBe(before);
  expect(followUp.value).toBe("2030-01-02T11:30");
  api.mutate((state) => {
    state.records.find((record) => record.id === item.id)!.data.case.nextActionAt = "2030-01-03T12:00:00.000Z";
  });
  confirm.mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Refresh case" }));
  await waitFor(() => expect(followUp.value).toBe("2030-01-03T13:00"));
  expect(leaving()).toBe(false);
  fireEvent.change(followUp, { target: { value: "2030-01-04T13:00" } });
  expect(leaving()).toBe(true);
  fireEvent.change(followUp, { target: { value: "2030-01-03T13:00" } });
  expect(leaving()).toBe(false);
  expect(writes()).toEqual([]);
});

it("retains the follow-up draft and its guard when a confirmed refresh fails", async () => {
  const user = userEvent.setup();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const item = exception();
  assign(item.id, "Sandbox Admin", "Sandbox Admin");
  renderApp(`/cases/${item.id}`);
  const followUp = await screen.findByLabelText<HTMLInputElement>("Follow-up time (WAT)");
  fireEvent.change(followUp, { target: { value: "2030-01-02T11:30" } });
  api.failNext(/^\/v1\/pilot\/cases\//, { status: 503, error: "The case could not be refreshed. Try again." }, "GET");
  await user.click(screen.getByRole("button", { name: "Refresh case" }));
  await screen.findByText(/^The case could not be refreshed\. Try again\./);
  expect(followUp.value).toBe("2030-01-02T11:30");
  expect(leaving()).toBe(true);
  expect(writes()).toEqual([]);
});

it("keeps the default follow-up baseline stable as time passes and resets it after refresh", async () => {
  const user = userEvent.setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2029-01-01T08:00:00.000Z"));
  const item = exception();
  renderApp(`/cases/${item.id}`);
  const followUp = await screen.findByLabelText<HTMLInputElement>("Follow-up time (WAT)");
  expect(followUp.value).toBe("2029-01-02T09:00");
  clock.mockReturnValue(Date.parse("2029-01-01T10:00:00.000Z"));
  fireEvent.change(screen.getByPlaceholderText("Name, reference or record type"), { target: { value: "payment" } });
  expect(followUp.value).toBe("2029-01-02T09:00");
  expect(leaving()).toBe(false);
  await user.click(screen.getByRole("button", { name: "Refresh case" }));
  await waitFor(() => expect(followUp.value).toBe("2029-01-02T11:00"));
  expect(confirm).not.toHaveBeenCalled();
  expect(leaving()).toBe(false);
});

it("uses the saved follow-up as the new baseline, then guards further date-only edits", async () => {
  const user = userEvent.setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const item = exception();
  assign(item.id, "Sandbox Admin", "Sandbox Admin");
  renderApp(`/cases/${item.id}`);
  const followUp = await screen.findByLabelText<HTMLInputElement>("Follow-up time (WAT)");
  fireEvent.change(followUp, { target: { value: "2030-01-02T11:30" } });
  await user.type(screen.getByLabelText("Handover or progress note"), "Moved the follow-up after confirming availability.");
  await user.click(screen.getByRole("button", { name: "Save next step" }));
  await screen.findByText("Case saved. Its handover history is updated.");
  expect(writes().filter((call) => call.path === `/v1/pilot/cases/${item.id}`)).toHaveLength(1);
  expect(api.state().records.find((record) => record.id === item.id)?.data.case.nextActionAt).toBe("2030-01-02T10:30:00.000Z");
  expect(followUp.value).toBe("2030-01-02T11:30");
  expect(leaving()).toBe(false);
  fireEvent.change(followUp, { target: { value: "2030-01-03T11:30" } });
  expect(leaving()).toBe(true);
  fireEvent.change(followUp, { target: { value: "2030-01-02T11:30" } });
  expect(leaving()).toBe(false);
  await user.click(screen.getByRole("link", { name: "Back to Exceptions" }));
  await screen.findByRole("heading", { name: "Exceptions" });
  expect(confirm).not.toHaveBeenCalled();
});

it("explains that only the assignee or an Admin can change a case someone else holds", async () => {
  const item = exception();
  assign(item.id, "Sandbox Finance", "Sandbox Finance");
  api.role = "Operations";
  renderApp(`/cases/${item.id}`);
  const save = await screen.findByRole("button", { name: "Save next step" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  const reason = document.getElementById(save.getAttribute("aria-describedby")!)!;
  expect(reason.textContent).toBe("This case is assigned to Sandbox Finance. Only Sandbox Finance or an Admin can record its next step or hand it over.");
  expect((screen.getByLabelText("Next step") as HTMLInputElement).closest("fieldset")?.disabled).toBe(true);
  expect(writes()).toEqual([]);
});

it("lets an Admin hand over a case someone else holds, to a person on the lender's case list only", async () => {
  const user = userEvent.setup();
  const item = exception();
  assign(item.id, "Sandbox Finance", "Sandbox Finance");
  renderApp(`/cases/${item.id}`);
  const select = (await screen.findByLabelText("Assigned to")) as HTMLSelectElement;
  expect(select.disabled).toBe(false);
  expect([...select.options].map((option) => option.value)).toEqual(["Sandbox Admin", "Sandbox Operations", "Sandbox Finance", "Sandbox Compliance reviewer"]);
  expect(document.getElementById("case-assignee-help")?.textContent).toBe("Only people who can work on cases for this lender are listed. Read-only team members cannot be given a case.");
  await user.selectOptions(select, "Sandbox Operations");
  await user.type(screen.getByLabelText("Handover or progress note"), "Operations should call the payer.");
  await user.click(screen.getByRole("button", { name: "Save handover" }));
  await screen.findByText("Case saved. Its handover history is updated.");
  expect(api.state().records.find((r) => r.id === item.id)?.data.case).toMatchObject({ assignee: "Sandbox Operations", assigneeName: "Sandbox Operations" });
});

it("asks for a new assignee when the person holding the case can no longer work on cases", async () => {
  const user = userEvent.setup();
  const item = exception();
  assign(item.id, "Clerk:former-analyst", "Former analyst");
  renderApp(`/cases/${item.id}`);
  const select = (await screen.findByLabelText("Assigned to")) as HTMLSelectElement;
  const former = [...select.options].find((option) => option.value === "Clerk:former-analyst")!;
  expect(former.disabled).toBe(true);
  expect(former.textContent).toBe("Former analyst · can no longer work on cases");
  expect(document.getElementById("case-assignee-help")?.textContent).toBe("Former analyst can no longer work on cases for this lender. Choose who takes the case over.");
  expect((screen.getByRole("button", { name: "Save next step" }) as HTMLButtonElement).disabled).toBe(true);
  await user.selectOptions(select, "Sandbox Finance");
  expect((screen.getByRole("button", { name: "Save handover" }) as HTMLButtonElement).disabled).toBe(false);
  expect(writes()).toEqual([]);
});

it("names each missing or past value at its field before asking the service", async () => {
  const user = userEvent.setup();
  const item = exception();
  renderApp(`/cases/${item.id}`);
  const nextAction = await screen.findByLabelText("Next step");
  expect(document.getElementById("case-assignee-help")?.textContent).toBe("Claiming assigns this case to you. Once it is yours, you can hand it over.");
  const followUp = screen.getByLabelText("Follow-up time (WAT)");
  fireEvent.change(followUp, { target: { value: "2020-01-01T09:00" } });
  await user.type(nextAction, "ab");
  await user.click(screen.getByRole("button", { name: "Claim and save next step" }));
  expect(await screen.findByText("Check the 3 highlighted fields before saving.")).toBeTruthy();
  expect(screen.getByText("Enter the next step (at least 3 characters).")).toBeTruthy();
  expect(screen.getByText("Choose a follow-up time in the future. The exception deadline stays as it is.")).toBeTruthy();
  expect(screen.getByText("Enter a handover or progress note (at least 3 characters).")).toBeTruthy();
  expect(nextAction.getAttribute("aria-invalid")).toBe("true");
  expect(followUp.getAttribute("aria-describedby")).toBe("case-follow-up-help case-follow-up-error");
  expect(document.activeElement).toBe(nextAction);
  expect(writes()).toEqual([]);
  // Correcting a field clears its message, and the claim is then sent once.
  await user.type(nextAction, "c");
  expect(nextAction.getAttribute("aria-invalid")).toBeNull();
  fireEvent.change(followUp, { target: { value: "2030-01-01T09:00" } });
  await user.type(screen.getByLabelText("Handover or progress note"), "Checked the source reference.");
  await user.click(screen.getByRole("button", { name: "Claim and save next step" }));
  await screen.findByText("Case saved. Its handover history is updated.");
  expect(writes().map((call) => call.path)).toEqual([`/v1/pilot/cases/${item.id}`]);
});

it("opens this exception in Exceptions from its case, even when it is resolved", async () => {
  const user = userEvent.setup();
  const item = exception();
  api.mutate((state) => {
    const record = state.records.find((r) => r.id === item.id)!;
    record.status = "resolved";
    record.data.resolutionCode = "held_credit";
  });
  renderApp(`/cases/${item.id}`);
  const link = await screen.findByRole("link", { name: "Open Exceptions to resolve it" });
  expect(link.getAttribute("href")).toBe(`/exceptions?record=${item.id}&lender=${api.merchantIds[0]}#record-${item.id}`);
  await user.click(link);
  expect(await screen.findByText("Selected exception")).toBeTruthy();
  const row = await waitFor(() => { const found = document.getElementById(`record-${item.id}`); if (!found) throw new Error("row not shown"); return found; });
  expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(within(row).getByText(/Outcome:/)).toBeTruthy();
  // The queue comes back with its filters when asked for.
  await user.click(screen.getByRole("button", { name: "Show all exceptions" }));
  expect(await screen.findByRole("tablist", { name: "Exception filter" })).toBeTruthy();
  expect(new URLSearchParams(window.location.search).get("record")).toBeNull();
});
