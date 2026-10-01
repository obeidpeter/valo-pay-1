import type { ValopayRecord } from '@workspace/api-client-react';
import { policyGuardrails, templateTextProblems } from '@workspace/valopay-schema';
import { readableLabel } from '@/components/record-label';

/** An explicit link takes precedence. A missing link is never replaced with a guessed match. */
export function previousVersion(record: ValopayRecord, records: ValopayRecord[]) {
  const linkedId = record.data?.previousVersionId;
  const eligible = records.filter(candidate => candidate.merchantId === record.merchantId && candidate.kind === record.kind && candidate.id !== record.id);
  if (linkedId) return { record: eligible.find(candidate => candidate.id === linkedId), linked: true };
  const version = Number(record.data?.version);
  const candidates = eligible.filter(candidate => candidate.name === record.name
    && (record.kind !== 'templates' || candidate.data?.purpose === record.data?.purpose)
    && Number(candidate.data?.version) < version);
  const highest = Math.max(...candidates.map(candidate => Number(candidate.data?.version)));
  const matches = candidates.filter(candidate => Number(candidate.data?.version) === highest);
  return { record: matches.length === 1 ? matches[0] : undefined, linked: false };
}

const sampleValues: Record<string, string> = {
  amount: '₦25,000.00', date: '25 September 2026', lender: 'Example Lender', merchant: 'Example Lender', contact: 'support@example.com',
};

export function renderSampleMessage(text: unknown) {
  return String(text || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (token, name: string) => Object.hasOwn(sampleValues, name.trim()) ? sampleValues[name.trim()]! : token);
}

export function TemplatePreview({ text, title = 'Sample customer message' }: { text: unknown; title?: string }) {
  const rendered = renderSampleMessage(text);
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-muted-foreground">{title}</p>
      <blockquote className="rounded-lg border bg-background p-3 text-sm whitespace-pre-wrap break-words">{rendered || 'Write a message to see the sample here.'}</blockquote>
      <p className="text-xs text-muted-foreground">Synthetic example only. No message is sent.</p>
      {Boolean(text) && templateTextProblems(text).length > 0 && <div role="status" className="space-y-1 text-xs text-warning-foreground"><p>This message needs changes before it can be saved or submitted.</p>{templateTextProblems(text).map(problem => <p key={problem}>{problem}</p>)}</div>}
    </div>
  );
}

function HistoryNote({ current, previous, linked }: { current: ValopayRecord; previous?: ValopayRecord; linked: boolean }) {
  return <p className="text-xs text-muted-foreground">{previous
    ? `${linked ? 'Previous version' : `Earlier version with the same name${current.kind === 'templates' ? ' and purpose' : ''}`}: ${String(previous.data?.version ?? 'Unknown')} · ${readableLabel(previous.status)}. Reviewing version ${String(current.data?.version ?? 'Unknown')}.`
    : linked
      ? 'The linked previous version is unavailable. Its changes cannot be compared here; check the version history before approving.'
      : 'No unambiguous earlier version is available. Review this version in full; no comparison is being assumed.'}</p>;
}

const policyFields = [
  ['maxAttempts', 'Maximum attempts', policyGuardrails.defaultMaxAttempts, ''],
  ['spacingHours', 'Time between attempts', policyGuardrails.defaultSpacingHours, ' hours'],
  ['firstNoticeHours', 'Notice before first attempt', policyGuardrails.defaultFirstNoticeHours, ' hours'],
  ['retryNoticeHours', 'Notice before each retry', policyGuardrails.defaultRetryNoticeHours, ' hours'],
  ['partialAllowed', 'Partial collections allowed', false, ''],
  ['complianceMapping', 'Explanation of required rules', '', ''],
] as const;

function policyValue(record: ValopayRecord, key: string, fallback: unknown, suffix: string) {
  const value = record.data?.[key] ?? fallback;
  return typeof value === 'boolean' ? (value ? 'Yes' : 'No') : `${String(value || (value === 0 ? 0 : 'Not provided'))}${suffix}`;
}

export function PolicyReview({ record, records }: { record: ValopayRecord; records: ValopayRecord[] }) {
  const { record: previous, linked } = previousVersion(record, records);
  const value = (key: string, fallback: number) => Number(record.data?.[key] ?? fallback);
  return (
    <section aria-label="Policy review" className="space-y-4 rounded-lg border bg-secondary/10 p-4">
      <div><h3 className="font-semibold">{record.name} · Version {String(record.data?.version ?? '1')}</h3><HistoryNote current={record} previous={previous} linked={linked} /></div>
      <div className="space-y-3">
        {policyFields.map(([key, label, fallback, suffix]) => {
          const current = policyValue(record, key, fallback, suffix);
          const before = previous ? policyValue(previous, key, fallback, suffix) : null;
          const changed = before !== null && before !== current;
          return <div key={key} className={`rounded-md border p-3 text-sm ${changed ? 'border-warning-border bg-warning/30' : 'bg-background'}`}>
            <p className="font-medium">{label}{changed && <span className="ml-2 text-xs text-warning-foreground">Changed</span>}</p>
            {before !== null && <p className="mt-1 text-muted-foreground">Previous: {before}</p>}
            <p className="mt-1 whitespace-pre-wrap break-words">This version: {current}</p>
          </div>;
        })}
      </div>
      <div className="space-y-2">
        <p className="text-xs font-semibold text-muted-foreground">Illustrative policy-change message</p>
        <blockquote className="rounded-lg border bg-background p-3 text-sm">Example Lender: Your retry rules allow up to {value('maxAttempts', policyGuardrails.defaultMaxAttempts)} attempts in total, at least {value('spacingHours', policyGuardrails.defaultSpacingHours)} hours apart. We give at least {value('firstNoticeHours', policyGuardrails.defaultFirstNoticeHours)} hours’ notice before the first attempt and {value('retryNoticeHours', policyGuardrails.defaultRetryNoticeHours)} hours before each retry. Partial collections are {record.data?.partialAllowed ? 'allowed' : 'not allowed'}. For help, contact support@example.com.</blockquote>
        <p className="text-xs text-muted-foreground">Synthetic example only. Approval does not send this message or apply the new version to existing mandates.</p>
      </div>
    </section>
  );
}

export function TemplateReview({ record, records }: { record: ValopayRecord; records: ValopayRecord[] }) {
  const { record: previous, linked } = previousVersion(record, records);
  const textChanged = !!previous && String(previous.data?.text ?? '') !== String(record.data?.text ?? '');
  const purposeChanged = !!previous && previous.data?.purpose !== record.data?.purpose;
  return (
    <section aria-label="Template review" className="space-y-4 rounded-lg border bg-secondary/10 p-4">
      <div><h3 className="font-semibold">{record.name} · Version {String(record.data?.version ?? '1')}</h3><HistoryNote current={record} previous={previous} linked={linked} /></div>
      <p className="text-sm">Purpose: {readableLabel(record.data?.purpose || 'Not provided')}{purposeChanged && <span className="ml-2 text-warning-foreground">Changed from {readableLabel(previous!.data?.purpose)}</span>}</p>
      {previous && <TemplatePreview title="Previous version — sample message" text={previous.data?.text} />}
      <TemplatePreview title={textChanged ? 'This version — message changed' : 'This version — sample message'} text={record.data?.text} />
      {previous && !textChanged && <p className="text-xs text-muted-foreground">The message wording is unchanged.</p>}
      <details className="text-xs"><summary className="cursor-pointer font-medium">Review original template placeholders</summary><pre className="mt-2 whitespace-pre-wrap break-words">{String(record.data?.text || '')}</pre></details>
    </section>
  );
}
