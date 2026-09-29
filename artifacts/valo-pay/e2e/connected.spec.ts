import { test, expect } from "@playwright/test";
import path from "node:path";
test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
});
test("connected modules are readable, keyboard accessible and fit the viewport", async ({
  page,
}, info) => {
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
      return results.violations.map((v: any) => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        nodes: v.nodes.map((n: any) => n.target),
      }));
    });
    expect(violations).toEqual([]);
    await page.screenshot({
      path: info.outputPath(route!.slice(1) + ".png"),
      fullPage: true,
    });
    if (route === "/cash-desk") {
      await page
        .getByText("Base · day 30", { exact: true })
        .scrollIntoViewIfNeeded();
      await page.locator("#main").evaluate((node) => {
        node.scrollTop += 420;
      });
      await page.screenshot({ path: info.outputPath("cash-desk-details.png") });
    }
  }
});
test("a bank return stays pending until the sample provider confirms payment", async ({
  page,
}) => {
  await page.goto("/pay-by-bank");
  await expect(
    page.getByRole("heading", { name: "Pay by Bank", level: 1 }),
  ).toBeVisible();
  const options = await page
    .getByLabel("Customer and instalment")
    .locator("option")
    .allTextContents();
  await page.getByLabel("Customer and instalment").selectOption({
    label: options.find((s) => s.includes("DEMO-LOAN-1005"))!,
  });
  await page.getByRole("button", { name: /Create checkout/ }).click();
  await page.getByRole("button", { name: "Simulate authorisation" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Reason")
    .fill("Review the amount and sample beneficiary");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Simulate authorisation" })
    .click();
  await page.getByRole("button", { name: "Simulate return from bank" }).click();
  await expect(
    page.getByText(
      "Browser returned. Payment is not confirmed; awaiting provider evidence.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Simulate unknown outcome" }).click();
  await expect(
    page.getByText(/You cannot collect this instalment again until the outcome is known/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check again: confirmed" }).click();
  await expect(
    page.getByRole("link", { name: "Open Reconciliation", exact: true }),
  ).toBeVisible();
});
test("permissions can be granted and revoked with an explicit explanation", async ({
  page,
}) => {
  await page.goto("/connections");
  await page
    .getByLabel("Purpose", { exact: true })
    .selectOption("merchant_account_read");
  await page
    .getByLabel("Reason for granting permission")
    .fill("Review SME sample account balances");
  await page.getByRole("button", { name: "Grant sample permission" }).click();
  await page.getByRole("button", { name: "Review revocation" }).click();
  await page
    .getByLabel("Reason for revoking permission")
    .fill("The SME withdrew sample account permission");
  await page.getByRole("button", { name: "Revoke permission" }).click();
  await expect(
    page.getByText(
      "Permission revoked. New dependent work is blocked; historical evidence is retained.",
    ),
  ).toBeVisible();
  await page.goto("/cash-desk");
  await expect(
    page.getByRole("button", { name: /Set up sample Cash Desk/ }),
  ).toBeDisabled();
});
