import { test, expect, type Locator } from '@playwright/test';
import path from 'node:path';

// Prepare for presentation in a real browser, against the fake API server: the run, its progress and the pages it
// fills, then a second press that sends nothing. On a desktop and a phone.
test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });

const steps = ['Import batches', 'A case with an owner', 'Pay by Bank checkouts', 'Daily closes', 'Close review', 'Credit Desk', 'Cash Desk', 'Saved exports'];
async function expectSteps(items: Locator, status: string) {
  await expect(items).toHaveCount(steps.length);
  for (const [index, label] of steps.entries()) {
    await expect(items.nth(index)).toContainText(`${index + 1}. ${label}`);
    await expect(items.nth(index)).toContainText(status);
  }
}

test('Prepare for presentation fills the lender’s pages once, and a second press sends nothing', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const writes: Array<{ url: string; key?: string }> = [];
  page.on('request', request => { if (request.url().includes('/api/') && request.method() !== 'GET') writes.push({ url: request.url(), key: request.headers()['idempotency-key'] }); });
  await page.goto('/presentation');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Presentation');
  const section = page.getByRole('region', { name: 'Sample records for the presentation' });
  await expect(section.getByText('Sample data only. No money moves and nothing is sent to a bank.')).toBeVisible();
  const items = section.getByRole('listitem');
  await expectSteps(items, 'Waiting');
  expect(writes).toEqual([]);

  // The run's first read is held, so its busy state can be seen; later reads go straight through.
  let release!: () => void, first = true;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/workspace', async route => { if (first) { first = false; await held; } await route.continue(); });
  await section.getByRole('button', { name: 'Prepare for presentation' }).click();
  const busy = section.getByRole('button', { name: 'Preparing for presentation…' });
  await expect(busy).toBeDisabled();
  await expect(busy).toHaveAttribute('aria-busy', 'true');
  release();
  await expect(section.getByRole('status')).toHaveText('All 8 steps are done. Open Overview to start.', { timeout: 90_000 });
  await expectSteps(items, 'Completed');
  await expect(section.getByRole('button', { name: 'Prepare for presentation' })).toBeEnabled();
  // Every write with its own key, and the presenter's demo role as it was.
  expect(writes.length).toBeGreaterThan(30);
  expect(writes.every(write => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(write.key ?? ''))).toBe(true);
  expect(new Set(writes.map(write => write.key)).size).toBe(writes.length);
  await expect(page.getByRole('paragraph').filter({ hasText: /^Demo role: Admin$/ })).toBeVisible();

  await page.addScriptTag({ path: path.resolve('node_modules/axe-core/axe.min.js') });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await page.evaluate(async () => { await Promise.all(document.getAnimations().map(a => a.finished.catch(() => undefined))); });
    const violations = await page.evaluate(async () => (await (window as any).axe.run(document.getElementById('main'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map((v: any) => ({ id: v.id, targets: v.nodes.map((n: any) => n.target) })));
    expect(violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await section.screenshot({ path: testInfo.outputPath(`prepared-${theme}.png`) });
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'));

  // The seeded proposed match is still waiting in Matches to review.
  const lender = await page.locator('select[id^="lender-"]:visible').inputValue();
  const matches = await (await page.request.get(`/api/v1/reconciliation/proposals?merchantId=${lender}&q=SBX-PAY-1003`)).json();
  expect(matches.total).toBe(1);
  expect(matches.related.map((record: { reference: string }) => record.reference)).toEqual(expect.arrayContaining(['SBX-PAY-1003', 'DEMO-LOAN-1003']));

  // The pages show what was prepared.
  await page.goto('/pay-by-bank');
  const history = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Checkout history' }) });
  for (const status of ['Confirmed', 'Awaiting authorisation', 'Outcome unknown']) await expect(history.getByRole('button', { name: new RegExp(status) })).toHaveCount(1);
  await page.goto('/close-review');
  await expect(page.getByRole('navigation', { name: 'Daily closes' }).getByText('Waiting for review')).toHaveCount(1);
  await page.goto('/credit-desk');
  const version = page.getByLabel('Assessment version');
  await expect(version.locator('option')).toHaveCount(2);
  await expect(version.locator('option', { hasText: 'Policy checks met' })).toHaveCount(1);
  await version.selectOption((await version.locator('option', { hasText: 'More evidence needed' }).getAttribute('value'))!);
  await expect(page.getByText(/Refusal is not a credit-risk penalty\./)).toBeVisible();
  await page.goto('/imports');
  await expect(page.getByRole('button', { name: /Presentation payment evidence/ })).toBeVisible();

  // A second press finds every step done and sends nothing.
  await page.goto('/presentation');
  writes.length = 0;
  await section.getByRole('button', { name: 'Prepare for presentation' }).click();
  await expect(section.getByRole('status')).toHaveText('All 8 steps are done. Open Overview to start.', { timeout: 60_000 });
  await expectSteps(items, 'Already done');
  expect(writes).toEqual([]);
});
