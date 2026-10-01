import { Link, useSearch } from 'wouter';
import { getListRecordsQueryKey, useListRecords, type ValopayRecord } from '@workspace/api-client-react';
import { conditionClearedCode, heldEvidenceCodes, heldEvidenceOf, providerIdentityConfirmedCode, providerIdentityOf, providerIdentityParts, providerIdentityReviewOf, resolutionCodesForException, resolveExceptionType, unseenReversalCodes, unseenReversalOf } from '@workspace/valopay-schema';
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
  const named = claims.map(claim => `settlement batch ${claim.reference} (${claim.handEntered ? 'entered by hand' : 'built from the provider’s lines'}) also names ${providerIdentityLabel(claim.identity)}`);
  return `You cannot confirm a connection for this settlement batch yet. ${claims.length === 1 ? 'Another batch names the same connection' : 'Other batches name the same connections'}: ${named.join('; ')}. Confirming a connection cannot settle two batches that claim one payout. Ask the person who manages this data to correct the reference or provider of the duplicate batch. The next reconciliation then releases the correct batch and closes this exception. Leave it open until then.`;
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
  if (values.resolutionCode === providerIdentityConfirmedCode && !values.confirmedProviderIdentity) return { confirmedProviderIdentity: 'Choose the connection the providers confirmed for this batch.' };
  if (values.resolutionCode !== providerIdentityConfirmedCode && values.confirmedProviderIdentity) return { confirmedProviderIdentity: `Clear the connection, or choose the outcome ${readableLabel(providerIdentityConfirmedCode)}.` };
  return {};
}

/**
 * A resolution code's name for one exception. A reversal waiting for its payment offers two of the generic mismatch's
 * codes, whose own names (about a mandate's or attempt's state) do not say what they do to it, so each also says that;
 * every other code is named as everywhere else.
 */
export function resolutionLabel(exception: ValopayRecord | null | undefined, code: unknown): string {
  if (waitingReversal(exception) && code === unseenReversalCodes.adopted) return 'Provider status accepted; reversal waits for its payment';
  if (waitingReversal(exception) && code === unseenReversalCodes.setAside) return 'Valo Pay status kept; reversal set aside permanently';
  return readableLabel(code);
}

/**
 * An exception's status as a person reads it. Valo Pay closes an exception whose cause went away (condition_cleared):
 * that one reads Closed automatically, and one a person resolved reads Resolved.
 */
export function exceptionStatus(exception: { status: string; data?: Record<string, unknown> | null }): string {
  return exception.status === 'closed' && exception.data?.resolutionCode === conditionClearedCode ? conditionClearedCode : exception.status;
}

/**
 * What the resolve dialog explains: one paragraph about the chosen outcome, or, where the reader still has a choice, the
 * writing standard's three parts: what happened, each choice on its own line, then what happens next.
 */
export type Guidance = string | { happened: string; choices: ReadonlyArray<readonly [choice: string, effect: string]>; next: string };

/**
 * What recording the chosen outcome does where the service acts on it: evidence held as a possible duplicate, a payment
 * held as one, and a reversal waiting for its payment, which the next reconciliation reads the resolution of before it
 * looks for any payment, and a settlement batch held for its provider identity, which a confirmation of its connection
 * releases. Undefined where resolving records the outcome and reason alone.
 */
export function resolutionEffect(exception: ValopayRecord, code: unknown, held?: boolean, blocked?: string): Guidance | undefined {
  const type = resolveExceptionType(exception.data?.type), chosen = String(code || '');
  if (identityHold(exception) && held !== false) {
    if (blocked) return blocked;
    // Its only outcome confirms whose payout the batch is: any other would close it while the batch stays held.
    const review = providerIdentityReviewOf(exception.data?.condition) !== undefined, it = review ? 'this review' : 'this exception';
    if (!chosen) return {
      happened: `${review ? 'An earlier resolution of this batch’s hold still stands, but the batch stays on hold. ' : 'This settlement batch is on hold. '}Its evidence is not counted until Finance or an Admin confirms which connection paid it out.`,
      choices: [
        [readableLabel(providerIdentityConfirmedCode), 'Choose this with the connection the providers confirmed. The next reconciliation then releases the batch.'],
        [`Leave ${it} open`, `Do this if the providers cannot say which connection it was. When the person who manages this data has corrected it, the next reconciliation releases the batch and closes ${it}.`],
      ],
      next: 'Check with the providers before you choose. No money moves.',
    };
    if (chosen === providerIdentityConfirmedCode) return 'The next reconciliation releases this settlement batch as a payout of the connection you choose. Settlement lines and bank statement lines for that connection stay with the batch. So does evidence that names no connection. Settlement lines for other connections move to their own batches, and bank statement lines for them are left to link to their own. The batch’s amounts before fees, fee and after fees leave out the lines that move, unless someone typed them by hand. The expected fee always leaves them out. No money moves.';
  }
  if (waitingReversal(exception)) {
    // No code keeps it open for Finance to check (escalated_to_provider is not offered), so the box says to leave it open.
    if (!chosen) return {
      happened: 'This reversal names a payment that no connection has reported yet.',
      choices: [
        ['Leave this exception open', 'Do this while you ask the provider which payment the reversal belongs to. If that payment arrives through the same connection and matches, the reversal applies to it. If it arrives through another connection, or names a different payer, currency or amount, the reversal is held for you as a new exception. Either way, this exception then closes.'],
        [resolutionLabel(exception, unseenReversalCodes.adopted), 'The reversal keeps waiting for its payment, with no new exception.'],
        [resolutionLabel(exception, unseenReversalCodes.setAside), 'The reversal reverses nothing, even if its payment arrives later.'],
      ],
      next: 'When the provider has answered, choose an outcome. This box then shows what the next reconciliation will do.',
    };
    return chosen === unseenReversalCodes.adopted
      ? 'The reversal keeps waiting for its payment, and no new exception is raised. When reconciliation records that payment, it reverses it. If the payment names a different payer, currency or amount, the reversal is held for you instead. No money moves.'
      : 'The next reconciliation sets the reversal aside permanently. It reverses nothing, even if its payment arrives later. No money moves.';
  }
  if (type !== 'suspected_duplicate') return undefined;
  if (!heldEvidenceOf(exception.data?.condition)) {
    // A payment held as a possible duplicate: only distinct payments changes it.
    return chosen === 'distinct_payments' ? `Choosing ${readableLabel(chosen)} releases this payment from its duplicate hold straight away. It is then matched like any other payment. No money moves.` : undefined;
  }
  if (!chosen) return 'Choose the outcome once you have checked the evidence. This box then shows what the next reconciliation will do.';
  if (chosen === heldEvidenceCodes.samePayment) return 'The next reconciliation joins this evidence to the payment this exception names. Evidence of that payment becomes extra evidence for it, and no second payment is created. Evidence of a reversal reverses that payment. If the payment changes first and the evidence no longer matches it, the evidence is held for you again. No money moves.';
  if (chosen === heldEvidenceCodes.notMoney) return 'The next reconciliation sets this evidence aside permanently. It does not create a payment and is not joined to any payment. No money moves.';
  return `The next reconciliation records this evidence as a separate payment${chosen === 'confirmed_duplicate_refund' ? ', held until its refund is recorded' : ''}. Evidence of a reversal is set aside instead, because Valo Pay does not create a payment only to reverse it. No money moves.`;
}

/**
 * What confirming whose payout a held batch is does to the reports its exception carries: nothing, since only Finance's
 * resolution of a report settles it; each comes back as an exception of its own once the batch is released.
 */
const heldCarried = (exception: ValopayRecord, held: boolean | undefined, what: string, one: boolean): string | undefined =>
  identityHold(exception) && held !== false
    ? `This exception also includes ${what}. Confirming the connection does not settle ${one ? 'it' : 'them'}. After the batch is released, ${one ? 'the report comes' : 'each report comes'} back as its own exception. Resolve it after you have checked with the provider.`
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
  const carried = heldCarried(exception, held, reports === 1 ? 'the provider’s report of a payment counted in two settlement batches' : `${formatNumber(reports)} provider reports of payments counted in two settlement batches`, reports === 1);
  if (carried) return carried;
  return reports === 1
    ? 'This exception also includes the provider’s report of a payment counted in two settlement batches. Resolving the exception also closes that report, whatever outcome you choose, and it will not be raised again. Check both payouts with the provider first.'
    : `This exception also includes ${formatNumber(reports)} provider reports of payments counted in two settlement batches. Resolving the exception also closes those reports, whatever outcome you choose, and they will not be raised again. Check both payouts of each with the provider first.`;
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
  const carried = heldCarried(exception, held, reports === 1 ? 'the report of a settlement line in a different currency from its batch' : `${formatNumber(reports)} reports of settlement lines in a different currency from their batch`, reports === 1);
  if (carried) return carried;
  return reports === 1
    ? 'This exception also includes a report of a settlement line in a different currency from its batch. The batch does not count that line. Resolving the exception also closes the report, whatever outcome you choose, and it will not be raised again. First ask the provider which batch pays out the line.'
    : `This exception also includes ${formatNumber(reports)} reports of settlement lines in a different currency from their batch. The batch does not count those lines. Resolving the exception also closes those reports, whatever outcome you choose, and they will not be raised again. First ask the provider which batch pays out each line.`;
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
  const guidance: Guidance = checkout
    ? {
        happened: 'The outcome of this Pay by Bank payment is unknown.',
        choices: [
          [readableLabel('resolved_succeeded'), 'Records the payment as received, with your evidence reference, and allocates it to its instalment.'],
          [readableLabel('resolved_failed'), 'Records the checkout as failed.'],
          [readableLabel('provider_confirmed_no_debit'), 'Records the checkout as failed.'],
        ],
        next: 'Whichever you choose, the checkout stops holding its instalment, so a new checkout or a retry can follow. No money moves.',
      }
    : type === 'customer_dispute'
      ? {
          happened: 'The customer disputes this instalment. Collection and allocation are paused while it is in dispute.',
          choices: [
            [readableLabel('not_upheld'), 'Takes the instalment out of dispute. Its status goes back to match its balance, and collection and allocation start again.'],
            [readableLabel('upheld_refund'), 'Keeps the instalment in dispute until Finance releases it on the Collections page.'],
            [readableLabel('mandate_cancelled'), 'Keeps the instalment in dispute until Finance releases it on the Collections page.'],
          ],
          next: 'Your outcome and reason are saved in the audit log. No money moves.',
        }
      : resolutionEffect(exception, resolutionCode, held, blocked) ?? 'Resolving records your outcome and reason. It does not allocate a payment, issue a refund, reissue a mandate or move money. If the outcome needs another action, such as a refund, do it first and put its reference in your reason.';
  const carried = [countedTwiceEffect(exception, held), otherCurrencyLinesEffect(exception, held)].filter(Boolean).join(' ') || undefined;
  return <section aria-label="Exception context" className="space-y-3 rounded-lg border bg-secondary/10 p-4 text-sm">
    <div><h3 className="font-semibold">{readableLabel(exception.data?.type)}</h3><p className="mt-1 font-mono text-xs">{exception.reference || 'No reference'}</p></div>
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2"><dt className="text-muted-foreground">Customer</dt><dd className="min-w-0 break-words">{customer ? `${customer.name} · ${customer.reference}` : exception.customerId ? 'Name not available' : 'No customer linked'}</dd><dt className="text-muted-foreground">Amount</dt><dd className="font-semibold">{formatRecordMoney(exception, exception.amountKobo)}</dd><dt className="text-muted-foreground">Team</dt><dd>{String(exception.data?.owner || 'No team')}</dd>{Boolean(exception.data?.dueBy) && <><dt className="text-muted-foreground">Deadline</dt><dd>{formatDate(String(exception.data.dueBy))}</dd></>}</dl>
    <div className="rounded-md border bg-background p-3"><p className="font-medium">Notes</p><p className="mt-1 whitespace-pre-wrap break-words">{String(exception.data?.notes || 'No notes yet. Check the linked evidence before you choose an outcome.')}</p></div>
    <div className="flex flex-wrap gap-x-4 gap-y-2">{exception.customerId && <Link className="min-h-6 text-primary underline" href={`/customers/${encodeURIComponent(exception.customerId)}?${customerParams}${linkedId ? `#record-${encodeURIComponent(linkedId)}` : ''}`}>Open Customer history</Link>}{financial && <Link className="min-h-6 text-primary underline" href={`/reconciliation?${lender}`}>Open Reconciliation</Link>}{mandate && <Link className="min-h-6 text-primary underline" href={`/mandates?${lender}`}>Open Mandates</Link>}{checkout && <Link className="min-h-6 text-primary underline" href={`/pay-by-bank?${lender}`}>Open Pay by Bank</Link>}{!financial && !mandate && !checkout && <Link className="min-h-6 text-primary underline" href={`/collections?${lender}`}>Open Collections</Link>}</div>
    {resolving && <div className="rounded-md border bg-background p-3"><p className="font-medium">{resolutionCode ? `Record outcome: ${resolutionLabel(exception, resolutionCode)}` : 'Record an outcome after reviewing the evidence.'}</p><GuidanceText guidance={guidance} />{carried && <p className="mt-2">{carried}</p>}</div>}
  </section>;
}

/** A paragraph, or what happened, each choice on its own line, then what happens next. */
function GuidanceText({ guidance }: { guidance: Guidance }) {
  if (typeof guidance === 'string') return <p className="mt-1">{guidance}</p>;
  return <>
    <p className="mt-1">{guidance.happened}</p>
    <ul className="mt-2 space-y-1.5">{guidance.choices.map(([choice, effect]) => <li key={choice}><span className="font-medium">{choice}:</span> {effect}</li>)}</ul>
    <p className="mt-2">{guidance.next}</p>
  </>;
}
