import { z } from "zod";
import { isRealDate, isoDay } from "./records";

/**
 * BIL-02: whether design-partner terms can price a new invoice, shared by the
 * service and the console so the invoice refusal, the statement, the report
 * and Go-live evidence give a cause in the same words. The service stamps a
 * proposal when Admin or Finance saves signed terms with the dates, and a
 * different Admin or Finance user confirms it (confirm_discount_terms).
 */
type Terms = Record<string, unknown>;
const contractFields = ["discountStartDate", "fullPriceStartDate", "discountTermsReference"] as const;
const fieldNames: Record<(typeof contractFields)[number], string> = { discountStartDate: "discount start date", fullPriceStartDate: "full-price start date", discountTermsReference: "signed agreement reference" };
const LEAD = "These design-partner terms cannot price a new invoice yet.";
const UNREADABLE = "The recorded proposal or confirmation of these discount dates cannot be read: save the commercial terms again to propose the dates afresh. If that save is refused, add replacement terms from the signed agreement with Add terms; the original record stays as it is.";
const listed = (items: string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const filled = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const objectOf = (value: unknown): Terms | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Terms : undefined;

/** BIL-02: explicit contract dates, never a funding month or a hard-coded year. Terms that name none of them have no dates yet. */
export function discountDateProblem(data: Terms): string | undefined {
  if (!contractFields.some(key => data[key] !== undefined && data[key] !== "")) return undefined;
  if (!contractFields.every(key => filled(data[key]))) return "Enter both discount dates and the signed agreement reference.";
  for (const key of ["discountStartDate", "fullPriceStartDate"] as const) {
    const date = data[key] as string;
    if (!isRealDate(date) || !/^\d{4}-\d{2}-01$/.test(date)) return "Discount dates must be the first day of a real billing month. Monthly invoices do not prorate a mid-month price change.";
  }
  if ((data.fullPriceStartDate as string) <= (data.discountStartDate as string)) return "Full-price billing must start after the discount starts.";
  return undefined;
}

/**
 * Whether the person confirming discount dates is the person who proposed
 * them: the same actor, or the same principal (a staff account's signed-in
 * identity, or a sandbox's one visitor, whatever demo role it plays). A
 * proposal an earlier build stamped names no principal: a demo role then
 * stands for the sandbox's visitor, who proposed it.
 */
export function discountProposedBy(proposal: { reviewedBy: string; proposedPrincipal?: string }, confirmer: { actor: string; principal: string }): boolean {
  if (confirmer.actor === proposal.reviewedBy) return true;
  if (proposal.proposedPrincipal !== undefined) return confirmer.principal === proposal.proposedPrincipal;
  return proposal.reviewedBy.startsWith("Sandbox ") && confirmer.actor.startsWith("Sandbox ");
}

/** Why design-partner terms cannot price a new invoice, or that they can: full_price for terms that are not a design partner's, confirmed when a second person confirmed the current dates. */
export type DiscountTermsState =
  | "full_price" | "unsigned" | "full_price_terms_unsigned" | "dates_missing" | "dates_unreadable" | "dates_invalid"
  | "not_proposed" | "evidence_unreadable" | "changed_since_proposed" | "changed_since_confirmed" | "awaiting_confirmation" | "confirmed";
/** Who recorded a step of the decision, as the service recorded them (a demo role or a staff account), and when. */
export interface DiscountTermsStep { by: string; at: string }
/** Whether the terms can price a new invoice, the first cause when not, why in words, and who proposed and confirmed the current dates. */
export interface DiscountTermsStatus { state: DiscountTermsState; ready: boolean; explanation: string; proposal?: DiscountTermsStep; confirmation?: DiscountTermsStep }

/**
 * The state of a commercial record's design-partner pricing, read from stored
 * data that an earlier build or a direct write may have left in any shape.
 * Everything Finance enters is named at once; the proposal and confirmation
 * are read only once that is complete. Pricing is ready only with a
 * confirmation, by a different person, of the current dates and reference.
 */
export function discountTermsStatus(data: unknown): DiscountTermsStatus {
  const terms = objectOf(data) ?? {};
  if (terms.designPartner !== true) return { state: "full_price", ready: true, explanation: "Full public price." };
  const blocked = (state: DiscountTermsState, ...sentences: string[]): DiscountTermsStatus => ({ state, ready: false, explanation: [LEAD, ...sentences].join(" ") });
  if (terms.signed !== true) return blocked("unsigned", "They are not signed, so they bill nothing: tick “Signed” once the agreement is signed.");
  const causes: Array<[DiscountTermsState, string]> = [];
  if (terms.signedFullPriceTerms !== true) causes.push(["full_price_terms_unsigned", "The full-price terms are not recorded as signed: tick “Full-price terms are signed” once they are, so that the discount dates can be proposed."]);
  const unreadable = contractFields.filter(key => terms[key] !== undefined && terms[key] !== null && typeof terms[key] !== "string");
  const missing = contractFields.filter(key => !unreadable.includes(key) && !filled(terms[key]));
  if (missing.length) {
    const names = listed(missing.map(key => `the ${fieldNames[key]}`));
    causes.push(["dates_missing", `${names.charAt(0).toUpperCase()}${names.slice(1)} ${missing.length === 1 ? "is missing: enter it" : "are missing: enter them"} from the signed agreement.`]);
  }
  if (unreadable.length) causes.push(["dates_unreadable", `The saved ${listed(unreadable.map(key => fieldNames[key]))} cannot be read: enter ${unreadable.length === 1 ? "it" : "them"} again from the signed agreement.`]);
  const problem = missing.length || unreadable.length ? undefined : discountDateProblem(terms);
  if (problem) causes.push(["dates_invalid", `The saved discount dates need correcting. ${problem}`]);
  if (causes.length) return blocked(causes[0]![0], ...causes.map(([, sentence]) => sentence));
  const review = terms.discountReview;
  if (review === undefined || review === null) return blocked("not_proposed", "No proposal is recorded for these discount dates: save the commercial terms again to propose them for confirmation.");
  const proposal = objectOf(review);
  if (!proposal || !filled(proposal.reviewedBy) || typeof proposal.reviewedAt !== "string" || !isRealDate(proposal.reviewedAt)
    || ![proposal.discountStartDate, proposal.fullPriceStartDate, proposal.termsReference].every(value => typeof value === "string")
    || (proposal.proposedPrincipal !== undefined && !filled(proposal.proposedPrincipal))) return blocked("evidence_unreadable", UNREADABLE);
  const confirmed = ["confirmedBy", "confirmedPrincipal", "confirmedAt"].some(key => proposal[key] !== undefined);
  if (confirmed && (!filled(proposal.confirmedBy) || !filled(proposal.confirmedPrincipal) || typeof proposal.confirmedAt !== "string" || !isRealDate(proposal.confirmedAt)
    || discountProposedBy({ reviewedBy: proposal.reviewedBy, proposedPrincipal: proposal.proposedPrincipal as string | undefined }, { actor: proposal.confirmedBy, principal: proposal.confirmedPrincipal }))) return blocked("evidence_unreadable", UNREADABLE);
  const start = terms.discountStartDate as string, end = terms.fullPriceStartDate as string;
  if (proposal.discountStartDate !== start || proposal.fullPriceStartDate !== end || proposal.termsReference !== (terms.discountTermsReference as string).trim()) {
    return confirmed
      ? blocked("changed_since_confirmed", "The discount dates or agreement reference changed after they were confirmed: save the commercial terms again to propose the current dates for a new confirmation.")
      : blocked("changed_since_proposed", "The discount dates or agreement reference changed after they were proposed: save the commercial terms again to propose the current dates.");
  }
  const proposed = { by: proposal.reviewedBy, at: proposal.reviewedAt };
  if (!confirmed) return { ...blocked("awaiting_confirmation", "The discount dates await confirmation: a different Admin or Finance user from the person who proposed them must confirm them against the signed agreement in Go-live evidence."), proposal: proposed };
  return { state: "confirmed", ready: true, explanation: `Confirmed agreement: discount from ${start}; full price from ${end}.`, proposal: proposed, confirmation: { by: proposal.confirmedBy as string, at: proposal.confirmedAt as string } };
}

/**
 * The data confirm_discount_terms requires (POST /v1/actions, recordId the
 * commercial terms): the proposed discount dates and agreement reference the
 * confirmer checked against the signed agreement. A proposal that has changed
 * since is not confirmed (409).
 */
export const discountConfirmationDataSchema = z.object({
  discountStartDate: isoDay.describe("The proposed discount start date, as it was read."),
  fullPriceStartDate: isoDay.describe("The proposed full-price start date, as it was read."),
  discountTermsReference: z.string().trim().min(1, "Send the signed agreement reference you checked.").max(500).describe("The proposed signed agreement reference, as it was read."),
});
/** The data of a discount confirmation. */
export type DiscountConfirmationData = z.infer<typeof discountConfirmationDataSchema>;
