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
    await page.addInitScript(value => localStorage.setItem('valopay-theme', value), theme);
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
    await expect(page.getByRole('complementary', { name: 'Console sidebar' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
    await expect.poll(() => page.locator('#main').evaluate(main => main.scrollWidth - main.clientWidth), route).toBeLessThanOrEqual(1);
  }
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
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
  await expect(page.getByRole('complementary', { name: 'Console sidebar' })).toBeVisible();
  await expect(drawer).toBeHidden();
  await expect(page.locator('#main')).toBeFocused();
});

test('a failed auth entry is fetched again at a fresh URL without reloading the page', async ({ page, request }) => {
  // An isolated domain enables the real production loader. All traffic is
  // intercepted: no identity provider or real credentials are involved.
  // auth-session.test.tsx separately checks the real provider/form context.
  const attempts: string[] = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'auth.valopay.test') return route.abort();
    if (/\/clerk-session-[^/]+\.js$/.test(url.pathname)) {
      attempts.push(url.href);
      if (attempts.length === 1) return route.fulfill({ status: 503, contentType: 'text/javascript', body: 'Unavailable' });
      return route.fulfill({ contentType: 'text/javascript', body: `
        let placed = false;
        export function ClerkSession({ slots }) {
          if (!placed) { placed = true; queueMicrotask(() => {
            for (const [, slot] of slots.snapshot()) {
              const form = document.createElement('form');
              form.setAttribute('aria-label', 'Recovered test sign-in');
              form.innerHTML = '<label>Test account<input type="text" /></label>';
              slot.node.append(form);
            }
          }); }
          return null;
        }
        export function ClerkSignIn() { return null; }
        export function ClerkSignUp() { return null; }
        export function VerifiedSession() { return null; }
      ` });
    }
    const response = await request.get(`http://127.0.0.1:4173${url.pathname}${url.search}`);
    return route.fulfill({ response });
  });
  await page.goto('http://auth.valopay.test/sign-in');
  await expect(page.getByRole('alert')).toContainText('We could not load sign-in.');
  await page.evaluate(() => {
    const draft = document.createElement('input');
    draft.setAttribute('aria-label', 'Open draft');
    draft.value = 'Unsaved sample work';
    document.getElementById('main')!.append(draft);
  });
  await page.getByRole('alert').getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Recovered test sign-in' })).toBeVisible();
  await expect(page.getByLabel('Open draft')).toHaveValue('Unsaved sample work');
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).not.toBe(attempts[1]);
  await expect(page.getByRole('alert')).toHaveCount(0);
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
