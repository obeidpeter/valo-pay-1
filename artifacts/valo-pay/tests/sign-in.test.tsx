import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor } from "./harness";

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi();
});
afterEach(() => api.uninstall());

// jsdom serves the console from localhost with no Clerk key, so there is no account to sign into (lib/auth.tsx).
describe("sign-in pages without Clerk", () => {
  it("says sign-in is unavailable on this host and offers the sandbox instead of a form", async () => {
    renderApp("/sign-in");
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Sign in",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Sign-in is unavailable here" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "You cannot sign in at this address. Open the sandbox to try Valo Pay without an account.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: /Open the sandbox/ })
        .getAttribute("href"),
    ).toBe("/overview");
    expect(
      screen
        .getAllByRole("link", { name: "Back to home" })
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/", "/"]);
    expect(screen.getByRole("heading", { name: "Why sign in?" })).toBeTruthy();
    expect(
      screen.getByText(
        /Live payments and bank connections are switched off, even when you sign in/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /do not connect real bank accounts, make lending decisions or move money/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Work you do in the sandbox is not copied to your workspace/,
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.title).toBe("Sign in · Valo Pay"),
    );
    expect(api.calls).toEqual([]);
  });

  it("says the same for creating an account", async () => {
    renderApp("/sign-up");
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Create an account",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "You cannot create an account at this address. Open the sandbox to try Valo Pay without an account.",
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Open the sandbox/ })
        .getAttribute("href"),
    ).toBe("/overview");
    await waitFor(() =>
      expect(document.title).toBe("Create an account · Valo Pay"),
    );
    expect(api.calls).toEqual([]);
  });

  it("explains the sandbox retention rule without creating a workspace or connecting a provider", async () => {
    const user = userEvent.setup();
    renderApp("/sign-in");
    const summary = await screen.findByText("How long is my workspace kept?");
    await user.click(summary);
    expect(summary.closest("details")?.open).toBe(true);
    expect(
      screen.getByText(
        /The sandbox is kept in this browser and may be deleted after 30 days/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /connect|authorise|pay|assess/i }),
    ).toBeNull();
    expect(api.calls).toEqual([]);
  });
});
