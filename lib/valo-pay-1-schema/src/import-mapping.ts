import { recordDataSchemas } from "./records";

/*
 * What a CSV column can fill when it is imported, shared by the API's check
 * and the console's mapping. The importer keeps a column that names no field
 * as extra detail on the record, which nothing reads, so a column the person
 * meant as a name must be mapped to it.
 */

/** The record's own fields a column can fill, whatever the kind (a customer has no customer to link to). */
const recordFields = ["name", "reference", "status", "amountKobo", "customerId"] as const;
/** The fields a column of this import kind can fill: the record's own and its kind's data fields. */
export function importFieldsOf(kind: string): string[] {
  const schema = recordDataSchemas[kind as keyof typeof recordDataSchemas];
  const own = recordFields.filter((field) => !(kind === "customers" && field === "customerId"));
  return [...own, ...(schema ? Object.keys(schema.shape).filter((field) => field !== "synthetic") : [])];
}
/** Each import kind as both import screens name it. */
export const importKindLabels: Readonly<Record<string, string>> = {
  customers: "Customers", mandates: "Mandates", "due-items": "Instalments", attempts: "Collection attempts", observations: "Payment evidence",
};
/**
 * A field in the operator's words: one map for both import screens, their
 * sample files, the customer form and the import's row errors. A customer's
 * name and reference are the customer form's; the links name what an operator
 * may give, a reference or an ID.
 */
const fieldLabels: Readonly<Record<string, string>> = {
  name: "Name", reference: "Reference", status: "Status", amountKobo: "Amount",
  customerId: "Customer reference or ID", mandateId: "Mandate reference or ID", dueItemId: "Instalment reference or ID", policyId: "Policy ID",
  bankName: "Bank name", accountMasked: "Masked account number", phoneMasked: "Masked phone number", consentProvenance: "Consent source or reference",
  payDay: "Pay day", consentCapturedAt: "Consent captured at", workflow: "Activation method", frequency: "Frequency", activationDeadline: "Activation deadline",
  consentEvidence: "Consent evidence", consentGaps: "Missing consent evidence", consentGiven: "Consent given", providerReference: "Provider reference",
  dueDate: "Due date", owner: "Collection owner", overrideReason: "Override reason", instalmentId: "Instalment ID", number: "Attempt number",
  failureCode: "Failure code", occurredAt: "Occurred at", source: "Source", narration: "Narration", eventId: "Event ID", channel: "Channel",
  currency: "Currency", payerKey: "Payer key", debitReference: "Debit reference", batchReference: "Batch reference", feeKobo: "Fee",
  grossAmountKobo: "Gross amount", outstandingKobo: "Outstanding amount", provider: "Provider", providerConnection: "Provider connection",
  virtualAccountCustomerId: "Virtual account customer ID", noticeId: "Notice ID", paymentId: "Payment ID", experimentId: "Experiment ID",
};
const kindFieldLabels: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  customers: { name: "Full name", reference: "Loan software reference" },
};
/** A field of an import kind in the operator's words: the shared label, or its name spelled out ("cancellationReason" as "Cancellation reason"). */
export function importFieldLabel(kind: string, field: string): string {
  const own = Object.hasOwn(kindFieldLabels, kind) ? kindFieldLabels[kind]! : {};
  if (Object.hasOwn(own, field)) return own[field]!;
  if (Object.hasOwn(fieldLabels, field)) return fieldLabels[field]!;
  const words = field.replace(/Kobo$/, "").replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/[_.-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
/** The header both sample files give their row ID column. */
export const importRowIdLabel = "Source row ID";
/** A header folded for comparison: case, spaces and punctuation ignored, so "Full Name" and "full_name" are one. */
const fold = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Common headers that do not fold to their field's name. */
const aliases: Record<string, string> = {
  fullname: "name", customername: "name", payername: "name", accountname: "name", borrowername: "name",
  ref: "reference", amount: "amountKobo", due: "dueDate",
  mandate: "mandateId", mandatereference: "mandateId", instalment: "dueItemId", instalmentreference: "dueItemId",
};
/**
 * The field a column's header suggests for this kind, or undefined: a header
 * that folds to a field's name or its shared label, or a common spelling such
 * as full_name for the name. A customer reference is the customer's own
 * reference in a customer file and the link to the customer in any other.
 */
export function suggestImportField(kind: string, column: string): string | undefined {
  const folded = fold(column), fields = importFieldsOf(kind);
  const exact = fields.find((field) => fold(field) === folded) ?? fields.find((field) => fold(importFieldLabel(kind, field)) === folded);
  if (exact) return exact;
  const field = ["customerreference", "customerref"].includes(folded) ? (kind === "customers" ? "reference" : "customerId") : Object.hasOwn(aliases, folded) ? aliases[folded] : undefined;
  return field && fields.includes(field) ? field : undefined;
}
/** The column a header marks as the source row ID ("Source row ID", source_row_id or row_id), or undefined. */
export function suggestRowIdColumn(columns: readonly string[]): string | undefined {
  return columns.find((column) => ["sourcerowid", "rowid"].includes(fold(column)));
}
/**
 * The header row of a CSV as the importer reads it: the first record, without
 * a byte order mark or the blank lines before it, each header trimmed and
 * quoted ones unquoted. Empty when the text has no complete header row, such
 * as an unclosed quote.
 */
export function csvHeader(text: string): string[] {
  const source = text.replace(/^\uFEFF/, "").replace(/^(?:[ \t]*(?:\r\n|\n|\r))+/, ""), headers: string[] = [];
  const skipSpaces = (at: number) => { while (source[at] === " " || source[at] === "\t") at++; return at; };
  let index = 0;
  for (;;) {
    let cell = "";
    index = skipSpaces(index);
    if (source[index] === '"') {
      for (index++; ; index++) {
        if (index >= source.length) return [];
        if (source[index] === '"' && source[index + 1] === '"') { cell += '"'; index++; }
        else if (source[index] === '"') { index++; break; }
        else cell += source[index];
      }
      index = skipSpaces(index);
    } else {
      while (index < source.length && !",\r\n".includes(source[index]!)) cell += source[index++];
      cell = cell.trim();
    }
    headers.push(cell);
    if (source[index] === ",") { index++; continue; }
    if (index < source.length && !"\r\n".includes(source[index]!)) return [];
    return headers.length === 1 && !headers[0] ? [] : headers;
  }
}
/**
 * Whether a record came from an import batch: its source rows change only through a reviewed import correction.
 * A quick import's rows carry an import identity too, so they are recognised when imported again, but name no batch
 * to correct them from, so they stay editable as records.
 */
export function fromImportBatch(record: { data?: Record<string, unknown> | null } | null | undefined): boolean {
  const identity = record?.data?.importIdentity as { batchId?: unknown } | undefined;
  return typeof identity?.batchId === "string" && identity.batchId !== "";
}
