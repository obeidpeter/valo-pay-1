import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

test.beforeEach(async ({ request, page }) => {
  await request.post('/__test/reset');
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

async function openAssignedHandover(page: Page, request: APIRequestContext) {
  const workspace = await (await request.get('/api/v1/workspace')).json();
  const lender = workspace.merchants[0].id;
  const source = (await (await request.get(`/api/v1/records/exceptions?merchantId=${lender}&limit=1`)).json()).items[0];
  const saved = await request.post(`/api/v1/pilot/cases/${source.id}?merchantId=${lender}`, {
    data: {
      action: 'handover', expectedUpdatedAt: source.updatedAt, assignee: workspace.actor,
      note: 'Handing this sample case to the named administrator.',
      nextAction: 'Inspect the sample receipt and record the outcome.',
      nextActionAt: '2026-09-20T10:00:00.000Z', evidenceIds: [],
    },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.goto('/work');
  const opener = page.getByRole('button', { name: 'Acknowledge handover', exact: true });
  await expect(opener).toBeVisible();
  return opener;
}

async function holdQueueRefresh(page: Page) {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/api\/v1\/work\?/, async route => {
    await held;
    await route.continue();
  });
  return release;
}

test('handover cancellation returns to its opener and a delayed acknowledgement refresh focuses the result', async ({ page, request }) => {
  const opener = await openAssignedHandover(page, request);
  const dialog = page.getByRole('dialog', { name: 'Acknowledge handover?' });
  for (const close of ['Cancel', 'Escape']) {
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('checkbox').check();
    if (close === 'Cancel') await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    else await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
  }
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await dialog.getByRole('checkbox').check();
  const release = await holdQueueRefresh(page);
  try {
    await dialog.getByRole('button', { name: 'Acknowledge handover', exact: true }).click();
    const confirmation = page.getByText(/Handover acknowledged\. The case and its next step stay open/);
    await expect(confirmation).toBeVisible();
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
    release();
    await expect(opener).toHaveCount(0);
    await expect(confirmation).toBeFocused();
  } finally { release(); }
});

test('a delayed handover refresh preserves focus after the person moves to another control', async ({ page, request }) => {
  const opener = await openAssignedHandover(page, request);
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Acknowledge handover?' });
  await dialog.getByRole('checkbox').check();
  const release = await holdQueueRefresh(page);
  try {
    await dialog.getByRole('button', { name: 'Acknowledge handover', exact: true }).click();
    await expect(page.getByText(/Handover acknowledged\. The case and its next step stay open/)).toBeVisible();
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
    const filter = page.getByRole('combobox', { name: 'Show', exact: true });
    await filter.focus();
    release();
    await expect(opener).toHaveCount(0);
    await expect(filter).toBeFocused();
  } finally { release(); }
});
