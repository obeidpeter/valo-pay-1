import { DESIGN_PARTNER_DISCOUNT, isRealDate } from '@workspace/valopay-schema';
import type { Context, TypedRecord } from './types';

type Terms = TypedRecord<'commercial'>['data'];
export type DiscountDecision = { ready: boolean; rate: number | null; explanation: string };
const fields = ['discountStartDate', 'fullPriceStartDate', 'discountTermsReference'] as const;

/** BIL-02: explicit contract dates, never a funding month or a hard-coded year. */
export function discountDateProblem(data: Terms): string | undefined {
  if (!fields.some(key => data[key] !== undefined && data[key] !== '')) return undefined;
  if (!fields.every(key => typeof data[key] === 'string' && data[key]!.trim())) return 'Enter both discount dates and the signed agreement reference.';
  for (const key of ['discountStartDate', 'fullPriceStartDate'] as const) {
    const date = data[key]!;
    if (!isRealDate(date) || !/^\d{4}-\d{2}-01$/.test(date)) return 'Discount dates must be the first day of a real billing month. Monthly invoices do not prorate a mid-month price change.';
  }
  if (data.fullPriceStartDate! <= data.discountStartDate!) return 'Full-price billing must start after the discount starts.';
  return undefined;
}

/** Called only by the role-checked record write; the client cannot supply a review identity. */
export function reviewedDiscount(data: Terms, ctx: Context): Terms['discountReview'] {
  if (data.signed !== true || data.signedFullPriceTerms !== true || data.designPartner !== true || discountDateProblem(data) || !data.discountStartDate || !data.fullPriceStartDate || !data.discountTermsReference?.trim()) return undefined;
  return { reviewedBy: ctx.actor, reviewedAt: ctx.now, discountStartDate: data.discountStartDate, fullPriceStartDate: data.fullPriceStartDate, termsReference: data.discountTermsReference.trim() };
}

/** A saved review is bound to its dates/reference. Missing or stale reviews block new pricing. */
export function designPartnerDiscount(data: Terms | undefined, period: string): DiscountDecision {
  if (!data || data.designPartner !== true) return { ready: true, rate: 0, explanation: 'Full public price.' };
  const review = data.discountReview;
  if (data.signed !== true || data.signedFullPriceTerms !== true || discountDateProblem(data) || !review || typeof review !== 'object' || Array.isArray(review)
    || typeof review.reviewedBy !== 'string' || !review.reviewedBy.trim() || typeof review.reviewedAt !== 'string' || !isRealDate(review.reviewedAt)
    || !data.discountStartDate || !data.fullPriceStartDate || !data.discountTermsReference?.trim()
    || review.discountStartDate !== data.discountStartDate || review.fullPriceStartDate !== data.fullPriceStartDate
    || review.termsReference !== data.discountTermsReference.trim()) {
    return { ready: false, rate: null, explanation: 'Review the discount dates against the signed agreement in Go-live evidence before issuing a new invoice. Older agreements are not assigned dates automatically.' };
  }
  const discounted = period >= data.discountStartDate.slice(0, 7) && period < data.fullPriceStartDate.slice(0, 7);
  return { ready: true, rate: discounted ? 1 - DESIGN_PARTNER_DISCOUNT : 0,
    explanation: `${discounted ? '50% design-partner discount' : 'Full public price'} for this billing month. Reviewed agreement: discount from ${data.discountStartDate}; full price from ${data.fullPriceStartDate}.` };
}
