import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

// Every route, audited as a whole page at each project's width (a desktop and a phone, in each engine):
// the WCAG 2.2 AA rules and the best-practice landmark rules. The landmark rules are page-level, so axe runs
// them only over the whole document: a scan scoped to #main cannot see a duplicate between the sidebar and a
// page, a complementary landmark inside main, or a scrolling frame named like the region around it.
const landmarkRules = [
  "landmark-banner-is-top-level", "landmark-complementary-is-top-level", "landmark-contentinfo-is-top-level",
  "landmark-main-is-top-level", "landmark-no-duplicate-banner", "landmark-no-duplicate-contentinfo",
  "landmark-no-duplicate-main", "landmark-one-main", "landmark-unique", "region",
];

const routes: Array<[string, string | RegExp]> = [
  ["/", "Collections, credit and cash. One clear view."],
  ["/sign-in", "Sign in"],
  ["/sign-up", "Create an account"],
  ["/team-invite", "Accept your invitation"],
  ["/no-such-page", "Page not found"],
  ["/overview", "Overview"],
  ["/work", "My work"],
  ["/exceptions", "Exceptions"],
  ["/reconciliation", "Reconciliation"],
  ["/reconciliation?view=review", "Reconciliation"],
  ["/collections", "Collections"],
  ["/imports", "Import batches"],
  ["/close-review", "Close review"],
  ["/customers", "Customers"],
  ["/mandates", "Mandates"],
  ["/policies", "Policies and templates"],
  ["/pay-by-bank", "Pay by Bank"],
  ["/credit-desk", "Credit Desk"],
  ["/cash-desk", "Cash Desk"],
  ["/connections", "Permissions and readiness"],
  ["/reports", "Reports & analytics"],
  ["/exports", "Saved exports"],
  ["/audit", "Audit log"],
  ["/evidence", "Go-live evidence"],
  ["/pilot", "Your pilot journey"],
  ["/sources", "Data sources"],
  ["/operations", "Operations"],
  ["/team", "Team & access"],
  ["/lifecycle", "Data retention"],
  ["/settings", "Settings & administration"],
  ["/presentation", /^Presentation$/],
];

test.beforeEach(async ({ request, page }) => {
  await request.post("/__test/reset");
  await page.emulateMedia({ reducedMotion: "reduce" });
});

/** Waits for the page's own reads and for scrolling frames to be measured, since a frame is a named region only while it scrolls. */
async function settle(page: Page, heading: string | RegExp) {
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("status").filter({ hasText: /^Loading / })).toHaveCount(0);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function audit(page: Page, where: string) {
  await page.addScriptTag({ path: path.resolve("node_modules/axe-core/axe.min.js") });
  const violations = await page.evaluate(async (rules) => {
    const result = await (window as any).axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: Object.fromEntries(rules.map((rule: string) => [rule, { enabled: true }])),
    });
    return result.violations.map((violation: any) => ({ id: violation.id, nodes: violation.nodes.map((node: any) => ({ target: node.target, summary: node.failureSummary })) }));
  }, landmarkRules);
  expect(violations, where).toEqual([]);
}

/** On a desktop the sidebar shows the current page's link, however far down the list it sits. */
async function expectCurrentPageInView(page: Page, label: string) {
  const sidebar = page.getByRole("complementary", { name: "Console sidebar" }).getByRole("navigation", { name: "Pages" });
  const current = sidebar.getByRole("link", { name: label, exact: true });
  await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(current).toHaveAttribute("aria-current", "page");
  await expect.poll(async () => {
    const [list, link] = await Promise.all([sidebar.boundingBox(), current.boundingBox()]);
    return !!list && !!link && link.y >= list.y - 1 && link.y + link.height <= list.y + list.height + 1;
  }).toBe(true);
}

for (const [route, heading] of routes) {
  test(`${route} has unique, top-level landmarks and passes WCAG 2.2 AA as a whole page`, async ({ page }, info) => {
    await page.goto(route);
    await settle(page, heading);
    await audit(page, route);
    const navLink = await page.evaluate((path) => {
      const link = [...document.querySelectorAll<HTMLAnchorElement>('aside nav[aria-label="Pages"] a')].find((item) => item.getAttribute("href") === path);
      if (!link) return null;
      // The purpose is a separate aria-describedby span. Its text belongs to
      // the description, not the link's explicitly declared accessible name.
      const visibleLabel = [...(link.querySelector("span")?.childNodes ?? [])]
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent).join("").trim();
      return { label: link.getAttribute("aria-label"), visibleLabel };
    }, route.split("?")[0]!);
    if (navLink) {
      expect(navLink.visibleLabel, `${route} has a readable navigation label`).toMatch(/\S/);
      expect(navLink.label, `${route} has an explicit accessible name`).toMatch(/\S/);
      expect(navLink.label, `${route} accessible name includes its visible label`).toContain(navLink.visibleLabel);
      if (!info.project.name.startsWith("mobile")) await expectCurrentPageInView(page, navLink.label!);
    }
  });
}

test("record pages have unique, top-level landmarks and pass WCAG 2.2 AA as a whole page", async ({ page, request }) => {
  const lender = (await (await request.get("/api/v1/workspace")).json()).merchants[0].id;
  const customer = (await (await request.get(`/api/v1/records/customers?merchantId=${lender}&limit=1`)).json()).items[0];
  await page.goto(`/customers/${customer.id}`);
  await settle(page, customer.name);
  await audit(page, "customer history");
  const exception = (await (await request.get(`/api/v1/records/exceptions?merchantId=${lender}&limit=1`)).json()).items[0];
  await page.goto(`/cases/${exception.id}`);
  await settle(page, /^Case: /);
  await audit(page, "case");
});

test("the presentation guide keeps landmarks unique", async ({ page }) => {
  await page.goto("/presentation");
  await settle(page, /^Presentation$/);
  await page.getByRole("button", { name: "Start presentation guide" }).click();
  await expect(page.getByRole("region", { name: "Presentation guide" })).toBeVisible();
  await audit(page, "presentation guide");
});

test("the phone drawer opens on the current page, in the sidebar's groups, and keeps landmarks unique", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("mobile"), "The drawer is the phone's navigation.");
  await page.goto("/presentation");
  await settle(page, /^Presentation$/);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Menu" });
  await expect(drawer.getByRole("link", { name: "Presentation", exact: true })).toBeFocused();
  await expect(drawer.getByRole("group", { name: "Daily work" })).toBeVisible();
  await audit(page, "phone drawer");
});

test("following a link to a page low in the list brings its entry into view in the sidebar", async ({ page }, info) => {
  test.skip(info.project.name.startsWith("mobile"), "The sidebar is the desktop's navigation.");
  await page.goto("/imports");
  await settle(page, "Import batches");
  await page.getByRole("link", { name: "Manage source schedules, mappings and totals" }).click();
  await settle(page, "Data sources");
  await expectCurrentPageInView(page, "Data sources");
});
