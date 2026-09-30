import { test, expect, type Locator, type Page } from "@playwright/test";
import path from "node:path";

// Focus, headings and the presentation guide in a real browser (audit of 23
// September, items 6 to 8).
test.beforeEach(async ({ request, page }) => {
  await request.post("/__test/reset");
  await page.emulateMedia({ reducedMotion: "reduce" });
});

const focused = (page: Page) => page.evaluate(() => {
  const active = document.activeElement as HTMLElement | null;
  return active ? { tag: active.tagName.toLowerCase(), id: active.id, text: (active.getAttribute("aria-label") || active.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80) } : null;
});

const DAY = 86_400_000;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();
/** Answers the workspace as a staff pilot's, signed in as administrator A; everything else stays the synthetic API's. */
async function staffAdministrator(page: Page) {
  await page.route("**/api/v1/workspace", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), accessMode: "staff", actor: "Clerk:user_admin_a", role: "Admin" } });
  });
}
/** Answers a staff request as the service would, after long enough for the pressed button to wait disabled. */
const slowly = () => new Promise((resolve) => setTimeout(resolve, 600));

/** Whether the page has an h1, as axe's best-practice rule asks. */
async function headingOne(page: Page) {
  await page.addScriptTag({ path: path.resolve("node_modules/axe-core/axe.min.js") });
  return page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: "rule", values: ["page-has-heading-one"] } })).violations.map((v: any) => v.id));
}

test("focus follows Edit, Cancel and Save on Settings instead of falling to the page", async ({ page }) => {
  await page.goto("/settings");
  const edit = page.getByRole("button", { name: "Edit", exact: true });
  await edit.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => focused(page)).toMatchObject({ id: "settings-authorisationMode" });
  await page.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => focused(page)).toMatchObject({ tag: "button", text: "Edit" });
  await page.keyboard.press("Enter");
  await page.getByLabel("Lender contact details for customer notices").pressSequentially(" (updated)");
  await page.getByRole("button", { name: "Save", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Settings saved").first()).toBeVisible();
  await expect.poll(() => focused(page)).toMatchObject({ tag: "button", text: "Edit" });
});

test("a Pay by Bank step that removes its button moves focus to what it did", async ({ page }) => {
  await page.goto("/pay-by-bank");
  await page.getByRole("button", { name: /Create checkout/ }).click();
  await page.getByRole("button", { name: "Simulate authorisation" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason").fill("Review sample payment details");
  await dialog.getByRole("button", { name: "Simulate authorisation" }).click();
  const browserReturn = page.getByRole("button", { name: "Simulate return from bank" });
  await browserReturn.focus();
  await page.keyboard.press("Enter");
  await expect(browserReturn).toHaveCount(0);
  await expect.poll(() => focused(page)).toMatchObject({ tag: "p", text: expect.stringMatching(/^Return from the bank recorded\./) });
});

test("a decision on Team & access moves focus to what it did, and a staff administrator is still warned", async ({ page }) => {
  // Console review of 24 September, item 3, with the staff answers at the network edge.
  await staffAdministrator(page);
  const member = (id: string, name: string, role: string, expiresAt: string) => ({ id, actor: `Clerk:user_${id}`, name, role, status: "active", expiresAt, updatedAt: inDays(-1), lenderIds: [], allLenders: role === "Admin" });
  const members = [member("admin_a", "Ada Admin", "Admin", inDays(10)), member("admin_b", "Bola Admin", "Admin", inDays(60)), member("ops", "Chidi Ops", "Operations", inDays(80)), member("fin", "Funmi Obi", "Finance", inDays(80))];
  const change = (id: string, memberId: string, name: string, from: string, to: string) => ({ id, memberId, name, from: { role: from, status: "active" }, to: { role: to, status: "active" }, reason: "Covers the close reviews", requestedBy: "Clerk:user_admin_b", requestedAt: inDays(-0.1) });
  let invitations = [{ id: "i-1", email: "finance.new@example.test", role: "Finance", status: "pending", expiresAt: inDays(6), invitedBy: "Clerk:user_admin_b", approval: "awaiting", approvedBy: null }];
  let changes = [change("c-1", "ops", "Chidi Ops", "Operations", "Finance"), change("c-2", "fin", "Funmi Obi", "Finance", "Compliance reviewer")];
  await page.route("**/api/v1/team", (route) => route.request().method() === "GET" ? route.fulfill({ json: { mode: "staff", actor: "Clerk:user_admin_a", members, lenders: [], invitations, changes, events: [], message: "Verified staff access." } }) : route.fallback());
  await page.route(/\/api\/v1\/team\/(invitations|changes)\/[^/]+\/(approve|decline)$/, async (route) => {
    await slowly();
    const [, , , , kind, id, decision] = new URL(route.request().url()).pathname.split("/");
    if (kind === "invitations") { invitations = []; return route.fulfill({ json: { message: "Invitation approved: finance.new@example.test can now accept it as Finance." } }); }
    const request = changes.find((item) => item.id === id)!;
    changes = changes.filter((item) => item !== request);
    if (decision === "decline") return route.fulfill({ json: { message: "Change request declined. The membership is unchanged." } });
    return route.fulfill({ json: { id: request.memberId, actor: `Clerk:user_${request.memberId}`, name: request.name, role: request.to.role, status: "active", expiresAt: inDays(80), updatedAt: new Date().toISOString(), message: `Change approved: ${request.name} is now ${request.to.role} (active).`, pendingChange: null } });
  });
  await page.goto("/team");
  // Administrator A's access ends within 14 days: the warning's code loads for a staff administrator.
  await expect(page.getByRole("status", { name: "Administrator access" })).toContainText("Your administrator access ends on");
  const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Waiting for a second administrator" }) });
  for (const [name, said] of [["Approve invitation", /^Invitation approved/], ["Approve change", /^Change approved: Chidi Ops/], ["Decline change", /^Change request declined/]] as const) {
    const count = await panel.getByRole("button", { name }).count();
    await panel.getByRole("button", { name }).first().focus();
    await page.keyboard.press("Enter");
    await expect(panel.getByRole("button", { name })).toHaveCount(count - 1);
    await expect.poll(() => focused(page)).toMatchObject({ tag: "p", text: expect.stringMatching(said) });
  }
});

test("Approve turning it off and Keep the stop on move focus to what they did when their box goes", async ({ page }) => {
  // Console review of 24 September, item 3: another administrator asked to lift the stop.
  await staffAdministrator(page);
  let waiting = true, stopOn = true;
  await page.route(/\/api\/v1\/settings\?/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch(), body = await response.json();
    const release = { lender: { requestedBy: "Clerk:user_admin_b", requestedAt: inDays(-0.02), reason: "Provider incident resolved", policyId: null } };
    await route.fulfill({ response, json: { ...body, merchant: { ...body.merchant, killSwitch: stopOn }, settings: { ...body.settings, ...(waiting ? { emergencyStopReleases: release } : {}) } } });
  });
  await page.route(/\/api\/v1\/actions\?/, async (route) => {
    const sent = route.request().postDataJSON();
    if (!["approve_kill_switch_off", "kill_switch"].includes(sent.action)) return route.fallback();
    await slowly();
    waiting = false;
    stopOn = sent.action === "kill_switch";
    await route.fulfill({ json: { message: `Lender emergency stop is ${stopOn ? "on" : "off"}. No collection instruction was sent.`, data: { enabled: stopOn } } });
  });
  for (const [name, said] of [["Approve turning it off", /^Lender emergency stop is off\./], ["Keep the stop on", /^Lender emergency stop is on\./]] as const) {
    waiting = true;
    stopOn = true;
    await page.goto("/settings");
    await page.getByLabel("Reason for changing the emergency stop").fill("Second administrator's decision on the request");
    const button = page.getByRole("button", { name });
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(button).toHaveCount(0);
    await expect.poll(() => focused(page)).toMatchObject({ tag: "p", text: expect.stringMatching(said) });
  }
});

test("End presentation moves focus to the page content", async ({ page }) => {
  await page.goto("/presentation");
  await page.getByRole("button", { name: "Start presentation guide" }).click();
  const guide = page.getByRole("region", { name: "Presentation guide" });
  await guide.getByRole("button", { name: "End presentation" }).focus();
  await page.keyboard.press("Enter");
  await expect(guide).toHaveCount(0);
  await expect.poll(() => focused(page)).toMatchObject({ tag: "main", id: "main" });
});

test("loading and error states keep an h1", async ({ page }) => {
  // The workspace on its way.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/workspace", async (route) => { await held; await route.continue(); });
  await page.goto("/overview");
  await expect(page.getByRole("status").filter({ hasText: "Loading your workspace…" })).toBeVisible();
  expect(await headingOne(page)).toEqual([]);
  release();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await page.unroute("**/api/v1/workspace");

  // A page whose first load failed, with nothing to show.
  for (const [route, api, problem] of [
    ["/overview", "**/api/v1/overview?*", "We could not load the overview"],
    ["/pay-by-bank", "**/api/v1/connected?*", "Unable to load Pay by Bank"],
    ["/credit-desk", "**/api/v1/connected?*", "Unable to load Credit Desk"],
    ["/cash-desk", "**/api/v1/connected?*", "Unable to load Cash Desk"],
    ["/connections", "**/api/v1/connected?*", "Unable to load Permissions and readiness"],
  ] as const) {
    await page.route(api, (request) => request.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Lender not found in this workspace.", requestId: "browser-missing" }) }));
    await page.goto(route);
    await expect(page.getByText(problem)).toBeVisible();
    expect(await page.locator("h1").count(), route).toBe(1);
    expect(await headingOne(page), route).toEqual([]);
    await page.unroute(api);
  }
});

test("on a phone the presentation guide keeps its title on a line or two and leaves the page in view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await page.goto("/presentation");
  await page.getByRole("button", { name: "Start presentation guide" }).click();
  const guide = page.getByRole("region", { name: "Presentation guide" });
  await guide.getByLabel("Talking point").selectOption("2");
  const title = guide.getByText("3 of 6 · Explain the match");
  await expect(title).toBeVisible();
  const titleBox = (await title.boundingBox())!, guideBox = (await guide.boundingBox())!;
  const lineHeight = await title.evaluate((node) => parseFloat(getComputedStyle(node).lineHeight));
  // Before, the title was squeezed beside the buttons to one word a line (six lines) and the guide covered about 60% of the screen.
  expect(titleBox.height).toBeLessThanOrEqual(lineHeight * 2 + 1);
  expect(guideBox.height).toBeLessThanOrEqual(664 * 0.5);
  const action = guide.getByRole("link", { name: "Open the sample customer" });
  expect((await action.boundingBox())!.y).toBeGreaterThan(titleBox.y + titleBox.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("the anonymous sandbox on a host without sign-in never fetches Clerk's code", async ({ page, request }) => {
  const scripts = new Set<string>();
  page.on("request", (sent) => { if (sent.resourceType() === "script" || sent.url().endsWith(".js")) scripts.add(sent.url()); });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goto("/overview");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  // The console fetches every page's code while the browser is idle, Team & access among them.
  await expect.poll(() => [...scripts].some((url) => /\/team-[\w-]+\.js$/.test(url)), { timeout: 15_000 }).toBe(true);
  await page.waitForLoadState("networkidle");
  const withClerk: string[] = [];
  for (const url of scripts) if ((await (await request.get(url)).text()).includes('"@clerk/react"')) withClerk.push(url);
  expect(withClerk).toEqual([]);
  expect(scripts.size).toBeGreaterThan(5);
});

test("the landing page and the anonymous sandbox carry no shared schemas, zod or administrator warning in their entry script", async ({ page, request }) => {
  const scripts = new Set<string>();
  page.on("request", (sent) => { if (sent.resourceType() === "script" || sent.url().endsWith(".js")) scripts.add(sent.url()); });
  // Text the minifier keeps: zod's type names, a message of the shared record schemas and the warning's heading.
  const signatures = { zod: /ZodObject/, "shared schemas": /Use YYYY-MM-DD or a UTC timestamp/, "administrator warning": /Administrator access is ending/ };
  const entryCarries = async (route: string) => {
    const entry = await page.locator('script[type="module"][src]').getAttribute("src");
    const code = await (await request.get(entry!)).text();
    return Object.entries(signatures).filter(([, signature]) => signature.test(code)).map(([name]) => `${route}: ${name}`);
  };
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await entryCarries("/")).toEqual([]);
  await page.goto("/overview");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  expect(await entryCarries("/overview")).toEqual([]);
  // The console fetches every page's code while idle; none of it is the warning, which only a staff administrator loads.
  await expect.poll(() => [...scripts].some((url) => /\/team-[\w-]+\.js$/.test(url)), { timeout: 15_000 }).toBe(true);
  await page.waitForLoadState("networkidle");
  const withWarning: string[] = [];
  for (const url of scripts) if (signatures["administrator warning"].test(await (await request.get(url)).text())) withWarning.push(url);
  expect(withWarning).toEqual([]);
});

// Second review of the audit fixes, the older focus patterns, by keyboard in a real browser: paging, Discard original
// request and Revoke access.
/** A moment for each list answer, as a pilot's takes, so there is a page load to wait through. */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** From here on, notes whether keyboard focus ever rests on the page body: after every change to the page and on every frame. */
const watchFocus = (page: Page) => page.evaluate(() => {
  const seen = window as unknown as { focusFell?: boolean };
  seen.focusFell = false;
  const check = () => { if (!document.activeElement || document.activeElement === document.body) seen.focusFell = true; };
  new MutationObserver(check).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const frame = () => { check(); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
});
const focusFell = (page: Page) => page.evaluate(() => (window as unknown as { focusFell?: boolean }).focusFell);

/**
 * Pages a list to its last page by keyboard while the route holds each answer back: as each page loads the rows and the
 * pager stay and the pressed button keeps the focus, Previous takes it on the last page, and it never rests on the body.
 */
async function pageToTheEnd(page: Page, path: string, label: string) {
  await page.goto(path);
  const pager = page.getByRole("navigation", { name: `Pages of ${label}` });
  const next = pager.getByRole("button", { name: `Next page of ${label}` });
  const pages = Number((await pager.getByText(/^Page 1 of [\d,]+$/).innerText()).replace(/^Page 1 of |,/g, ""));
  expect(pages, path).toBeGreaterThan(2);
  await next.focus();
  await watchFocus(page);
  await page.keyboard.press("Enter");
  // While the next page loads the rows and the pager stay, and the pressed button keeps the focus.
  await expect(next).toHaveAttribute("aria-disabled", "true");
  expect(await focused(page), path).toMatchObject({ tag: "button", text: `Next page of ${label}` });
  for (let at = 2; at <= pages; at++) {
    if (at > 2) await page.keyboard.press("Enter");
    await expect(pager.getByText(`Page ${at} of ${pages}`, { exact: true })).toBeVisible();
    await expect(next).not.toHaveAttribute("aria-disabled", "true");
    if (at < pages) expect(await focused(page), path).toMatchObject({ tag: "button", text: `Next page of ${label}` });
  }
  // On the last page Next has nowhere to go: Previous takes the focus.
  await expect.poll(() => focused(page)).toMatchObject({ tag: "button", text: `Previous page of ${label}` });
  expect(await focusFell(page), path).toBe(false);
}

test("paging Customers and the Audit log by keyboard keeps focus on the pager control pressed, never on the page", async ({ page, request }) => {
  const lender = (await (await request.get("/api/v1/workspace")).json()).merchants[0].id;
  const rows = Array.from({ length: 60 }, (_, i) => `Pager customer ${String(i).padStart(2, "0")},E2E-PAGER-${i},Synthetic consent,Sandbox Bank,•••• 0001`);
  expect((await request.post(`/api/v1/imports?merchantId=${lender}`, { data: { kind: "customers", csv: "name,reference,consentProvenance,bankName,accountMasked\n" + rows.join("\n"), mapping: {}, identityColumn: "reference", syntheticOnly: true, commit: true } })).ok()).toBeTruthy();
  // Every audited write adds an entry: enough for three pages of the log.
  for (let i = 0; i < 60; i++) expect((await request.post(`/api/v1/actions?merchantId=${lender}`, { data: { action: "run_reconciliation" } })).ok()).toBeTruthy();
  await page.route(/\/api\/v1\/records\/(customers|audit)\?/, async (route) => { await pause(1000); await route.fallback(); });
  for (const [path, label] of [["/customers", "customers"], ["/audit", "audit entries"]] as const) await pageToTheEnd(page, path, label);
});

test("paging the Exceptions, Mandates and Collections queues and the close history by keyboard keeps focus on the pager control pressed", async ({ page, request }) => {
  test.setTimeout(90_000);
  const lender = (await (await request.get("/api/v1/workspace")).json()).merchants[0].id;
  // Sixty open exceptions give the queue three pages; the browser workspace already has 55 more mandates, instalments and closes.
  for (let i = 0; i < 60; i++) expect((await request.post(`/api/v1/records/exceptions?merchantId=${lender}`, { data: { name: `Pager exception ${i}`, reference: `E2E-PAGER-EXCEPTION-${i}`, data: { type: "mapping_needed", notes: "Synthetic paging check." } } })).ok()).toBeTruthy();
  await page.route(/\/api\/v1\/(queues\/(exceptions|mandates|collections)|close-history)\?/, async (route) => { await pause(700); await route.fallback(); });
  for (const [path, label] of [["/exceptions", "exceptions"], ["/mandates", "mandates"], ["/collections", "instalments"], ["/reports", "recorded closes"]] as const) await pageToTheEnd(page, path, label);
});

test("paging a pilot page's list by keyboard keeps focus on the page button pressed while the next page loads", async ({ page, request }) => {
  // Sixty more import batches give the list at least three pages.
  expect((await request.post("/__test/aged-batches?count=60")).ok()).toBeTruthy();
  await page.route(/\/api\/v1\/pilot\/batches\?/, async (route) => { await pause(700); await route.fallback(); });
  await page.goto("/imports");
  const next = page.getByRole("button", { name: "Next batches" }), range = page.getByText(/^1–25 of [\d,]+$/);
  const total = Number((await range.innerText()).replace(/^1–25 of |,/g, ""));
  expect(total).toBeGreaterThan(50);
  await next.focus();
  await watchFocus(page);
  await page.keyboard.press("Enter");
  await expect(next).toHaveAttribute("aria-disabled", "true");
  expect(await focused(page)).toMatchObject({ tag: "button", text: "Next batches" });
  for (let offset = 25; offset < total; offset += 25) {
    if (offset > 25) await page.keyboard.press("Enter");
    await expect(page.getByText(`${offset + 1}–${Math.min(offset + 25, total)} of ${total}`, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Previous batches" })).not.toHaveAttribute("aria-disabled", "true");
    if (offset + 25 < total) expect(await focused(page)).toMatchObject({ tag: "button", text: "Next batches" });
  }
  // On the last page Next has nowhere to go: Previous batches takes the focus.
  await expect.poll(() => focused(page)).toMatchObject({ tag: "button", text: "Previous batches" });
  expect(await focusFell(page)).toBe(false);
});

test("paging either picker by keyboard keeps the focus on the pager control pressed while the page loads", async ({ page, request }) => {
  const lender = (await (await request.get("/api/v1/workspace")).json()).merchants[0].id;
  const rows = Array.from({ length: 60 }, (_, i) => `Picker customer ${String(i).padStart(2, "0")},E2E-PICKER-${i},Synthetic consent,Sandbox Bank,•••• 0001`);
  expect((await request.post(`/api/v1/imports?merchantId=${lender}`, { data: { kind: "customers", csv: "name,reference,consentProvenance,bankName,accountMasked\n" + rows.join("\n"), mapping: {}, identityColumn: "reference", syntheticOnly: true, commit: true } })).ok()).toBeTruthy();
  await page.route(/\/api\/v1\/records\/(customers|due-items)\?/, async (route) => { await pause(700); await route.fallback(); });
  for (const { path, open, dialog: name, label } of [
    { path: "/mandates", open: () => page.getByRole("button", { name: "Add mandate" }).first().click(), dialog: "Add mandate", label: "customer choices" },
    { path: "/reconciliation", open: () => page.getByRole("row").filter({ hasText: "SBX-UNIDENTIFIED-001" }).getByRole("button", { name: "Allocate payment", exact: true }).click(), dialog: "Allocate payment", label: "instalment choices" },
  ]) {
    await page.goto(path);
    await open();
    const dialog = page.getByRole("dialog", { name });
    await expect(dialog.getByText(new RegExp(`^1–25 of [\\d,]+ ${label}$`))).toBeVisible();
    const next = dialog.getByRole("button", { name: `Next page of ${label}` });
    await next.focus();
    await page.keyboard.press("Enter");
    // While the next page loads the choices and the pager stay, a loading line beside them, and the pressed button keeps the focus.
    await expect(next).toHaveAttribute("aria-disabled", "true");
    await expect(dialog.getByText(/^Loading (customer|instalment) choices…$/)).toBeVisible();
    expect(await focused(page), path).toMatchObject({ tag: "button", text: `Next page of ${label}` });
    await expect(dialog.getByText(new RegExp(`^26–50 of [\\d,]+ ${label}$`))).toBeVisible();
    await expect(next).not.toHaveAttribute("aria-disabled", "true");
    expect(await focused(page), path).toMatchObject({ tag: "button", text: `Next page of ${label}` });
  }
});

test("paging either picker with its form complete, or pressing Enter in its search, sends nothing", async ({ page, request }) => {
  // Third review of the audit fixes, finding 1: Previous and Next were submit buttons of the picker's dialog form, so paging
  // a complete form sent the allocation or created the mandate.
  const lender = (await (await request.get("/api/v1/workspace")).json()).merchants[0].id;
  const rows = Array.from({ length: 60 }, (_, i) => `Picker customer ${String(i).padStart(2, "0")},E2E-PICKER-${i},Synthetic consent,Sandbox Bank,•••• 0001`);
  expect((await request.post(`/api/v1/imports?merchantId=${lender}`, { data: { kind: "customers", csv: "name,reference,consentProvenance,bankName,accountMasked\n" + rows.join("\n"), mapping: {}, identityColumn: "reference", syntheticOnly: true, commit: true } })).ok()).toBeTruthy();
  const writes: string[] = [];
  page.on("request", (sent) => { if (sent.method() !== "GET" && sent.url().includes("/api/v1/")) writes.push(`${sent.method()} ${new URL(sent.url()).pathname}`); });
  /** Next by keyboard and Previous by pointer, then Enter in the search: the page of choices changes and nothing is sent. */
  async function lookFurther(dialog: ReturnType<Page["getByRole"]>, label: string, search: string, term: string) {
    await dialog.getByRole("button", { name: `Next page of ${label}` }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByText(new RegExp(`^26–50 of [\\d,]+ ${label}$`))).toBeVisible();
    await dialog.getByRole("button", { name: `Previous page of ${label}` }).click();
    await expect(dialog.getByText(new RegExp(`^1–25 of [\\d,]+ ${label}$`))).toBeVisible();
    await dialog.getByRole("searchbox", { name: search }).fill(term);
    await page.keyboard.press("Enter");
    await expect(dialog.getByText(new RegExp(`^1–\\d+ of \\d+ ${label}$`))).toBeVisible();
    await page.waitForTimeout(500);
    expect(writes).toEqual([]);
    await expect(dialog).toBeVisible();
  }
  await page.goto("/reconciliation");
  await page.getByRole("row").filter({ hasText: "SBX-UNIDENTIFIED-001" }).getByRole("button", { name: "Allocate payment", exact: true }).click();
  const allocation = page.getByRole("dialog", { name: "Allocate payment" });
  await expect(allocation.getByText(/^1–25 of [\d,]+ instalment choices$/)).toBeVisible();
  await allocation.getByLabel(/^Instalment/).selectOption({ index: 1 });
  await allocation.getByLabel(/^Amount to allocate/).fill("100.00");
  await allocation.getByLabel(/^Reason/).fill("Looking further through the choices");
  await lookFurther(allocation, "instalment choices", "Find an instalment", "BROWSER-DUE-1");

  await page.goto("/mandates");
  await page.getByRole("button", { name: "Add mandate" }).first().click();
  const mandate = page.getByRole("dialog", { name: "Add mandate" });
  await expect(mandate.getByText(/^1–25 of [\d,]+ customer choices$/)).toBeVisible();
  await mandate.locator("#mandate-customerId").selectOption({ index: 1 });
  await mandate.getByLabel(/Mandate name/).fill("Mandate made by paging");
  await mandate.getByLabel(/Debit limit/).fill("500.00");
  await mandate.getByLabel(/Provider reference/).fill("E2E-PAGER-MANDATE");
  await mandate.getByLabel(/Consent evidence reference/).fill("E2E-PAGER-CONSENT");
  await mandate.locator("#mandate-policyId").selectOption({ index: 1 });
  await lookFurther(mandate, "customer choices", "Search customers", "Picker customer 1");
});

test("Discard original request moves focus back to the control that sent the request", async ({ page }) => {
  await staffAdministrator(page);
  // Another administrator asked to lift the stop; the approval never reaches the service, so the request still waits.
  await page.route(/\/api\/v1\/settings\?/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: { ...body, merchant: { ...body.merchant, killSwitch: true }, settings: { ...body.settings, emergencyStopReleases: { lender: { requestedBy: "Clerk:user_admin_b", requestedAt: inDays(-0.02), reason: "Provider incident resolved", policyId: null } } } } });
  });
  await page.route(/\/api\/v1\/actions\?/, async (route) => {
    if (route.request().postDataJSON().action !== "approve_kill_switch_off") return route.fallback();
    await slowly();
    await route.abort("connectionreset");
  });
  page.on("dialog", (dialog) => { void dialog.accept(); });
  await page.goto("/settings");
  await page.getByLabel("Reason for changing the emergency stop").fill("Second administrator's decision on the request");
  const approve = page.getByRole("button", { name: "Approve turning it off" });
  await approve.focus();
  await page.keyboard.press("Enter");
  const discard = page.getByRole("button", { name: "Discard original request" });
  await expect(discard).toBeVisible();
  await discard.focus();
  await page.keyboard.press("Enter");
  await expect(discard).toHaveCount(0);
  await expect.poll(() => focused(page)).toMatchObject({ tag: "button", text: "Approve turning it off" });
});

test("confirming Revoke access moves focus to what the revocation did once it is answered", async ({ page }) => {
  await staffAdministrator(page);
  const person = (id: string, name: string, role: string) => ({ id, actor: `Clerk:user_${id}`, name, role, status: "active", expiresAt: inDays(60), updatedAt: inDays(-1), lenderIds: [] as string[], allLenders: role === "Admin" });
  let chidi = person("ops", "Chidi Ops", "Operations");
  const admins = [person("admin_a", "Ada Admin", "Admin"), person("admin_b", "Bola Admin", "Admin")];
  await page.route("**/api/v1/team", (route) => route.request().method() === "GET" ? route.fulfill({ json: { mode: "staff", actor: "Clerk:user_admin_a", members: [...admins, chidi], lenders: [], invitations: [], changes: [], events: [], message: "Verified staff access." } }) : route.fallback());
  await page.route(/\/api\/v1\/team\/members\/ops$/, async (route) => {
    await pause(1500);
    chidi = { ...chidi, status: "revoked", updatedAt: new Date().toISOString() };
    const { lenderIds: _lenders, allLenders: _all, ...answer } = chidi;
    await route.fulfill({ json: { ...answer, message: "Chidi Ops’s access is revoked. Their lender access and pending invitations are removed.", pendingChange: null } });
  });
  await page.goto("/team");
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "Chidi Ops" }) });
  await card.getByLabel("Access for Chidi Ops").selectOption("revoked");
  await card.getByLabel("Reason for changing Chidi Ops").fill("Left the pilot team this week");
  await card.getByRole("button", { name: "Save access change" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Revoke Chidi Ops’s access?" });
  await dialog.getByRole("button", { name: "Revoke access" }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  // While the answer is on its way (1.5 s), focus waits on the page's main region, never on the body.
  await expect.poll(() => focused(page), { timeout: 1000 }).toMatchObject({ tag: "main", id: "main" });
  await expect.poll(() => focused(page)).toMatchObject({ tag: "p", text: expect.stringMatching(/^Chidi Ops’s access is revoked\./) });
  await expect(card.getByText(/^Operations · revoked/)).toBeVisible();
  await expect.poll(() => focused(page)).toMatchObject({ tag: "p", text: expect.stringMatching(/^Chidi Ops’s access is revoked\./) });
});

// Fourth review of the audit fixes, findings 1 and 2: a failed page sent focus to whichever problem notice rendered first,
// here the proposed matches' behind the allocation dialog, and Try again on a failed page dropped focus to the page body.
const badGateway = { status: 502, contentType: "text/html", body: "<html>Bad gateway</html>" };
/**
 * With the second page's answer failing, pages by keyboard and presses the notice's Try again twice: while the service
 * still fails, the notice goes as the page loads and then takes the focus back; once it answers, the page arrives and
 * the pager control pressed takes the focus back. A 5xx is tried three times, over about three seconds, before it shows.
 */
async function tryAgainKeepsFocus(page: Page, scope: Page | Locator, label: string, answer: { failing: boolean }) {
  await scope.getByRole("button", { name: `Next page of ${label}` }).focus();
  await page.keyboard.press("Enter");
  const retry = scope.getByRole("alert").filter({ hasText: `Unable to load ${label}` }).getByRole("button", { name: "Try again" });
  await expect(retry).toBeFocused({ timeout: 15_000 });
  await page.keyboard.press("Enter");
  await expect(retry).toHaveCount(0);
  await expect(retry).toBeFocused({ timeout: 15_000 });
  answer.failing = false;
  await page.keyboard.press("Enter");
  await expect(scope.getByText(new RegExp(`^26–50 of [\\d,]+ ${label}$`))).toBeVisible();
  await expect(scope.getByRole("button", { name: `Next page of ${label}` })).toBeFocused();
}

test("a failed page of the allocation picker moves focus to its own notice, inside its dialog, and Try again keeps it", async ({ page }) => {
  // The proposed matches cannot be read at all, so their table behind the dialog shows its problem notice.
  await page.route(/\/api\/v1\/reconciliation\/proposals\?/, (route) => route.fulfill(badGateway));
  const answer = { failing: true };
  await page.route(/\/api\/v1\/records\/due-items\?.*allocatable=true/, async (route) => {
    if (new URL(route.request().url()).searchParams.get("offset") !== "25") return route.fallback();
    return answer.failing ? route.fulfill(badGateway) : route.fallback();
  });
  await page.goto("/reconciliation");
  await expect(page.getByText(/^We could not load matches to review/)).toBeVisible();
  await page.getByRole("row").filter({ hasText: "SBX-UNIDENTIFIED-001" }).getByRole("button", { name: "Allocate payment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Allocate payment" });
  await expect(dialog.getByText(/^1–25 of [\d,]+ instalment choices$/)).toBeVisible();
  await tryAgainKeepsFocus(page, dialog, "instalment choices", answer);
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
});

test("Try again on a page of Customers that failed keeps the focus, whether the page fails again or arrives", async ({ page, request }) => {
  const lender = (await (await request.get("/api/v1/workspace")).json()).merchants[0].id;
  const rows = Array.from({ length: 60 }, (_, i) => `Pager customer ${String(i).padStart(2, "0")},E2E-RETRY-${i},Synthetic consent,Sandbox Bank,•••• 0001`);
  expect((await request.post(`/api/v1/imports?merchantId=${lender}`, { data: { kind: "customers", csv: "name,reference,consentProvenance,bankName,accountMasked\n" + rows.join("\n"), mapping: {}, identityColumn: "reference", syntheticOnly: true, commit: true } })).ok()).toBeTruthy();
  const answer = { failing: true };
  await page.route(/\/api\/v1\/records\/customers\?/, async (route) => {
    if (new URL(route.request().url()).searchParams.get("offset") !== "25") return route.fallback();
    return answer.failing ? route.fulfill(badGateway) : route.fallback();
  });
  await page.goto("/customers");
  await expect(page.getByText(/^1–25 of [\d,]+ customers$/)).toBeVisible();
  await tryAgainKeepsFocus(page, page, "customers", answer);
});

// Fourth review of the audit fixes, finding 3: a refused or lost Save lender access left focus on the page body, while its
// notice sat unfocused in the member's card.
for (const how of ["refused", "lost"] as const) test(`a ${how} Save lender access moves focus to the member's notice`, async ({ page, request }) => {
  await staffAdministrator(page);
  const lenders = (await (await request.get("/api/v1/workspace")).json()).merchants;
  const person = (id: string, name: string, role: string) => ({ id, actor: `Clerk:user_${id}`, name, role, status: "active", expiresAt: inDays(60), updatedAt: inDays(-1), lenderIds: role === "Admin" ? [] : [lenders[0].id], allLenders: role === "Admin" });
  const members = [person("admin_a", "Ada Admin", "Admin"), person("admin_b", "Bola Admin", "Admin"), person("ops", "Chidi Ops", "Operations")];
  await page.route("**/api/v1/team", (route) => route.request().method() === "GET" ? route.fulfill({ json: { mode: "staff", actor: "Clerk:user_admin_a", members, lenders, invitations: [], changes: [], events: [], message: "Verified staff access." } }) : route.fallback());
  await page.route(/\/api\/v1\/team\/members\/ops\/lenders$/, async (route) => {
    await slowly();
    if (how === "lost") return route.abort("connectionreset");
    return route.fulfill({ status: 409, json: { error: "This membership changed after you opened it. Refresh Team & access and review it before changing it again.", requestId: "fix60-409" } });
  });
  await page.goto("/team");
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "Chidi Ops" }) });
  await card.getByRole("checkbox", { checked: false }).first().check();
  await card.getByLabel("Reason for lender access change for Chidi Ops").fill("Needs the second lender for cover");
  const save = card.getByRole("button", { name: "Save lender access" });
  await save.focus();
  await page.keyboard.press("Enter");
  // The form waits disabled for the answer. Chromium then moves the focus to the page body; a browser that leaves it on
  // the disabled button is made to do the same, so every browser checks where it goes from there.
  await expect(save).toBeDisabled();
  await page.evaluate(() => { const active = document.activeElement as HTMLElement | null; if (active?.matches(":disabled")) active.blur(); });
  const notice = card.getByRole("alert").filter({ hasText: how === "refused" ? "This membership changed after you opened it." : "Outcome not confirmed" }).first();
  await expect(notice).toBeVisible();
  await expect(notice).toBeFocused();
});

// Review of the fourth review's console fixes: the card kept watching a refused Save lender access whose answer found the
// person in the invitation form, so creating an invitation there sent the focus back to the card's old notice.
test("an invitation's answer takes the focus, not a member's Save lender access refused while the person was in the invitation form", async ({ page, request }) => {
  await staffAdministrator(page);
  const lenders = (await (await request.get("/api/v1/workspace")).json()).merchants;
  const person = (id: string, name: string, role: string) => ({ id, actor: `Clerk:user_${id}`, name, role, status: "active", expiresAt: inDays(60), updatedAt: inDays(-1), lenderIds: role === "Admin" ? [] : [lenders[0].id], allLenders: role === "Admin" });
  const members = [person("admin_a", "Ada Admin", "Admin"), person("admin_b", "Bola Admin", "Admin"), person("ops", "Chidi Ops", "Operations")];
  await page.route("**/api/v1/team", (route) => route.request().method() === "GET" ? route.fulfill({ json: { mode: "staff", actor: "Clerk:user_admin_a", members, lenders, invitations: [], changes: [], events: [], message: "Verified staff access." } }) : route.fallback());
  await page.route(/\/api\/v1\/team\/members\/ops\/lenders$/, async (route) => {
    await pause(1500);
    return route.fulfill({ status: 409, json: { error: "This membership changed after you opened it. Refresh Team & access and review it before changing it again.", requestId: "fix60-409" } });
  });
  await page.route(/\/api\/v1\/team\/invitations$/, async (route) => {
    await slowly();
    return route.fulfill({ status: 201, json: { id: "inv-1", token: "a".repeat(64), approval: "not_required", message: "Invitation created. Share the link directly with this person; no email has been sent. It expires in seven days." } });
  });
  await page.goto("/team");
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "Chidi Ops" }) });
  await card.getByRole("checkbox", { checked: false }).first().check();
  await card.getByLabel("Reason for lender access change for Chidi Ops").fill("Needs the second lender for cover");
  const save = card.getByRole("button", { name: "Save lender access" });
  await save.focus();
  await page.keyboard.press("Enter");
  await expect(save).toBeDisabled();
  // While it waits, the person moves on to the invitation form, where the refusal finds them.
  const email = page.getByLabel("Verified email");
  await email.focus();
  await expect(card.getByRole("alert").filter({ hasText: "This membership changed after you opened it." }).first()).toBeVisible();
  await expect(email).toBeFocused();
  await email.fill("new.colleague@example.test");
  const create = page.getByRole("button", { name: "Create invitation" });
  await create.focus();
  await page.keyboard.press("Enter");
  // The button waits disabled for the answer; a browser that leaves the focus on it is made to drop it to the page body.
  await expect(create).toBeDisabled();
  await page.evaluate(() => { const active = document.activeElement as HTMLElement | null; if (active?.matches(":disabled")) active.blur(); });
  await expect.poll(() => focused(page)).toMatchObject({ tag: "p", text: expect.stringMatching(/^Invitation created\. Share the link directly/) });
});
