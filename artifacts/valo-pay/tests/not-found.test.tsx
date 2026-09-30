import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("not found", () => {
  it("answers an address the console has no page for, without creating a sandbox", async () => {
    const user = userEvent.setup();
    renderApp("/reportz");
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
    expect(screen.getByText("/reportz")).toBeTruthy();
    expect(screen.getByText("Nothing has changed.")).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Page not found · Valo Pay"));
    expect(screen.getByRole("link", { name: "Open Overview" }).getAttribute("href")).toBe("/overview");
    expect(screen.getAllByRole("link", { name: "Back to home" }).map((link) => link.getAttribute("href"))).toEqual(["/", "/"]);
    // No sidebar and no workspace request: the console was never mounted.
    expect(screen.queryByRole("link", { name: /Audit log/ })).toBeNull();
    expect(api.calls).toEqual([]);

    await user.click(screen.getByRole("link", { name: "Open Overview" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(api.calls.some((call) => call.path === "/v1/workspace")).toBe(true);
  });

  it("treats an address below a known page the same way", async () => {
    renderApp("/customers/abc/def");
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
    expect(api.calls).toEqual([]);
  });
});
