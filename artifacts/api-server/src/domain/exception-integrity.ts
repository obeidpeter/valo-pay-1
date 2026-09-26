import { isDeepStrictEqual } from 'node:util';
import type { ValopayRecord } from './types';

/** Only the dedicated resolution/condition-clearing workflow may record these fields. */
export const exceptionActionFields = [
  'resolutionCode', 'resolvedBy', 'resolvedAt', 'resolutionRuleVersion', 'conditionCleared',
  'confirmedFailureCode', 'confirmedProviderIdentity', 'legacyType', 'legacyResolutionReview',
] as const;

/** A review of recorded historical evidence cannot be redirected to a different case while still open. */
export function exceptionReviewSubjectChanged(before: ValopayRecord, after: Partial<ValopayRecord>, linked?: ValopayRecord): boolean {
  if (before.kind !== 'exceptions' || !(before.data.legacyResolutionReview || (linked?.kind === 'settlement-batches' && linked.data.providerIdentityReview))) return false;
  return before.amountKobo !== after.amountKobo || before.customerId !== after.customerId
    || ['type', 'condition', 'linkedRecordId', 'linkedKind'].some(field => !isDeepStrictEqual(before.data[field], after.data?.[field]));
}

/** A completed decision's meaning and attribution remain the same on every later save. */
export function exceptionDecisionChanged(before: ValopayRecord, after: ValopayRecord, derivedCurrency?: string): boolean {
  if (before.kind !== 'exceptions' || !['resolved', 'closed'].includes(before.status)) return false;
  return (before.status !== after.status && !(before.status === 'resolved' && after.status === 'closed')) || before.amountKobo !== after.amountKobo || before.customerId !== after.customerId
    || (!isDeepStrictEqual(before.data.currency, after.data.currency) && !(!before.data.currency && derivedCurrency && after.data.currency === derivedCurrency))
    || [...exceptionActionFields, 'type', 'condition', 'linkedRecordId', 'linkedKind', 'countedTwice', 'otherCurrencyLines', 'notes']
      .some(field => !isDeepStrictEqual(before.data[field], after.data[field]));
}
