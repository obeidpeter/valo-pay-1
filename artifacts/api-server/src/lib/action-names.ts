import { valueLabel } from "@workspace/valopay-schema";

/**
 * Actions and routes in plain words: what Request history calls a request, and what the audit log calls an entry.
 * The codes stay as they are stored and sent (an audit entry's action, a request's body), since code matches them;
 * only the words a person reads are built here. Never a code: an action this module does not know is spelled out
 * through the shared value labels.
 */
type Words = {
  /** What a request asks for, as its button says it: "Suspend mandate". */
  readonly request: string;
  /** What an audit entry records, once it is done: "Mandate suspended". */
  readonly done: string;
};
const words = (request: string, done: string): Words => ({ request, done });

/** The workspace actions (POST /v1/actions), by code. */
const workspaceActions: Readonly<Record<string, Words>> = {
  kill_switch: words("Turn the emergency stop on or off", "Emergency stop changed"),
  approve_kill_switch_off: words("Approve turning off the emergency stop", "Turning off the emergency stop approved"),
  mandate_suspend: words("Suspend mandate", "Mandate suspended"),
  mandate_cancel: words("Cancel mandate", "Mandate cancelled"),
  mandate_reinstate: words("Resume mandate", "Mandate resumed"),
  mandate_reissue: words("Reissue mandate", "Mandate reissued"),
  activation_reminder: words("Record activation reminder", "Activation reminder recorded"),
  notify_policy_change: words("Record policy change notice", "Policy change notice recorded"),
  apply_policy_version: words("Apply policy version", "Policy version applied"),
  submit_policy: words("Submit retry policy for review", "Retry policy submitted for review"),
  approve_policy: words("Approve retry policy", "Retry policy approved"),
  reject_policy: words("Reject retry policy", "Retry policy rejected"),
  new_policy_version: words("Draft next version of retry policy", "Next retry policy version drafted"),
  submit_template: words("Submit message template for review", "Message template submitted for review"),
  approve_template: words("Approve message template", "Message template approved"),
  reject_template: words("Request changes to message template", "Changes requested to message template"),
  new_template_version: words("Draft next version of message template", "Next message template version drafted"),
  confirm_allocation: words("Confirm match", "Match confirmed"),
  reject_allocation: words("Reject match", "Match rejected"),
  manual_allocate: words("Allocate payment", "Payment allocated"),
  review_allocation: words("Mark match correct or incorrect", "Match marked correct or incorrect"),
  resolve_exception: words("Resolve exception", "Exception resolved"),
  record_refund: words("Record refund", "Refund recorded"),
  release_dispute: words("Release from dispute", "Released from dispute"),
  simulate_failure: words("Simulate failed collection attempt", "Failed collection attempt simulated"),
  backtest_policy: words("Test retry policy", "Retry policy tested"),
  preregister_experiment: words("Register experiment plan", "Experiment plan registered"),
  hand_back: words("Return collection", "Collection returned"),
  issue_invoice: words("Issue invoice", "Invoice issued"),
  confirm_discount_terms: words("Confirm discount dates", "Discount dates confirmed"),
  run_reconciliation: words("Run reconciliation", "Reconciliation run"),
  daily_close: words("Run daily close", "Daily close run"),
  set_role: words("Change demo role", "Demo role changed"),
  verify_audit: words("Check audit log", "Audit log checked"),
};

/** The connected banking actions (POST /v1/connected/actions), by code. */
const connectedActions: Readonly<Record<string, Words>> = {
  "consent.grant": words("Grant permission", "Permission granted"),
  "consent.revoke": words("Withdraw permission", "Permission withdrawn"),
  "payment.create": words("Create checkout", "Checkout created"),
  "payment.authorise": words("Simulate authorisation", "Authorisation simulated"),
  "payment.cancel": words("Cancel checkout", "Checkout cancelled"),
  "payment.return": words("Simulate return from the bank", "Return from the bank simulated"),
  "payment.outcome": words("Simulate payment outcome", "Payment outcome simulated"),
  "payment.refund_request": words("Request refund", "Refund requested"),
  "payment.refund_confirm": words("Record refund", "Refund recorded"),
  "payment.reverse": words("Record reversal", "Reversal recorded"),
  "credit.assess": words("Run assessment", "Assessment run"),
  "credit.review": words("Record assessment review", "Assessment review recorded"),
  "cash.initialize": words("Set up Cash Desk", "Cash Desk set up"),
  "cash.refresh_sample": words("Refresh sample balances", "Sample balances refreshed"),
  "cash.forecast": words("Save forecast", "Forecast saved"),
  "cash.erp.prepare": words("Prepare accounting draft", "Accounting draft prepared"),
  "cash.erp.refresh": words("Refresh accounting review", "Accounting review refreshed"),
  "cash.erp.review": words("Approve accounting draft", "Accounting draft approved"),
  "cash.erp.export": words("Prepare accounting export file", "Accounting export file prepared"),
  "cash.vat.export": words("Save VAT schedule", "VAT schedule saved"),
  "cash.payroll.prepare": words("Prepare payroll funding plan", "Payroll funding plan prepared"),
  "cash.payroll.refresh": words("Refresh payroll funding review", "Payroll funding review refreshed"),
  "cash.payroll.approve": words("Approve payroll funding plan", "Payroll funding plan approved"),
  "cash.payroll.export": words("Prepare payroll export file", "Payroll export file prepared"),
  "cash.payroll.reconcile": words("Simulate payroll payment result", "Payroll payment result simulated"),
};
/** The product a connected action belongs to, which Request history names before it; a permission names none. */
const connectedProducts: Readonly<Record<string, string>> = { payment: "Pay by Bank", credit: "Credit Desk", cash: "Cash Desk" };

const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined => Object.hasOwn(table, key) ? table[key] : undefined;
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** A workspace action's request in words: "Suspend mandate". An action this module does not name is spelled out. */
export function workspaceActionRequest(action: string): string {
  return own(workspaceActions, action)?.request ?? valueLabel(action);
}
/** A connected banking action's request in words, with its product unless its button names it: "Pay by Bank: create checkout", "Set up Cash Desk". */
export function connectedActionRequest(action: string): string {
  const named = own(connectedActions, action);
  if (!named) return "Connected banking action";
  const product = own(connectedProducts, action.split(".")[0] ?? "");
  return product && !named.request.includes(product) ? `${product}: ${lowerFirst(named.request)}` : named.request;
}
/** What a connected banking action did, in words: "Checkout created". */
export function connectedActionDone(action: string): string {
  return own(connectedActions, action)?.done ?? "Connected banking change saved";
}

/** A record type in words, one and many: the kinds the record routes name, and what an export holds. */
const recordTypes: Readonly<Record<string, readonly [one: string, many: string]>> = {
  customers: ["Customer", "Customers"], mandates: ["Mandate", "Mandates"], "due-items": ["Instalment", "Instalments"],
  attempts: ["Collection attempt", "Collection attempts"], observations: ["Payment evidence", "Payment evidence"],
  payments: ["Payment", "Payments"], allocations: ["Allocation", "Allocations"], "settlement-batches": ["Settlement batch", "Settlement batches"],
  exceptions: ["Exception", "Exceptions"], policies: ["Retry policy", "Retry policies"], templates: ["Message template", "Message templates"],
  notifications: ["Notification", "Notifications"], cutovers: ["Collection transfer", "Collection transfers"], audit: ["Audit log entry", "Audit log"],
  closes: ["Daily close", "Daily closes"], exports: ["Export", "Exports"], commercial: ["Commercial terms", "Commercial terms"],
  reviews: ["Review", "Reviews"], evidence: ["Evidence", "Evidence register"], experiments: ["Experiment", "Experiments"],
  costs: ["Cost", "Costs"], calendar: ["Calendar date", "Calendar"], integrations: ["Integration", "Integrations"],
  members: ["Member", "Members"], "retry-decisions": ["Retry decision", "Retry decisions"], invoices: ["Invoice", "Invoices"],
  "gate-pack": ["Go-live evidence pack", "Go-live evidence pack"], billing: ["Billing statement", "Billing statement"],
  "reviewed-close": ["Reviewed close evidence", "Reviewed close evidence"], "dispute-pack": ["Dispute pack", "Dispute pack"],
  "customer-pack": ["Dispute pack", "Dispute pack"],
};
/** One record of a type in words: "Instalment". */
export function recordTypeName(kind: string): string {
  return own(recordTypes, kind)?.[0] ?? valueLabel(kind);
}
/** A type of record, or what an export holds, in words: "Instalments", "Dispute pack". */
export function recordTypesName(kind: string): string {
  return own(recordTypes, kind)?.[1] ?? valueLabel(kind);
}

/** A route's audit entry, by the method and path it stores ("post.records.customers", "patch.records.exceptions.{id}"). */
const routeEntries: ReadonlyArray<readonly [RegExp, (kind: string) => string]> = [
  [/^post\.records\.([a-z-]+)$/, (kind) => `${recordTypeName(kind)} added`],
  [/^patch\.records\.([a-z-]+)\..+$/, (kind) => `${recordTypeName(kind)} edited`],
  [/^patch\.settings$/, () => "Settings changed"],
  [/^post\.imports$/, () => "Records imported"],
  [/^post\.exports$/, () => "Export created"],
  [/^post\.exports\..+\.retry$/, () => "Export retried"],
  [/^post\.pilot\.batches(?:\..+\.save)?$/, () => "Import batch saved"],
  [/^post\.pilot\.batches\..+\.commit$/, () => "Checked batch imported"],
  [/^post\.pilot\.cases\..+$/, () => "Case updated"],
  [/^post\.pilot\.import-corrections$/, () => "Import correction proposed"],
  [/^post\.pilot\.import-corrections\..+\.decision$/, () => "Import correction decision recorded"],
  [/^post\.pilot\.import-corrections\..+\.recovery$/, () => "Import correction reviewer changed"],
  [/^post\.pilot\.close-reviews\.prepare$/, () => "Close review prepared"],
  [/^post\.pilot\.close-reviews\..+\.decision$/, () => "Close review decision recorded"],
  [/^post\.pilot\.close-reviews\..+\.reassign$/, () => "Close review reassigned"],
  [/^post\.sources\.manifests$/, () => "Expected files saved"],
  [/^post\.sources\.profiles$/, () => "Source profile created"],
  [/^post\.sources\.profiles\..+\.save$/, () => "Source profile saved"],
  [/^post\.sources\.paystack\.fixtures$/, () => "Paystack practice message recorded"],
  [/^post\.sources\.events\..+\.replay$/, () => "Paystack message rechecked"],
  [/^post\.work\.notifications\.read$/, () => "Notifications marked as read"],
  [/^post\.work\.handovers\.acknowledge$/, () => "Handover acknowledged"],
  [/^post\.lifecycle\.policy$/, () => "Retention policy changed"],
  [/^post\.lifecycle\.holds$/, () => "Retention hold changed"],
  [/^post\.lifecycle\.runs$/, () => "Deletion preview prepared"],
  [/^post\.lifecycle\.runs\..+\.approve$/, () => "Deletion run approved"],
  [/^post\.lifecycle\.runs\..+\.execute$/, () => "Deletion run carried out"],
];
/** Entries the service writes itself, by their stored action. */
const serviceEntries: Readonly<Record<string, string>> = {
  "sandbox.created": "Sample lender created", "lender.created": "Lender created",
  "daily_close.paused": "Automatic daily close paused",
  "paystack.test_event": "Paystack test event received", "paystack.test_verification": "Paystack test event checked",
  "export.started": "Export preparation started", "export.ready": "Export ready to download", "export.failed": "Export failed",
  "export.released": "Export returned to the queue", "export.access_changed": "Export stopped because access changed",
};
/**
 * What an audit entry recorded, from its stored action, in words: "Customer added", "Mandate suspended". The stored
 * action stays as it is (a route's method and path, an action's code), since code and the chain's hashes read it.
 */
export function auditEntryName(action: string): string {
  const known = own(workspaceActions, action)?.done ?? own(connectedActions, action)?.done ?? own(serviceEntries, action);
  if (known) return known;
  for (const [pattern, name] of routeEntries) {
    const matched = pattern.exec(action);
    if (matched) return name(matched[1] ?? "");
  }
  return "Change recorded";
}
/** An audit entry as a person reads it: named in words from its stored action, which data.action keeps. Any other
 * record is returned as it is. For the answers that show entries (the overview, the audit log's list and a
 * customer's history), never for the chain itself, an export or a stored row. */
export function withAuditName<R extends { kind: string; name: string; data: Record<string, unknown> }>(record: R): R {
  if (record.kind !== "audit") return record;
  const action = typeof record.data?.action === "string" ? record.data.action : record.name;
  return { ...record, name: auditEntryName(action) };
}

/**
 * The words for a request Request history lists without a summary (a sealed or purged request): its stored label.
 * An earlier build stored an action's code there with its underscores spelled as spaces ("kill switch",
 * "payment.refund request"); that code is named in words, and any other label is shown as it was stored.
 */
export function storedRequestLabel(label: string): string {
  const code = label.trim().replaceAll(" ", "_");
  if (own(workspaceActions, code)) return workspaceActionRequest(code);
  if (own(connectedActions, code)) return connectedActionRequest(code);
  return label;
}
