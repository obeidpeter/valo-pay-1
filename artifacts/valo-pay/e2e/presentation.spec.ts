import { test, expect } from '@playwright/test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { presentationSamples } from '../src/lib/presenter-brief';
import { presentationSteps } from '../src/lib/presentation';

test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });

test('presentation preparation, downloads and guide are usable on desktop and phone', async ({ page }, testInfo) => {
  const writes: string[] = [];
  page.on('request', req => { if (req.url().includes('/api/') && req.method() !== 'GET') writes.push(req.method()); });
  await page.goto('/presentation');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Presentation');
  await page.getByRole('checkbox', { name: /I chose one sample lender/ }).check();
  await expect(page.getByRole('checkbox', { name: 'I pressed Prepare for presentation for this lender and checked each page I will show.' })).toBeVisible();
  const briefEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download presenter brief' }).click();
  const brief = await briefEvent;
  expect(brief.suggestedFilename()).toBe('valo-pay-presenter-brief.md');
  const briefText = await readFile((await brief.path())!, 'utf8');
  expect(briefText).toContain('external connection has not been verified');
  expect(briefText).toContain('## 20-minute run sheet');
  expect(briefText).toContain('  - 8:30 · Take a payment by bank · 90 seconds');
  expect(briefText).toContain('- 14:00 to 16:00: What is real and what comes next. Open Go-live evidence.');
  expect(briefText).toContain('- [ ] I pressed Prepare for presentation for this lender and checked each page I will show.');
  const csvEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV of payment evidence' }).click();
  const csv = await csvEvent;
  expect(await readFile((await csv.path())!, 'utf8')).toContain('18000.50,statement,PRES-D001');
  await page.addScriptTag({ path: path.resolve('node_modules/axe-core/axe.min.js') });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    // Inspect the settled theme, after its colour transitions have finished.
    await page.evaluate(async () => { await Promise.all(document.getAnimations().map(a => a.finished.catch(() => undefined))); });
    const violations = await page.evaluate(async () => (await (window as any).axe.run(document.getElementById('main'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map((v: any) => ({ id: v.id, targets: v.nodes.map((n: any) => n.target) })));
    expect(violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.evaluate(() => { document.getElementById('main')!.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath(`presentation-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.getByRole('button', { name: 'Start presentation guide' }).focus();
  await page.keyboard.press('Enter');
  const guide = page.getByRole('region', { name: 'Presentation guide' });
  await expect(guide).toBeVisible();
  await guide.getByRole('link', { name: 'Open Overview' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await guide.getByRole('button', { name: 'Next talking point' }).click();
  await page.reload();
  await expect(guide.getByText('2 of 9 · Bring in payment evidence')).toBeVisible();
  await guide.getByRole('link', { name: 'Open Import batches' }).click();
  await expect(page.getByRole('heading', { name: 'Import batches' })).toBeVisible();
  await guide.getByRole('button', { name: 'End presentation' }).click();
  await expect(guide).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('step three opens the sample customer, where rule R1 matched the payment automatically for exactly 1,800,050 kobo', async ({ page, request }) => {
  // The rehearsal: the pack imported through the batch routes, committed once, then reconciled.
  const lender = (await (await request.get('/api/v1/workspace')).json()).merchants[0].id;
  const kinds = ['customers', 'due-items', 'observations'];
  for (const [index, sample] of presentationSamples('2026-09-19').entries()) {
    const saved = await request.post(`/api/v1/pilot/batches?merchantId=${lender}`, { data: { name: sample.kind, kind: kinds[index], source: 'Presentation sample', sourceBatchId: sample.filename, businessDate: '2026-09-19', identityColumn: 'source_row_id', amountUnit: 'naira', syntheticOnly: true, mapping: {}, csv: sample.csv } });
    expect(saved.ok(), await saved.text()).toBeTruthy();
    const batch = await saved.json();
    const committed = await request.post(`/api/v1/pilot/batches/${batch.id}/commit?merchantId=${lender}`, { data: { expectedUpdatedAt: batch.updatedAt } });
    expect(committed.ok(), await committed.text()).toBeTruthy();
  }
  expect((await request.post(`/api/v1/actions?merchantId=${lender}`, { data: { action: 'run_reconciliation' } })).ok()).toBeTruthy();
  const records = async (kind: string) => (await (await request.get(`/api/v1/records/${kind}?merchantId=${lender}`)).json()).items as Array<{ id: string; reference: string; status: string; amountKobo: number; data: Record<string, unknown> }>;
  const customer = (await records('customers')).find(item => item.reference === 'PRES-C001')!;
  const due = (await records('due-items')).find(item => item.reference === 'PRES-D001')!;
  const matches = (await records('allocations')).filter(item => item.data.dueItemId === due.id);
  expect(matches.map(item => ({ status: item.status, amountKobo: item.amountKobo, rule: item.data.rule, confidence: item.data.confidence, automatic: item.data.automatic }))).toEqual([{ status: 'confirmed', amountKobo: 1_800_050, rule: 'R1', confidence: 'certain', automatic: true }]);

  const writes: string[] = [];
  page.on('request', req => { if (req.url().includes('/api/') && req.method() !== 'GET') writes.push(req.method()); });
  await page.goto('/presentation');
  await page.getByRole('button', { name: 'Start presentation guide' }).click();
  const guide = page.getByRole('region', { name: 'Presentation guide' });
  await guide.getByLabel('Talking point').selectOption('2');
  await expect(guide.getByText('3 of 9 · Explain the match')).toBeVisible();
  const open = guide.getByRole('link', { name: 'Open the sample customer' });
  await expect(open).toHaveAttribute('href', `/customers/${customer.id}`);
  await open.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Presentation customer' })).toBeVisible();
  const match = page.getByText(/^Matched automatically by rule R1\. Confidence: Certain\. Provider reference PRES-O001 matches instalment PRES-D001/);
  await expect(match).toBeVisible();
  await expect(guide.getByRole('button', { name: 'End presentation' })).toBeVisible();
  expect(writes).toEqual([]);
});

test('the guide takes nine talking points by keyboard and opens Pay by Bank, Credit Desk and Cash Desk', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', req => { if (req.url().includes('/api/') && req.method() !== 'GET') writes.push(req.method()); });
  await page.goto('/presentation');
  await expect(page.getByRole('heading', { level: 2, name: 'Nine moments that explain the value' })).toBeVisible();
  await page.getByRole('button', { name: 'Start presentation guide' }).click();
  const guide = page.getByRole('region', { name: 'Presentation guide' });
  const list = guide.getByLabel('Talking point');
  await list.selectOption('5');
  for (const [counter, action, href, heading] of [
    ['6 of 9 · Take a payment by bank', 'Open Pay by Bank', '/pay-by-bank', 'Pay by Bank'],
    ['7 of 9 · Check an applicant’s affordability', 'Open Credit Desk', '/credit-desk', 'Credit Desk'],
    ['8 of 9 · See the business’s cash', 'Open Cash Desk', '/cash-desk', 'Cash Desk'],
  ] as const) {
    await expect(guide.getByText(counter)).toBeVisible();
    const open = guide.getByRole('link', { name: action });
    await expect(open).toHaveAttribute('href', href);
    await open.click();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await guide.getByRole('button', { name: 'Next talking point' }).focus();
    await page.keyboard.press('Enter');
  }
  // The last press leaves Next talking point unavailable, so the focus goes to the talking points, not the page body.
  await expect(guide.getByText('9 of 9 · Leave with the evidence')).toBeVisible();
  await expect(guide.getByRole('button', { name: 'Next talking point' })).toBeDisabled();
  await expect(list).toBeFocused();
  await expect(list).toHaveValue('8');
  await expect(guide.getByRole('link', { name: 'Open Saved exports' })).toHaveAttribute('href', '/exports');
  expect(writes).toEqual([]);
});

test('typing a talking point’s number picks it from the list', async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('chromium'), 'Chromium changes a closed list as the key is typed; Firefox and WebKit may open it instead.');
  await page.goto('/presentation');
  await page.getByRole('button', { name: 'Start presentation guide' }).click();
  const guide = page.getByRole('region', { name: 'Presentation guide' });
  await guide.getByLabel('Talking point').focus();
  for (const [key, counter] of [['7', '7 of 9 · Check an applicant’s affordability'], ['9', '9 of 9 · Leave with the evidence'], ['2', '2 of 9 · Bring in payment evidence']] as const) {
    await page.keyboard.press(key);
    await expect(guide.getByText(counter)).toBeVisible();
    // The list reads keys typed within a second as one search, so the next number waits until that has passed.
    await page.waitForTimeout(1_100);
  }
});

test('on a phone the guide fits each of the nine talking points and shows the one chosen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await page.goto('/presentation');
  await page.getByRole('button', { name: 'Start presentation guide' }).click();
  const guide = page.getByRole('region', { name: 'Presentation guide' });
  const list = guide.getByLabel('Talking point');
  for (const [index, step] of presentationSteps.entries()) {
    await list.selectOption(String(index));
    const title = guide.getByText(`${index + 1} of ${presentationSteps.length} · ${step.title}`);
    await expect(title).toBeVisible();
    const titleBox = (await title.boundingBox())!, guideBox = (await guide.boundingBox())!, listBox = (await list.boundingBox())!;
    const lineHeight = await title.evaluate((node) => parseFloat(getComputedStyle(node).lineHeight));
    expect(titleBox.height, step.title).toBeLessThanOrEqual(lineHeight * 2 + 1);
    expect(guideBox.height, step.title).toBeLessThanOrEqual(664 * 0.5);
    // The list has its own row, wide enough to show the talking point's title, with Next talking point under it.
    expect(listBox.width, step.title).toBeGreaterThan(guideBox.width * 0.6);
    expect((await guide.getByRole('button', { name: 'Next talking point' }).boundingBox())!.y, step.title).toBeGreaterThanOrEqual(listBox.y + listBox.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
});
