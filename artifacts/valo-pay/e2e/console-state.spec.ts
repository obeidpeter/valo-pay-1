import { test, expect, type Page } from "@playwright/test";

// What an open form and its recovery state survive in a real browser: the Back
// and Forward buttons, and a background workspace refresh that fails. The Back
// guard depends on the order of listeners on window, which jsdom and Chromium
// have not always agreed on, so it is proved in the browser too.
test.beforeEach(async ({ request, page }) => {
  await request.post("/__test/reset");
  await page.emulateMedia({ reducedMotion: "reduce" });
});

async function navigate(page: Page, name: string) {
  const menu = page.getByRole("button", { name: "Open menu", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("link", { name, exact: true }).click();
}

/** Every confirm the page raises, answered with `accept` at the time it is raised. */
function confirms(page: Page) {
  const seen: string[] = [];
  const answer = { accept: false };
  page.on("dialog", async (dialog) => {
    seen.push(dialog.message());
    await (answer.accept ? dialog.accept() : dialog.dismiss());
  });
  return { seen, answer };
}

test("browser Back and Forward ask before an unsaved draft is discarded", async ({ page }) => {
  const asked = confirms(page);
  await page.goto("/overview");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await navigate(page, "Settings");
  await expect(page.getByText("07:00 WAT").first()).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const contact = page.getByLabel("Lender contact details for customer notices");
  await contact.pressSequentially(" keep this");

  // Declined: the page and the draft stay.
  await page.evaluate(() => history.back());
  await expect.poll(() => asked.seen.length).toBe(1);
  expect(asked.seen[0]).toContain("Discard your unsaved changes?");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(contact).toHaveValue(/keep this/);
  await expect(page.getByRole("heading", { level: 1, name: "Settings", exact: true })).toBeVisible();

  // Accepted: Back leaves, and Forward returns to a page without the draft.
  asked.answer.accept = true;
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect.poll(() => asked.seen.length).toBe(2);
  await page.goForward();
  await expect(page.getByRole("heading", { level: 1, name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
});

test("browser Back keeps a case note when the person chooses to keep editing", async ({ page }) => {
  const asked = confirms(page);
  await page.goto("/exceptions");
  await page.getByRole("link", { name: "Open case" }).first().click();
  const note = page.getByRole("textbox", { name: "Handover or progress note" });
  await note.fill("Draft note for the next person");
  await page.goBack();
  await expect.poll(() => asked.seen.length).toBe(1);
  await expect(page).toHaveURL(/\/cases\//);
  await expect(note).toHaveValue("Draft note for the next person");
});

/** Answers every workspace request with this, until the returned function restores the service. */
async function breakWorkspace(page: Page, status: number, headers: Record<string, string> = {}) {
  let refused = 0;
  const handler = async (route: import("@playwright/test").Route) => {
    refused += 1;
    const html = status >= 500;
    await route.fulfill({
      status,
      headers: { "content-type": html ? "text/html" : "application/json", ...headers },
      body: html ? "<html><body>502 Bad Gateway</body></html>" : JSON.stringify({ error: "Too many requests. Try again in 1 minute.", requestId: "browser-limit" }),
    });
  };
  await page.route("**/api/v1/workspace", handler);
  return { refused: () => refused, restore: () => page.unroute("**/api/v1/workspace", handler) };
}

/** Moves the page's clock past the workspace's thirty-second refresh and the read's two repeats (1 s, then 2 s). */
async function passRefresh(page: Page, seconds = 31) {
  await page.clock.fastForward(seconds * 1000);
  for (let step = 0; step < 6; step += 1) {
    await page.waitForTimeout(150);
    await page.clock.runFor(1000);
  }
}

test("a failed background refresh keeps the open draft and says the workspace could not be refreshed", async ({ page }) => {
  await page.clock.install();
  await page.goto("/customers");
  await page.getByRole("button", { name: "Add customer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add customer" });
  await dialog.getByLabel(/^Full name/).fill("Draft customer typed before the outage");

  const outage = await breakWorkspace(page, 502);
  await passRefresh(page);
  expect(outage.refused()).toBeGreaterThan(0);
  const problem = page.getByRole("status").filter({ hasText: "Your workspace could not be refreshed." });
  await expect(problem).toBeVisible();
  await expect(problem).toContainText("Request history");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/^Full name/)).toHaveValue("Draft customer typed before the outage");
  await expect(page.getByText("No lender data has been changed.")).toHaveCount(0);

  // The dialog is modal, so the notice waits behind it; the next automatic refresh clears it.
  await outage.restore();
  await passRefresh(page);
  await expect(problem).toHaveCount(0);
  await expect(dialog.getByLabel(/^Full name/)).toHaveValue("Draft customer typed before the outage");
});

test("Try again on a failed refresh's notice refreshes the workspace at once", async ({ page }) => {
  await page.clock.install();
  await page.goto("/overview");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  const outage = await breakWorkspace(page, 502);
  await passRefresh(page);
  const problem = page.getByRole("status").filter({ hasText: "Your workspace could not be refreshed." });
  await expect(problem).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await outage.restore();
  await problem.getByRole("button", { name: "Try again" }).click();
  await expect(problem).toHaveCount(0);
});

test("a save whose answer was lost keeps its recovery through a failed refresh", async ({ page }) => {
  await page.clock.install();
  await page.goto("/customers");
  await page.getByRole("button", { name: "Add customer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add customer" });
  await dialog.getByLabel(/^Full name/).fill("Outage customer");
  await dialog.getByLabel(/^Loan software reference/).fill("OUTAGE-REF-001");
  await dialog.getByLabel(/^Consent source or reference/).fill("Synthetic signed form OUTAGE-1");
  // The save commits, then its answer is lost on the way back.
  await page.route("**/api/v1/records/customers?*", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch();
    await route.abort("connectionreset");
  });
  await dialog.getByRole("button", { name: "Add customer", exact: true }).click();
  await expect(dialog.getByText("Request not confirmed", { exact: true })).toBeVisible();

  const outage = await breakWorkspace(page, 502);
  await passRefresh(page);
  const problem = page.getByRole("status").filter({ hasText: "Your workspace could not be refreshed." });
  await expect(problem).toBeVisible();
  await expect(problem.getByRole("link", { name: "Request history" })).toHaveAttribute("href", "/operations");
  await expect(dialog.getByText("Request not confirmed", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Check original request" })).toBeVisible();
  await expect(page.getByText("No lender data has been changed.")).toHaveCount(0);
  await outage.restore();
});

test("a 429 on the refresh keeps the page and waits as long as the service asks", async ({ page }) => {
  await page.clock.install();
  await page.goto("/customers");
  await page.getByRole("button", { name: "Add customer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add customer" });
  await dialog.getByLabel(/^Full name/).fill("Half-written customer");

  const limited = await breakWorkspace(page, 429, { "Retry-After": "120" });
  await passRefresh(page);
  expect(limited.refused()).toBe(1);
  const problem = page.getByRole("status").filter({ hasText: "Your workspace could not be refreshed." });
  await expect(problem).toBeVisible();
  await expect(problem).toContainText("Too many requests. Try again in 1 minute.");
  await expect(dialog.getByLabel(/^Full name/)).toHaveValue("Half-written customer");
  await expect(page.getByRole("heading", { name: "Please wait before trying again" })).toHaveCount(0);

  // The next automatic refresh waits for the two minutes the service asked for, not the usual thirty seconds.
  await passRefresh(page, 60);
  expect(limited.refused()).toBe(1);
  await limited.restore();
  await passRefresh(page, 60);
  await expect(problem).toHaveCount(0);
  await expect(dialog.getByLabel(/^Full name/)).toHaveValue("Half-written customer");
});
