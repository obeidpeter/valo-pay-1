import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi();
});
afterEach(() => {
  api.uninstall();
  vi.unstubAllEnvs();
});

describe("landing page", () => {
  it("closes section navigation on Escape and focuses the chosen section", async () => {
    const user = userEvent.setup();
    renderApp("/");
    const toggle = screen.getByRole("button", { name: "Open menu" });
    await user.click(toggle);
    await user.keyboard("{Escape}");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    await user.click(toggle);
    await user.tab();
    expect(document.activeElement).toBe(
      within(
        screen.getByRole("navigation", { name: "Mobile sections" }),
      ).getByRole("link", { name: "Products" }),
    );
    await user.click(
      within(
        screen.getByRole("navigation", { name: "Mobile sections" }),
      ).getByRole("link", { name: "Common questions" }),
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(document.activeElement?.id).toBe("questions"));
    expect(api.calls).toEqual([]);
  });

  it("previews all four workspaces by keyboard without fetching or creating a sandbox", async () => {
    const user = userEvent.setup();
    renderApp("/");
    const tabs = screen.getByRole("tablist", { name: "Preview a product" });
    await user.click(within(tabs).getByRole("tab", { name: "Collections" }));
    for (const [key, name, path] of [
      ["{ArrowRight}", "Pay by Bank", "/pay-by-bank"],
      ["{ArrowRight}", "Credit Desk", "/credit-desk"],
      ["{End}", "Cash Desk", "/cash-desk"],
      ["{ArrowRight}", "Collections", "/overview"],
      ["{ArrowLeft}", "Cash Desk", "/cash-desk"],
      ["{Home}", "Collections", "/overview"],
    ]) {
      await user.keyboard(key!);
      const selected = within(tabs).getByRole("tab", { name: name! });
      expect(document.activeElement).toBe(selected);
      expect(selected.getAttribute("aria-selected")).toBe("true");
      const panel = screen.getByRole("tabpanel", { name: name! });
      expect(
        within(panel)
          .getByRole("link", { name: `Explore ${name}` })
          .getAttribute("href"),
      ).toBe(path);
      expect(
        document.getElementById(selected.getAttribute("aria-controls")!),
      ).toBe(panel);
    }
    expect(document.querySelector("iframe")).toBeNull();
    expect(api.calls).toEqual([]);
  });

  it("lets visitors choose before loading and close and reopen the actual console", async () => {
    const user = userEvent.setup();
    renderApp("/");
    await user.click(screen.getByRole("button", { name: /04 · Cash Desk/ }));
    expect(document.querySelector("iframe")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Open the full page" })
        .getAttribute("href"),
    ).toBe("/cash-desk");
    await user.click(
      screen.getByRole("button", { name: "Load interactive preview" }),
    );
    expect(
      screen
        .getByTitle("Interactive preview of Cash Desk, with sample data")
        .getAttribute("src"),
    ).toBe("/cash-desk?embedded=1");
    await user.click(screen.getByRole("button", { name: "Close preview" }));
    expect(document.querySelector("iframe")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Load interactive preview" }),
      ),
    );
    await user.click(
      screen.getByRole("button", { name: "Load interactive preview" }),
    );
    expect(document.querySelector("iframe")).toBeTruthy();
    expect(api.calls).toEqual([]);
  });

  it("keeps previews below a deployment base path and requires a new load after switching", async () => {
    vi.stubEnv("BASE_URL", "/preview/");
    const user = userEvent.setup();
    renderApp("/");
    for (const [name, route] of [
      ["Collections", "overview"],
      ["Pay by Bank", "pay-by-bank"],
      ["Credit Desk", "credit-desk"],
      ["Cash Desk", "cash-desk"],
    ]) {
      await user.click(
        screen.getByRole("button", { name: new RegExp(`0[1-4] · ${name}`) }),
      );
      expect(document.querySelector("iframe")).toBeNull();
      await user.click(
        screen.getByRole("button", { name: "Load interactive preview" }),
      );
      expect(
        screen
          .getByTitle(`Interactive preview of ${name}, with sample data`)
          .getAttribute("src"),
      ).toBe(`/preview/${route}?embedded=1`);
    }
    expect(api.calls).toEqual([]);
  });

  it("describes the expanded product and its limits without starting a workspace", async () => {
    renderApp("/");
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Collections, credit and cash. One clear view.",
      }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.title).toBe(
        "Valo Pay 1 · Collections, credit and cash operations",
      ),
    );
    const lines = Array.from(screen.getByRole("main").querySelectorAll("p, h1"))
      .slice(0, 3)
      .map((node) => node.textContent ?? "");
    expect(lines[0]).toBe(
      "Financial operations for Nigerian lenders and small businesses",
    );
    expect(lines[2]).toMatch(/^Valo Pay 1 never holds money\./);
    expect(
      screen
        .getByRole("link", { name: "Skip to main content" })
        .getAttribute("href"),
    ).toBe("#main");
    expect(
      screen.getByText("Live payments and bank connections are switched off"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Examples with sample data. Live payments and bank connections are switched off.",
      ),
    ).toBeTruthy();
    const contact = screen.getByRole("link", { name: "Email the Valo Pay 1 team" });
    expect(contact.getAttribute("href")).toMatch(
      /^mailto:pilots@example\.test\?subject=/,
    );
    for (const link of document.querySelectorAll<HTMLAnchorElement>(
      'a[href^="#"]',
    )) {
      expect(
        document.getElementById(link.hash.slice(1)),
        link.hash,
      ).toBeTruthy();
    }
    expect(api.calls).toEqual([]);
  });

  it("opens the sandbox only when the visitor chooses to", async () => {
    const user = userEvent.setup();
    renderApp("/");
    expect(api.calls).toEqual([]);
    await user.click(
      screen.getAllByRole("link", { name: /Open the sandbox/ })[0]!,
    );
    expect(
      await screen.findByRole("heading", { name: "Overview" }),
    ).toBeTruthy();
    expect(api.calls.some((call) => call.path === "/v1/workspace")).toBe(true);
    await waitFor(() => expect(document.title).toBe("Overview · Valo Pay 1"));
  });
});

describe("landing page for a signed-in visitor", () => {
  it("offers their workspace wherever a signed-out visitor is offered the sandbox", async () => {
    renderApp("/");
    // The header, the hero and the closing call to action.
    expect(
      screen.getAllByRole("link", { name: "Open the sandbox" }),
    ).toHaveLength(3);
    expect(
      screen.getByRole("navigation", { name: "Explore the sandbox" }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("banner")).getByRole("link", { name: "Sign in" }),
    ).toBeTruthy();
    cleanup();

    // The landing page ships with the shell, loaded before a test's own mock, so a fresh copy of it is given
    // the session Clerk has already reported: knowing who is signed in asks nothing of the network.
    vi.resetModules();
    vi.doMock("@/lib/auth", () => ({
      authEnabled: true,
      useSessionUser: () => ({ userId: "user_returning", isLoaded: true }),
      useSignOut: () => () => {},
      AuthShow: () => null,
      AuthProvider: ({ children }: { children: unknown }) => children,
      ClerkSlot: () => null,
      ClerkSignIn: () => null,
      ClerkSignUp: () => null,
      VerifiedSession: () => null,
    }));
    const { default: SignedInLanding } = await import("@/pages/landing");
    const view = render(<SignedInLanding />);
    const workspace = view.getAllByRole("link", { name: "Open your workspace" });
    expect(workspace).toHaveLength(3);
    expect(
      workspace.every((link) => link.getAttribute("href") === "/overview"),
    ).toBe(true);
    expect(view.queryByRole("link", { name: /Open the sandbox/ })).toBeNull();
    expect(
      view.getByRole("navigation", { name: "Explore your workspace" }),
    ).toBeTruthy();
    expect(
      within(view.getByRole("banner")).queryByRole("link", { name: "Sign in" }),
    ).toBeNull();
    // Nothing written for a visitor without an account: no Sign in anywhere, no "No sign-in needed".
    expect(view.queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(view.queryByText(/No sign-in/)).toBeNull();
    expect(
      view.getByText("Sample data is made up. It is not real customers or money."),
    ).toBeTruthy();
    expect(view.getByText("Sample data only.")).toBeTruthy();
    expect(api.calls).toEqual([]);

    // Signed out on a host where sign-in is available: the sandbox, and Sign in, as for any visitor.
    vi.resetModules();
    vi.doMock("@/lib/auth", () => ({
      authEnabled: true,
      useSessionUser: () => ({ userId: null, isLoaded: true }),
      useSignOut: () => () => {},
      AuthShow: () => null,
      AuthProvider: ({ children }: { children: unknown }) => children,
      ClerkSlot: () => null,
      ClerkSignIn: () => null,
      ClerkSignUp: () => null,
      VerifiedSession: () => null,
    }));
    const { default: SignedOutLanding } = await import("@/pages/landing");
    cleanup();
    const signedOut = render(<SignedOutLanding />);
    expect(signedOut.getAllByRole("link", { name: "Open the sandbox" })).toHaveLength(3);
    expect(signedOut.queryByRole("link", { name: /Open your workspace/ })).toBeNull();
    expect(within(signedOut.getByRole("banner")).getByRole("link", { name: "Sign in" })).toBeTruthy();
    // The header, the closing call to action and the footer.
    expect(signedOut.getAllByRole("link", { name: "Sign in" })).toHaveLength(3);
    expect(
      signedOut.getByText(/^No sign-in or bank connection needed\. Sample data is made up\./),
    ).toBeTruthy();
    expect(signedOut.getByText("No sign-in needed. Sample data only.")).toBeTruthy();
    expect(
      signedOut.getByText("No sign-in needed. The preview opens only when you choose."),
    ).toBeTruthy();
    expect(api.calls).toEqual([]);
    vi.doUnmock("@/lib/auth");
  });
});
