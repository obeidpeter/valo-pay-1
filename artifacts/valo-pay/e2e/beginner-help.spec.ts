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
  await expect(page.getByText(/Awaiting authorisation, Authorised, Pending and Outcome unknown all mean the payment is not confirmed/)).toBeVisible();
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

test('overview metrics fit their cards beside the sidebar, and a wider amount scrolls in a frame the keyboard reaches', async ({ page, request }, info) => {
  await request.post('/__test/reset');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/overview');
  const metrics = page.getByRole('region', { name: 'Key metrics' });
  await expect(metrics.getByText('Reconciled collections', { exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.addScriptTag({ path: path.resolve('node_modules/axe-core/axe.min.js') });
  // A box that scrolls must be a keyboard stop with a name (design rationale, Accessibility audit).
  const unreachable = () => page.evaluate(async () => (await (window as any).axe.run(document.querySelector('[aria-labelledby="overview-metrics-title"]'), { runOnly: { type: 'rule', values: ['scrollable-region-focusable'] } })).violations.length);
  for (const width of [768, 800, 820, 1024, 1280, 1536]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
    // Each value's frame is its parent, which scrolls when the value is wider than the card.
    const values = await metrics.locator('.tabular-nums').evaluateAll(nodes => nodes.map(node => {
      const frame = node.parentElement!, range = document.createRange();
      range.selectNodeContents(node.firstChild!);
      return {
        value: node.firstChild!.textContent,
        overflows: frame.scrollWidth > frame.clientWidth + 1,
        lines: new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size,
        width: Math.round(range.getBoundingClientRect().width),
        room: frame.clientWidth,
      };
    }));
    expect(values.length).toBe(4);
    // axe passes a box that scrolls by less than 13 px, as the 768 px card did, so the widths are measured too.
    expect(values.filter(value => value.overflows || value.lines !== 1), `${width} px: ${JSON.stringify(values)}`).toEqual([]);
    expect(await unreachable(), `${width} px`).toBe(0);
    if (width === 768) await metrics.screenshot({ path: info.outputPath('overview-metrics-768.png') });
  }
  // Text at twice its size on a phone: an amount wider than its card stays on one line in a named frame that scrolls
  // and is in the tab order, so the keyboard reaches it.
  await page.setViewportSize({ width: 320, height: 800 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  const frame = metrics.getByRole('region', { name: 'Outstanding amount' });
  await expect(frame).toHaveAttribute('tabindex', '0');
  expect(await frame.evaluate(node => node.scrollWidth > node.clientWidth && node.textContent)).toBe('₦1,151,000.00');
  expect(await unreachable()).toBe(0);
});

test('a metric frame follows its amount when the typeface arrives, without waiting for the page to render again', async ({ page, request }) => {
  await request.post('/__test/reset');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // The typeface is held back, so the amounts are laid out first in a fallback face.
  let release = () => {};
  const held = new Promise<void>(resolve => { release = () => resolve(); });
  await page.route('**/*.woff2', async route => { await held; await route.continue(); });
  await page.setViewportSize({ width: 320, height: 800 });
  // Only the document is awaited: Firefox and WebKit hold the load event for the typeface held back here.
  await page.goto('/overview', { waitUntil: 'domcontentloaded' });
  const metrics = page.getByRole('region', { name: 'Key metrics' });
  await expect(metrics.getByText('Outstanding amount', { exact: true })).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.fontSize = '125%'; });
  release();
  await page.evaluate(() => document.fonts.ready);
  // In Plus Jakarta Sans at this size ₦1,151,000.00 is wider than its frame, which the frame must say at once. Here the
  // fallback face fitted it, so only the amount's width changed: no render, and no resize of the frame.
  await expect(metrics.getByRole('region', { name: 'Outstanding amount' })).toHaveAttribute('tabindex', '0');
  // A width change that no fallback face decides, as on a machine whose fallback is wider: letters spaced out.
  await page.addStyleTag({ content: '[aria-labelledby="overview-metrics-title"] .tabular-nums { letter-spacing: .25em }' });
  await expect(metrics.getByRole('region', { name: 'Reconciled collections' })).toHaveAttribute('tabindex', '0');
});
