import { test, expect } from "@playwright/test";
import path from "node:path";

// WebKit's conditions, in every project: a short phone screen (the iPhone 13's), and a browser that does not
// anchor the view while content above it changes height (WebKit has no scroll anchoring; Chromium and Firefox
// have, so without this the Chromium projects could not see what WebKit shows).
test.use({ viewport: { width: 390, height: 664 } });

test.beforeEach(async ({ request, page }) => {
  await request.post("/__test/reset");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "* { overflow-anchor: none !important; }";
      document.head.append(style);
    });
  });
});

test("paging a table keeps its pager in view even where the browser does not anchor the view", async ({ page }) => {
  await page.goto("/reconciliation#precision-audit");
  await expect(page.locator("#precision-audit")).toBeFocused();
  const pager = page.getByRole("navigation", { name: "proposed matches pagination" });
  // The last page is shorter, and going back makes the table taller again: the pager stays in view both ways.
  for (const [direction, shown] of [["Next", "Page 2 of 3"], ["Next", "Page 3 of 3"], ["Previous", "Page 2 of 3"]]) {
    await pager.getByRole("button", { name: `${direction} page of proposed matches` }).click();
    await expect(pager.getByText(shown, { exact: true })).toBeVisible();
    await expect(pager).toBeInViewport();
  }
});

test("an empty Request history page still has something to focus, so a keyboard can scroll it on a short screen", async ({ page }) => {
  await page.goto("/operations");
  await expect(page.getByRole("heading", { level: 1, name: "Request history" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("link", { name: "Open Import batches" })).toBeVisible();
  await page.addScriptTag({ path: path.resolve("node_modules/axe-core/axe.min.js") });
  const violations = await page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: "rule", values: ["scrollable-region-focusable"] } })).violations.map((violation: any) => violation.id));
  expect(violations).toEqual([]);
});
