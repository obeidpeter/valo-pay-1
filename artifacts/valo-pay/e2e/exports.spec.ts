import { test, expect } from '@playwright/test';
import path from 'node:path';

test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });

test('saved exports keep exact history, file verification and recovery readable across screen sizes', async ({ page, request }, testInfo) => {
  const workspace = await (await request.get('/api/v1/workspace')).json(), merchantId = workspace.merchants[0].id;
  const ids: string[] = [];
  for (let index = 0; index < 27; index++) {
    const response = await request.post(`/api/v1/exports?merchantId=${merchantId}`, { data: { kind: 'customers', format: 'json' }, headers: { 'Idempotency-Key': `browser-export-${index}` } });
    expect(response.ok()).toBeTruthy(); ids.push((await response.json()).id);
  }
  const selected = ids[26]!;
  await page.goto(`/exports?job=${selected}`);
  await expect(page.getByRole('heading', { name: 'Saved exports', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open saved export', exact: true })).toHaveAttribute('href', new RegExp(selected));
  await expect(page.getByText('1–25 of 27', { exact: true })).toBeVisible();
  await page.getByText('Technical details', { exact: true }).click();
  await expect(page.getByText(/Checksum \(SHA-256\):/)).toBeVisible();
  await page.getByRole('button', { name: 'Next exports', exact: true }).click();
  await expect(page.getByText('26–27 of 27', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('26–27 of 27', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Export status', exact: true }).selectOption('failed');
  await expect(page.getByText(/No exports match this status/)).toBeVisible();
  await page.goto(`/exports?job=${selected}`);
  const real = await (await request.get(`/api/v1/exports/${selected}?merchantId=${merchantId}`)).json();
  await page.route(`**/api/v1/exports/${selected}?**`, async route => {
    await route.fulfill({ json: { ...real, status: 'running', stage: 'confirming', lastProgressAt: '2026-09-19T11:00:00.000Z', stalled: true, retryAllowed: true, recoveryAt: '2026-09-19T11:01:00.000Z' } });
  });
  await page.reload();
  await expect(page.getByText('File saved; finishing', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restart export', exact: true })).toBeVisible();
  await page.addScriptTag({ path: path.resolve('node_modules/axe-core/axe.min.js') });
  expect(await page.evaluate(async () => (await (window as any).axe.run(document.getElementById('main'), { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21aa'] } })).violations.map((item: any) => ({ id: item.id, nodes: item.nodes.map((node: any) => node.target) })))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  await page.getByRole('button', { name: 'Restart export', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('saved-export-recovery.png'), fullPage: true });
});
