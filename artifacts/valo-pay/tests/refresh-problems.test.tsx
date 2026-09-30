// A background refresh that fails keeps the figures already on the page (audit
// item 30): a small notice says they could not be refreshed and when they were
// last updated, and offers to try again. Only a first load that fails, with
// nothing to show, is a full error card.
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryClient } from "@/App";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi({ now: "2026-09-21T10:00:00.000Z" });
});
afterEach(() => api.uninstall());

const lastUpdated = /Showing (figures|settings|records|closes) last updated \d{1,2} \w{3,4} \d{4}, \d{2}:\d{2} WAT\./;
const text = (selector: string) => () => document.querySelector(selector)?.textContent;

describe("failed background refresh", () => {
  it.each([
    ["/overview", /^\/v1\/overview$/, "Overview", "The overview could not be refreshed.", text('section[aria-labelledby="overview-metrics-title"]')],
    ["/reports", /^\/v1\/reports$/, "Reports & analytics", "Reports could not be refreshed.", text('section[aria-label="Operational metrics"]')],
    ["/reports", /^\/v1\/close-history$/, "Reports & analytics", "The close history could not be refreshed.", text("#daily-closes")],
    ["/settings", /^\/v1\/settings$/, "Settings & administration", "Collection settings could not be refreshed.", () => screen.queryByRole("heading", { name: "Collection settings" })?.closest("section")?.textContent],
    ["/credit-desk", /^\/v1\/connected$/, "Credit Desk", "Credit Desk could not be refreshed.", text(".connected-page")],
    ["/pay-by-bank", /^\/v1\/connected$/, "Pay-by-bank", "Pay-by-bank could not be refreshed.", text(".connected-page fieldset")],
    ["/cash-desk", /^\/v1\/connected$/, "Cash Desk", "Cash Desk could not be refreshed.", text(".connected-page fieldset")],
    ["/connections", /^\/v1\/connected$/, "Permissions & readiness", "Permissions & readiness could not be refreshed.", text(".connected-page fieldset")],
  ])("%s keeps its figures when %s fails to refresh", async (route, request, heading, notice, figures) => {
    const user = userEvent.setup();
    renderApp(route);
    await screen.findByRole("heading", { name: heading, level: 1 });
    await waitFor(() => expect(screen.queryAllByText(/^Loading .*…$/)).toHaveLength(0));
    const before = figures();
    expect(before).toBeTruthy();
    api.failNext(request, { status: 503, error: "The service is busy. Try again in a moment." });
    await act(async () => { await queryClient.refetchQueries({ type: "active" }); });
    const status = (await screen.findByText(notice)).closest('[role="status"]') as HTMLElement;
    expect(status.textContent).toMatch(lastUpdated);
    expect(screen.queryByText(/^Unable to load/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // Only the notice was added: the cached figures are the ones shown before.
    expect(figures()?.replace(status.textContent!, "")).toBe(before);
    await user.click(within(status).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText(notice)).toBeNull());
    expect(figures()).toBe(before);
  });

  it("keeps a settings draft open when a refresh fails while it is edited", async () => {
    const user = userEvent.setup();
    renderApp("/settings");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.type(screen.getByLabelText("Lender contact details for customer notices"), " until Friday");
    api.failNext(/^\/v1\/settings$/, "offline");
    await act(async () => { await queryClient.refetchQueries({ type: "active" }); });
    await screen.findByText("Collection settings could not be refreshed.");
    expect(screen.getByDisplayValue(/until Friday$/)).toBeTruthy();
    expect(screen.queryByText("Unable to load collection settings")).toBeNull();
  });

  it("still shows the full problem when the first load fails", async () => {
    api.failNext(/^\/v1\/overview$/, { status: 503, error: "The service is busy. Try again in a moment." });
    renderApp("/overview");
    expect(await screen.findByText("We could not load the overview")).toBeTruthy();
    expect(screen.queryByText("The overview could not be refreshed.")).toBeNull();
  });
});
