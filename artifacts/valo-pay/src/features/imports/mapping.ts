import {
  importFieldsOf,
  importKindLabels,
  suggestImportField,
  type BatchInput,
} from "@workspace/valopay-schema";

export const types = importKindLabels as Record<BatchInput["kind"], string>;
/** Each kind's sample row: its source row ID and each field's value (amounts in kobo), headed by the shared labels. */
export const samples: Record<
  BatchInput["kind"],
  { rowId: string; values: Array<[string, string]> }
> = {
  customers: {
    rowId: "customer-001",
    values: [
      ["name", "Pilot customer"],
      ["reference", "PILOT-C001"],
      ["consentProvenance", "Synthetic pilot consent"],
      ["bankName", "Sandbox Bank"],
      ["accountMasked", "•••• 0001"],
    ],
  },
  mandates: {
    rowId: "mandate-001",
    values: [
      ["name", "Pilot mandate"],
      ["reference", "PILOT-M001"],
      ["customerId", "PILOT-C001"],
      ["amountKobo", "5000000"],
      ["workflow", "hosted_consent"],
      ["frequency", "monthly"],
      ["activationDeadline", "2028-12-01"],
      ["consentEvidence", "SYNTHETIC-CONSENT-001"],
      ["consentGaps", ""],
    ],
  },
  "due-items": {
    rowId: "instalment-001",
    values: [
      ["name", "Pilot instalment"],
      ["reference", "PILOT-D001"],
      ["customerId", "PILOT-C001"],
      ["amountKobo", "2500000"],
      ["dueDate", "2028-12-01"],
      ["mandateId", ""],
      ["owner", "lms"],
      ["overrideReason", ""],
    ],
  },
  attempts: {
    rowId: "attempt-001",
    values: [
      ["name", "Pilot attempt"],
      ["reference", "PILOT-A001"],
      ["customerId", "PILOT-C001"],
      ["amountKobo", "2500000"],
      ["dueItemId", "PILOT-D001"],
      ["number", "1"],
      ["failureCode", "INSUFFICIENT_FUNDS"],
      ["occurredAt", "2028-12-02"],
    ],
  },
  observations: {
    rowId: "payment-001",
    values: [
      ["name", "Pilot payment"],
      ["reference", "PILOT-O001"],
      ["customerId", "PILOT-C001"],
      ["amountKobo", "2500000"],
      ["source", "statement"],
      ["dueItemId", "PILOT-D001"],
      ["narration", "PILOT-D001 synthetic transfer"],
    ],
  },
};
export const fields = [
  "name",
  "reference",
  "status",
  "customerId",
  "amountKobo",
  "consentProvenance",
  "bankName",
  "accountMasked",
  "phoneMasked",
  "payDay",
  "consentCapturedAt",
  "workflow",
  "frequency",
  "activationDeadline",
  "consentEvidence",
  "consentGaps",
  "consentGiven",
  "policyId",
  "providerReference",
  "dueDate",
  "mandateId",
  "owner",
  "overrideReason",
  "instalmentId",
  "dueItemId",
  "number",
  "failureCode",
  "occurredAt",
  "source",
  "narration",
  "eventId",
  "channel",
  "currency",
  "payerKey",
];
/**
 * Where a column goes when the mapping leaves it out, as the service reads it:
 * the row identity column is only the identity unless it is the reference or
 * event ID, amount is the amount, and any other header names its own field.
 */
export const defaultTarget = (column: string, identityColumn: string) =>
  column === identityColumn && !["reference", "eventId"].includes(column)
    ? ""
    : column === "amount"
      ? "amountKobo"
      : column;
/**
 * A field for each column the last check found that no mapping entry covers
 * and whose header is no field of the kind (a header that is one keeps mapping
 * to itself): full_name as the name, due_date as the due date. Each field
 * once, and never one another column already fills.
 */
export function suggestedMapping(
  kind: string,
  columns: string[],
  mapping: Record<string, string>,
  identityColumn: string,
): Record<string, string> {
  const known = importFieldsOf(kind);
  const taken = new Set(
    columns
      .map((column) =>
        Object.hasOwn(mapping, column)
          ? mapping[column]
          : defaultTarget(column, identityColumn),
      )
      .filter(Boolean),
  );
  const suggested: Record<string, string> = {};
  for (const column of columns) {
    if (
      Object.hasOwn(mapping, column) ||
      column === identityColumn ||
      known.includes(defaultTarget(column, identityColumn))
    )
      continue;
    const field = suggestImportField(kind, column);
    if (field && !taken.has(field)) {
      suggested[column] = field;
      taken.add(field);
    }
  }
  return suggested;
}
export const empty = (): BatchInput => ({
  name: "",
  kind: "customers",
  source: "",
  sourceBatchId: "",
  businessDate: new Date(Date.now() + 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10),
  sourceExpectationId: undefined,
  identityColumn: "source_row_id",
  amountUnit: "naira",
  mapping: {},
  csv: "",
  syntheticOnly: true,
});
