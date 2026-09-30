import { test, expect } from '@playwright/test';

test('entering the console from a scrolled public page keeps the environment header in view', async ({ page, request }) => {
  await request.post('/__test/reset');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  // The footer's entry point exercises a real long public page on every viewport.
  const entry = page.getByRole('navigation', { name: 'Explore the sandbox' }).getByRole('link', { name: 'Collections', exact: true });
  await entry.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  await entry.click();
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.locator('.environment-strip')).toBeInViewport({ ratio: 1 });
  expect(await page.locator('.console-shell').evaluate(node => node.getBoundingClientRect().top)).toBe(0);

  // Default focus can move even an overflow:hidden document. A reload can also
  // restore that offset after React's mount effects have already run.
  await page.getByRole('main').press('Control+Home');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await page.getByRole('main').press('Control+Home');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.locator('.environment-strip')).toBeInViewport({ ratio: 1 });
  expect(await page.locator('.console-shell').evaluate(node => node.getBoundingClientRect().top)).toBe(0);
});
