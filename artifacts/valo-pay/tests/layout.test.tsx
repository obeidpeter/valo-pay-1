import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

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
    expect(screen.getByText('Watch only', { selector: 'strong' })).toBeTruthy();

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
});
