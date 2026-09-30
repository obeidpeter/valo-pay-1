import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    await user.click(toggle);
    await user.keyboard("{Escape}");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    await user.click(toggle);
    await user.tab();
    expect(document.activeElement).toBe(
      within(
        screen.getByRole("navigation", { name: "Mobile sections" }),
      ).getByRole("link", { name: "Workspaces" }),
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
    const tabs = screen.getByRole("tablist", { name: "Preview a workspace" });
    await user.click(within(tabs).getByRole("tab", { name: "Collections" }));
    for (const [key, name, path] of [
      ["{ArrowRight}", "Pay-by-bank", "/pay-by-bank"],
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
        .getByRole("link", { name: "Open full screen" })
        .getAttribute("href"),
    ).toBe("/cash-desk");
    await user.click(
      screen.getByRole("button", { name: "Load interactive preview" }),
    );
    expect(
      screen
        .getByTitle("Interactive Valo Pay cash desk preview — sample data")
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
      ["Pay-by-bank", "pay-by-bank"],
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
          .getByTitle(
            `Interactive Valo Pay ${name!.toLowerCase()} preview — sample data`,
          )
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
        name: "Collections, credit and cash. One clear workspace.",
      }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.title).toBe(
        "Valo Pay · Collections, credit and cash operations",
      ),
    );
    const lines = Array.from(screen.getByRole("main").querySelectorAll("p, h1"))
      .slice(0, 3)
      .map((node) => node.textContent ?? "");
    expect(lines[0]).toBe("Financial operations for Nigerian lenders and SMEs");
    expect(lines[2]).toMatch(/^We never hold money\./);
    expect(
      screen
        .getByRole("link", { name: "Skip to main content" })
        .getAttribute("href"),
    ).toBe("#main");
    expect(screen.getByText("Live operations are disabled")).toBeTruthy();
    expect(
      screen.getByText(
        "Illustrative sample workflows. No live bank connection or financial instruction.",
      ),
    ).toBeTruthy();
    const contact = screen
      .getAllByRole("link", { name: "Discuss a pilot" })
      .find((link) => link.getAttribute("href")?.startsWith("mailto:"));
    expect(contact?.getAttribute("href")).toMatch(
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
    await waitFor(() => expect(document.title).toBe("Overview · Valo Pay"));
  });
});
