import { test, expect } from '@playwright/test';
import path from 'node:path';

test('public task help supports search, keyboard, history and reflow without opening a workspace', async ({ page }, info) => {
  const workspaceReads: string[] = [];
  const writes: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/workspace') workspaceReads.push(url.pathname);
    if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) writes.push(url.pathname);
  });
  await page.goto('/help');
  const search = page.getByLabel('Search tasks and terms', { exact: true });
  await search.fill('pending');
  await search.press('Enter');
  const guide = page.getByRole('link', { name: /Understand payment status without paying twice/ });
  await expect(guide).toBeVisible();
  await guide.focus();
  await guide.press('Enter');
  await expect(page.getByRole('heading', { name: 'Understand payment status without paying twice', exact: true })).toBeFocused();
  await expect(page.getByText(/Pending means/)).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Search results', exact: true })).toBeFocused();
  await expect(search).toHaveValue('pending');
  await page.reload();
  await expect(guide).toBeVisible();

  await page.addScriptTag({ path: path.resolve('node_modules/axe-core/axe.min.js') });
  const violations = await page.evaluate(async () => {
    const results = await (window as any).axe.run(document.body, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
    });
    return results.violations.map((violation: any) => ({ id: violation.id, nodes: violation.nodes.map((node: any) => node.target) }));
  });
  expect(violations).toEqual([]);
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(guide).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('public-help-reflow.png'), fullPage: true });
  expect(workspaceReads).toEqual([]);
  expect(writes).toEqual([]);
});
