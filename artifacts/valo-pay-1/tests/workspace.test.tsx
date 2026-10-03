import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryClient } from "@/App";
import { WORKSPACE_REFRESH_MS, retryAfterMs, workspaceRefreshInterval, workspaceRefreshOnFocus } from "@/lib/query-retry";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, within, waitFor } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

const workspace = /^\/v1\/workspace$/;

describe("workspace", () => {
  it("says what is happening until the workspace arrives", async () => {
    renderApp("/overview");
    expect(screen.getByRole("status").textContent).toBe("Loading your workspace…");
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(screen.queryByText("Loading your workspace…")).toBeNull();
  });

  it("passes on the service's own words when it asks the visitor to wait, and tries again on request", async () => {
    const user = userEvent.setup();
    api.failNext(workspace, { status: 429, error: "Too many new sandboxes were started from your network in the last hour. Try again in an hour." });
    renderApp("/overview");
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { level: 1, name: "Please wait before trying again" })).toBeTruthy();
    expect(within(alert).getByText("Too many new sandboxes were started from your network in the last hour. Try again in an hour.")).toBeTruthy();
    // It claims nothing about what changed: a change saved just before is checked in Request history.
    expect(within(alert).getByText("If you had just saved a change, check Request history once your workspace opens, before you send it again.")).toBeTruthy();
    expect(screen.queryByText(/No lender data has been changed/)).toBeNull();
    // The console is not shown without a workspace; the frame offers the start, twice, and the page says so in its title.
    expect(screen.queryByRole("link", { name: /Audit log/ })).toBeNull();
    expect(screen.getAllByRole("link", { name: "Back to home" }).map((link) => link.getAttribute("href"))).toEqual(["/", "/"]);
    await waitFor(() => expect(document.title).toBe("Workspace unavailable · Valo Pay 1"));

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(api.calls.filter((call) => call.path === "/v1/workspace").map((call) => call.status)).toEqual([429, 200]);
    await waitFor(() => expect(document.title).toBe("Overview · Valo Pay 1"));
  });

  it("says when the service could not be reached at all", async () => {
    api.failNext(workspace, "offline");
    renderApp("/overview");
    expect(await screen.findByRole("heading", { level: 1, name: "We could not load your workspace" })).toBeTruthy();
    expect(screen.getByText("Valo Pay 1 could not be reached. Check your connection and try again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("keeps a service error's internals to itself and gives the time for a report", async () => {
    api.failNext(workspace, { status: 500, error: "relation \"valopay_workspaces\" does not exist" });
    renderApp("/overview");
    expect(await screen.findByRole("heading", { level: 1, name: "We could not load your workspace" })).toBeTruthy();
    expect(screen.getByText(/When reporting the problem, include this time and support reference:/)).toBeTruthy();
    expect(screen.getByText(/^fake-[0-9a-f]{4}$/)).toBeTruthy();
    expect(screen.queryByText(/valopay_workspaces/)).toBeNull();
  });
});

/** Refreshes the workspace in the background, as its thirty-second timer does. */
async function refreshWorkspace() {
  await act(async () => { await queryClient.refetchQueries({ queryKey: ["workspace"] }); });
}
const refreshNotice = () => (screen.queryByText("We could not refresh your workspace.")?.closest('[role="status"]') ?? null) as HTMLElement | null;

describe("a failed background refresh of the workspace", () => {
  it("keeps the page and an open draft, says the workspace could not be refreshed and points to Request history", async () => {
    const user = userEvent.setup();
    renderApp("/customers");
    await screen.findByText("Ada Okonkwo");
    await user.click(screen.getByRole("button", { name: "Add customer" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Full name/), "Draft customer");
    api.failNext(workspace, "offline");
    await refreshWorkspace();
    const notice = await waitFor(() => { const found = refreshNotice(); expect(found).toBeTruthy(); return found!; });
    expect(notice.textContent).toMatch(/Valo Pay 1 could not be reached\. Showing the workspace loaded \d{1,2} \w{3,4} \d{4}, \d{2}:\d{2} WAT\./);
    expect(within(notice).getByRole("link", { name: "Request history" }).getAttribute("href")).toBe("/operations");
    // The dialog and its draft are the same elements as before the refresh.
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect((within(dialog).getByLabelText(/^Full name/) as HTMLInputElement).value).toBe("Draft customer");
    expect(screen.queryByRole("heading", { name: "We could not load your workspace" })).toBeNull();
    expect(screen.queryByText(/No lender data has been changed/)).toBeNull();
    // The dialog is modal, so the notice's Try again waits behind it; the next automatic refresh clears the notice.
    await refreshWorkspace();
    await waitFor(() => expect(refreshNotice()).toBeNull());
    expect((within(dialog).getByLabelText(/^Full name/) as HTMLInputElement).value).toBe("Draft customer");
    expect(api.calls.filter((call) => call.path === "/v1/workspace").map((call) => call.status)).toEqual([200, 0, 200]);
  });

  it("keeps a save whose outcome is unconfirmed, with its retry, through a failed refresh", async () => {
    const user = userEvent.setup();
    renderApp("/customers");
    await screen.findByText("Ada Okonkwo");
    await user.click(screen.getByRole("button", { name: "Add customer" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Full name/), "Lost answer customer");
    await user.type(within(dialog).getByLabelText(/^Loan software reference/), "LOST-ANSWER-1");
    await user.type(within(dialog).getByLabelText(/^Consent source or reference/), "Synthetic signed form LOST-1");
    api.failNext(/^\/v1\/records\/customers$/, "offline", "POST");
    await user.click(within(dialog).getByRole("button", { name: "Add customer" }));
    await within(dialog).findByText("Request not confirmed");
    api.failNext(workspace, { status: 502, error: "Bad gateway" });
    await refreshWorkspace();
    await waitFor(() => expect(refreshNotice()).toBeTruthy());
    expect(refreshNotice()!.textContent).toMatch(/Valo Pay 1 could not answer\. Support reference: fake-\w+\./);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByText("Request not confirmed")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Check original request" })).toBeTruthy();
  });

  it("passes on a 429's own words, says when the next automatic refresh is, and tries again on request", async () => {
    const user = userEvent.setup();
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    api.failNext(workspace, { status: 429, error: "Too many requests. Try again in 1 minute.", headers: { "Retry-After": "120" } });
    await refreshWorkspace();
    await waitFor(() => expect(refreshNotice()).toBeTruthy());
    expect(refreshNotice()!.textContent).toContain("Too many requests. Try again in 1 minute.");
    expect(refreshNotice()!.textContent).toMatch(/The next automatic refresh is after \d{1,2} \w{3,4} \d{4}, \d{2}:\d{2} WAT\./);
    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Please wait before trying again" })).toBeNull();
    await user.click(within(refreshNotice()!).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(refreshNotice()).toBeNull());
    expect(api.calls.filter((call) => call.path === "/v1/workspace").map((call) => call.status)).toEqual([200, 429, 200]);
  });

  it("waits as long as the service asks before refreshing again, and every thirty seconds otherwise", () => {
    const at = Date.parse("2026-09-23T10:00:00.000Z");
    const refused = (headers: Record<string, string>, status = 429) => ({ state: { status: "error", errorUpdatedAt: at, error: { status, headers: new Headers(headers) } } });
    expect(retryAfterMs({ headers: new Headers({ "Retry-After": "120" }) })).toBe(120_000);
    expect(retryAfterMs({ headers: new Headers({ "Retry-After": "Wed, 23 Sep 2026 10:05:00 GMT" }) }, at)).toBe(300_000);
    expect(retryAfterMs({ headers: new Headers() })).toBeUndefined();
    expect(retryAfterMs(new TypeError("Failed to fetch"))).toBeUndefined();
    expect(workspaceRefreshInterval({ state: { status: "success", errorUpdatedAt: 0, error: null } }, at)).toBe(WORKSPACE_REFRESH_MS);
    expect(workspaceRefreshInterval(refused({}), at)).toBe(WORKSPACE_REFRESH_MS);
    expect(workspaceRefreshInterval(refused({ "Retry-After": "120" }), at)).toBe(120_000);
    expect(workspaceRefreshInterval(refused({ "Retry-After": "120" }), at + 100_000)).toBe(WORKSPACE_REFRESH_MS);
    expect(workspaceRefreshInterval(refused({ "Retry-After": "5" }), at)).toBe(WORKSPACE_REFRESH_MS);
    expect(workspaceRefreshInterval(refused({ "Retry-After": "90" }, 503), at)).toBe(90_000);
    // Returning to the tab does not refresh early either.
    expect(workspaceRefreshOnFocus(refused({ "Retry-After": "120" }), at + 60_000)).toBe(false);
    expect(workspaceRefreshOnFocus(refused({ "Retry-After": "120" }), at + 120_000)).toBe(true);
    expect(workspaceRefreshOnFocus(refused({}), at)).toBe(true);
  });
});
