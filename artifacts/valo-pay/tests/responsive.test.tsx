import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { revealCurrentPage } from "@/components/layout";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

// jsdom applies no stylesheet, so the phone bar and the sidebar are both in the
// document here; the browser shows one or the other. What these tests pin is
// that the two offer the same pages and the same lender, and how the drawer
// opens, navigates, closes and hands focus on.
describe("responsive layout", () => {
  it("offers the same pages and lender in the phone bar's drawer as in the sidebar, with the current page marked", async () => {
    const user = userEvent.setup();
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Operations overview" });
    // The lender is chosen in the same place on a phone and on a desktop: once each, the same name.
    const lenders = screen.getAllByLabelText("Active lender") as HTMLSelectElement[];
    expect(lenders).toHaveLength(2);
    expect(lenders.map((select) => select.value)).toEqual([api.merchantIds[0], api.merchantIds[0]]);
    const [sidebarPages] = screen.getAllByRole("navigation", { name: "Pages" });
    const sidebarLabels = within(sidebarPages!).getAllByRole("link").map((link) => link.getAttribute("aria-label") || link.textContent);
    expect(sidebarLabels).toHaveLength(25);
    expect(within(sidebarPages!).getByRole('link', { name: 'Presentation' }).getAttribute('href')).toBe('/presentation');
    expect(sidebarLabels).toEqual(expect.arrayContaining(['My work','Data sources','Close review','Data retention','Saved exports']));
    expect(within(sidebarPages!).getByRole('link', { name: 'Saved exports' }).getAttribute('href')).toBe('/exports');
    expect(sidebarLabels).toEqual(expect.arrayContaining(['Pilot journey', 'Import batches', 'Operations', 'Team & access']));

    const groupNames = (list: HTMLElement) => within(list).getAllByRole("group").map((group) => document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent);
    const sidebarGroups = groupNames(sidebarPages!);

    await user.click(screen.getByRole("button", { name: "Menu" }));
    const drawer = await screen.findByRole("dialog", { name: "Menu" });
    const drawerLabels = within(within(drawer).getByRole("navigation", { name: "Pages" })).getAllByRole("link").map((link) => link.getAttribute("aria-label") || link.textContent);
    expect(drawerLabels).toEqual(sidebarLabels);
    expect(within(drawer).getByRole("link", { name: "Help & glossary" }).getAttribute("href")).toBe("/help");
    // The same named groups, in the same order.
    expect(groupNames(within(drawer).getByRole("navigation", { name: "Pages" }))).toEqual(sidebarGroups);
    expect(within(drawer).getByRole('link', { name: 'Saved exports' }).getAttribute('href')).toBe('/exports');
    expect(within(drawer).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
    expect(within(drawer).getByRole("link", { name: "Audit log" }).getAttribute("aria-current")).toBeNull();
  });

  it("closes the drawer after a page is chosen in it and moves focus to the page content, as the sidebar does", async () => {
    const user = userEvent.setup();
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Operations overview" });
    await user.click(screen.getByRole("button", { name: "Menu" }));
    const drawer = await screen.findByRole("dialog", { name: "Menu" });
    await user.click(within(drawer).getByRole("link", { name: "Audit log" }));
    await screen.findByRole("heading", { name: "Audit log" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement?.id).toBe("main"));
    await waitFor(() => expect(document.title).toBe("Audit log · Valo Pay"));
  });

  it("closes the drawer on Escape and returns focus to the Menu button", async () => {
    const user = userEvent.setup();
    renderApp("/customers");
    await screen.findByText("Ada Okonkwo");
    const menu = screen.getByRole("button", { name: "Menu" });
    await user.click(menu);
    await screen.findByRole("dialog", { name: "Menu" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(menu));
    // Nothing was navigated: the page and its title are as they were.
    await waitFor(() => expect(document.title).toBe("Customers · Valo Pay"));
    expect(screen.getByText("Ada Okonkwo")).toBeTruthy();
  });

  it("switches the lender from the phone bar and the drawer follows the change of page", async () => {
    const user = userEvent.setup();
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Operations overview" });
    const [first, second] = api.merchantIds as [string, string];
    const [phoneLender] = screen.getAllByLabelText("Active lender") as HTMLSelectElement[];
    await user.selectOptions(phoneLender!, second);
    await waitFor(() => expect(api.calls.some((call) => call.path === "/v1/overview" && call.query.merchantId === second)).toBe(true));
    expect(api.calls.some((call) => call.path === "/v1/overview" && call.query.merchantId === first)).toBe(true);
    // Both selectors show the same lender: one choice, shown in two places.
    const lenders = screen.getAllByLabelText("Active lender") as HTMLSelectElement[];
    expect(lenders.map((select) => select.value)).toEqual([second, second]);
  });

  it("lists every page once, in named groups with daily work first and a label and icon of its own", async () => {
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Operations overview" });
    const [sidebarPages] = screen.getAllByRole("navigation", { name: "Pages" });
    const groups = within(sidebarPages!).getAllByRole("group");
    const named = groups.map((group) => [document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent, within(group).getAllByRole("link").map((link) => link.getAttribute("aria-label") || link.textContent)]);
    expect(named).toEqual([
      ["Daily work", ["Overview", "My work", "Exceptions", "Reconciliation", "Collections", "Import batches", "Close review"]],
      ["Customers and policies", ["Customers", "Mandates", "Policies & templates"]],
      ["Connected banking", ["Pay-by-bank", "Credit Desk", "Cash Desk", "Permissions & readiness"]],
      ["Oversight", ["Reports", "Saved exports", "Audit log", "Go-live evidence"]],
      ["Setup and administration", ["Pilot journey", "Data sources", "Operations", "Team & access", "Data retention", "Settings", "Presentation"]],
    ]);
    const links = within(sidebarPages!).getAllByRole("link");
    for (const link of links) expect(document.getElementById(link.getAttribute("aria-describedby")!)?.textContent).toBeTruthy();
    const icons = links.map((link) => [...link.querySelector("svg")!.classList].find((name) => name.startsWith("lucide-")));
    expect(new Set(icons).size).toBe(links.length);
    expect(new Set(links.map((link) => link.getAttribute("aria-label") || link.textContent)).size).toBe(links.length);
    // Every page the console routes to has a link; only the record pages (a customer, a case) are reached from their lists.
    const app = [join(process.cwd(), "src", "App.tsx"), join(process.cwd(), "artifacts", "valo-pay", "src", "App.tsx")].find((candidate) => existsSync(candidate))!;
    const routes = [...readFileSync(app, "utf8").matchAll(/path: '(\/[^']+)'/g)].map((match) => match[1]!).filter((path) => !path.includes(":"));
    expect(links.map((link) => link.getAttribute("href")).sort()).toEqual(routes.sort());
  });

  it("opens the drawer on the current page's link, wherever it sits in the list", async () => {
    const user = userEvent.setup();
    renderApp("/presentation");
    await screen.findByRole("heading", { level: 1, name: "Presentation" });
    await user.click(screen.getByRole("button", { name: "Menu" }));
    const drawer = await screen.findByRole("dialog", { name: "Menu" });
    const current = within(drawer).getByRole("link", { name: "Presentation" });
    expect(current.getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(document.activeElement).toBe(current));
  });

  it("scrolls the sidebar's list, and only the list, to a current page below its fold", async () => {
    renderApp("/settings");
    await screen.findByRole("heading", { name: "Settings & administration" });
    const [sidebarPages] = screen.getAllByRole("navigation", { name: "Pages" });
    const current = within(sidebarPages!).getByRole("link", { name: "Settings" });
    expect(current.getAttribute("aria-current")).toBe("page");
    // jsdom lays nothing out: give the list a 300 px window and the link a place 800 px down it.
    const box = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(sidebarPages!, "getBoundingClientRect").mockReturnValue(box(100, 300));
    vi.spyOn(current, "getBoundingClientRect").mockReturnValue(box(900, 34));
    revealCurrentPage(sidebarPages!);
    // The link's middle is brought to the list's middle: 900 - 100 - (300 - 34) / 2.
    expect(sidebarPages!.scrollTop).toBe(667);
    // A link already in view leaves the list where it is.
    sidebarPages!.scrollTop = 20;
    vi.spyOn(current, "getBoundingClientRect").mockReturnValue(box(150, 34));
    revealCurrentPage(sidebarPages!);
    expect(sidebarPages!.scrollTop).toBe(20);
  });
});
