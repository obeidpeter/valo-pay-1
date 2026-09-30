import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("keyboard", () => {
  it("offers a skip to the page content as the first tab stop, and marks the current page", async () => {
    const user = userEvent.setup();
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    await user.tab();
    const skip = document.activeElement as HTMLElement;
    expect(skip.textContent).toBe("Skip to page content");
    await user.click(skip);
    expect(document.activeElement?.id).toBe("main");
    expect(screen.getByRole("link", { name: /Overview/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Audit log" }).getAttribute("aria-current")).toBeNull();
  });

  it("moves focus to the page content after navigating, as a page load would", async () => {
    const user = userEvent.setup();
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    await user.click(screen.getByRole("link", { name: "Audit log" }));
    await screen.findByRole("heading", { name: "Audit log" });
    await waitFor(() => expect(document.activeElement?.id).toBe("main"));
    expect(screen.getByRole("link", { name: "Audit log" }).getAttribute("aria-current")).toBe("page");
  });

  it("starts the next console page at the top of its scrolling region", async () => {
    const user = userEvent.setup();
    renderApp("/reports?view=billing");
    await screen.findByRole("heading", { name: "Reports & analytics" });
    await user.click(await screen.findByText("Billing rates & rules"));
    const main = screen.getByRole("main");
    // jsdom has no layout, but preserves offsets on the main element that survives navigation.
    main.scrollTop = 640;
    main.scrollLeft = 80;

    await user.click(screen.getByRole("link", { name: "Overview" }));
    await screen.findByRole("heading", { name: "Overview" });
    expect(screen.getByRole("main")).toBe(main);
    await waitFor(() => {
      expect(main.scrollTop).toBe(0);
      expect(main.scrollLeft).toBe(0);
      expect(document.activeElement).toBe(main);
    });
  });

  it("keeps same-page scroll and filter state when the shell rerenders", async () => {
    const user = userEvent.setup();
    renderApp("/exceptions");
    await user.click(await screen.findByRole("tab", { name: "High severity (1)" }));
    const main = screen.getByRole("main");
    main.scrollTop = 320;

    await user.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeTruthy();
    expect(main.scrollTop).toBe(320);
    expect(screen.getByRole("tab", { name: "High severity (1)" }).getAttribute("aria-selected")).toBe("true");
  });

  it("moves between the exception filter tabs with the arrow keys, one tab stop for the group", async () => {
    const user = userEvent.setup();
    renderApp("/exceptions");
    const open = await screen.findByRole("tab", { name: /All open/ });
    const high = screen.getByRole("tab", { name: /High severity/ });
    const resolved = screen.getByRole("tab", { name: /Resolved/ });
    expect(open.getAttribute("tabindex")).toBe("0");
    expect(high.getAttribute("tabindex")).toBe("-1");
    open.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(high);
    expect(high.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(resolved);
    expect(await screen.findByText("No resolved exceptions yet")).toBeTruthy();
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(open);
    expect(open.getAttribute("aria-selected")).toBe("true");
  });

  it("puts the caret in the search box on \"/\", types \"/\" inside it, and clears it on Escape", async () => {
    const user = userEvent.setup();
    renderApp("/customers");
    await screen.findByText("Ada Okonkwo");
    const search = screen.getByPlaceholderText("Search by name, reference or phone…") as HTMLInputElement;
    expect(search.getAttribute("aria-keyshortcuts")).toBe("/");
    await user.keyboard("/");
    expect(document.activeElement).toBe(search);
    expect(search.value).toBe("");
    await user.keyboard("DEMO/");
    expect(search.value).toBe("DEMO/");
    await user.keyboard("{Escape}");
    expect(search.value).toBe("");
  });

  it("lists the shortcuts on the settings page", async () => {
    renderApp("/settings");
    expect(await screen.findByRole("heading", { name: "Keyboard" })).toBeTruthy();
    expect(screen.getByText("Put the caret in the search box on a page that has one (Customers, Audit log).")).toBeTruthy();
  });
});
