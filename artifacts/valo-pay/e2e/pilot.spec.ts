import { test, expect } from "@playwright/test";
import path from "node:path";
test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
});
test("saved import and case handover work across reload with accessible responsive screens", async ({
  page,
  request,
}, testInfo) => {
  await page.goto("/imports");
  await page.getByRole("button", { name: "Use sample", exact: true }).click();
  await page.getByRole("button", { name: "Save and check batch" }).click();
  await expect(
    page.getByRole("heading", { name: "Saved check results" }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: /Customers sample.*Pilot sample/ })
    .click();
  await expect(page.getByLabel("CSV content")).toHaveValue(/PILOT-C001/);
  await page.getByRole("button", { name: "Commit checked batch" }).click();
  await expect(
    page.getByRole("heading", { name: "Import complete" }),
  ).toBeVisible();
  await page.addScriptTag({
    path: path.resolve("node_modules/axe-core/axe.min.js"),
  });
  expect(
    await page.evaluate(async () =>
      (
        await (window as any).axe.run(document.getElementById("main"), {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations.map((v: any) => ({
        id: v.id,
        nodes: v.nodes.map((n: any) => n.target),
      })),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("saved-import.png"),
    fullPage: true,
  });
  const lender = await page
    .locator('select[id^="lender-"]:visible')
    .inputValue();
  const record = (
    await (
      await request.get(`/api/v1/records/exceptions?merchantId=${lender}`)
    ).json()
  ).items[0];
  await page.goto(`/cases/${record.id}`);
  await page
    .getByLabel("Next action", { exact: true })
    .fill("Review the source payment");
  await page
    .getByLabel("Handover or progress note")
    .fill("Verified the sample reference and source batch.");
  await page.getByRole("button", { name: "Claim and save next step" }).click();
  await expect(
    page.getByText("Case update saved with its handover history."),
  ).toBeVisible();
  await page.getByLabel("Assigned to").selectOption("Sandbox Finance");
  await page
    .getByLabel("Handover or progress note")
    .fill("Finance to check the proposed allocation.");
  await page.getByRole("button", { name: "Save handover" }).click();
  await expect(page.getByText("Case handed over · Sandbox Finance")).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Finance to check the proposed allocation."),
  ).toBeVisible();
  await page.addScriptTag({
    path: path.resolve("node_modules/axe-core/axe.min.js"),
  });
  expect(
    await page.evaluate(async () =>
      (
        await (window as any).axe.run(document.getElementById("main"), {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations.map((v: any) => v.id),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("case-handover.png"),
    fullPage: true,
  });
});
test("an import whose name falls back warns, suggests the column and asks before committing", async ({
  page,
}) => {
  const warning =
    "No column is mapped to Name, so each record’s name is taken from its reference (or its row number without one). Not mapped to a field: full_name, which looks like the name. Map the column that holds the name, or import anyway to save the fallback.";
  await page.goto("/imports");
  await page.getByRole("textbox", { name: "Batch name" }).fill("Mapped customers");
  await page.getByRole("textbox", { name: "Source name" }).fill("Loan system export");
  await page.getByRole("textbox", { name: "Source batch ID" }).fill("map-001");
  await page
    .getByRole("textbox", { name: "CSV content" })
    .fill("source_row_id,full_name,reference,consentProvenance\nrow-1,Named in an unmapped column,UNMAPPED-C1,Synthetic consent");
  await page.getByRole("button", { name: "Save and check batch" }).click();
  const results = page.getByRole("region", { name: "Saved batch results" });
  await expect(results.getByText(warning)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "full_name" })).toHaveValue("name");
  await expect(page.getByText(/Suggested from the column names: full_name as Full name\./)).toBeVisible();
  await page.addScriptTag({ path: path.resolve("node_modules/axe-core/axe.min.js") });
  expect(
    await page.evaluate(async () =>
      (await (window as any).axe.run(document.getElementById("main"), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })).violations.map((v: any) => ({ id: v.id, nodes: v.nodes.map((n: any) => n.target) })),
    ),
  ).toEqual([]);
  // Skipping the column on purpose keeps the warning, and committing asks first.
  await page.getByRole("combobox", { name: "full_name" }).selectOption("");
  await page.getByRole("button", { name: "Save and check batch" }).click();
  await expect(results.getByRole("heading", { name: "Saved check results" })).toBeVisible();
  await page.getByRole("button", { name: "Commit checked batch" }).click();
  const dialog = page.getByRole("dialog", { name: "Commit with fallback values?" });
  await expect(dialog.getByText(warning)).toBeVisible();
  await dialog.getByRole("button", { name: "Review the mapping" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Commit checked batch" })).toBeFocused();
  await page.getByRole("button", { name: "Commit checked batch" }).click();
  await page.getByRole("dialog", { name: "Commit with fallback values?" }).getByRole("button", { name: "Commit anyway" }).click();
  await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Saved with fallback values" })).toBeVisible();
});
test("an unknown case says so at once, after a single request", async ({
  page,
}) => {
  const asked: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/pilot/cases/no-such-case")
      asked.push(request.method());
  });
  await page.goto("/cases/no-such-case");
  await expect(
    page.getByRole("heading", { name: "Case not found", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("no-such-case", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Back to exceptions" }),
  ).toHaveAttribute("href", "/exceptions");
  // A refusal is never repeated: past the first retry's one-second delay, still one request.
  await page.waitForTimeout(1500);
  expect(asked).toEqual(["GET"]);
});
