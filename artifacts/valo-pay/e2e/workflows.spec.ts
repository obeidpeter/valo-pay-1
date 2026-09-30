import { test, expect, type Page } from "@playwright/test";
test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
});
async function navigate(page: Page, name: string) {
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("link", { name, exact: true }).click();
}
test('unmatched searches explain the result and reconciliation search survives changing views',async({page})=>{
  for(const route of ['/exceptions','/mandates','/collections']) {
    await page.goto(route+'?q=nonexistent-search');
    await expect(page.getByText(/^No (exceptions|mandates|instalments) match your search$/)).toBeVisible();
    await expect(page.getByText(/^(All clear: no open exceptions|No mandates yet|No instalments yet)$/)).toHaveCount(0);
    await page.getByRole('button',{name:'Clear search'}).click();
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await expect(page.getByText(/^No (exceptions|mandates|instalments) match your search$/)).toHaveCount(0);
  }
  await page.goto('/reconciliation?view=review');
  await page.getByLabel('Search reconciliation').fill('BROWSER-MATCH');
  await page.getByRole('button',{name:'Search',exact:true}).click();
  await expect(page.getByText('1–25 of 55 matches to review',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'All sections',exact:true}).click();
  await expect(page.getByLabel('Search reconciliation')).toHaveValue('BROWSER-MATCH');
  await expect(page.getByText('1–25 of 55 matches to review',{exact:true})).toBeVisible();
});
test("the allocation picker counts only the instalments it offers", async ({ page }) => {
  await page.goto("/reconciliation");
  await page.getByRole("row").filter({ hasText: "SBX-UNIDENTIFIED-001" }).getByRole("button", { name: "Allocate payment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Allocate payment" });
  const pager = dialog.getByText(/^1–\d+ of \d+ instalment choices$/);
  await expect(pager).toBeVisible();
  const [, shown, total] = /^1–(\d+) of (\d+)/.exec(await pager.innerText())!;
  const offered = dialog.getByLabel(/^Instalment/).locator("option:not([value=''])");
  await expect(offered).toHaveCount(Number(shown));
  // Every page is full of choices, so the count is the number of instalments that can take a payment.
  expect(Number(total)).toBeGreaterThan(Number(shown));
  await expect(dialog.getByText("Paid, cancelled, closed and disputed instalments are not listed. Instalments on hold while Finance reviews an earlier reversal decision are not listed either.")).toBeVisible();
  // DEMO-LOAN-1001 is paid: searching for it offers nothing and says so, with no pager.
  await dialog.getByRole("searchbox", { name: "Find an instalment" }).fill("DEMO-LOAN-1001");
  await expect(dialog.getByText("No instalment that can take a payment matches this search.")).toBeVisible();
  await expect(offered).toHaveCount(0);
  await expect(dialog.getByRole("navigation", { name: "Pages of instalment choices" })).toHaveCount(0);
});
test("paged queue search, saved view, record return and browser history", async ({
  page,
}) => {
  await page.goto("/mandates");
  await expect(page.getByText(/^1–25 of \d+ mandates$/)).toBeVisible();
  await page.getByLabel("Search this queue").fill("BROWSER-MND");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByText("1–25 of 55 mandates", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next page of mandates" }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  // The pager names page 2 at once but keeps page 1's rows until page 2 arrives: read a row only once it has.
  await expect(page.getByRole("button", { name: "Next page of mandates" })).not.toHaveAttribute("aria-disabled", "true");
  const reference = await page
    .locator("tbody tr")
    .first()
    .locator("td")
    .first()
    .innerText();
  await page.locator("tbody tr").first().getByRole("link").click();
  await page.getByRole("link", { name: "Back to Mandates" }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await expect(page.getByText(reference, { exact: true })).toBeVisible();
  await page.locator("summary").filter({ hasText: "Saved views" }).click();
  await page.getByLabel("View name").fill("Activation desk");
  await page.getByRole("button", { name: "Save current view" }).click();
  const storedViews = await page.evaluate(() =>
    Object.entries(localStorage)
      .filter(([key]) => key.startsWith("valopay-queue-views-v2:"))
      .flatMap(([, value]) => JSON.parse(value)),
  );
  expect(storedViews).toEqual([
    { name: "Activation desk", view: "all", owner: "", type: "" },
  ]);
  await page.reload();
  await page.locator("summary").filter({ hasText: "Saved views" }).click();
  await page
    .getByRole("button", { name: "Activation desk", exact: true })
    .click();
  await expect(page.getByLabel("Search this queue")).toHaveValue("");
  await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page of mandates" }).click();
  await page.goBack();
  await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
});
test("close range uses native date fields, pages summaries and loads evidence on demand", async ({
  page,
}) => {
  const detailRequests: string[] = [];
  page.on("request", (r) => {
    if (/\/api\/v1\/close-history\//.test(r.url()))
      detailRequests.push(r.url());
  });
  await page.goto("/reports");
  await expect(
    page.getByRole("list", { name: "Recorded daily closes" }),
  ).toBeVisible();
  expect(detailRequests).toHaveLength(0);
  await page.getByLabel("From date (WAT)", { exact: true }).fill("2026-08-02");
  await page.getByLabel("To date (WAT)", { exact: true }).fill("2026-08-03");
  await page.getByRole("button", { name: "Apply dates" }).click();
  await expect(
    page.getByText(
      /Showing 2 recorded closes from 2 Aug 2026 to 3 Aug 2026/,
    ),
  ).toBeVisible();
  await page
    .getByRole("list", { name: "Recorded daily closes" })
    .locator("summary")
    .first()
    .click();
  await expect(
    page.getByText("Unallocated at start", { exact: true }),
  ).toBeVisible();
  expect(detailRequests).toHaveLength(1);
  const width = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(width.page).toBeLessThanOrEqual(width.viewport);
  await page.getByRole("button", { name: "Clear dates" }).click();
  await page
    .getByRole("button", { name: "Next page of recorded closes" })
    .click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Billing", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Issue invoice" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Pilot evidence", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "New experiment" }),
  ).toBeVisible();
});
test("a close's money in another currency is listed in that currency beside its naira", async ({ page, request }) => {
  // Second review of the audit fixes, console finding 1: a USD card payment held for Finance.
  const lender = (await (await request.get("/api/v1/workspace")).json()).merchants[0].id;
  const customer = (await (await request.get(`/api/v1/records/customers?merchantId=${lender}&limit=1`)).json()).items[0];
  const imported = await request.post(`/api/v1/imports?merchantId=${lender}`, { data: { kind: "observations", csv: `name,reference,customerId,amount,source,currency,channel\nUSD card payment,E2E-USD-1,${customer.reference},1000.00,card,USD,card`, mapping: {}, identityColumn: "reference", amountUnit: "naira", syntheticOnly: true, commit: true } });
  expect(imported.ok(), await imported.text()).toBeTruthy();
  expect((await request.post(`/api/v1/actions?merchantId=${lender}`, { data: { action: "run_reconciliation" } })).ok()).toBeTruthy();
  await page.goto("/reports");
  await page.getByRole("button", { name: "Run daily close" }).click();
  await expect(page.getByText("Daily close completed").first()).toBeVisible();
  // The sample closes are dated around the fixed clock; this close is the one they do not name.
  const latest = page.getByRole("list", { name: "Recorded daily closes" }).locator("li").filter({ hasNotText: "Recorded sample close" }).first();
  await latest.getByText("View close details").click();
  for (const label of ["Unallocated at start", "Unallocated at close"]) {
    await expect(latest.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd")).toContainText(/and USD\u00a01,000\.00 \(1 payment\)/);
  }
});
test("the API and the browser print a close's money in another currency with the same decimals", async ({ page, request }) => {
  // Third review of the audit fixes, finding 2: the API took a currency's decimals from Node's copy of CLDR and the console
  // from the browser's, which disagree for COP, HUF, IDR, PKR and RSD; both now take them from ISO 4217.
  const lender = (await (await request.get("/api/v1/workspace")).json()).merchants[0].id;
  const customer = (await (await request.get(`/api/v1/records/customers?merchantId=${lender}&limit=1`)).json()).items[0];
  const csv = ["name,reference,customerId,amount,source,currency,channel", `COP card,E2E-COP-1,${customer.reference},100000,card,COP,card`, `HUF card,E2E-HUF-1,${customer.reference},123456,card,HUF,card`, `RSD card,E2E-RSD-1,${customer.reference},5000,card,RSD,card`].join("\n");
  const imported = await request.post(`/api/v1/imports?merchantId=${lender}`, { data: { kind: "observations", csv, mapping: {}, identityColumn: "reference", amountUnit: "kobo", syntheticOnly: true, commit: true } });
  expect(imported.ok(), await imported.text()).toBeTruthy();
  expect((await request.post(`/api/v1/actions?merchantId=${lender}`, { data: { action: "run_reconciliation" } })).ok()).toBeTruthy();
  await page.goto("/reports");
  await page.getByRole("button", { name: "Run daily close" }).click();
  await expect(page.getByText("Daily close completed").first()).toBeVisible();
  const latest = page.getByRole("list", { name: "Recorded daily closes" }).locator("li").filter({ hasNotText: "Recorded sample close" }).first();
  // The close's own line, which the API wrote, and its details, which the browser writes.
  await expect(latest).toContainText("including COP 1,000.00, HUF 1,234.56 and RSD 50.00 in other currencies");
  await latest.getByText("View close details").click();
  await expect(latest.locator("dt", { hasText: "Unallocated at close" }).locator("xpath=following-sibling::dd")).toContainText(/COP\u00a01,000\.00 \(1 payment\), HUF\u00a01,234\.56 \(1 payment\) and RSD\u00a050\.00 \(1 payment\)/);
});
test("arriving at the accuracy review scrolls there once; paging a table keeps the view on that table", async ({
  page,
}) => {
  await page.goto("/reconciliation#precision-audit");
  const review = page.locator("#precision-audit");
  await expect(review).toBeFocused();
  await expect(review).toBeInViewport();
  const pager = page.getByRole("navigation", {
    name: "Pages of matches to review",
  });
  for (const next of ["Page 2 of 3", "Page 3 of 3"]) {
    await pager
      .getByRole("button", { name: "Next page of matches to review" })
      .click();
    await expect(pager.getByText(next, { exact: true })).toBeVisible();
    await expect(pager).toBeInViewport();
    await expect(review).not.toBeFocused();
  }
});
test("reconciliation pages retain evidence and reject a proposed match with a reason", async ({
  page,
  request,
}) => {
  const unbounded: string[] = [];
  page.on("request", (r) => {
    if (
      /\/api\/v1\/records\//.test(r.url()) &&
      !new URL(r.url()).searchParams.has("limit")
    )
      unbounded.push(r.url());
  });
  await page.goto("/reconciliation?view=review");
  await expect(
    page.getByRole("button", { name: "Next page of matches to review" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Next page of matches to review" })
    .click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Reject match", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("region", { name: "Match evidence" }),
  ).toBeVisible();
  await dialog
    .getByLabel(/Reason/)
    .fill("The synthetic source reference needs a separate Finance review.");
  const rejection = page.waitForResponse((response) =>
    response.url().includes("/api/v1/actions?") && response.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Reject match", exact: true })
    .click();
  const response = await rejection;
  const outcome = await response.json();
  expect(response.ok(), JSON.stringify(outcome)).toBeTruthy();
  const submitted = response.request().postDataJSON();
  expect(submitted.data.proposalId).toBeTruthy();
  expect(submitted.data.proposalUpdatedAt).toBeTruthy();
  expect(outcome.record).toMatchObject({
    id: submitted.data.proposalId,
    status: "superseded",
    data: { supersededReason: submitted.reason },
  });
  await expect(dialog).toBeHidden();
  const merchantId = new URL(response.url()).searchParams.get("merchantId");
  const saved = await request.get(`/api/v1/records/allocations?merchantId=${merchantId}&id=${submitted.data.proposalId}&limit=1`);
  expect(saved.ok()).toBeTruthy();
  expect((await saved.json()).items[0].status).toBe("superseded");
  expect(unbounded).toHaveLength(0);
  await navigate(page, "Reports");
  await expect(
    page.getByRole("heading", { name: "Reports & analytics" }),
  ).toBeVisible();
});
