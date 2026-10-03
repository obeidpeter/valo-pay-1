import { readableLabel } from '@/components/record-label';

/** One record of each kind in plain words, for a list that mixes kinds: a case's evidence, a customer's history. */
const kindNames: Readonly<Record<string, string>> = {
  customers: 'Customer', mandates: 'Mandate', 'due-items': 'Instalment', attempts: 'Collection attempt', payments: 'Payment',
  observations: 'Payment evidence', allocations: 'Allocation', 'settlement-batches': 'Settlement batch', evidence: 'Evidence',
  closes: 'Daily close', exports: 'Export', policies: 'Retry policy', templates: 'Message template', notifications: 'Customer message',
  'retry-decisions': 'Retry decision', exceptions: 'Exception',
};

/** A record kind as one record of it is named ("due-items" is "Instalment"), never the kind's code. */
export function recordKindName(kind: unknown): string {
  const value = String(kind || '');
  return Object.hasOwn(kindNames, value) ? kindNames[value]! : readableLabel(value);
}
