/**
 * Record kinds, their status vocabularies and the state machines the TRD
 * (section 4.2) allows.  This is the single source for the API validator and
 * the console; neither may hard-code a status string of its own.
 */
export const recordKinds = [
  "customers", "mandates", "due-items", "attempts", "observations", "payments", "allocations",
  "settlement-batches", "exceptions", "policies", "templates", "notifications", "cutovers", "audit",
  "closes", "exports", "commercial", "reviews", "evidence", "experiments", "costs", "calendar",
  "integrations", "members", "retry-decisions", "invoices",
] as const;
/** A record kind the generic record API addresses in its path (`/v1/records/:kind`). */
export type ApiRecordKind = (typeof recordKinds)[number];

/**
 * Kinds only the platform writes, through its own workflows: pilot imports,
 * source controls, close review, work and case history, retention, Paystack
 * test evidence and connected banking. The generic record API neither lists,
 * creates nor edits them; their data is typed in records.ts like every other
 * kind's.
 */
export const domainRecordKinds = [
  "import-batches", "import-revisions", "import-corrections", "import-correction-events",
  "source-profiles", "source-manifests", "provider-events",
  "close-reviews", "close-review-events", "case-events", "work-events",
  "retention-policies", "retention-holds", "retention-runs", "retention-receipts",
  "connected-consents", "connected-intents", "connected-credit-assessments", "connected-credit-reviews",
  "connected-cash-workspace", "connected-cash-forecasts", "connected-cash-erp", "connected-cash-vat", "connected-cash-payroll",
] as const;
/** A kind only the platform writes. */
export type DomainRecordKind = (typeof domainRecordKinds)[number];

/** Every kind stored in valopay_records: the record API's kinds and the platform's own. */
export const storedRecordKinds = [...recordKinds, ...domainRecordKinds] as const;
/** A record kind as stored; `TypedRecord` and `RecordDataOf` type a record of any of them. */
export type RecordKind = (typeof storedRecordKinds)[number];

/** Kinds a merchant user may create or edit through the generic record API. */
export const editableKinds = [
  "customers", "mandates", "due-items", "attempts", "observations", "exceptions", "policies", "templates",
  "cutovers", "commercial", "reviews", "evidence", "experiments", "costs", "calendar", "settlement-batches",
] as const;
/** A kind the generic record API may create or edit. */
export type EditableKind = (typeof editableKinds)[number];

/** Kinds accepted by the synthetic CSV importer. */
export const importKinds = ["customers", "mandates", "due-items", "attempts", "observations"] as const;

/** The statuses each kind may carry; a kind absent here has a free-form status. */
export const recordStatuses = {
  customers: ["active", "inactive"],
  mandates: ["draft", "submitted", "pending_activation", "active", "suspended", "expired", "cancelled", "failed"],
  "due-items": ["scheduled", "in_collection", "partially_paid", "paid", "unpaid_final", "in_dispute", "cancelled", "closed"],
  attempts: ["scheduled", "sent", "succeeded", "failed", "unknown", "cancelled", "reversed"],
  observations: ["unresolved", "resolved"],
  "settlement-batches": ["pending", "reconciled", "variance"],
  payments: ["unallocated", "proposed", "allocated", "partial", "overpaid", "possible_duplicate", "returned"],
  allocations: ["proposed", "confirmed", "superseded"],
  exceptions: ["open", "assigned", "in_progress", "resolved", "closed"],
  policies: ["draft", "submitted", "approved", "rejected"],
  templates: ["draft", "submitted", "approved", "rejected"],
  experiments: ["draft", "preregistered", "closed"],
  cutovers: ["draft", "ready", "handed_back"],
  evidence: ["pending", "recorded"],
  notifications: ["simulated", "blocked", "accepted", "delivered", "failed"],
  "retry-decisions": ["recorded"],
  closes: ["completed"],
  exports: ["queued", "running", "ready", "failed"],
  invoices: ["issued"],
  // Kinds only the platform writes: their workflows set these, and the record API never does.
  "import-batches": ["draft", "ready", "needs_correction", "committed"],
  "import-revisions": ["recorded"],
  "import-corrections": ["recorded"],
  "import-correction-events": ["recorded"],
  "source-profiles": ["active", "paused"],
  "source-manifests": ["declared"],
  "provider-events": ["recorded", "awaiting_verification", "quarantined", "ignored", "ignored_stale", "rejected_fixture"],
  "close-reviews": ["awaiting_review", "approved", "changes_requested"],
  "close-review-events": ["recorded"],
  "case-events": ["recorded"],
  "work-events": ["recorded"],
  "retention-policies": ["recorded"],
  "retention-holds": ["recorded"],
  "retention-runs": ["preview", "approved", "running", "attention", "completed"],
  "retention-receipts": ["recorded"],
  "connected-consents": ["active", "revoked"],
  "connected-intents": ["created", "authorised", "pending", "unknown", "failed", "confirmed", "cancelled", "refunded", "reversed"],
  "connected-credit-assessments": ["review_pending", "insufficient_evidence", "blocked"],
  "connected-credit-reviews": ["recorded"],
} as const satisfies Partial<Record<RecordKind, readonly string[]>>;
/** The status union of a kind with a controlled vocabulary. */
export type StatusOf<K extends keyof typeof recordStatuses> = (typeof recordStatuses)[K][number];
/** A mandate's status. */
export type MandateStatus = StatusOf<"mandates">;
/** A due item's status. */
export type DueItemStatus = StatusOf<"due-items">;
/** An exception's status. */
export type ExceptionStatus = StatusOf<"exceptions">;

/** Status a record starts in when the caller does not supply one. */
export const defaultStatus: Partial<Record<RecordKind, string>> = {
  customers: "active", mandates: "pending_activation", "due-items": "scheduled", attempts: "failed",
  observations: "unresolved", exceptions: "open", evidence: "pending", calendar: "active", commercial: "discovery",
  reviews: "recorded", costs: "recorded", cutovers: "draft", experiments: "draft", policies: "draft",
  templates: "draft", "settlement-batches": "pending",
};

/** TRD 4.2 mandate state machine.  Terminal states have no exits. */
export const mandateTransitions: Record<MandateStatus, readonly MandateStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["pending_activation", "failed"],
  pending_activation: ["active", "expired", "cancelled"],
  active: ["cancelled", "suspended", "expired"],
  suspended: ["active", "cancelled"],
  expired: [],
  cancelled: [],
  failed: [],
};

/**
 * TRD 4.2 exception machine.  "resolved" is reached only through the
 * resolve action with a controlled code (EXC-03); "closed" follows resolution,
 * or the platform closes an open exception whose condition cleared.
 */
export const exceptionTransitions: Record<ExceptionStatus, readonly ExceptionStatus[]> = {
  open: ["assigned", "in_progress"],
  assigned: ["in_progress", "open"],
  in_progress: ["assigned"],
  resolved: ["closed"],
  closed: [],
};

/** Statuses per kind that only a domain action may set; a generic create or update is refused. */
export const actionOnlyStatuses: Partial<Record<RecordKind, readonly string[]>> = {
  "due-items": ["in_collection", "partially_paid", "paid", "unpaid_final", "in_dispute", "closed"],
  exceptions: ["resolved", "closed"],
  policies: ["submitted", "approved", "rejected"],
  templates: ["submitted", "approved", "rejected"],
  experiments: ["preregistered", "closed"],
  cutovers: ["handed_back"],
  "settlement-batches": ["reconciled", "variance"],
};
/** True when a generic create or update must refuse the status because only a domain action may set it. */
export const isActionOnlyStatus = (kind: string, status: string): boolean => (actionOnlyStatuses[kind as RecordKind] ?? []).includes(status);

/** The statuses of an exception still being worked. */
export const openExceptionStatuses = ["open", "assigned", "in_progress"] as const;
/** True while an exception is still being worked. */
export const isOpenException = (status: string): boolean => (openExceptionStatuses as readonly string[]).includes(status);
