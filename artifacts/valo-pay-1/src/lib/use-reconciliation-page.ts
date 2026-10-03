import { useSearch } from 'wouter';
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListReconciliation,
  getListReconciliationQueryKey,
  listReconciliation,
} from "@workspace/valo-pay-1-api-client-react";
import { useWorkspace } from "./workspace-context";
import { useUrlPagination } from "./use-url-pagination";
import { keepRowsWhilePaging } from "./use-record-pagination";
export function useReconciliationPage(
  queue: Parameters<typeof listReconciliation>[0],
  dueItem?: string,
) {
  const { merchantId } = useWorkspace();
  const pagination = useUrlPagination(merchantId, queue + "-");
  const q = new URLSearchParams(useSearch()).get('q') || undefined;
  const params = {
    q,
    merchantId: merchantId!,
    dueItem,
    limit: pagination.pageSize,
    offset: pagination.offset,
  };
  const queryKey = getListReconciliationQueryKey(queue, params), client = useQueryClient();
  const query = useListReconciliation(queue, params, {
    query: {
      enabled: !!merchantId,
      queryKey,
      // Paging keeps the current rows until the next page arrives, so the table, its pager
      // and the pressed button stay in place. Another lender, search or instalment never does.
      placeholderData: keepRowsWhilePaging(queryKey, client),
    },
  });
  useEffect(() => {
    if (query.data && !query.isPlaceholderData && query.data.offset !== pagination.offset)
      pagination.correctPage(Math.floor(query.data.offset / pagination.pageSize));
  }, [query.data, query.isPlaceholderData, pagination.offset, pagination.pageSize]);
  return { ...query, pagination };
}
