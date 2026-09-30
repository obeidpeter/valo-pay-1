import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

test.beforeEach(async ({ request, page }) => {
  await request.post("/__test/reset");
  await page.emulateMedia({ reducedMotion: "reduce" });
});

async function navigate(page: Page, name: string) {
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("link", { name, exact: true }).click();
}

async function audit(page: Page, selector = "#main") {
  await page.addScriptTag({ path: path.resolve("node_modules/axe-core/axe.min.js") });
  const violations = await page.evaluate(async (scope) => {
    const results = await (window as any).axe.run(document.querySelector(scope), {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    });
    return results.violations.map((violation: any) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node: any) => ({ target: node.target, summary: node.failureSummary })),
    }));
  }, selector);
  expect(violations).toEqual([]);
}

async function expectReflow(page: Page) {
  const geometry = await page.evaluate(() => {
    const main = document.getElementById("main")!;
    const bounds = main.getBoundingClientRect();
    // Wide comparison tables keep their own scroll frames. Other visible
    // controls must remain inside the main column at 320 CSS pixels.
    const outside = [...main.querySelectorAll<HTMLElement>("button,input,select,textarea,a")]
      .filter(node => !node.closest("table") && node.getClientRects().length > 0)
      .filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
      })
      .map(node => ({ tag: node.tagName, name: node.getAttribute("aria-label") || node.textContent?.trim() }));
    return { width: document.documentElement.scrollWidth, viewport: innerWidth, outside };
  });
  expect(geometry.width).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(geometry.outside).toEqual([]);
}

test("a tall queue keeps its place after a short page and browser Back", async ({ page }) => {
  await page.goto("/mandates?q=BROWSER-MND");
  await expect(page.getByText("1–25 of 55 mandates", { exact: true })).toBeVisible();
  const main = page.locator("#main");
  const saved = await main.evaluate(node => {
    const position = Math.min(1200, node.scrollHeight - node.clientHeight);
    node.scrollTop = position;
    return position;
  });
  expect(saved).toBeGreaterThan(400);
  // Let the browser deliver the scroll event that captures this route's position.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await navigate(page, "Customers");
  await expect(page.getByRole("heading", { name: "Customers", level: 1 })).toBeVisible();
  await expect.poll(() => main.evaluate(node => node.scrollTop)).toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/mandates\?q=BROWSER-MND$/);
  await expect(page.getByText("1–25 of 55 mandates", { exact: true })).toBeVisible();
  await expect.poll(() => main.evaluate(node => node.scrollTop)).toBeCloseTo(saved, 0);
  await expect(page.getByLabel("Search this queue")).toHaveValue("BROWSER-MND");
});

test("role, lender mode and WAT context reflect the current authority on every viewport", async ({ page, request }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  const workspace = await (await request.get("/api/v1/workspace")).json();
  const activeLender = await page.locator('select[id^="lender-"]:visible').inputValue();
  const lender = workspace.merchants.find((item: { id: string }) => item.id === activeLender);
  const context = page.locator("#main .workspace-bar");
  await expect(context).toBeInViewport();
  await expect(context).toContainText(`Demo role: ${workspace.role}`);
  await expect(context).toContainText(`Mode: ${lender.mode}`);
  await expect(context).toContainText("Times in WAT");
  await page.getByLabel("Demo role", { exact: true }).selectOption("Read-only");
  await page.getByRole("button", { name: "Switch role", exact: true }).click();
  await expect(context).toContainText("Demo role: Read-only");
  await navigate(page, "Customers");
  await expect(page.getByRole("heading", { name: "Customers", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add customer", exact: true })).toBeDisabled();
  await expect(context).toBeInViewport();
  await expect(context).toContainText("Demo role: Read-only");
  expect((await (await request.get("/api/v1/workspace")).json()).role).toBe("Read-only");
});

test("field correction links retain the draft and return keyboard focus to its opener", async ({ page }) => {
  await page.goto("/customers");
  const opener = page.getByRole("button", { name: "Add customer", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Add customer", exact: true });
  const name = dialog.getByLabel(/^Full name/);
  await name.fill("Retained synthetic customer");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByLabel(/^Loan software reference/)).toBeFocused();
  const correction = dialog.getByRole("button", { name: /Consent source or reference: Consent source or reference is required/ });
  await correction.focus();
  await page.keyboard.press("Enter");
  const consent = dialog.getByLabel(/^Consent source or reference/);
  await expect(consent).toBeFocused();
  await consent.fill("Synthetic consent reference");
  await expect(consent).not.toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveValue("Retained synthetic customer");
  await audit(page, '[role="dialog"]');
  page.once("dialog", prompt => prompt.accept());
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("the payment comparison keeps evidence readable and keyboard focus inside its dialog", async ({ page }, info) => {
  await page.goto("/reconciliation?view=review");
  const opener = page.getByRole("button", { name: "Confirm match", exact: true }).first();
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Confirm match" });
  const title = dialog.getByRole("heading", { name: "Confirm match", exact: true });
  await expect(title).toBeFocused();
  await expect(title).toBeInViewport();
  const evidence = dialog.getByRole("region", { name: "Match evidence" });
  await expect(evidence.getByRole("heading", { name: "Recorded payment", exact: true })).toBeVisible();
  await expect(evidence.getByRole("heading", { name: "Instalment", exact: true })).toBeVisible();
  await expect(evidence.getByText(/Collection result:/)).toBeVisible();
  await expect(evidence.getByText(/Settlement:/)).toBeVisible();
  await expect(evidence.getByText(/Provider fees are checked separately/)).toBeVisible();
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await dialog.getByLabel("Reason *", { exact: true }).focus();
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  }
  await audit(page, '[role="dialog"]');
  await page.screenshot({ path: info.outputPath("comparison-dialog.png"), scale: "css" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("reduced-motion theme changes keep inherited text in the selected palette immediately", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("valopay-theme", "light"));
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  for (const theme of ["dark", "light"] as const) {
    await page.getByRole("radio", { name: theme === "dark" ? "Dark" : "Light", exact: true }).check();
    // Do not wait away a transient contrast defect: inherited text and the palette
    // must agree as soon as the user's theme selection completes.
    const colours = await page.evaluate(() => {
      const expected = document.createElement("span");
      expected.style.cssText = "display:none;transition:none!important;color:hsl(var(--foreground))";
      document.body.append(expected);
      const foreground = getComputedStyle(expected).color;
      expected.remove();
      return {
        dark: document.documentElement.classList.contains("dark"),
        foreground,
        nodes: [...document.querySelectorAll("body,#main,.workspace-bar strong,h1,#paystack-heading")].map(node => {
          const style = getComputedStyle(node);
          return { name: node.id || node.tagName, colour: style.color, fill: style.getPropertyValue("-webkit-text-fill-color"), duration: style.transitionDuration };
        }),
      };
    });
    expect(colours.dark).toBe(theme === "dark");
    expect(colours.nodes.length).toBeGreaterThan(4);
    for (const node of colours.nodes) {
      expect(node, `${theme}: ${node.name}`).toMatchObject({ colour: colours.foreground, duration: "0s" });
      if (node.fill) expect(node.fill, `${theme}: ${node.name} text fill`).toBe(colours.foreground);
    }
  }
});

for (const theme of ["light", "dark"] as const) {
  test(`critical queues pass scoped WCAG 2.2 AA checks and reflow in ${theme} mode`, async ({ page }, info) => {
    test.setTimeout(60000);
    await page.addInitScript(value => localStorage.setItem("valopay-theme", value), theme);
    for (const [route, title] of [
      ["/reconciliation", "Reconciliation"],
      ["/exceptions", "Exceptions"],
      ["/settings", "Settings"],
      ["/collections", "Collections"],
    ]) {
      await page.setViewportSize({ width: 840, height: 1000 });
      await page.goto(route!);
      await expect(page.getByRole("heading", { name: title!, level: 1 })).toBeVisible();
      // Audit the final typefaces too: their metrics change native select widths.
      await page.evaluate(() => document.fonts.ready);
      if (route !== "/settings") await expect(page.getByRole("button", { name: "Refresh queue", exact: true })).toBeEnabled();
      else await expect(page.getByLabel("Demo role", { exact: true })).toHaveValue("Admin");
      if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
      else await expect(page.locator("html")).not.toHaveClass(/dark/);
      await audit(page);
      await page.screenshot({ path: info.outputPath(`${route!.slice(1)}-${theme}-tablet.png`), scale: "css" });
      await page.setViewportSize({ width: 320, height: 800 });
      await expectReflow(page);
      if (route === "/collections") {
        // The card clips overflow, so merely fitting the viewport is not enough.
        const ownerFitsCard = await page.getByLabel("Filter instalments by who collects them").evaluate(node => {
          const control = node.getBoundingClientRect();
          const card = node.closest("section")!.getBoundingClientRect();
          return control.left >= card.left && control.right <= card.right;
        });
        expect(ownerFitsCard).toBe(true);
      }
      await page.screenshot({ path: info.outputPath(`${route!.slice(1)}-${theme}-320.png`), scale: "css" });
    }
  });
}

test("a page past the end is corrected in place, so browser Back leaves the list", async ({ page }) => {
  await page.goto("/overview");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goto("/collections?page=99&size=25");
  // The queue moves to its last page and says so in the address.
  await expect(page).toHaveURL(/[?&]lender=/);
  expect(new URL(page.url()).searchParams.get("page")).not.toBe("99");
  await page.goBack();
  await expect(page).toHaveURL(/\/overview$/);
});
