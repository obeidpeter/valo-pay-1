import React from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useWorkspace } from '@/lib/workspace-context';
import { valueLabel } from '@workspace/valo-pay-1-schema';

/** Keep API values intact while using ordinary words in the interface (the shared valueLabel, which import row errors use too). */
export function readableLabel(value: unknown): string {
  return valueLabel(value);
}

export function CustomerAvatar({ name, large = false }: { name: string; large?: boolean }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('');
  return <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-foreground font-semibold ${large ? 'h-14 w-14 text-lg' : 'h-9 w-9 text-xs'}`}>{initials || '?'}</span>;
}

/** Statuses shown in the success colour: done, and done well. Record-keyed codes ("payroll-run.completed") are the connected pages'. */
const successStatuses = new Set(['active', 'paid', 'allocated', 'confirmed', 'resolved', 'reconciled', 'succeeded', 'payroll-item.succeeded', 'payroll-run.completed']);
/** Statuses shown in the danger colour. */
const dangerStatuses = new Set(['failed', 'expired', 'unpaid_final', 'variance']);
/** Statuses shown in the warning colour: work waiting on someone, or an outcome nobody knows yet. */
const warningStatuses = new Set(['pending_activation', 'proposed', 'unallocated', 'possible_duplicate', 'in_progress', 'checkout.unknown', 'payroll-item.unknown', 'permission.revoked', 'assessment.blocked', 'accounting-draft.blocked']);
/** Whatever its code, a status that reads one of these words warns: it cannot continue, or its outcome is not known. */
const warningWords = new Set(['Outcome unknown', 'Blocked', 'Withdrawn', 'Some outcomes unknown']);

/** A status's colour: success, danger, warning or neutral (`tone` for tests and callers that need the name). */
export function statusTone(status: unknown): 'success' | 'danger' | 'warning' | 'neutral' {
  const value = String(status || '');
  if (successStatuses.has(value)) return 'success';
  if (dangerStatuses.has(value)) return 'danger';
  if (warningStatuses.has(value) || (value && warningWords.has(readableLabel(value)))) return 'warning';
  return 'neutral';
}
const toneClasses = {
  success: 'bg-success/10 text-success border-success/20',
  danger: 'bg-destructive/10 text-destructive border-destructive/20',
  warning: 'bg-warning text-warning-foreground border-warning-border',
  neutral: 'bg-secondary text-secondary-foreground border-border',
} as const;

/** A status in the shared words (valueLabel), in sentence case; a missing status reads "Not recorded", never a code. */
export function StatusBadge({ status }: { status: unknown }) {
  const value = String(status || '');
  const tone = toneClasses[statusTone(value)];
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
