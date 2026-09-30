import { test, expect } from "@playwright/test";
import { formatKobo } from "../../src/lib/formatters";

test("a slow committed customer request recovers its lost response without a second record", async ({
  page,
  context,
}) => {
  const arranged = await context.request.post("/__test/session");
  expect(arranged.ok()).toBeTruthy();
  const fixture = await arranged.json();
  const reference = "DB-INTERRUPTED-CUSTOMER";
  const name = "Synthetic recovery customer";
  const attempts: { key: string | undefined; body: string | null; url: string }[] = [];
  let committed: { status: number; record: { id: string } } | undefined;
  let releaseResponse!: () => void;
  const responseHeld = new Promise<void>((resolve) => { releaseResponse = resolve; });

  await page.route("**/api/v1/records/customers?*", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    attempts.push({
      key: request.headers()["idempotency-key"],
      body: request.postData(),
      url: request.url(),
    });
    if (attempts.length !== 1) return route.continue();
    // Commit through the real API/PostgreSQL first. Only delivery to this
    // browser is held and then lost; no success response or record is mocked.
    const response = await route.fetch({ maxRetries: 0 });
    committed = { status: response.status(), record: await response.json() };
    await responseHeld;
    await route.abort("connectionreset");
  });

  await page.goto("/customers");
  await page.getByRole("button", { name: "Add customer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add customer" });
  const fullName = dialog.getByLabel(/^Full name/);
  const loanReference = dialog.getByLabel(/^Loan software reference/);
  await fullName.fill(name);
  await loanReference.fill(reference);
  await dialog.getByLabel(/^Consent source or reference/).fill("Synthetic signed form DB-CONSENT-RECOVERY");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  try {
    await expect.poll(() => committed?.status).toBe(200);
    // The intentionally delayed acknowledgement must never be treated as
    // success, even though a separate read can already see the saved record.
    const savedBeforeAcknowledgement = await context.request.get(
      `/api/v1/records/customers?merchantId=${fixture.merchantId}&search=${reference}&limit=10`,
    );
    expect(savedBeforeAcknowledgement.ok()).toBeTruthy();
    expect((await savedBeforeAcknowledgement.json()).total).toBe(1);
    await expect(dialog).toBeVisible();
    const saving = dialog.getByRole("button", { name: "Saving…", exact: true });
    await expect(saving).toBeDisabled();
    await expect(saving).toHaveAttribute("aria-busy", "true");
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await expect(fullName).toBeDisabled();
    await expect(dialog.getByText("Outcome not confirmed", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("row").filter({ hasText: reference })).toHaveCount(0);
    expect(attempts).toHaveLength(1);
  } finally {
    releaseResponse();
  }

  await expect(dialog.getByText("Outcome not confirmed", { exact: true })).toBeVisible();
  await expect(fullName).toBeDisabled();
  await expect(fullName).toHaveValue(name);
  await expect(loanReference).toBeDisabled();
  await expect(loanReference).toHaveValue(reference);
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

  // Declining to abandon the uncertain session preserves the draft and retry.
  const closeWarning = new Promise<string>((resolve) => {
    page.once("dialog", async (warning) => {
      const message = warning.message();
      await warning.dismiss();
      resolve(message);
    });
  });
  await page.keyboard.press("Escape");
  expect(await closeWarning).toContain("Closing does not cancel the request");
  await expect(dialog).toBeVisible();
  expect(attempts).toHaveLength(1);

  const replayResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/records/customers?") && response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Retry same request", exact: true }).click();
  const replay = await replayResponse;
  expect(replay.ok()).toBeTruthy();
  expect((await replay.json()).id).toBe(committed!.record.id);
  await expect(dialog).toBeHidden();
  expect(attempts).toHaveLength(2);
  expect(attempts[0].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(attempts[1]).toEqual(attempts[0]);

  await page.reload();
  await page.getByLabel("Search customers").fill(reference);
  await expect(page.getByRole("row").filter({ hasText: reference })).toHaveCount(1);
  const stored = await context.request.get(
    `/api/v1/records/customers?merchantId=${fixture.merchantId}&search=${reference}&limit=10`,
  );
  expect(stored.ok()).toBeTruthy();
  const records = await stored.json();
  expect(records.total).toBe(1);
  expect(records.items).toHaveLength(1);
  expect(records.items[0]).toMatchObject({ id: committed!.record.id, name, reference, data: { synthetic: true } });
});

test("real API bootstrap, database history pages, full balances and lender isolation", async ({
  page,
  context,
}) => {
  // A fresh anonymous request exercises the real middleware and workspace bootstrap.
  const bootstrap = await context.request.get("/api/v1/workspace");
  expect(bootstrap.ok()).toBeTruthy();
  expect((await bootstrap.json()).environment).toBe("sandbox");
  const arranged = await context.request.post("/__test/session");
  expect(arranged.ok()).toBeTruthy();
  const fixture = await arranged.json();
  const responses: any[] = [];
  page.on("response", async (response) => {
    if (response.url().includes("/history?") && response.ok())
      responses.push(await response.json());
  });
  await page.goto(
    `/customers/${fixture.customerId}?record=${fixture.oldRecordId}`,
  );
  await expect(
    page.getByRole("region", { name: "Selected collection record" }),
  ).toContainText("DB-DUE-00");
  await expect(
    page.getByText(`${fixture.eventCount} events in the full history`, {
      exact: true,
    }),
  ).toBeVisible();
  const position = page
    .locator("div")
    .filter({
      has: page.getByRole("heading", {
        name: "Customer position",
        exact: true,
      }),
    })
    .last();
  await expect(position).toContainText(
    formatKobo(fixture.position.outstandingKobo),
  );
  await page
    .getByRole("button", { name: "Next page of history events" })
    .click();
  await expect(page).toHaveURL(/history-page=2/);
  await expect
    .poll(() => responses.some((r) => r.offsets.events === 25))
    .toBeTruthy();
  const second = responses.find((r) => r.offsets.events === 25);
  expect(second.position).toEqual(fixture.position);
  expect(second.events).toHaveLength(25);
  expect(second.totals.events).toBe(fixture.eventCount);
  expect(second.focusedRecord.id).toBe(fixture.oldRecordId);
  await page.reload();
  await expect(
    page.getByText(`${fixture.eventCount} events in the full history`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(position).toContainText(
    formatKobo(fixture.position.outstandingKobo),
  );
  const foreign = await context.request.get(
    `/api/v1/customers/${fixture.customerId}/history?merchantId=${fixture.otherMerchantId}`,
  );
  expect(foreign.status()).toBe(404);
  const invalid = await context.request.get(
    `/api/v1/customers/${fixture.customerId}/history?merchantId=${fixture.merchantId}&eventsLimit=101`,
  );
  expect(invalid.status()).toBe(400);
});

test("real reconciliation search, recorded rejection, reload persistence and audit evidence", async ({
  page,
  context,
}) => {
  const arranged = await context.request.post("/__test/session");
  expect(arranged.ok()).toBeTruthy();
  const fixture = await arranged.json();
  await page.goto("/reconciliation?view=review");
  await page.getByLabel("Search reconciliation").fill(fixture.paymentReference);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("1 to review", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name:"Confirm match", exact:true })).toHaveCount(1);
  await page.getByLabel("Search reconciliation").fill(fixture.customerName);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByText("1–25 of 31 matches to review", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Next page of matches to review" })
    .click();
  await expect(
    page.getByText("26–31 of 31 matches to review", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search reconciliation").fill("DOES-NOT-EXIST");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByText("No results match your search", { exact: true }).first(),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/proposals-page=/);
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(
    page.getByText("1–25 of 31 matches to review", { exact: true }),
  ).toBeVisible();
  const rejection = page.waitForResponse(
    (r) =>
      r.url().includes("/api/v1/actions") && r.request().method() === "POST",
  );
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
    .fill(
      "Synthetic database browser test: source evidence does not support this match.",
    );
  await dialog
    .getByRole("button", { name: "Reject match", exact: true })
    .click();
  const response = await rejection;
  expect(response.ok()).toBeTruthy();
  const action = await response.json();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(
    page.getByText("1–25 of 30 matches to review", { exact: true }),
  ).toBeVisible();
  const record = await context.request.get(
    `/api/v1/records/allocations?merchantId=${fixture.merchantId}&id=${action.record.id}&limit=1`,
  );
  expect(record.ok()).toBeTruthy();
  expect((await record.json()).items[0].status).toBe("superseded");
  const audit = await context.request.get(
    `/api/v1/records/audit?merchantId=${fixture.merchantId}&limit=25`,
  );
  expect(audit.ok()).toBeTruthy();
  expect(JSON.stringify(await audit.json())).toContain(
    "Synthetic database browser test",
  );
});
