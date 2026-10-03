import { useEffect, useState, type KeyboardEvent } from 'react';
import type { QueryClient } from '@tanstack/react-query';

export const RECORD_PAGE_SIZES = [25, 50, 100] as const;

/**
 * A picker's search sits in its dialog's form and looks as the person types, so Enter there does nothing more: it never
 * submits the form around it, such as an allocation or a new mandate that happens to be complete.
 */
export function searchWithoutSubmitting(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault();
}

/** Wait for a pause in typing; changing lenders never reuses another lender's search. */
export function useDebouncedSearch(value: string, scope: string | null | undefined, delay = 300) {
  const trimmed = value.trim();
  const [settled, setSettled] = useState({ scope, value: trimmed });
  useEffect(() => {
    const timeout = setTimeout(() => setSettled({ scope, value: trimmed }), delay);
    return () => clearTimeout(timeout);
  }, [trimmed, scope, delay]);
  const search = settled.scope === scope ? settled.value : '';
  return { search, searchPending: search !== trimmed };
}

/** Reset synchronously on a lender/filter change, before issuing the next request. */
export function useRecordPagination(resetKey: string, total?: number) {
  const [size, setSize] = useState<number>(25);
  const [position, setPosition] = useState({ key: resetKey, page: 0 });
  useEffect(() => {
    setPosition(previous => previous.key === resetKey ? previous : { key: resetKey, page: 0 });
  }, [resetKey]);
  const requestedPage = position.key === resetKey ? position.page : 0;
  const page = total === undefined ? requestedPage : Math.min(requestedPage, Math.max(0, Math.ceil(total / size) - 1));
  const setPage = (next: number) => setPosition({ key: resetKey, page: Math.max(0, Math.floor(next)) });
  const setPageSize = (next: number) => {
    if (!RECORD_PAGE_SIZES.some(value => value === next)) return;
    setSize(next);
    setPosition({ key: resetKey, page: 0 });
  };
  return { page, pageSize: size, offset: page * size, setPage, setPageSize };
}

export type RecordPaginationState = ReturnType<typeof useRecordPagination>;

/** A request's page: `limit` and `offset`, and a paged section's own (`eventsLimit`, `paymentsOffset` and the like). */
const pageField = /^(?:limit|offset)$|(?:Limit|Offset)$/;
/** A path whose query string carries its page (`/pilot/batches?offset=25`), without it. */
const pathWithoutPage = (path: string) => {
  const [route, query] = path.split('?');
  if (query === undefined) return path;
  const params = new URLSearchParams(query);
  for (const name of [...params.keys()]) if (pageField.test(name)) params.delete(name);
  return `${route}?${params}`;
};
/** A query key without its page, so two pages of one list compare equal and nothing else does. */
const listOf = (queryKey: readonly unknown[]) => JSON.stringify(queryKey.map(part => typeof part === 'string' ? pathWithoutPage(part)
  : part && typeof part === 'object' ? Object.fromEntries(Object.entries(part).filter(([name]) => !pageField.test(name))) : part));

/**
 * A list query's placeholder while a person pages: the rows shown stay until the next page arrives, so the table, its
 * pager and the control pressed stay in place. Only another page of the same list keeps them; another lender, record,
 * search or filter never shows the earlier rows. Nor does a page whose request has failed: once its query has recorded
 * an error, fetching it again (Try again, a refresh, a return to the tab) shows it loading, never the earlier page's
 * rows as its own. Pass the query's key and the query client.
 */
export function keepRowsWhilePaging(queryKey: readonly unknown[], client: QueryClient) {
  const list = listOf(queryKey);
  return <T,>(previous: T | undefined, previousQuery?: { queryKey: readonly unknown[] }): T | undefined =>
    previousQuery && listOf(previousQuery.queryKey) === list && !client.getQueryState(queryKey)?.errorUpdateCount ? previous : undefined;
}
