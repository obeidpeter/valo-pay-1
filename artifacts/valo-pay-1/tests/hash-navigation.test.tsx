import { randomUUID } from 'node:crypto';
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor } from './harness';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => { api.uninstall(); vi.restoreAllMocks(); });

describe('section deep links', () => {
  it('waits for report data before focusing and revealing the requested daily-close section', async () => {
    const release = api.hold(/^\/v1\/reports$/);
    const scrolled: Element[] = [];
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) { scrolled.push(this); });
    renderApp('/reports#daily-closes');
    await screen.findByText('Loading reports…');
    expect(document.getElementById('daily-closes')).toBeNull();
    release();
    const section = await screen.findByRole('region', { name: 'Daily close records' });
    await waitFor(() => expect(document.activeElement).toBe(section));
    expect(scrolled).toContain(section);
    expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' });
  });

  it('follows the Reports accuracy link through client navigation and delayed allocation data', async () => {
    const user = userEvent.setup();
    const release = api.hold(/^\/v1\/reconciliation\/audit$/);
    renderApp('/reports');
    await user.click(await screen.findByRole('link', { name: 'Review matches' }));
    expect(window.location.hash).toBe('#precision-audit');
    const section = await screen.findByRole('region', { name: 'Match accuracy review' });
    expect(document.activeElement).not.toBe(section);
    release();
    await waitFor(() => expect(document.activeElement).toBe(section));
  });

  it('arrives at the accuracy review once: paging a Reconciliation table leaves the view and focus with that table', async () => {
    api.setNow('2026-09-18T11:00:00.000Z');
    api.mutate(state => {
      const proposal = state.records.find(record => record.kind === 'allocations' && record.status === 'proposed')!;
      for (let i = 0; i < 30; i++) {
        state.records.push({ ...structuredClone(proposal), id: randomUUID(), reference: `PAGED-MATCH-${i}` });
        // Automatic, certain matches confirmed last month: the accuracy review's sample, with a second page of its own.
        state.records.push({ ...structuredClone(proposal), id: randomUUID(), status: 'confirmed', reference: `SAMPLED-MATCH-${i}`, data: { ...proposal.data, automatic: true, confidence: 'certain', confirmedAt: '2026-08-14T10:00:00.000Z' } });
      }
    });
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) { scrolled.push(this); });
    const user = userEvent.setup();
    renderApp('/reconciliation#precision-audit');
    const section = await screen.findByRole('region', { name: 'Match accuracy review' });
    await waitFor(() => expect(document.activeElement).toBe(section));
    expect(scrolled.filter(element => element === section)).toHaveLength(1);
    // jsdom has no layout, but keeps the offset set on the page area: paging must not reset it.
    const main = screen.getByRole('main');
    main.scrollTop = 1234;
    for (const table of ['matches to review', 'sampled matches']) {
      await user.click(await screen.findByRole('button', { name: `Next page of ${table}` }));
      await screen.findByText(new RegExp(`^26–\\d+ of \\d+ ${table}$`));
      // Any scroll this render scheduled runs in the next frame: none may return to the review.
      await act(async () => { await new Promise(resolve => window.requestAnimationFrame(resolve)); });
      expect(scrolled.filter(element => element === section)).toHaveLength(1);
      expect(document.activeElement).not.toBe(section);
      expect(main.scrollTop).toBe(1234);
    }
    expect(window.location.hash).toBe('#precision-audit');
  });

  it('opens a landing section from a shared URL without loading a workspace', async () => {
    renderApp('/#pilot');
    const section = screen.getByRole('region', { name: 'Start with one problem worth solving.' });
    await waitFor(() => expect(document.activeElement).toBe(section));
    expect(api.calls).toEqual([]);
  });
});
