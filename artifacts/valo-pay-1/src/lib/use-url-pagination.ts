import { useSearchParams, useLocation } from "wouter";
import { RECORD_PAGE_SIZES } from "./use-record-pagination";
/** URLs carry page state through history and record visits. A lender change
 * never reuses the previous lender's page. Filter controls clear their page.
 * A person's page change adds a history entry; correcting a page past the end
 * (correctPage) replaces the address, so Back leaves the list instead of
 * returning to the out-of-range page, and so does returning to the first page
 * while a search is typed (resetPage), so Back never steps through letters. */
export function useUrlPagination(
  merchantId: string | null | undefined,
  prefix = "",
) {
  const [search] = useSearchParams();
  const [location, navigate] = useLocation();
  const pageKey = prefix + "page",
    sizeKey = prefix + "size";
  const size = Number(search.get(sizeKey) || 25),
    pageSize = RECORD_PAGE_SIZES.some((n) => n === size) ? size : 25;
  const number = Number(search.get(pageKey) || 1);
  const page =
    search.get("lender") && search.get("lender") !== merchantId
      ? 0
      : Number.isSafeInteger(number) && number > 0 && number <= 21474836
        ? number - 1
        : 0;
  const update = (next: number, nextSize = pageSize, replace = false) => {
    const params = new URLSearchParams(search);
    params.set(pageKey, String(Math.max(0, Math.floor(next)) + 1));
    params.set(sizeKey, String(nextSize));
    if (merchantId) params.set("lender", merchantId);
    // The router prefixes its base; the browser's pathname already carries it, so it must not be reused here.
    navigate(location + "?" + params + window.location.hash, { replace });
  };
  return {
    page,
    pageSize,
    offset: page * pageSize,
    setPage: (next: number) => update(next),
    correctPage: (next: number) => update(next, pageSize, true),
    resetPage: () => {
      if (page !== 0) update(0, pageSize, true);
    },
    setPageSize: (next: number) => {
      if (RECORD_PAGE_SIZES.some((n) => n === next)) update(0, next);
    },
  };
}
