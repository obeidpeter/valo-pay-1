/** Keep a queue's filters and lender when an operator follows a record. */
export function collectionReturnTo(search: URLSearchParams, merchantId: string, rowId?: string): string {
  const params = new URLSearchParams(search);
  params.delete('returnTo');
  params.set('lender', merchantId);
  return `/collections?${params}${rowId ? `#record-${encodeURIComponent(rowId)}` : ''}`;
}

/** Return links can only point to this lender's collections queue, never an external site. */
export function safeCollectionReturnTo(value: string | null, merchantId: string | null | undefined): string | null {
  if (!value || !merchantId || value.length > 4096 || !value.startsWith('/collections?') || /[\\\r\n]/.test(value)) return null;
  try {
    const url = new URL(value, 'https://valo-pay-1.invalid');
    if (url.origin !== 'https://valo-pay-1.invalid' || url.pathname !== '/collections' || url.searchParams.get('lender') !== merchantId) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

/** Customer history may return to this lender's directory or its collections queue. */
export function customerReturnTo(search: URLSearchParams, merchantId: string, rowId: string): string {
  const params = new URLSearchParams(search);
  params.delete('returnTo');
  params.set('lender', merchantId);
  return `/customers?${params}#record-${encodeURIComponent(rowId)}`;
}

export function safeCustomerReturnTo(value: string | null, merchantId: string | null | undefined): string | null {
  if (!value || !merchantId || value.length>4096 || /[\\\r\n]/.test(value)) return null;
  try {
    const url=new URL(value,'https://valo-pay-1.invalid');
    if(url.origin!=='https://valo-pay-1.invalid' || !['/customers','/collections','/exceptions','/mandates','/reconciliation'].includes(url.pathname) || url.searchParams.get('lender')!==merchantId) return null;
    return url.pathname+url.search+url.hash;
  } catch { return null; }
}

export function recordDestination(path: string, recordId: string, returnTo: string, merchantId: string, parameter = 'record'): string {
  const params = new URLSearchParams({ [parameter]: recordId, lender: merchantId, returnTo });
  return `${path}?${params}#record-${encodeURIComponent(recordId)}`;
}

/** Kinds whose page opens one record of theirs. */
const recordPages: Record<string, (id: string, lender: string) => string> = {
  customers: (id) => `/customers/${encodeURIComponent(id)}`,
  exceptions: (id) => `/cases/${encodeURIComponent(id)}`,
  mandates: (id, lender) => `/mandates?${new URLSearchParams({ record: id, lender })}#record-${encodeURIComponent(id)}`,
  'due-items': (id, lender) => `/reconciliation?${new URLSearchParams({ dueItem: id, lender })}#record-${encodeURIComponent(id)}`,
  'import-batches': (id) => `/imports?${new URLSearchParams({ batch: id })}`,
  // Without its ID, Saved exports selects the newest export and Data retention lists only the ten newest runs.
  exports: (id) => `/exports?${new URLSearchParams({ job: id })}`,
  'retention-runs': (id) => `/lifecycle?${new URLSearchParams({ run: id })}`,
};
/** Kinds whose page lists them, without opening one. */
const listPages: Record<string, string> = {
  'import-corrections': '/imports', closes: '/reports?view=operations#daily-closes', 'close-reviews': '/close-review',
  payments: '/reconciliation', allocations: '/reconciliation', 'settlement-batches': '/reconciliation', observations: '/reconciliation',
  attempts: '/collections', policies: '/policies', templates: '/policies', reviews: '/evidence', evidence: '/evidence', commercial: '/evidence',
  experiments: '/reports', invoices: '/reports', cutovers: '/settings', 'work-events': '/work',
  'source-profiles': '/sources', 'source-manifests': '/sources', 'provider-events': '/sources',
  'retention-policies': '/lifecycle', 'retention-holds': '/lifecycle',
  'connected-consents': '/connections', 'connected-intents': '/pay-by-bank', 'connected-credit-assessments': '/credit-desk', 'connected-credit-reviews': '/credit-desk',
  'connected-cash-workspace': '/cash-desk', 'connected-cash-forecasts': '/cash-desk', 'connected-cash-erp': '/cash-desk', 'connected-cash-vat': '/cash-desk', 'connected-cash-payroll': '/cash-desk',
};
/** Where a record of this kind is shown for this lender: the record itself where its page can open one, else the
 * page that lists its kind; null for a kind no page shows. */
export function recordPage(kind: string | null | undefined, id: string, merchantId: string): string | null {
  if (!kind) return null;
  if (Object.hasOwn(recordPages, kind)) return recordPages[kind]!(id, merchantId);
  return Object.hasOwn(listPages, kind) ? listPages[kind]! : null;
}
