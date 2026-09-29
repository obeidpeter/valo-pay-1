import { test, expect } from '@playwright/test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { presentationSamples } from '../src/lib/presenter-brief';

test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });

test('presentation preparation, downloads and guide are usable on desktop and phone', async ({ page }, testInfo) => {
  const writes: string[] = [];
  page.on('request', req => { if (req.url().includes('/api/') && req.method() !== 'GET') writes.push(req.method()); });
  await page.goto('/presentation');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Presentation');
  await page.getByRole('checkbox', { name: /I chose one sample lender/ }).check();
  const briefEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download presenter brief' }).click();
  const brief = await briefEvent;
  expect(brief.suggestedFilename()).toBe('valo-pay-presenter-brief.md');
  expect(await readFile((await brief.path())!, 'utf8')).toContain('external connection has not been verified');
  const csvEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download payment evidence CSV' }).click();
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
  await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
  await guide.getByRole('button', { name: 'Next talking point' }).click();
  await page.reload();
  await expect(guide.getByText('2 of 6 · Bring in payment evidence')).toBeVisible();
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
  await expect(guide.getByText('3 of 6 · Explain the match')).toBeVisible();
  const open = guide.getByRole('link', { name: 'Open the sample customer' });
  await expect(open).toHaveAttribute('href', `/customers/${customer.id}`);
  await open.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Presentation customer' })).toBeVisible();
  const match = page.getByText(/^Matched automatically and with certainty by rule R1\. Provider reference PRES-O001 resolved to instalment PRES-D001/);
  await expect(match).toBeVisible();
  await expect(guide.getByRole('button', { name: 'End presentation' })).toBeVisible();
  expect(writes).toEqual([]);
});
