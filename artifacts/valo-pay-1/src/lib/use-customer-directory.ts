import { useEffect, useRef } from 'react';
import { useSearchParams } from 'wouter';
import { RECORD_PAGE_SIZES } from './use-record-pagination';

/** Keep directory searches and pages in the URL, including visits through history. */
export function useCustomerDirectory(merchantId: string | null) {
  const [params, setParams] = useSearchParams();
  const previousMerchant = useRef(merchantId);
  const sameLender = !params.get('lender') || params.get('lender') === merchantId;
  const search = sameLender ? params.get('q') || '' : '';
  const size = Number(params.get('size'));
  const pageSize = RECORD_PAGE_SIZES.some(value => value === size) ? size : 25;
  const number = Number(params.get('page'));
  const page = sameLender && Number.isSafeInteger(number) && number > 0 && number <= 1_000_000 ? number - 1 : 0;
  const update = (values: Record<string, string>, replace = false) => setParams(current => {
    const next = new URLSearchParams(current);
    for (const [key, value] of Object.entries(values)) { if (value) next.set(key, value); else next.delete(key); }
    if (merchantId) next.set('lender', merchantId);
    return next;
  }, { replace });
  useEffect(() => {
    if (previousMerchant.current && merchantId && previousMerchant.current !== merchantId && params.get('lender') !== merchantId) update({ q: '', page: '', size: '' }, true);
    previousMerchant.current = merchantId;
  }, [merchantId]);
  return {
    params, search, sameLender,
    setSearch: (value: string) => update({ q: value, page: '' }, true),
    pagination: {
      page, pageSize, offset: page * pageSize,
      setPage: (value: number) => update({ page: String(Math.max(0, Math.floor(value)) + 1) }),
      /** Replaces a page past the end, so Back does not return to it. */
      correctPage: (value: number) => update({ page: String(Math.max(0, Math.floor(value)) + 1) }, true),
      setPageSize: (value: number) => { if (RECORD_PAGE_SIZES.some(size => size === value)) update({ size: String(value), page: '' }); },
    },
  };
}
