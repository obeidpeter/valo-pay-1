import { Link, useSearch } from 'wouter';
import { getListRecordsQueryKey, useListRecords, type ValopayRecord } from '@workspace/api-client-react';
import { heldEvidenceCodes, heldEvidenceOf, providerIdentityConfirmedCode, providerIdentityOf, providerIdentityParts, providerIdentityReviewOf, resolutionCodesForException, resolveExceptionType, unseenReversalCodes, unseenReversalOf } from '@workspace/valopay-schema';
import { formatDate, formatNumber } from '@/lib/formatters';
import { formatRecordMoney } from '@/lib/currencies';
import { readableLabel } from '@/components/record-label';
import { useWorkspace } from '@/lib/workspace-context';

/** A reversal waiting for a payment no connection has seen: a provider_status_mismatch whose condition names its evidence. */
const waitingReversal = (exception: ValopayRecord | null | undefined) =>
  resolveExceptionType(exception?.data?.type) === 'provider_status_mismatch' && unseenReversalOf(exception?.data?.condition) !== undefined;

/** A settlement batch held for its provider identity (FIN-03): a settlement_variance whose condition names the batch, its hold's own or a renewed review's. */
const identityHold = (exception: ValopayRecord | null | undefined) =>
  resolveExceptionType(exception?.data?.type) === 'settlement_variance' && providerIdentityOf(exception?.data?.condition) !== undefined;
/** Whether a role may confirm a held batch's identity: the service accepts it from Admin and Finance only (403 otherwise). */
const confirmsIdentity = (role: string | undefined) => role === 'Admin' || role === 'Finance';

/**
 * The codes one exception offers a person in this role: its codes (resolutionCodesForException), which for a batch's
 * provider identity hold follow whether the batch is still held (`held`, unknown while it loads, when only the
 * confirmation is offered), less provider_identity_confirmed for a role that may not record it, and none while the batch
 * can be confirmed as no connection (`blocked`), as the service would refuse every one (409).
 */
export function resolutionChoices(exception: ValopayRecord | null | undefined, role: string | undefined, held?: boolean, blocked?: string): readonly string[] {
  if (blocked && identityHold(exception) && held !== false) return [];
  return resolutionCodesForException(exception, { identityHeld: held !== false }).filter(code => code !== providerIdentityConfirmedCode || confirmsIdentity(role));
}

/** A settlement batch identity in words: its connection, as the service compares it, and its batch reference. */
export function providerIdentityLabel(identity: unknown): string {
  const parts = providerIdentityParts(identity);
  return parts ? `${parts.connection} (batch ${parts.batchReference})` : String(identity);
}

/** One other batch that records or claims an identity a held batch was held for, as reconciliation records it (providerIdentityClaimedBy). */
type IdentityClaim = { identity: string; batchId: string; reference: string; handEntered: boolean };
/** Why a held batch can be confirmed as none of its connections: each is another batch's too, which the data owner settles. */
function collisionExplanation(claims: readonly IdentityClaim[]): string {
  const named = claims.map(claim => `settlement batch ${claim.reference}${claim.handEntered ? ', entered by hand,' : ', built from the provider\'s lines,'} also records or claims ${providerIdentityLabel(claim.identity)}`);
  return `No connection can be confirmed for this settlement batch now: ${named.join('; ')}. A confirmation settles which connection's payout a batch is, not a collision between two batches: the data owner corrects the duplicate batch's reference or provider, and the next reconciliation then releases the genuine batch and closes this exception. Leave it open until then.`;
}

/**
 * The batch a provider identity exception names, as the resolve dialog needs it: whether it is still held for its
 * provider identity (`held`; undefined while it loads, for any other exception, and for a role that may not resolve
 * one), and while it is, the identities it may be confirmed as: those it was held for, or the one it already records,
 * less those another batch records or claims (providerIdentityClaimedBy, which the service refuses with 409), with why
 * none is left when none is (`blocked`).
 */
export function useHeldBatchIdentities(exception: ValopayRecord | null | undefined, enabled: boolean, role: string | undefined): { held?: boolean; identities: { label: string; value: string }[]; blocked?: string } {
  const { merchantId } = useWorkspace();
  const batchId = identityHold(exception) ? providerIdentityOf(exception?.data?.condition) : undefined;
  const params = { merchantId: merchantId || '', id: batchId || '' };
  const found = useListRecords('settlement-batches', params, { query: { enabled: enabled && confirmsIdentity(role) && !!merchantId && !!batchId, queryKey: getListRecordsQueryKey('settlement-batches', params) } });
  const batch = enabled && confirmsIdentity(role) ? found.data?.items?.find(item => item.id === batchId) : undefined;
  if (!batch) return { identities: [] };
  const review = batch.data?.providerIdentityReview as { identities?: unknown } | undefined;
  // Released (providerIdentityRelease), the batch is no longer held: its hold's exception stays open only for the reports it carries.
  if (!review || batch.data?.providerIdentityRelease) return { held: false, identities: [] };
  const identities = Array.isArray(review.identities) ? review.identities.map(String) : [];
  const recorded = batch.data?.providerIdentityKey;
  const heldFor = recorded ? identities.filter(identity => identity === recorded) : identities;
  const claims = (Array.isArray(batch.data?.providerIdentityClaimedBy) ? batch.data.providerIdentityClaimedBy : []) as IdentityClaim[];
  const choices = heldFor.filter(identity => !claims.some(claim => claim.identity === identity));
  return {
    held: true, identities: choices.map(identity => ({ label: providerIdentityLabel(identity), value: identity })),
    ...(heldFor.length && !choices.length ? { blocked: collisionExplanation(claims.filter(claim => heldFor.includes(claim.identity))) } : {}),
  };
}

/** What the resolve dialog refuses before sending for a held batch: a confirmation with no identity, or an identity with another outcome. */
export function providerIdentityErrors(values: Record<string, unknown>): Record<string, string> {
  if (values.resolutionCode === providerIdentityConfirmedCode && !values.confirmedProviderIdentity) return { confirmedProviderIdentity: 'Choose the connection the providers confirmed this batch pays out.' };
  if (values.resolutionCode !== providerIdentityConfirmedCode && values.confirmedProviderIdentity) return { confirmedProviderIdentity: 'Choose a connection only when you record Provider identity confirmed.' };
  return {};
}

/**
 * A resolution code's name for one exception. A reversal waiting for its payment offers two of the generic mismatch's
 * codes, whose own names (about a mandate's or attempt's state) do not say what they do to it, so each also says that;
 * every other code is named as everywhere else.
 */
export function resolutionLabel(exception: ValopayRecord | null | undefined, code: unknown): string {
  if (waitingReversal(exception) && code === unseenReversalCodes.adopted) return 'Provider state adopted; reversal waits for its payment';
  if (waitingReversal(exception) && code === unseenReversalCodes.setAside) return 'Platform state confirmed; reversal set aside for good';
  return readableLabel(code);
}

/**
 * What recording the chosen outcome does where the service acts on it: evidence held as a suspected duplicate, a payment
 * held as one, and a reversal waiting for its payment, which the next reconciliation reads the resolution of before it
 * looks for any payment, and a settlement batch held for its provider identity, which a confirmation of its connection
 * releases. Undefined where resolving records the outcome and reason alone.
 */
export function resolutionEffect(exception: ValopayRecord, code: unknown, held?: boolean, blocked?: string): string | undefined {
  const type = resolveExceptionType(exception.data?.type), chosen = String(code || '');
  if (identityHold(exception) && held !== false) {
    if (blocked) return blocked;
    // Its only outcome confirms whose payout the batch is: any other would close it while the batch stays held.
    const review = providerIdentityReviewOf(exception.data?.condition) !== undefined, it = review ? 'this review' : 'this exception';
    if (!chosen) return `${review ? 'An earlier resolution of this batch\'s hold keeps its meaning, but the batch stays held, with its evidence uncounted, until Finance or an administrator confirms whose payout it is. ' : ''}Once the providers have confirmed whose payout this settlement batch is, choose Provider identity confirmed and that connection. If they cannot attribute it to one connection, leave ${it} open: once the data owner has repaired the evidence, the next reconciliation releases the batch and closes ${it}.`;
    if (chosen === providerIdentityConfirmedCode) return 'The next reconciliation releases this settlement batch as the payout of the connection you choose. Its settlement lines and statement credits of that connection stay with it, and so does evidence that names no connection. Each settlement line of another connection moves to that connection\'s own batch, and each statement credit of another connection is left to link to its own; the batch\'s gross, fee and net leave out the lines that move, unless they were typed by hand, and its expected fee always does. No money moves.';
  }
  if (waitingReversal(exception)) {
    // No code keeps it open for Finance to check (escalated_to_provider is not offered), so the box says to leave it open.
    if (!chosen) return 'Leave this exception open while you check with the provider which collection the reversal reverses: if its payment arrives meanwhile through the same connection and agrees with it, the reversal applies to it; if the payment comes through another connection, or names another payer, currency or amount, the reversal is held for you with an exception of its own. Either way this exception closes. Once the provider has answered, choose the outcome, and this box says what the next reconciliation does with it.';
    return chosen === unseenReversalCodes.adopted
      ? 'The reversal keeps waiting for its payment, with no new exception: the reconciliation that records that payment reverses it, or holds it for you if the payment names another payer, currency or amount. No money moves.'
      : 'The next reconciliation sets the reversal aside for good: it reverses nothing, even if its payment arrives later. No money moves.';
  }
  if (type !== 'suspected_duplicate') return undefined;
  if (!heldEvidenceOf(exception.data?.condition)) {
    // A payment held as a suspected duplicate: only distinct payments changes it.
    return chosen === 'distinct_payments' ? 'Distinct payments releases this payment from its duplicate hold at once: it is then matched like any other payment. No money moves.' : undefined;
  }
  if (!chosen) return 'Choose the outcome once you have checked the evidence. This box then says what the next reconciliation does with it.';
  if (chosen === heldEvidenceCodes.samePayment) return 'The next reconciliation joins this evidence to the payment this exception names, while it is held for its connection alone: evidence of a payment becomes more evidence of it, with no second payment made, and evidence of a reversal reverses that payment. If the payment changes first so that the evidence no longer agrees with it, the evidence is held for you again. No money moves.';
  if (chosen === heldEvidenceCodes.notMoney) return 'The next reconciliation sets this evidence aside for good: no payment is made from it, and it is joined to no payment. No money moves.';
  return `The next reconciliation records this evidence as a payment of its own${chosen === 'confirmed_duplicate_refund' ? ', held until its refund is recorded' : ''}. Evidence of a reversal is set aside instead, since no payment is made only to be reversed. No money moves.`;
}

/**
 * What confirming whose payout a held batch is does to the reports its exception carries: nothing, since only Finance's
 * resolution of a report settles it; each comes back as an exception of its own once the batch is released.
 */
const heldCarried = (exception: ValopayRecord, held: boolean | undefined, what: string, one: boolean): string | undefined =>
  identityHold(exception) && held !== false
    ? `This exception also carries ${what}. Confirming whose payout the batch is settles no report: after the release, ${one ? 'the report comes' : 'each report comes'} back as an exception of its own, to resolve once you have checked with the provider.`
    : undefined;

/**
 * What any resolution also does to an exception that carries reports of a collection the provider counts in two
 * settlement batches (data.countedTwice, reports the service added to it while it was open for their batch): it settles
 * them, so none is raised again; except a confirmation of a held batch's provider identity (`held`), which settles none.
 * Undefined for an exception that carries none.
 */
export function countedTwiceEffect(exception: ValopayRecord, held?: boolean): string | undefined {
  const reports = Array.isArray(exception.data?.countedTwice) ? exception.data.countedTwice.length : 0;
  if (!reports) return undefined;
  const carried = heldCarried(exception, held, reports === 1 ? 'the provider\'s report of a collection counted in two settlement batches' : `${formatNumber(reports)} of the provider's reports of collections counted in two settlement batches`, reports === 1);
  if (carried) return carried;
  return reports === 1
    ? 'This exception also carries the provider\'s report of a collection counted in two settlement batches. Resolving it settles that report too, whichever outcome you record: it is not raised again, so check both payouts with the provider first.'
    : `This exception also carries ${formatNumber(reports)} of the provider's reports of collections counted in two settlement batches. Resolving it settles those reports too, whichever outcome you record: they are not raised again, so check both payouts of each with the provider first.`;
}

/**
 * What any resolution also does to an exception that carries reports of settlement lines in another currency than their
 * batch (data.otherCurrencyLines, reports the service added to it while it was open for their batch): it settles them,
 * so none is raised again; except a confirmation of a held batch's provider identity (`held`), which settles none.
 * Undefined for an exception that carries none.
 */
export function otherCurrencyLinesEffect(exception: ValopayRecord, held?: boolean): string | undefined {
  const reports = Array.isArray(exception.data?.otherCurrencyLines) ? exception.data.otherCurrencyLines.length : 0;
  if (!reports) return undefined;
  const carried = heldCarried(exception, held, reports === 1 ? 'the report of a settlement line in another currency than its batch' : `${formatNumber(reports)} reports of settlement lines in another currency than their batch`, reports === 1);
  if (carried) return carried;
  return reports === 1
    ? 'This exception also carries the report of a settlement line in another currency than its batch, which the batch does not count. Resolving it settles that report too, whichever outcome you record: it is not raised again, so check with the provider which batch pays the line out first.'
    : `This exception also carries ${formatNumber(reports)} reports of settlement lines in another currency than their batch, which the batch does not count. Resolving it settles those reports too, whichever outcome you record: they are not raised again, so check with the provider which batch pays each line out first.`;
}

export function ExceptionContext({ exception, customer, resolutionCode, resolving }: { exception: ValopayRecord; customer?: ValopayRecord; resolutionCode?: unknown; resolving: boolean }) {
  const type = resolveExceptionType(exception.data?.type);
  // A batch's provider identity hold: what resolving does follows whether the batch is still held (one request with the dialog's).
  const { workspace } = useWorkspace();
  const { held, blocked } = useHeldBatchIdentities(exception, resolving, workspace?.role);
  const lender = new URLSearchParams({ lender: exception.merchantId });
  const linkedId = String(exception.data?.linkedRecordId || '');
  const customerParams = new URLSearchParams(lender);
  const queueParams = new URLSearchParams(useSearch());
  queueParams.set('lender', exception.merchantId);
  queueParams.delete('returnTo');
  customerParams.set('returnTo', '/exceptions?' + queueParams);
  if (linkedId) customerParams.set('record', linkedId);
  const financial = type && ['unallocated_payment', 'suspected_duplicate', 'overpayment', 'settlement_variance'].includes(type);
  const mandate = type && ['activation_expired', 'mandate_limit_exceeded', 'imported_consent_gap'].includes(type);
  const checkout = exception.data?.linkedKind === 'connected-intents';
  // What recording the outcome does: a dispute's instalment and a pay-by-bank checkout's instalment follow the resolution,
  // and so do held evidence, a held payment, a waiting reversal and a batch held for its provider identity (resolutionEffect).
  const effect = checkout
    ? 'Confirmed successful records the pay-by-bank payment as received, with your evidence reference, and applies it to its instalment; Confirmed failed, or Provider confirmed no debit, records the checkout as failed. Either way the checkout no longer holds its instalment, so a new checkout or retry may follow. No money moves.'
    : type === 'customer_dispute'
      ? 'Not upheld takes the instalment out of dispute: its status then follows its balance, and collection and allocation resume. Upheld or mandate cancelled keeps it in dispute until Finance releases it from dispute on the Collections page. No money moves.'
      : resolutionEffect(exception, resolutionCode, held, blocked) ?? 'Resolving this exception records your outcome and reason. It does not allocate a payment, issue a refund, reissue a mandate or move money. Complete any required action in its workflow and include its evidence reference in your reason.';
  const carried = [countedTwiceEffect(exception, held), otherCurrencyLinesEffect(exception, held)].filter(Boolean).join(' ') || undefined;
  return <section aria-label="Exception context" className="space-y-3 rounded-lg border bg-secondary/10 p-4 text-sm">
    <div><h3 className="font-semibold">{readableLabel(exception.data?.type)}</h3><p className="mt-1 font-mono text-xs">{exception.reference || exception.id}</p></div>
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2"><dt className="text-muted-foreground">Customer</dt><dd className="min-w-0 break-words">{customer ? `${customer.name} · ${customer.reference}` : exception.customerId ? `Customer ${exception.customerId} (name unavailable)` : 'No customer linked'}</dd><dt className="text-muted-foreground">Amount</dt><dd className="font-semibold">{formatRecordMoney(exception, exception.amountKobo)}</dd><dt className="text-muted-foreground">Owner</dt><dd>{String(exception.data?.owner || 'Unassigned')}</dd>{Boolean(exception.data?.dueBy) && <><dt className="text-muted-foreground">Deadline</dt><dd>{formatDate(String(exception.data.dueBy))}</dd></>}</dl>
    <div className="rounded-md border bg-background p-3"><p className="font-medium">Recorded issue</p><p className="mt-1 whitespace-pre-wrap break-words">{String(exception.data?.notes || 'No notes have been recorded. Review the linked evidence before choosing an outcome.')}</p></div>
    {linkedId && <p className="break-all text-xs text-muted-foreground">Linked record: {linkedId}</p>}
    <div className="flex flex-wrap gap-x-4 gap-y-2">{exception.customerId && <Link className="min-h-6 text-primary underline" href={`/customers/${encodeURIComponent(exception.customerId)}?${customerParams}${linkedId ? `#record-${encodeURIComponent(linkedId)}` : ''}`}>Review customer history</Link>}{financial && <Link className="min-h-6 text-primary underline" href={`/reconciliation?${lender}`}>Review reconciliation</Link>}{mandate && <Link className="min-h-6 text-primary underline" href={`/mandates?${lender}`}>Review mandates</Link>}{checkout && <Link className="min-h-6 text-primary underline" href={`/pay-by-bank?${lender}`}>Review the pay-by-bank checkout</Link>}{!financial && !mandate && !checkout && <Link className="min-h-6 text-primary underline" href={`/collections?${lender}`}>Review collections</Link>}</div>
    {resolving && <div className="rounded-md border bg-background p-3"><p className="font-medium">{resolutionCode ? `Record outcome: ${resolutionLabel(exception, resolutionCode)}` : 'Record an outcome after reviewing the evidence.'}</p><p className="mt-1">{effect}</p>{carried && <p className="mt-1">{carried}</p>}</div>}
  </section>;
}
