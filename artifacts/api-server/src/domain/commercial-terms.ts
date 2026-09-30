import { DESIGN_PARTNER_DISCOUNT, discountDateProblem, discountProposedBy, discountTermsStatus, type DiscountConfirmationData } from '@workspace/valopay-schema';
import { touch } from './records';
import type { Context, TypedRecord } from './types';

/** BIL-02: explicit contract dates, never a funding month or a hard-coded year (the shared rule the console reads too). */
export { discountDateProblem };
type Terms = TypedRecord<'commercial'>['data'];
export type DiscountDecision = { ready: boolean; rate: number | null; explanation: string };

function refuse(message: string, status: number): never { throw Object.assign(new Error(message), { status }); }
/** The person behind an actor, as close reviews and import corrections take it: switching demo roles is not a second person. */
const principal = (ctx: Context) => ctx.principalId || (ctx.actor.startsWith('Sandbox ') ? 'unidentified-demo-person' : ctx.actor);

/** Called only by the role-checked record write: a proposal of the saved dates and reference, while the flags allow one. The client cannot supply one. */
export function reviewedDiscount(data: Terms, ctx: Context): Terms['discountReview'] {
  if (data.signed !== true || data.signedFullPriceTerms !== true || data.designPartner !== true || discountDateProblem(data) || !data.discountStartDate || !data.fullPriceStartDate || !data.discountTermsReference?.trim()) return undefined;
  return { reviewedBy: ctx.actor, reviewedAt: ctx.now, proposedPrincipal: principal(ctx), discountStartDate: data.discountStartDate, fullPriceStartDate: data.fullPriceStartDate, termsReference: data.discountTermsReference.trim() };
}

/** A different person's confirmation of the current dates prices new invoices; anything else blocks them, naming the actual cause. */
export function designPartnerDiscount(data: Terms | undefined, period: string): DiscountDecision {
  const status = discountTermsStatus(data);
  if (status.state === 'full_price') return { ready: true, rate: 0, explanation: status.explanation };
  if (!status.ready) return { ready: false, rate: null, explanation: status.explanation };
  const discounted = period >= data!.discountStartDate!.slice(0, 7) && period < data!.fullPriceStartDate!.slice(0, 7);
  return { ready: true, rate: discounted ? 1 - DESIGN_PARTNER_DISCOUNT : 0,
    explanation: `${discounted ? '50% design-partner discount' : 'Full public price'} for this billing month. ${status.explanation}` };
}

/**
 * BIL-02: a different Admin or Finance user confirms the proposed dates, naming the dates and reference they checked
 * against the signed agreement; the caller checks the role. The confirmer's principal must differ from the proposer's.
 */
export function confirmDiscountTerms(terms: TypedRecord<'commercial'>, ctx: Context, input: DiscountConfirmationData): NonNullable<Terms['discountReview']> {
  const status = discountTermsStatus(terms.data);
  if (status.state === 'full_price') refuse('These terms are billed at the full public price, so there are no discount dates to confirm.', 409);
  if (status.state === 'confirmed') refuse(`These discount dates are already confirmed by ${status.confirmation!.by}. Reload the page to see them.`, 409);
  if (status.state !== 'awaiting_confirmation') refuse(status.explanation, 409);
  const proposal = terms.data.discountReview!;
  if (input.discountStartDate !== proposal.discountStartDate || input.fullPriceStartDate !== proposal.fullPriceStartDate || input.discountTermsReference !== proposal.termsReference) {
    refuse('The proposed discount dates changed after you opened them. Reload the page and check the new dates against the signed agreement.', 409);
  }
  if (discountProposedBy(proposal, { actor: ctx.actor, principal: principal(ctx) })) {
    refuse('A different person must confirm these discount dates. The person who proposed them cannot confirm them. Switching demo roles is not a second person.', 403);
  }
  terms.data.discountReview = { ...proposal, confirmedBy: ctx.actor, confirmedPrincipal: principal(ctx), confirmedAt: ctx.now };
  touch(terms, ctx.now);
  return terms.data.discountReview;
}
