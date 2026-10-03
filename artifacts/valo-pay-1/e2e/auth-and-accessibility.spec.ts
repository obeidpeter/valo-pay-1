import { test, expect, type Locator } from '@playwright/test';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

test.beforeEach(async ({ request, page }) => {
  await request.post('/__test/reset');
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

/** Measure the rendered edge against both adjacent surfaces, including native
 * fields. Axe does not test necessary non-text field boundaries. */
async function boundaryContrast(field: Locator) {
  return field.evaluate((node) => {
    const rgb = (colour: string) => (colour.match(/[\d.]+/g) || []).map(Number);
    const surface = (element: Element | null): number[] => {
      if (!element) return [255, 255, 255];
      const colour = rgb(getComputedStyle(element).backgroundColor);
      if (colour.length === 4 && colour[3] === 0) return surface(element.parentElement);
      return colour.slice(0, 3);
    };
    const luminance = (colour: number[]) => colour.map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    const edge = luminance(rgb(getComputedStyle(node).borderTopColor));
    return [surface(node), surface(node.parentElement)].map(colour => {
      const adjacent = luminance(colour);
      return (Math.max(edge, adjacent) + 0.05) / (Math.min(edge, adjacent) + 0.05);
    });
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`necessary form boundaries remain distinct in ${theme} mode`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('valo-pay-1:test:theme', value), theme);
    await page.goto('/sources');
    for (const label of ['Profile name', 'Source name', 'Record type', 'First delivery expected (WAT)']) {
      const field = label === 'Record type' ? page.getByRole('combobox', { name: label, exact: true }) : page.getByLabel(label, { exact: true });
      await expect(field).toBeVisible();
      for (const ratio of await boundaryContrast(field)) expect(ratio, `${theme}: ${label}`).toBeGreaterThanOrEqual(3);
    }
    const profile = page.getByLabel('Profile name', { exact: true });
    const edge = await profile.evaluate(node => getComputedStyle(node).borderColor);
    const decorative = await profile.evaluate(node => getComputedStyle(node.closest('section')!).borderColor);
    expect(edge).not.toBe(decorative);
    await profile.focus();
    expect(await profile.evaluate(node => parseFloat(getComputedStyle(node).outlineWidth))).toBeGreaterThanOrEqual(2);
    await page.goto('/imports');
    const csv = page.getByLabel('CSV content', { exact: true });
    await expect(csv).toBeVisible();
    for (const ratio of await boundaryContrast(csv)) expect(ratio, `${theme}: CSV content`).toBeGreaterThanOrEqual(3);
  });
}

test('enlarged root text uses the drawer and preserves keyboard navigation without page overflow', async ({ page }, info) => {
  await page.setViewportSize({ width: 768, height: 960 });
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => document.documentElement.style.setProperty('font-size', '200%', 'important'));
  });
  for (const route of ['/sources', '/lifecycle', '/reports', '/settings']) {
    await page.goto(route);
    await expect(page.locator('#main h1')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeVisible();
    await expect.poll(() => page.locator('#main').evaluate(main => main.scrollWidth - main.clientWidth), route).toBeLessThanOrEqual(1);
  }
  const menu = page.getByRole('button', { name: 'Open menu', exact: true });
  await menu.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Menu' });
  await expect(drawer.getByRole('link', { name: 'Settings', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(menu).toBeFocused();
  await page.keyboard.press('Enter');
  await drawer.getByRole('link', { name: 'Data sources', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Data sources' })).toBeVisible();
  await expect(page.locator('#main')).toBeFocused();
  await page.screenshot({ path: info.outputPath('sources-enlarged-text.png') });
  await menu.click();
  await expect(drawer).toBeVisible();
  await page.evaluate(() => document.documentElement.style.removeProperty('font-size'));
  await page.setViewportSize({ width: 1280, height: 960 });
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
  await expect(drawer).toBeHidden();
  await expect(page.locator('#main')).toBeFocused();
});

test('an unrelated hostname cannot implicitly select an authentication project', async ({ page, request }) => {
  const providerRequests: string[] = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'auth.valo-pay-1.test') { providerRequests.push(url.href); return route.abort(); }
    if (/\/clerk-session-[^/]+\.js$/.test(url.pathname)) providerRequests.push(url.href);
    const response = await request.get(`http://127.0.0.1:4174${url.pathname}${url.search}`);
    return route.fulfill({ response });
  });
  await page.goto('http://auth.valo-pay-1.test/sign-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in', exact: true })).toBeVisible();
  expect(providerRequests).toEqual([]);
});

test('the built auth entry keeps its provider, forms and verification exports', async ({ page }) => {
  // This entry is loaded through a runtime URL, so its public exports must not
  // be removed by tree-shaking. Merely building the app cannot catch that.
  const entry = (await readdir(path.resolve('dist/public/assets'))).find(name => /^clerk-session-.*\.js$/.test(name));
  expect(entry).toBeTruthy();
  const loaded: string[] = [];
  page.on('request', request => loaded.push(request.url()));
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in', exact: true })).toBeVisible();
  expect(loaded.filter(url => url.includes('/clerk-session-'))).toEqual([]);
  const exported = await page.evaluate(async url => Object.keys(await import(url)), `/assets/${entry}`);
  expect(exported.sort()).toEqual(['ClerkSession', 'ClerkSignIn', 'ClerkSignUp', 'VerifiedSession']);
  expect(loaded.every(url => new URL(url).hostname === '127.0.0.1')).toBe(true);
});
