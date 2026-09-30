import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent } from "./harness";
import { THEME_STORAGE_KEY, initTheme, resolveTheme, setThemeChoice } from "@/lib/theme";

// A device whose light-or-dark setting a test can change; jsdom has no matchMedia of its own.
// The theme module keeps the first MediaQueryList it is given, so the object reads the shared
// `device` on every call and keeps its listeners there.
const device = { dark: false, listeners: new Set<() => void>() };
const originalMatchMedia = window.matchMedia;
const html = () => document.documentElement.classList.contains("dark");

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi();
  window.matchMedia = (query: string) => ({
    get matches() { return query.includes("dark") && device.dark; },
    media: query, onchange: null,
    addListener() { /* legacy */ }, removeListener() { /* legacy */ },
    addEventListener: (_type: string, listener: () => void) => { device.listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { device.listeners.delete(listener); },
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList;
  device.dark = false;
});
afterEach(() => { api.uninstall(); window.matchMedia = originalMatchMedia; });
const deviceChanged = () => device.listeners.forEach((listener) => listener());

describe("theme", () => {
  it("switches the theme from the sidebar and keeps the saved choice", async () => {
    const user = userEvent.setup();
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    await user.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(html()).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    await user.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(html()).toBe(false);
  });
  it("follows the device when nothing has been chosen, and changes with it", () => {
    device.dark = true;
    initTheme();
    expect(html()).toBe(true);
    device.dark = false;
    deviceChanged();
    expect(html()).toBe(false);
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("lets a stored choice win over the device, and Follow the device gives it back", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    device.dark = true;
    initTheme();
    expect(html()).toBe(false);
    setThemeChoice("system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(html()).toBe(true);
    setThemeChoice("dark");
    device.dark = false;
    deviceChanged();
    expect(html()).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("is chosen on the settings page, applies at once, says which theme is showing, and is kept for the next visit", async () => {
    const user = userEvent.setup();
    renderApp("/settings");
    const darkRadio = await screen.findByRole("radio", { name: "Dark" });
    expect((screen.getByRole("radio", { name: "Follow the device" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Following the device: light now.")).toBeTruthy();
    await user.click(darkRadio);
    expect(html()).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByText("Dark until you change it here.")).toBeTruthy();

    // The next visit: the choice is read back from this browser.
    cleanup();
    renderApp("/settings");
    expect(((await screen.findByRole("radio", { name: "Dark" })) as HTMLInputElement).checked).toBe(true);
    expect(html()).toBe(true);
    await user.click(screen.getByRole("radio", { name: "Follow the device" }));
    expect(html()).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("is applied by the page shell before the app loads, with the same key and rule", () => {
    const shellPath = [join(process.cwd(), "index.html"), join(process.cwd(), "artifacts", "valo-pay", "index.html")].find((candidate) => existsSync(candidate))!;
    const shell = readFileSync(shellPath, "utf8");
    expect(shell).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`);
    expect(shell).toContain("window.matchMedia('(prefers-color-scheme: dark)').matches");
    expect(shell).toContain("choice === 'dark' || (choice !== 'light' &&");
    expect(shell).toContain("document.documentElement.classList.toggle('dark', dark)");
  });
});
