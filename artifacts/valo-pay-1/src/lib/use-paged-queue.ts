import { useEffect, useState } from 'react';
import { useListQueue, getListQueueQueryKey, type ListQueueParams } from '@workspace/valo-pay-1-api-client-react';
import { useWorkspace } from './workspace-context';
import { useUrlPagination } from './use-url-pagination';
import { useSearchParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { keepRowsWhilePaging } from './use-record-pagination';

/**
 * Query keys include the complete lender/filter/page scope. Never display a previous scope's rows; another page of the
 * same list keeps the rows shown until it arrives (keepRowsWhilePaging), so the pager and the control pressed stay.
 */
export function usePagedQueue(queue: 'exceptions' | 'mandates' | 'collections', filters: Omit<ListQueueParams, 'merchantId' | 'limit' | 'offset'>) {
  const { merchantId } = useWorkspace();
  const client = useQueryClient();
  const [search] = useSearchParams();
  filters = {...filters,q:search.get('q') || undefined};
  const scope = JSON.stringify([merchantId, queue, filters]);
  const pagination = useUrlPagination(merchantId);
  const [located, setLocated] = useState('');
  const target = located === scope ? undefined : filters.target;
  const params = { ...filters, target, merchantId: merchantId!, limit: pagination.pageSize, offset: pagination.offset };
  const queryKey = getListQueueQueryKey(queue, params);
  const query = useListQueue(queue, params, { query: { enabled: !!merchantId, queryKey, placeholderData: keepRowsWhilePaging(queryKey, client) } });
  useEffect(() => {
    // The previous page's rows, shown while this one loads, say nothing of where this page is.
    if (!query.data || query.isPlaceholderData) return;
    if (target) {
      // Keep the resolved page mounted when switching to ordinary pagination.
      // A second empty loading state would detach the deep-link focus target.
      client.setQueryData(getListQueueQueryKey(queue, { ...params, target: undefined, offset: query.data.offset }), query.data);
      setLocated(scope);
    }
    const actualPage = Math.floor(query.data.offset / pagination.pageSize);
    if (actualPage !== pagination.page) pagination.correctPage(actualPage);
  }, [query.data, query.isPlaceholderData, scope, target, pagination.pageSize, pagination.page]);
  return { ...query, pagination: { ...pagination, ...(query.data && !query.isPlaceholderData ? { offset: query.data.offset, page: Math.floor(query.data.offset / pagination.pageSize) } : {}) } };
}
