import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

test.beforeEach(async ({ request, page }) => {
  await request.post('/__test/reset');
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

async function audit(page: Page) {
  await page.addScriptTag({ path: path.resolve('node_modules/axe-core/axe.min.js') });
  expect(await page.evaluate(async () => (await (window as any).axe.run(document.getElementById('main'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((item: any) => ({ id: item.id, nodes: item.nodes.map((node: any) => ({ target: node.target, summary: node.failureSummary })) })))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
}

test('the current assignee can review and acknowledge a handover without resolving its source case', async ({ page, request }, info) => {
  const workspace = await (await request.get('/api/v1/workspace')).json(), lender = workspace.merchants[0].id;
  const source = (await (await request.get(`/api/v1/records/exceptions?merchantId=${lender}`)).json()).items[0];
  const saved = await request.post(`/api/v1/pilot/cases/${source.id}?merchantId=${lender}`, { data: { action: 'handover', expectedUpdatedAt: source.updatedAt, assignee: workspace.actor, note: 'Handing this sample case to the named administrator.', nextAction: 'Inspect the sample payment evidence and record the outcome.', nextActionAt: '2026-09-20T10:00:00.000Z', evidenceIds: [] } });
  expect(saved.ok()).toBeTruthy();
  await page.goto('/work');
  await page.getByRole('button', { name: 'Acknowledge handover', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Acknowledge handover?' });
  await expect(dialog.getByRole('button', { name: 'Acknowledge handover' })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'I have checked this handover and its next step.' }).check();
  await dialog.getByRole('button', { name: 'Acknowledge handover', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(/Handover acknowledged\. The case and its next step stay open/)).toBeVisible();
  await page.getByRole('button', { name: 'Mark as read', exact: true }).click();
  await expect(page.getByText(/Notification marked as read/)).toBeVisible();
  await page.reload();
  await expect(page.getByText('Inspect the sample payment evidence and record the outcome.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Acknowledge handover', exact: true })).toHaveCount(0);
  expect((await (await request.get(`/api/v1/records/exceptions?merchantId=${lender}&id=${source.id}`)).json()).items[0].status).toBe('in_progress');
  await audit(page);
  await page.screenshot({ path: info.outputPath('personal-work-receipts.png'), fullPage: true });
});

test('an approved retention run keeps going until every source is removed', async ({ page, request }) => {
  expect((await request.post('/__test/aged-batches?count=3')).ok()).toBeTruthy();
  await page.goto('/lifecycle');
  await page.getByRole('checkbox', { name: 'Import files (CSV)' }).check();
  await page.getByLabel('Reason for the policy change').fill('Pilot agreement: raw files are kept for 30 days only.');
  await page.getByRole('button', { name: 'Save retention policy' }).click();
  await expect(page.getByText('Retention policy saved. Saving a policy does not delete data.')).toBeVisible();
  await page.getByRole('button', { name: 'Prepare deletion preview' }).click();
  await page.getByRole('checkbox', { name: /I have checked every item/ }).check();
  await page.getByLabel('Reason for approving this deletion').fill('Approved under the pilot retention agreement.');
  await page.getByRole('button', { name: 'Approve deletion' }).click();
  // The sample service removes one source a request: one click carries the run through all three.
  await page.getByRole('button', { name: 'Start deletion' }).click();
  const outcome = page.getByText('Deletion run complete. See its deletion records below.');
  await expect(outcome).toBeVisible();
  await expect(outcome).toBeFocused();
  await expect(page.getByText('3 items · 3 deleted · 0 left.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /Start deletion|Continue deletion|Stop/ })).toHaveCount(0);
  await audit(page);
});

// Second review of the audit fixes, console finding 2: a run that stops on a failed or lost request says so, and focus goes there.
for (const [how, said] of [
  ['answered 502 by a proxy', 'Deletion stopped because its last request was not confirmed. It may have deleted more items. Select Check original request above to find out. Deleted so far: 1 of 3 items.'],
  ['lost after the service removed its source', 'Deletion stopped because its last request was not confirmed. It may have deleted more items. Select Check original request above to find out. Deleted so far: 1 of 3 items.'],
] as const) test(`a retention run whose second request is ${how} says where it stopped, and focus goes there`, async ({ page, request }) => {
  expect((await request.post('/__test/aged-batches?count=3')).ok()).toBeTruthy();
  await page.goto('/lifecycle');
  await page.getByRole('checkbox', { name: 'Import files (CSV)' }).check();
  await page.getByLabel('Reason for the policy change').fill('Pilot agreement: raw files are kept for 30 days only.');
  await page.getByRole('button', { name: 'Save retention policy' }).click();
  await expect(page.getByText('Retention policy saved. Saving a policy does not delete data.')).toBeVisible();
  await page.getByRole('button', { name: 'Prepare deletion preview' }).click();
  await page.getByRole('checkbox', { name: /I have checked every item/ }).check();
  await page.getByLabel('Reason for approving this deletion').fill('Approved under the pilot retention agreement.');
  await page.getByRole('button', { name: 'Approve deletion' }).click();
  let sent = 0;
  await page.route(/\/api\/v1\/lifecycle\/runs\/[^/]+\/execute/, async route => {
    if (++sent !== 2) return route.fallback();
    if (how.startsWith('answered')) return route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' });
    await route.fetch();
    await route.abort('connectionreset');
  });
  const execute = page.getByRole('button', { name: 'Start deletion' });
  await execute.focus();
  await page.keyboard.press('Enter');
  const outcome = page.getByText(said, { exact: true });
  await expect(outcome).toBeVisible();
  // Stop went with the run: reading continues from what happened, never from the page body.
  await expect(outcome).toBeFocused();
  await expect(page.getByText('Outcome not confirmed', { exact: true })).toBeVisible();
  await audit(page);
});

for (const theme of ['light', 'dark'] as const) test(`new operations pages expose bounded state and clear setup controls in ${theme}`, async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript(value => localStorage.setItem('valopay-theme', value), theme);
  for (const [route, title] of [['/work', 'My work'], ['/close-review', 'Close review'], ['/lifecycle', 'Data retention'], ['/team', 'Team and access']]) {
    await page.goto(route);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    if (route === '/work') await expect(page.getByText('No work assigned yet', { exact: true })).toBeVisible();
    if (route === '/close-review') {
      await expect(page.getByText('Independent approval needs two people', { exact: true })).toBeVisible();
      const history = page.getByRole('navigation', { name: 'Daily closes' });
      await expect(history).toHaveAttribute('tabindex', '0');
      const bounds = await history.boundingBox();
      // Firefox can report fractional layout units just above the CSS maximum.
      const maximumHeight = (page.viewportSize()?.width || 1280) < 1024 ? 320 : 768;
      expect(bounds!.height).toBeLessThanOrEqual(maximumHeight + 0.5);
      await page.getByRole('heading', { name: 'Saved close evidence', exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('heading', { name: 'Saved close evidence', exact: true })).toBeVisible();
    }
    if (route === '/lifecycle') {
      await expect(page.getByRole('button', { name: 'Prepare deletion preview' })).toBeDisabled();
      await expect(page.getByRole('checkbox', { name: 'Import files (CSV)' })).not.toBeChecked();
      await expect(page.getByRole('checkbox', { name: 'Export files' })).not.toBeChecked();
    }
    if (route === '/team') {
      // The server's setup checks are an Admin's closed Technical setup section.
      const setup = page.locator('details').filter({ has: page.getByRole('heading', { name: 'Technical setup', exact: true }) });
      await expect(setup).not.toHaveAttribute('open', '');
      await setup.getByRole('heading', { name: 'Technical setup', exact: true }).click();
      await expect(page.getByText('No external wrapping key is configured in this offline test.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Check the encryption key' })).toHaveCount(0);
    }
    await audit(page);
    await page.screenshot({ path: info.outputPath(`${route.slice(1)}-${theme}.png`), fullPage: true });
  }
});
