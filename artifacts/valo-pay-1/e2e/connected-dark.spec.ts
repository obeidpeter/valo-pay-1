import { test, expect } from "@playwright/test";
import path from "node:path";

test("connected modules preserve contrast, legibility and viewport fit in dark mode", async ({
  page,
  request,
}, info) => {
  await request.post("/__test/reset");
  await page.addInitScript(() => localStorage.setItem("valo-pay-1:test:theme", "dark"));
  for (const [route, title] of [
    ["/pay-by-bank", "Pay by Bank"],
    ["/credit-desk", "Credit Desk"],
    ["/cash-desk", "Cash Desk"],
    ["/connections", "Permissions and readiness"],
  ]) {
    await page.goto(route!);
    await expect(
      page.getByRole("heading", { name: title!, level: 1 }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.addScriptTag({
      path: path.resolve("node_modules/axe-core/axe.min.js"),
    });
    const violations = await page.evaluate(async () => {
      const results = await (window as any).axe.run(
        document.getElementById("main"),
        { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } },
      );
      return results.violations.map((violation: any) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node: any) => node.target),
      }));
    });
    expect(violations).toEqual([]);
    await page.screenshot({
      path: info.outputPath(`${route!.slice(1)}-dark.png`),
      fullPage: true,
    });
  }
});
