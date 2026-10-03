import { test, expect } from '@playwright/test';
import path from 'node:path';

test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });

test('a proposed source correction preserves the original record and shows its review evidence on every screen size', async ({ page, request }, info) => {
  const workspace = await (await request.get('/api/v1/workspace')).json(), merchantId = workspace.merchants[0].id;
  const saved = await request.post(`/api/v1/pilot/batches?merchantId=${merchantId}`, { data: { name: 'Browser source correction', kind: 'customers', source: 'browser-lms', sourceBatchId: 'browser-correction-source', businessDate: '2026-09-18', identityColumn: 'source_row_id', amountUnit: 'naira', mapping: {}, syntheticOnly: true, csv: 'source_row_id,name,reference,consentProvenance\nrow-1,Original sample customer,BROWSER-CORRECTION-1,Synthetic consent record' } });
  expect(saved.ok()).toBeTruthy(); const batch = await saved.json();
  const committed = await request.post(`/api/v1/pilot/batches/${batch.id}/commit?merchantId=${merchantId}`, { data: { expectedUpdatedAt: batch.updatedAt } });
  expect(committed.ok()).toBeTruthy();
  const customer = (await (await request.get(`/api/v1/records/customers?merchantId=${merchantId}&search=BROWSER-CORRECTION-1`)).json()).items[0];
  await page.goto(`/imports?batch=${batch.id}`);
  await page.getByRole('combobox', { name: 'Imported record', exact: true }).selectOption(customer.id);
  await page.getByLabel('Corrected customer name', { exact: true }).fill('Corrected sample customer');
  await page.getByRole('button', { name: 'Preview correction', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Before and after', exact: true })).toBeVisible();
  await page.getByLabel('Reason for correction', { exact: true }).fill('Correct the spelling against the original source evidence.');
  await page.getByLabel('Evidence reference', { exact: true }).fill('SYNTHETIC-CORRECTION-001');
  await page.getByRole('combobox', { name: 'Finance reviewer', exact: true }).selectOption('Sandbox Finance');
  await page.getByRole('button', { name: 'Send correction for review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for review', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve and apply correction', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Waiting for review', exact: true })).toBeVisible();
  const unchanged = (await (await request.get(`/api/v1/records/customers?merchantId=${merchantId}&id=${customer.id}`)).json()).items[0];
  expect(unchanged.name).toBe('Original sample customer');
  await page.addScriptTag({ path: path.resolve('node_modules/axe-core/axe.min.js') });
  expect(await page.evaluate(async () => (await (window as any).axe.run(document.getElementById('main'), { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21aa'] } })).violations.map((item: any) => ({ id: item.id, nodes: item.nodes.map((node: any) => node.target) })))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  await page.getByRole('heading', { name: 'Waiting for review', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('import-correction-review.png'), fullPage: true });
});
