import { test, expect, type APIRequestContext, type Locator } from "@playwright/test";

// Prepare for presentation through the real API and PostgreSQL, the routes the live site runs: a new sandbox, the
// run, the pages that show what it prepared, then a second press that saves nothing. This test server sets up no file
// storage unless PRIVATE_OBJECT_DIR is given, and then the exports step must say so in Valo Pay's words while every
// other step completes.
const steps = ["Import batches", "A case with an owner", "Pay by Bank checkouts", "Daily closes", "Close review", "Credit Desk", "Cash Desk", "Saved exports"];
const storage = Boolean(process.env.PRIVATE_OBJECT_DIR);
const NO_STORAGE = "Exports are not set up yet. Contact the Valo Pay team.";

async function expectSteps(items: Locator, status: string, exportsStatus = status) {
  await expect(items).toHaveCount(steps.length);
  for (const [index, label] of steps.entries()) {
    await expect(items.nth(index)).toContainText(`${index + 1}. ${label}`);
    await expect(items.nth(index)).toContainText(index === steps.length - 1 ? exportsStatus : status);
  }
}
/** How many audit log entries the lender has: every saved change adds one. */
async function auditEntries(request: APIRequestContext, lender: string): Promise<number> {
  const answer = await request.get(`/api/v1/records/audit?merchantId=${lender}&limit=1`);
  expect(answer.ok()).toBeTruthy();
  return (await answer.json()).total;
}

test("prepares a new sandbox through the real API, and a second press saves nothing", async ({ page, context }) => {
  test.setTimeout(240_000);
  await page.goto("/presentation");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Presentation");
  const lender = await page.locator('select[id^="lender-"]:visible').inputValue();
  const section = page.getByRole("region", { name: "Sample records for the presentation" });
  const items = section.getByRole("listitem"), summary = section.getByRole("status");
  await expectSteps(items, "Waiting");

  await section.getByRole("button", { name: "Prepare for presentation" }).click();
  await expect(summary).not.toHaveText("", { timeout: 180_000 });
  const exportsStatus = storage ? "Completed" : "Failed";
  await expectSteps(items, "Completed", exportsStatus);
  if (storage) await expect(summary).toHaveText("All 8 steps are done. Open Overview to start.");
  else {
    await expect(items.last()).toContainText(NO_STORAGE);
    await expect(summary).toHaveText("1 step failed. Select Prepare for presentation to try it again.");
  }
  await expect(page.getByRole("paragraph").filter({ hasText: /^Demo role: Admin$/ })).toBeVisible();

  // The seeded proposed match is still waiting in Matches to review.
  const matches = await (await context.request.get(`/api/v1/reconciliation/proposals?merchantId=${lender}`)).json();
  expect(matches.total).toBe(1);
  expect(matches.related.map((record: { reference: string }) => record.reference)).toEqual(expect.arrayContaining(["SBX-PAY-1003", "DEMO-LOAN-1003"]));

  // The pages show what was prepared.
  await page.goto("/imports");
  await expect(page.getByRole("button", { name: /Presentation payment evidence/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Presentation instalments/ })).toContainText("Imported");
  await page.goto("/pay-by-bank");
  const history = page.locator("section").filter({ has: page.getByRole("heading", { name: "Checkout history" }) });
  for (const status of ["Confirmed", "Awaiting authorisation", "Outcome unknown"]) await expect(history.getByRole("button", { name: new RegExp(status) })).toHaveCount(1);
  await page.goto("/close-review");
  const closes = page.getByRole("navigation", { name: "Daily closes" });
  await expect(closes.getByRole("link")).toHaveCount(3);
  await expect(closes.getByRole("link").first()).toContainText("Latest close");
  await expect(closes.getByRole("link").first()).toContainText("Waiting for review");
  await expect(page.getByText("Sandbox Finance", { exact: true }).first()).toBeVisible();
  await page.goto("/credit-desk");
  // Ada Okonkwo's assessment waits for a different person to review it: the button approves nothing.
  await expect(page.getByRole("heading", { level: 3, name: "Ada Okonkwo" })).toBeVisible();
  await expect(page.getByText(/^A different person must review this assessment\./)).toBeVisible();
  await page.getByRole("tab", { name: "Review history" }).click();
  await expect(page.getByText(/^No review yet for this version\./)).toBeVisible();
  const version = page.getByLabel("Assessment version");
  await version.selectOption((await version.locator("option", { hasText: "More evidence needed" }).getAttribute("value"))!);
  await expect(page.getByText(/Refusal is not a credit-risk penalty\./)).toBeVisible();
  await page.goto("/work");
  await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible();
  await expect(page.getByText("Ask the lender team for the customer’s signed consent record")).toBeVisible();

  // A second press finds every step done and saves nothing; without file storage the exports are refused again.
  const before = await auditEntries(context.request, lender);
  const writes: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/") && request.method() !== "GET") writes.push(new URL(request.url()).pathname); });
  await page.goto("/presentation");
  await section.getByRole("button", { name: "Prepare for presentation" }).click();
  await expect(summary).not.toHaveText("", { timeout: 120_000 });
  await expectSteps(items, "Already done", storage ? "Already done" : "Failed");
  expect(writes).toEqual(storage ? [] : ["/api/v1/exports"]);
  expect(await auditEntries(context.request, lender)).toBe(before);
  await expect(page.getByRole("paragraph").filter({ hasText: /^Demo role: Admin$/ })).toBeVisible();
});
