import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedSearch } from '@/lib/use-record-pagination';

afterEach(() => vi.useRealTimers());

describe('the pause before a search', () => {
  it('searches only once typing has paused for 300 ms, and a key restarts the pause', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value, scope }) => useDebouncedSearch(value, scope), { initialProps: { value: '', scope: 'lender-a' } });
    rerender({ value: 'Scale', scope: 'lender-a' });
    expect(result.current).toEqual({ search: '', searchPending: true });
    act(() => { vi.advanceTimersByTime(299); });
    expect(result.current.search).toBe('');
    rerender({ value: 'Scale customer ', scope: 'lender-a' });
    act(() => { vi.advanceTimersByTime(299); });
    expect(result.current).toEqual({ search: '', searchPending: true });
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toEqual({ search: 'Scale customer', searchPending: false });
  });

  it('never carries a search from one lender to another', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value, scope }) => useDebouncedSearch(value, scope), { initialProps: { value: 'PCUST-123', scope: 'lender-a' } });
    act(() => { vi.advanceTimersByTime(300); });
    expect(result.current.search).toBe('PCUST-123');
    rerender({ value: 'PCUST-123', scope: 'lender-b' });
    expect(result.current).toEqual({ search: '', searchPending: true });
  });
});
