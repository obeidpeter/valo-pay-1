import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("empty states", () => {
  it("says when nothing matches a search, as a status, and recovers when it is cleared", async () => {
    const user = userEvent.setup();
    renderApp("/customers");
    expect(await screen.findByText("Ada Okonkwo")).toBeTruthy();
    const search = screen.getByPlaceholderText("Search by name, reference or phone…");
    await user.type(search, "zzzz");
    const title = await screen.findByText("No customers match “zzzz”");
    const status = title.closest<HTMLElement>('[role="status"]')!;
    expect(within(status).getByText(/Check the spelling/)).toBeTruthy();
    await user.clear(search);
    expect(await screen.findByText("Ada Okonkwo")).toBeTruthy();
    expect(screen.queryByText("No customers match “zzzz”")).toBeNull();
    expect(screen.queryByText("Loading search results…")).toBeNull();
  });

  it("says the same for the audit log's search", async () => {
    const user = userEvent.setup();
    renderApp("/audit");
    await screen.findByRole("table");
    await user.type(screen.getByPlaceholderText("Search by action, person or summary…"), "nothing-like-this");
    const title = await screen.findByText("No entries match “nothing-like-this”");
    expect(title.closest('[role="status"]')).toBeTruthy();
  });

  it("says what would be in an empty table and where it comes from", async () => {
    api.mutate((state) => { state.records.splice(0, state.records.length, ...state.records.filter((record) => record.kind !== "due-items")); });
    renderApp("/collections");
    const title = await screen.findByText("No instalments recorded");
    expect(title.closest("tr")).toBeTruthy();
    expect(screen.getByText(/Open Import sample data to add synthetic instalments using a sample CSV/)).toBeTruthy();
  });

  it("offers the next step when a lender has none of something", async () => {
    api.mutate((state) => { state.records.splice(0, state.records.length, ...state.records.filter((record) => record.kind !== "mandates")); });
    renderApp("/mandates");
    expect(await screen.findByText("No mandates yet")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Create synthetic mandate" }).length).toBe(2);
  });

  it("marks a filtered view's emptiness as the result of the filter", async () => {
    const user = userEvent.setup();
    renderApp("/exceptions");
    await user.click(await screen.findByRole("tab", { name: /Resolved/ }));
    await waitFor(() => expect(screen.getByText("No resolved exceptions yet").closest('[role="status"]')).toBeTruthy());
  });
});
