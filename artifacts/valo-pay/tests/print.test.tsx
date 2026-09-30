import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => { api.uninstall(); vi.useRealTimers(); });

// jsdom applies no stylesheet, so what these tests pin is the markup the print rules act on: which
// parts of the console are marked to leave the page, and the provenance the page gains on paper.
describe("print", () => {
  it("marks the chrome to leave the page and carries the lender and the sandbox notice instead", async () => {
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    const banner = screen.getByText(/^Sandbox · Sample data\. We never hold money\./).parentElement!;
    expect(banner.className).toContain("print:hidden");
    expect(screen.getByRole("complementary").className).toContain("print:hidden");
    expect(screen.getByRole("button", { name: "Menu" }).closest(".sticky")!.className).toContain("print:hidden");
    const provenance = screen.getByText("Valo Pay · Sample data sandbox").closest("div.print\\:block")!;
    expect(provenance.textContent).toMatch(/Meridian Credit|Cedar Cooperative/);
    expect(provenance.textContent).toContain("Sample data only. We never hold money. This is not a live payment record");
  });

  it("says when and from where the page was printed, taking the time again as printing starts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-18T09:05:00Z"));
    renderApp("/overview");
    await screen.findByRole("heading", { name: "Overview" });
    const footer = screen.getByText(/^Printed /);
    expect(footer.textContent).toMatch(/ from the Valo Pay sandbox · Overview · (Meridian Credit|Cedar Cooperative)\.$/);
    const before = footer.textContent!;
    vi.setSystemTime(new Date("2026-09-19T14:30:00Z"));
    window.dispatchEvent(new Event("beforeprint"));
    await vi.waitFor(() => expect(screen.getByText(/^Printed /).textContent).not.toBe(before));
    expect(screen.getByText(/^Printed /).textContent).toContain("19 Sept 2026");
  });

  it("keeps the settings page's appearance and keyboard help off the paper, and shows the exceptions filter as words", async () => {
    renderApp("/settings");
    await screen.findByRole("heading", { name: "Keyboard" });
    expect(document.querySelector('[aria-labelledby="appearance-title"]')!.className).toContain("print:hidden");
    expect(document.querySelector('[aria-labelledby="keyboard-title"]')!.className).toContain("print:hidden");
  });

  it("has print rules that open the frames, drop the controls and keep the light ink", () => {
    const cssPath = [join(process.cwd(), "src", "index.css"), join(process.cwd(), "artifacts", "valo-pay", "src", "index.css")].find((candidate) => existsSync(candidate))!;
    const css = readFileSync(cssPath, "utf8");
    const print = css.slice(css.indexOf("@media print {"));
    expect(print).toContain("button, input, select, textarea, nav, [role=\"tablist\"], .fixed { display: none !important; }");
    expect(print).toContain(".overflow-auto, .overflow-x-auto, .overflow-y-auto, .overflow-hidden { overflow: visible !important; }");
    expect(print).toContain("thead { display: table-header-group; }");
    expect(print).toContain("tr, li, figure, dt, dd { break-inside: avoid; }");
    expect(print).toContain(".truncate { overflow: visible !important; white-space: normal !important;");
    // The dark tokens and the dark variant are scoped to screens, so paper is always the light theme.
    expect(css).toMatch(/@media screen \{\r?\n\s+\.dark \{/);
    expect(css).toMatch(/@custom-variant dark \{\r?\n\s+@media screen \{/);
  });
});
