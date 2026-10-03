import { act, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueFreshness, QUEUE_STALE_AFTER_MS } from '@/components/queue-freshness';

afterEach(() => vi.useRealTimers());

describe('queue freshness notices', () => {
  it('ages the oldest supporting response and refreshes every queue dependency', async () => {
    vi.useFakeTimers();
    const first = { data: {}, dataUpdatedAt: Date.now(), isFetching: false, error: null, refetch: vi.fn().mockResolvedValue({}) };
    const second = { ...first, refetch: vi.fn().mockResolvedValue({}) };
    render(<QueueFreshness queries={[first, second]} />);
    expect(screen.queryByText(/more than 5 minutes/)).toBeNull();
    act(() => { vi.advanceTimersByTime(QUEUE_STALE_AFTER_MS); });
    expect(screen.getByText(/more than 5 minutes/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh queue' })); });
    expect(first.refetch).toHaveBeenCalledOnce();
    expect(second.refetch).toHaveBeenCalledOnce();
  });

  it('distinguishes offline cached records from an offline first load', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const query = { data: {}, dataUpdatedAt: Date.now(), isFetching: false, error: null, refetch: vi.fn() };
    const view = render(<QueueFreshness queries={[query]} />);
    expect(screen.getByText(/Showing last loaded records/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh queue' }).hasAttribute('disabled')).toBe(true);
    view.rerender(<QueueFreshness queries={[{ ...query, data: undefined, dataUpdatedAt: 0 }]} />);
    expect(screen.getByText(/Reconnect to load this queue/)).toBeTruthy();
    expect(query.refetch).not.toHaveBeenCalled();
  });
});
