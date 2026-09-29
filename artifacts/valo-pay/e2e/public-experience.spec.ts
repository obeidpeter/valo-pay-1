import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

async function audit(page: Page) {
  await page.addScriptTag({
    path: path.resolve("node_modules/axe-core/axe.min.js"),
  });
  const violations = await page.evaluate(async () => {
    const result = await (window as any).axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    });
    return result.violations.map((v: any) => ({
      id: v.id,
      nodes: v.nodes.map((n: any) => ({
        target: n.target,
        summary: n.failureSummary,
      })),
    }));
  });
  expect(violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

for (const theme of ["light", "dark"]) {
  test(`public pages and all workspace previews are accessible in ${theme} mode`, async ({
    page,
  }, info) => {
    test.setTimeout(60000);
    const requests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/")) requests.push(req.url());
    });
    await page.addInitScript(
      (value) => localStorage.setItem("valopay-theme", value),
      theme,
    );
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Collections, credit and cash. One clear view.",
      }),
    ).toBeVisible();
    for (const name of [
      "Collections",
      "Pay by Bank",
      "Credit Desk",
      "Cash Desk",
    ]) {
      await page.getByRole("tab", { name, exact: true }).click();
      await expect(
        page.getByRole("tabpanel", { name, exact: true }),
      ).toBeVisible();
      await audit(page);
    }
    await page.getByRole("tab", { name: "Collections", exact: true }).click();
    await page.screenshot({
      path: info.outputPath(`landing-${theme}.png`),
      fullPage: true,
      scale: "css",
    });
    await page.screenshot({ path: info.outputPath(`hero-${theme}.png`), scale: "css" });
    for (const [route, heading] of [
      ["/sign-in", "Sign in"],
      ["/sign-up", "Create an account"],
    ]) {
      await page.goto(route!);
      await expect(
        page.getByRole("heading", { name: heading!, level: 1 }),
      ).toBeVisible();
      await page.getByText("How long is my workspace kept?").click();
      await expect(
        page.getByText(
          /The sandbox is kept in this browser and may be deleted after 30 days/,
        ),
      ).toBeVisible();
      await audit(page);
      await page.screenshot({
        path: info.outputPath(`${route!.slice(1)}-${theme}.png`),
        fullPage: true,
        scale: "css",
      });
    }
    expect(requests).toEqual([]);
  });
}

test("navigation, keyboard previews and opt-in tour preserve visitor control", async ({
  page,
  request,
}) => {
  await request.post("/__test/reset");
  const workspaceRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/v1/workspace"))
      workspaceRequests.push(req.url());
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Collections", exact: true }).focus();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("tab", { name: "Cash Desk", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("tabpanel", { name: "Cash Desk", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Collections", exact: true }),
  ).toBeFocused();
  const menu = page.getByRole("button", { name: "Open menu" });
  if (await menu.isVisible()) {
    await menu.click();
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await menu.click();
    await page
      .getByRole("navigation", { name: "Mobile sections" })
      .getByRole("link", { name: "Common questions" })
      .click();
  } else {
    await page.locator('footer a[href="#questions"]').click();
  }
  await expect(page.locator("#questions")).toBeFocused();
  await page
    .locator("summary")
    .filter({ hasText: "Are Paystack and Xero already connected?" })
    .click();
  await expect(
    page.getByText(/Paystack is the preferred first payment provider/),
  ).toBeVisible();
  expect(workspaceRequests).toEqual([]);
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.getByRole("button", { name: /02 · Pay by Bank/ }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.getByRole("button", { name: "Load interactive preview" }).click();
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("heading", { name: "Pay-by-bank", level: 1 }),
  ).toBeVisible();
  expect(workspaceRequests.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: /03 · Credit Desk/ }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.getByRole("button", { name: "Load interactive preview" }).click();
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("heading", { name: "Credit Desk", level: 1 }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close preview" }).click();
  await expect(
    page.getByRole("button", { name: "Load interactive preview" }),
  ).toBeFocused();
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("public layouts fit a narrow 320px viewport", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 760 });
  for (const route of ["/", "/sign-in", "/sign-up"]) {
    await page.goto(route);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.locator("main").evaluate((main) =>
      Array.from(main.querySelectorAll("h1,h2,h3,p,button,a,summary,li"))
        .filter((node) => {
          const r = node.getBoundingClientRect();
          return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
        })
        .map((node) => node.textContent?.slice(0, 80)),
    );
    expect(overflow).toEqual([]);
    await page.screenshot({
      path: info.outputPath(
        `${route === "/" ? "landing" : route.slice(1)}-320.png`,
      ),
      fullPage: true,
      scale: "css",
    });
  }
});
