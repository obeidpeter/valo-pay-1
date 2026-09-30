import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, within } from './harness';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe('dashboard usability', () => {
  it('takes the operator from a queue to the page where it can be handled', async () => {
    const user = userEvent.setup();
    renderApp('/overview');
    const activation = await screen.findByRole('link', { name: /Awaiting activation/ });
    expect(activation.getAttribute('href')).toBe('/mandates?view=awaiting-activation');
    expect(screen.getByRole('link', { name: /Matches to review/ }).getAttribute('href')).toBe('/reconciliation?view=review');
    expect(screen.getByRole('link', { name: /Possible duplicates/ }).getAttribute('href')).toBe('/reconciliation?view=duplicates');
    expect(screen.getByRole('link', { name: /Failed collection attempts/ }).getAttribute('href')).toBe('/collections?view=failed');
    expect(screen.getByRole('link', { name: /Overdue exceptions/ }).getAttribute('href')).toBe('/exceptions?view=overdue');
    expect(screen.getByRole('link', { name: 'View daily closes' }).getAttribute('href')).toBe('/reports');
    await user.click(activation);
    expect(await screen.findByRole('heading', { name: 'Mandates' })).toBeTruthy();
    expect((await screen.findByRole('button', { name: 'Awaiting activation (2)' })).getAttribute('aria-pressed')).toBe('true');
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);
  });

  it('shows proportions as percentages and reveals the complete billing rules on demand', async () => {
    const user = userEvent.setup();
    renderApp('/reports');
    const allocation = await screen.findByText('Allocation rate');
    expect(within(allocation.parentElement!).getByText('50.0%')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Billing' }));
    const summary = screen.getByText('Billing rates & rules');
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    await user.click(summary);
    expect(details.open).toBe(true);
    expect(within(details).getByText('0.3%')).toBeTruthy();
    expect(within(details).getByText('7.5%')).toBeTruthy();
    expect(within(details).getByText(/A collection is billed once four things are true/)).toBeTruthy();
  });

  it('includes collapsed evidence when printing and restores the chosen disclosures afterwards', async () => {
    const user = userEvent.setup();
    renderApp('/reports?view=billing');
    const rates = (await screen.findByText('Billing rates & rules')).closest('details')!;
    const receipts = screen.getByText('Receipts by payment method').closest('details')!;
    await user.click(receipts.querySelector('summary')!);
    expect(rates.open).toBe(false);
    expect(receipts.open).toBe(true);
    window.dispatchEvent(new Event('beforeprint'));
    expect(rates.open).toBe(true);
    expect(receipts.open).toBe(true);
    window.dispatchEvent(new Event('afterprint'));
    expect(rates.open).toBe(false);
    expect(receipts.open).toBe(true);
  });
});
