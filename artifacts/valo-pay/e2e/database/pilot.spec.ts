import { test, expect } from "@playwright/test";
test("onboards an empty lender, persists imports and discovers a lost acknowledgement after reload", async ({
  page,
  context,
}) => {
  await page.goto("/pilot");
  const name = `Browser pilot ${Date.now()}`;
  await page.getByLabel("Lender name").fill(name);
  await page
    .getByRole("button", { name: "Create lender", exact: true })
    .click();
  await expect(
    page.getByText(
      "Lender created. Open Import batches to add its sample records.",
    ),
  ).toBeVisible();
  const select = page.locator('select[id^="lender-"]:visible');
  // The selector switches to the new lender once the workspace list refreshes,
  // which can land after the notice; read its value only when it has.
  await expect(select.locator("option:checked")).toHaveText(name);
  const lender = await select.inputValue();
  await page.goto("/imports");
  await expect(select).toHaveValue(lender);
  await page.getByRole("button", { name: "Use sample", exact: true }).click();
  await page.getByRole("button", { name: "Save and check batch" }).click();
  await expect(
    page.getByRole("heading", { name: "Saved check results" }),
  ).toBeVisible();
  await page.reload();
  await expect(select).toHaveValue(lender);
  await page
    .getByRole("button", { name: /Customers sample.*Pilot sample/ })
    .click();
  await page.route("**/api/v1/pilot/batches/*/commit?*", async (route) => {
    const result = await route.fetch({ maxRetries: 0 });
    expect(result.status()).toBe(200);
    await route.abort("connectionreset");
  });
  await page.getByRole("button", { name: "Import checked batch" }).click();
  await expect(
    page.getByText("Outcome not confirmed", { exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.goto("/operations");
  await expect(
    page.getByRole("heading", { name: "Operations", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("completed", { exact: true })).toHaveCount(2);
  const records = await context.request.get(
    `/api/v1/records/customers?merchantId=${lender}`,
  );
  expect((await records.json()).total).toBe(1);
  await page.reload();
  await expect(page.getByText("completed", { exact: true })).toHaveCount(2);
  await expect(
    page.getByRole("link", { name: "Open saved result" }),
  ).toHaveCount(2);
});
