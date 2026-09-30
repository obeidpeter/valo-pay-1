import React from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useWorkspace } from '@/lib/workspace-context';
import { valueLabel } from '@workspace/valopay-schema';

/** Keep API values intact while using ordinary words in the interface (the shared valueLabel, which import row errors use too). */
export function readableLabel(value: unknown): string {
  return valueLabel(value);
}

export function CustomerAvatar({ name, large = false }: { name: string; large?: boolean }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('');
  return <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-foreground font-semibold ${large ? 'h-14 w-14 text-lg' : 'h-9 w-9 text-xs'}`}>{initials || '?'}</span>;
}

/** A status in the shared words (valueLabel), in sentence case; a missing status reads "Not recorded", never a code. */
export function StatusBadge({ status }: { status: unknown }) {
  const value = String(status || '');
  const tone = ['active', 'paid', 'allocated', 'confirmed', 'resolved', 'reconciled', 'succeeded'].includes(value)
    ? 'bg-success/10 text-success border-success/20'
    : ['failed', 'expired', 'unpaid_final', 'variance'].includes(value)
      ? 'bg-destructive/10 text-destructive border-destructive/20'
      : ['pending_activation', 'proposed', 'unallocated', 'possible_duplicate', 'in_progress'].includes(value)
        ? 'bg-warning text-warning-foreground border-warning-border'
        : 'bg-secondary text-secondary-foreground border-border';
  const label = value ? readableLabel(value) : 'Not recorded';
  return <span title={label} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}><span aria-hidden="true" className="h-1 w-1 rounded-full bg-current" />{label}</span>;
}

type RecordIdentity = { id: string; name?: string | null; reference?: string | null };

/** Full identifiers remain available without dominating the operational table. */
export function RecordLabel({ record, id, customer = false }: { record?: RecordIdentity; id?: unknown; customer?: boolean }) {
  const [path]=useLocation(), search=useSearch();const {merchantId}=useWorkspace();
  const params=new URLSearchParams(search);if(merchantId)params.set('lender',merchantId);
  const returnTo=['/exceptions','/mandates','/collections','/reconciliation'].includes(path) ? path+'?'+params : null;
  const destination=record ? '/customers/'+record.id+(returnTo?'?'+new URLSearchParams({returnTo,lender:merchantId || ''}):'') : '';
  const fullId = record?.id || String(id || '');
  if (!record) return fullId
    ? <details className="text-xs"><summary className="cursor-pointer font-mono text-muted-foreground">{fullId.slice(0, 8)}…</summary><span className="mt-1 block max-w-56 break-all font-mono">{fullId}</span></details>
    : <span className="text-xs text-muted-foreground">{customer ? 'No customer linked' : 'Reference unavailable'}</span>;
  const title = customer ? record.name || record.reference || fullId : record.reference || record.name || fullId;
  return <div title={fullId} className="min-w-0">
    {customer ? <Link href={destination} className="font-medium text-foreground hover:text-primary hover:underline">{title}</Link> : <span className="font-medium text-foreground">{title}</span>}
    {customer && record.reference && <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">{record.reference}</span>}
    <span className="sr-only"> Record ID: {fullId}</span>
  </div>;
}
