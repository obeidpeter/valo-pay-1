import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor } from "./harness";
import { lenderModeLabel } from "@/components/layout";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

/** Serves the fake API's workspace as signed in, and as a staff pilot's when `staff` is set. */
function signedIn(staff = false) {
  const send = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const response = await send(input, options);
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    if (new URL(url, "http://localhost").pathname !== "/api/v1/workspace") return response;
    const workspace = await response.json();
    return new Response(JSON.stringify({ ...workspace, authenticated: true, ...(staff ? { accessMode: "staff" } : {}) }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

describe("layout", () => {
  it("loads the first lender and switches to the second", async () => {
    const user = userEvent.setup();
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Operations overview" });
    const [first, second] = api.merchantIds as [string, string];
    expect(api.calls.some((call) => call.path === "/v1/overview" && call.query.merchantId === first)).toBe(true);
    expect(api.calls.some((call) => call.path === "/v1/overview" && call.query.merchantId === second)).toBe(false);
    // The place is named once, in the sidebar: the sandbox for a visitor without an account.
    expect(screen.getByRole("complementary", { name: "Sidebar" }).textContent).toContain("Sandbox");
    expect(screen.getByText('Demo role:', { exact: false })).toBeTruthy();
    // The lender's observation mode, in plain words.
    expect(screen.getByText('Records payments only', { selector: 'strong' })).toBeTruthy();
    // In the sandbox the role is a demo role, and the bar links to where it is changed.
    expect(screen.getByRole('link', { name: 'Change demo role' }).getAttribute('href')).toBe('/settings#persona');

    // The lender selector exists twice in the document (phone bar and sidebar); the browser shows one. Either changes the lender for both.
    await user.selectOptions(screen.getAllByLabelText("Active lender")[0]!, second);
    await waitFor(() => expect(api.calls.some((call) => call.path === "/v1/overview" && call.query.merchantId === second)).toBe(true));
    await waitFor(() => expect(document.title).toBe("Overview · Valo Pay"));
  });

  it("navigates between pages from the sidebar", async () => {
    const user = userEvent.setup();
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Operations overview" });
    await user.click(screen.getByRole("link", { name: /Audit log/ }));
    expect(await screen.findByRole("button", { name: /Check audit log/ })).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Audit log · Valo Pay"));
    // The brand in the sidebar and in the phone bar leads back to the landing page, the same lockup as on it.
    const brands = screen.getAllByRole("link", { name: /Go to home page/ });
    expect(brands).toHaveLength(2);
    expect(brands.every((link) => link.getAttribute("href") === "/")).toBe(true);
  });

  it("opens Settings at the demo role control from the bar's Change demo role", async () => {
    const user = userEvent.setup();
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Operations overview" });
    await user.click(screen.getByRole("link", { name: "Change demo role" }));
    const control = await screen.findByLabelText("Demo role", { selector: "select" });
    await waitFor(() => expect(document.activeElement).toBe(control));
  });

  it("offers no demo role link to a staff pilot, whose role is not a demo role", async () => {
    api.role = "Finance";
    signedIn(true);
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Operations overview" });
    expect(document.querySelector("#main .workspace-bar")!.textContent).toContain("Role: Finance");
    expect(screen.queryByRole("link", { name: "Change demo role" })).toBeNull();
  });

  it("names each lender mode in plain words", () => {
    expect(lenderModeLabel("observation")).toBe("Records payments only");
    expect(lenderModeLabel("instruction")).toBe("Instructions after go-live");
    expect(lenderModeLabel("some_new_mode")).toBe("Some new mode");
  });
});
