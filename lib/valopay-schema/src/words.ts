import { valueLabel } from "./labels";

/*
 * Words for codes inside sentences, shared by the API and the console: what a
 * kind of record is called, and a stored value's label as it reads mid-sentence.
 * Codes stay in data fields; only what a person reads uses these words.
 */

/** Each stored record kind as people call it: one of them, and several. */
export const recordTypeLabels: Readonly<Record<string, { readonly one: string; readonly many: string }>> = {
  customers: { one: "customer", many: "customers" },
  mandates: { one: "mandate", many: "mandates" },
  "due-items": { one: "instalment", many: "instalments" },
  attempts: { one: "collection attempt", many: "collection attempts" },
  observations: { one: "payment evidence record", many: "payment evidence records" },
  payments: { one: "payment", many: "payments" },
  allocations: { one: "allocation", many: "allocations" },
  "settlement-batches": { one: "settlement batch", many: "settlement batches" },
  exceptions: { one: "exception", many: "exceptions" },
  policies: { one: "retry policy", many: "retry policies" },
  templates: { one: "message template", many: "message templates" },
  notifications: { one: "customer message", many: "customer messages" },
  cutovers: { one: "collection transfer", many: "collection transfers" },
  audit: { one: "audit log entry", many: "audit log entries" },
  closes: { one: "daily close", many: "daily closes" },
  exports: { one: "export", many: "exports" },
  commercial: { one: "commercial terms record", many: "commercial terms records" },
  reviews: { one: "review", many: "reviews" },
  evidence: { one: "evidence record", many: "evidence records" },
  experiments: { one: "experiment plan", many: "experiment plans" },
  costs: { one: "cost", many: "costs" },
  calendar: { one: "calendar day", many: "calendar days" },
  integrations: { one: "connection", many: "connections" },
  members: { one: "team member", many: "team members" },
  "retry-decisions": { one: "retry decision", many: "retry decisions" },
  invoices: { one: "invoice", many: "invoices" },
  "import-batches": { one: "import batch", many: "import batches" },
  "import-revisions": { one: "import batch version", many: "import batch versions" },
  "import-corrections": { one: "import correction", many: "import corrections" },
  "import-correction-events": { one: "import correction event", many: "import correction events" },
  "source-profiles": { one: "source profile", many: "source profiles" },
  "source-manifests": { one: "list of expected files", many: "lists of expected files" },
  "provider-events": { one: "provider receipt", many: "provider receipts" },
  "close-reviews": { one: "close review", many: "close reviews" },
  "close-review-events": { one: "close review event", many: "close review events" },
  "case-events": { one: "case event", many: "case events" },
  "work-events": { one: "work event", many: "work events" },
  "retention-policies": { one: "data retention setting", many: "data retention settings" },
  "retention-holds": { one: "retention hold", many: "retention holds" },
  "retention-runs": { one: "deletion run", many: "deletion runs" },
  "retention-receipts": { one: "deletion record", many: "deletion records" },
  "connected-consents": { one: "permission", many: "permissions" },
  "connected-intents": { one: "checkout", many: "checkouts" },
  "connected-credit-assessments": { one: "credit assessment", many: "credit assessments" },
  "connected-credit-reviews": { one: "credit review", many: "credit reviews" },
  "connected-cash-workspace": { one: "sample business", many: "sample businesses" },
  "connected-cash-forecasts": { one: "cash forecast", many: "cash forecasts" },
  "connected-cash-erp": { one: "accounting draft", many: "accounting drafts" },
  "connected-cash-vat": { one: "VAT schedule", many: "VAT schedules" },
  "connected-cash-payroll": { one: "payroll funding plan", many: "payroll funding plans" },
};

/**
 * A kind of record in words, for the middle of a sentence: "instalment" for
 * one (count 1), "instalments" for any other count. A kind with no entry is
 * spelled out ("source-rows" as "source rows").
 */
export function recordTypeLabel(kind: unknown, count = 1): string {
  const code = String(kind ?? "");
  const words = Object.hasOwn(recordTypeLabels, code) ? recordTypeLabels[code]! : undefined;
  if (words) return count === 1 ? words.one : words.many;
  return code.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/[_.-]+/g, " ").trim().toLowerCase() || (count === 1 ? "record" : "records");
}

/** A kind of record in words at the start of a sentence or as a name: "Instalment", "Instalments". */
export function recordTypeTitle(kind: unknown, count = 1): string {
  const words = recordTypeLabel(kind, count);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A stored value's label (valueLabel) as it reads inside a sentence: "awaiting
 * activation", "unpaid after final attempt". A label that starts with a name or
 * an abbreviation keeps its capital ("Valo Pay", "CSV only").
 */
export function valueWords(value: unknown): string {
  const label = valueLabel(value);
  if (/^(Valo Pay|Finance|Admin|Operations|Compliance)\b/.test(label) || !/^[A-Z][a-z]/.test(label)) return label;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * Roles in a refusal, exactly as the role chip names them and with no article: "Admin", "Admin or Finance",
 * "Admin, Operations or Finance". The refusal reads "Only {roles} can {action}." A sentence about a person
 * keeps its article instead ("Ask an Admin").
 */
export function rolesText(roles: readonly string[]): string {
  const names = [...new Set(roles)];
  if (!names.length) return "no one";
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/**
 * The reason an accuracy review records when it takes a match out of use. It is stored, and code recognises such
 * matches by it, so it never changes; supersededReasonText shows it in today's words.
 */
export const REVIEW_SUPERSESSION = "Precision audit marked this allocation wrong";

/** Why a match is no longer applied, as people read it: a review's stored reason in today's words, and an earlier "Superseded:" as "No longer applied:". */
export function supersededReasonText(reason: unknown): string {
  const text = String(reason ?? "");
  if (text.startsWith(REVIEW_SUPERSESSION)) return `An accuracy review marked this allocation wrong${text.slice(REVIEW_SUPERSESSION.length)}`;
  return text.replace(/^Superseded: /, "No longer applied: ");
}

/** A choice as the console's lists name it, quoted inside a sentence: ‘Confirmed failed’. */
export function optionText(code: unknown): string {
  return `‘${valueLabel(code)}’`;
}

/** Where payment evidence came from, inside a sentence: "a provider notification", "a bank statement". */
export function evidenceSourceText(source: unknown): string {
  const phrases: Record<string, string> = {
    webhook: "a provider notification", settlement: "a settlement report", statement: "a bank statement",
    transfer: "a bank transfer", card: "a card payment", manual: "an entry made by hand",
  };
  const code = String(source ?? "");
  return Object.hasOwn(phrases, code) ? phrases[code]! : valueWords(code);
}

/** A lender's mode by the name Settings gives it: "Records payments only" (observation) or "Instructions after go-live" (instruction). */
export function lenderModeText(mode: unknown): string {
  return mode === "observation" ? "Records payments only" : mode === "instruction" ? "Instructions after go-live" : valueLabel(mode);
}

/** Who collects an instalment, inside a sentence: "the loan management system", "the lender team", "Valo Pay". */
export function collectionOwnerText(owner: unknown): string {
  const phrases: Record<string, string> = {
    lms: "the loan management system", merchant_manual: "the lender team", provider_auto: "the provider’s automatic collection",
    valo: "Valo Pay", valopay: "Valo Pay",
  };
  const code = String(owner ?? "");
  return Object.hasOwn(phrases, code) ? phrases[code]! : code ? valueWords(code) : "not recorded";
}

/** Items in a sentence: "A, B or C", or with "and": "A, B and C". */
export function listText(items: readonly string[], joiner: "or" | "and" = "or"): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${joiner} ${items.at(-1)}`;
}

/** A missing record in the standard's words: "Instalment not found. It may have been deleted, or it belongs to another lender." */
export function notFoundText(thing: string): string {
  return `${thing.charAt(0).toUpperCase()}${thing.slice(1)} not found. It may have been deleted, or it belongs to another lender.`;
}

/** A record that changed after the reader opened it: "This close changed after you opened it. Reload the page and try again." */
export function changedText(thing: string): string {
  return `This ${thing} changed after you opened it. Reload the page and try again.`;
}
