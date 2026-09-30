import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollFrame } from '@/components/scroll-frame';
import { useSearchShortcut } from '@/lib/focus';
import { EmptyState } from '@/components/empty-state';
import { Loading } from '@/components/loading';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, getListRecordsQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { formatNumber } from '@/lib/formatters';
import { Search, UserPlus, ArrowRight, Users } from 'lucide-react';
import { CustomerAvatar, StatusBadge, readableLabel } from '@/components/record-label';
import { PermissionButton as Button } from '@/components/permission-button';
import { Link } from 'wouter';
import { RecordDialog } from '@/components/record-dialog';
import { importFieldLabel, recordStatuses } from '@workspace/valopay-schema';
import { LoadProblem } from '@/components/load-problem';
import { RecordPagination } from '@/components/record-pagination';
import { keepRowsWhilePaging, useDebouncedSearch } from '@/lib/use-record-pagination';
import { useCustomerDirectory } from '@/lib/use-customer-directory';
import { customerReturnTo } from '@/lib/record-navigation';
import { useHashTarget } from '@/lib/use-hash-target';
import { QueueFreshness } from '@/components/queue-freshness';

export default function CustomersPage() {
  const { merchantId, workspace } = useWorkspace();
  const { params: directoryParams, search, setSearch, sameLender, pagination } = useCustomerDirectory(merchantId);
  const searchRef = useRef<HTMLInputElement>(null);
  useSearchShortcut(searchRef);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { search: settledSearch, searchPending } = useDebouncedSearch(search, merchantId);
  const params = { merchantId: merchantId!, search: settledSearch || undefined, limit: pagination.pageSize, offset: pagination.offset };
  
  const customersKey = getListRecordsQueryKey('customers', params), client = useQueryClient();
  const customersQuery = useListRecords(
    'customers',
    params,
    { query: { enabled: !!merchantId && sameLender && !searchPending, queryKey: customersKey, placeholderData: keepRowsWhilePaging(customersKey, client) } }
  );
  const { data, isLoading, isFetching, error, refetch } = customersQuery;
  const rowTargets = useMemo(() => data?.items.map(customer => `record-${customer.id}`) || [], [data]);
  useHashTarget(rowTargets, !!data && !searchPending && sameLender);
  useEffect(() => {
    if (data && !isFetching && pagination.page > 0 && pagination.offset >= data.total) pagination.correctPage(Math.max(0, Math.ceil(data.total / pagination.pageSize) - 1));
  }, [data, isFetching, pagination.page, pagination.pageSize]);

  if (!merchantId) return null;
  if (!sameLender) return <div className="space-y-3"><h1 className="text-2xl font-bold">Choose the linked lender</h1><p>This customer list belongs to {workspace?.merchants.find(merchant => merchant.id === directoryParams.get('lender'))?.name || 'another lender'}. Choose that lender in Active lender to see this search again.</p><Button variant="outline" onClick={() => setSearch('')}>Open this lender’s customers</Button></div>;

  return (
    <div className="space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Customers</h1>
          <p className="text-muted-foreground mt-1">Search by name, reference or masked phone number. Each row opens that customer’s history.</p>
        </div>
        <div className="flex items-center gap-3">
          <Button kind="customers" className="gap-2" onClick={() => setIsDialogOpen(true)}>
            <UserPlus className="h-4 w-4" /> Add customer
          </Button>
        </div>
      </header>

      <QueueFreshness key={merchantId} queries={[customersQuery]} />

      <RecordDialog
        kind="customers"
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title="Add customer"
        submitLabel="Add customer"
        busyLabel="Adding customer…"
        fields={[
          // The same words as the import screens' columns and row errors (importFieldLabel).
          { name: 'name', label: importFieldLabel('customers', 'name'), type: 'text', required: true },
          { name: 'reference', label: importFieldLabel('customers', 'reference'), type: 'text', required: true },
          { name: 'status', label: importFieldLabel('customers', 'status'), type: 'select', options: recordStatuses.customers.map(status => ({ label: readableLabel(status), value: status })), required: true },
          { name: 'bankName', label: importFieldLabel('customers', 'bankName'), type: 'text', isData: true },
          { name: 'accountMasked', label: importFieldLabel('customers', 'accountMasked'), type: 'text', isData: true, help: 'For example, ******1234. Never enter a full account number.' },
          { name: 'phoneMasked', label: importFieldLabel('customers', 'phoneMasked'), type: 'text', isData: true },
          { name: 'consentProvenance', label: importFieldLabel('customers', 'consentProvenance'), type: 'text', isData: true, required: true, help: 'For example, signed form CONSENT-001 or a consent link reference. Use sample details only.' },
        ]}
        defaultValues={{ status: 'active' }}
      />

      <div className="bg-card border rounded-xl shadow-sm overflow-hidden flex flex-col">
        {search.trim() && <p className="hidden print:block p-4 border-b text-sm">Search: “{search.trim()}”</p>}
        <div className="p-5 border-b flex flex-wrap items-center justify-between gap-4 print:hidden">
          <div className="flex items-center gap-2.5">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Customer directory</h2>
            {data && <span className="rounded-full border bg-secondary/60 px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{formatNumber(data.total)}</span>}
          </div>
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input 
              type="text" 
              placeholder="Search by name, reference or phone…"
              aria-label="Search customers"
              ref={searchRef}
              aria-keyshortcuts="/"
              onKeyDown={event => { if (event.key === 'Escape') { setSearch(''); } }} 
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full min-w-52 pl-9 pr-9 py-2.5 bg-background border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border bg-secondary px-1.5 font-mono text-[11px] text-muted-foreground" aria-hidden="true">/</kbd>
          </div>
        </div>

        {isLoading || searchPending ? (
          <Loading what={searchPending ? 'search results' : 'customers'} />
        ) : error && !data ? (
          <LoadProblem what="customers" pager="customers" error={error} retry={() => { void refetch(); }} busy={isFetching} />
        ) : !data || data.items.length === 0 ? (
          search.trim() ? (
            <EmptyState filtered title={`No customers match “${search.trim()}”`}>Check the spelling, or search by the reference or the masked phone number.</EmptyState>
          ) : (
            <EmptyState title="No customers yet" action={<Button kind="customers" size="sm" variant="outline" onClick={() => setIsDialogOpen(true)}>Add customer</Button>}>
              Customers appear here after an import or when you add one. Select Add customer, or import sample records on Collections.
            </EmptyState>
          )
        ) : (
          <ScrollFrame label="Customers" className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm text-left">
              <thead className="bg-secondary/30 border-b text-muted-foreground">
                <tr>
                  <th className="px-6 py-4 font-medium">Customer</th>
                  <th className="px-6 py-4 font-medium">Contact</th>
                  <th className="px-6 py-4 font-medium">Bank details</th>
                  <th className="px-6 py-4 font-medium">Status</th>
                  <th className="px-6 py-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.items.map(customer => (
                  <tr key={customer.id} id={`record-${customer.id}`} tabIndex={-1} className="scroll-mt-24 hover:bg-secondary/10 transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <CustomerAvatar name={customer.name} />
                        <div>
                          <p className="font-semibold text-foreground">{customer.name}</p>
                          <p className="mt-0.5 text-[11px] font-mono text-muted-foreground">{customer.reference}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <p className="text-muted-foreground">{String(customer.data?.phoneMasked || 'Not provided')}</p>
                    </td>
                    <td className="px-6 py-4">
                      <p className="font-medium">{String(customer.data?.bankName || 'Not provided')}</p>
                      <p className="text-xs font-mono text-muted-foreground">{String(customer.data?.accountMasked || 'Not provided')}</p>
                    </td>
                    <td className="px-6 py-4">
                      <StatusBadge status={customer.status} />
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Link href={`/customers/${customer.id}?${new URLSearchParams({ lender: merchantId, returnTo: customerReturnTo(directoryParams, merchantId, customer.id) })}`} aria-label={`Open Customer history for ${customer.name}`} className="inline-flex min-h-9 items-center gap-2 rounded-lg px-2 text-primary hover:bg-secondary text-xs font-medium">
                        Open Customer history <ArrowRight aria-hidden="true" className="h-3 w-3" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollFrame>
        )}
        
        {data && !error && !searchPending && <RecordPagination pagination={pagination} total={data.total} busy={isFetching} label="customers" />}
      </div>
    </div>
  );
}
