/**
 * AUD-02 dispute pack: one customer, a one-page summary followed by the whole
 * timeline (AUD-01), as a paginated PDF plus CSV and JSON of the same data.
 * AUD-06: the retry policy, the notification template and the cutover contract
 * are shown as they applied at the time of each event, never the current ones.
 * Everything here is pure; storage and checksums live in valopay-exports.
 */
import PDFDocument from "pdfkit";
import { VALO_PACK_SANS_BOLD, VALO_PACK_SANS_REGULAR } from "../fonts/valo-pack-sans";
import { counted, moneyText, nairaText, otherCurrenciesText, WAT_OFFSET_MS } from "@workspace/valopay-schema";
import type { Context, DomainState, ValopayRecord } from "../domain/types";
import { inNaira, positionFor, unallocatedOtherCurrencies, type CustomerPosition, type OtherCurrencies } from "../domain/close";
import { currencyOf, exceptionCurrency } from "../domain/reconciliation";
import { recordsOf } from "../domain/records";
import { verifyAudit } from "./valopay-store";
import { collectExportBytes } from './export-download';

/** One event on a customer's timeline as the pack prints it, with the versions that governed it. */
export interface TimelineEvent {
  at: string;
  kind: string;
  event: string;
  status: string;
  reference: string;
  /** In the minor unit of `currency`: kobo for naira. */
  amountKobo: number;
  /** The currency of the amount: a payment's or evidence's own, and for an exception the one it names, else its money's (exceptionCurrency); NGN for everything else. */
  currency: string;
  detail: string;
  actor: string | null;
  policyVersion: number | null;
  templateVersion: number | null;
  cutoverId: string | null;
  recordId: string;
}

/** A policy, template or cutover version as it applied, with its text. */
export interface GoverningDocument {
  id: string;
  kind: "policies" | "templates" | "cutovers";
  name: string;
  version: number | null;
  status: string;
  appliesFrom: string;
  appliesUntil: string | null;
  text: string;
  parameters: Record<string, unknown>;
}

/** The whole pack: identity, summary, position, timeline, governing documents and the audit verification. */
export interface DisputePack {
  kind: "dispute-pack";
  environment: "synthetic_sandbox";
  merchant: { id: string; name: string; provider: string; mode: string };
  generatedAt: string;
  generatedBy: string;
  customer: Record<string, unknown>;
  /** The naira position; unallocatedOtherCurrencies lists money the customer's payments in other currencies hold unapplied, beside it. */
  position: CustomerPosition & { unallocatedOtherCurrencies?: OtherCurrencies };
  summary: Record<string, unknown>;
  timeline: TimelineEvent[];
  documents: GoverningDocument[];
  auditVerification: { valid: boolean; count: number; headHash: string };
  note: string;
}

const kobo = (value: number): string => nairaText(value);
const watStamp = (iso: string): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "n/a";
  return `${new Date(ms + WAT_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ")} WAT`;
};
const text = (value: unknown): string => value === undefined || value === null || value === "" ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);

/** The policy, template and cutover versions that governed an instant: the latest approved before it (AUD-06). */
function governing(documents: GoverningDocument[], kind: GoverningDocument["kind"], at: string): GoverningDocument | undefined {
  return documents.filter((document) => document.kind === kind && document.appliesFrom <= at && (document.appliesUntil === null || at < document.appliesUntil)).at(-1);
}

function governingDocuments(state: DomainState): GoverningDocument[] {
  const documents: GoverningDocument[] = [];
  const approvedPolicies = recordsOf(state, "policies").filter((item) => item.status === "approved" && item.data.approvedAt).sort((a, b) => String(a.data.approvedAt).localeCompare(String(b.data.approvedAt)));
  approvedPolicies.forEach((policy, index) => documents.push({
    id: policy.id, kind: "policies", name: policy.name, version: Number(policy.data.version || 1), status: policy.status,
    appliesFrom: String(policy.data.approvedAt), appliesUntil: approvedPolicies[index + 1] ? String(approvedPolicies[index + 1]!.data.approvedAt) : null,
    text: `Up to ${counted(Number(policy.data.maxAttempts ?? 3), "attempt")} counting every source; at least ${policy.data.spacingHours ?? 48} hours between attempts; first notice ${policy.data.firstNoticeHours ?? 48} hours before the first attempt; failed-debit notice ${policy.data.retryNoticeHours ?? 24} hours before any re-presentation; partial debits ${policy.data.partialAllowed ? "allowed" : "not allowed"}. Compliance mapping: ${policy.data.complianceMapping ?? "not recorded"}. Approved by ${policy.data.reviewer ?? "n/a"} (author ${policy.data.author ?? "n/a"}).`,
    parameters: { maxAttempts: policy.data.maxAttempts, spacingHours: policy.data.spacingHours, firstNoticeHours: policy.data.firstNoticeHours, retryNoticeHours: policy.data.retryNoticeHours, partialAllowed: policy.data.partialAllowed, author: policy.data.author, reviewer: policy.data.reviewer, approvedAt: policy.data.approvedAt },
  }));
  const approvedTemplates = recordsOf(state, "templates").filter((item) => item.status === "approved" && item.data.approvedAt).sort((a, b) => String(a.data.approvedAt).localeCompare(String(b.data.approvedAt)));
  approvedTemplates.forEach((template, index) => documents.push({
    id: template.id, kind: "templates", name: template.name, version: Number(template.data.version || 1), status: template.status,
    appliesFrom: String(template.data.approvedAt), appliesUntil: approvedTemplates[index + 1] ? String(approvedTemplates[index + 1]!.data.approvedAt) : null,
    text: String(template.data.text || ""), parameters: { purpose: template.data.purpose, author: template.data.author, reviewer: template.data.reviewer, approvedAt: template.data.approvedAt },
  }));
  const contracts = recordsOf(state, "cutovers").filter((item) => item.status !== "draft").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  contracts.forEach((cutover, index) => documents.push({
    id: cutover.id, kind: "cutovers", name: cutover.name, version: null, status: cutover.status,
    appliesFrom: String(cutover.data.handedBackAt || cutover.createdAt), appliesUntil: contracts[index + 1] ? String(contracts[index + 1]!.data.handedBackAt || contracts[index + 1]!.createdAt) : null,
    text: cutover.status === "handed_back"
      ? `Hand-back to ${cutover.data.fallbackOwner ?? "the fallback owner"}: ${(cutover.data.checklist as string[] | undefined)?.join("; ") ?? ""}. Confirmation: ${cutover.data.confirmation ?? ""}`
      : `Inventory: ${cutover.data.inventory ?? ""}. Incumbent disabled: ${cutover.data.incumbentDisabled ? "yes" : "no"}; external attempts imported: ${cutover.data.externalAttemptsImported ? "yes" : "no"}; dual-run complete: ${cutover.data.dualRunComplete ? "yes" : "no"}; accountable user: ${cutover.data.accountableUser ?? ""}; fallback owner: ${cutover.data.fallbackOwner ?? ""}. Confirmation: ${cutover.data.confirmation ?? ""}`,
    parameters: { fallbackOwner: cutover.data.fallbackOwner, accountableUser: cutover.data.accountableUser, incumbentDisabled: cutover.data.incumbentDisabled, externalAttemptsImported: cutover.data.externalAttemptsImported, dualRunComplete: cutover.data.dualRunComplete },
  }));
  return documents.sort((a, b) => a.appliesFrom.localeCompare(b.appliesFrom));
}

function eventTime(record: ValopayRecord): string {
  switch (record.kind) {
    case "attempts": return String(record.data.occurredAt || record.createdAt);
    case "observations": return String(record.data.occurredAt || record.createdAt);
    case "notifications": return String(record.data.acceptedAt || record.data.submittedAt || record.createdAt);
    case "retry-decisions": return String(record.data.evaluatedAt || record.createdAt);
    default: return record.createdAt;
  }
}

function describe(record: ValopayRecord): { event: string; detail: string } {
  const d = record.data;
  const notice = d.noticeRequired as { purpose?: unknown; requiredBy?: unknown; evidenced?: unknown } | undefined;
  const inputs = d.inputs as { code?: unknown; attemptNumber?: unknown; ceiling?: unknown } | undefined;
  switch (record.kind) {
    case "customers": return { event: "Customer record", detail: `Consent provenance: ${text(d.consentProvenance)}.` };
    case "mandates": return { event: `Mandate ${record.status}`, detail: `Workflow ${text(d.workflow)}; origin ${text(d.origin)}; consent evidence ${text(d.consentEvidence) || "none"}${Array.isArray(d.consentGaps) && d.consentGaps.length ? `; consent gaps: ${d.consentGaps.join(", ")}` : ""}; limit ${kobo(record.amountKobo)}.` };
    case "due-items": return { event: `Due item ${record.reference} ${record.status}`, detail: `Due ${text(d.dueDate)}; owner ${text(d.owner)}; outstanding ${kobo(Number(d.outstandingKobo ?? record.amountKobo))}${d.experimentArm ? `; experiment arm ${d.experimentArm}` : ""}${d.amendedAt ? `; amended ${watStamp(String(d.amendedAt))}` : ""}.` };
    case "attempts": return { event: `Attempt ${text(d.number) || "?"} ${record.status}`, detail: `${text(d.source)} source${d.failureCode ? `; failure code ${d.failureCode}` : ""}${d.rawFailureCode && d.rawFailureCode !== d.failureCode ? ` (raw ${d.rawFailureCode})` : ""}${d.providerReference ? `; provider reference ${d.providerReference}` : ""}${d.cancellationReason ? `; ${d.cancellationReason}` : ""}.` };
    case "observations": return { event: `Observation (${text(d.source)})`, detail: `${record.status}${d.resolutionKey ? ` by ${d.resolutionKey}` : ""}${d.paymentId ? `; resolved to payment ${d.paymentId}` : ""}${d.resolvedTo ? `; resolved to ${d.resolvedTo}` : ""}${d.batchReference ? `; batch ${d.batchReference}` : ""}.` };
    case "payments": return { event: `Payment ${record.reference} ${record.status}`, detail: `Channel ${text(d.channel)}; collection ${text(d.collectionStatus)}; settlement ${text(d.settlementStatus)}; reversal ${text(d.reversalStatus)}; refund ${text(d.refundStatus)}; allocated ${moneyText(Number(d.allocatedKobo || 0), currencyOf(record))}${d.explanation ? `; ${text(d.explanation).replace(/\.$/, "")}` : ""}.` };
    case "allocations": return { event: `Allocation ${text(d.rule)} ${record.status}`, detail: `${text(d.confidence)} confidence${d.automatic ? ", automatic" : ""}; ${text(d.explanation)}${d.supersededReason ? ` Superseded: ${d.supersededReason}` : ""}${typeof d.reviewed === "boolean" ? ` Reviewed ${d.reviewed ? "correct" : "wrong"} by ${text(d.reviewedBy)}.` : ""}` };
    case "exceptions": return { event: `Exception ${text(d.type)} ${record.status}`, detail: `Owner ${text(d.owner)}; severity ${text(d.severity)}; due by ${d.dueBy ? watStamp(String(d.dueBy)) : "n/a"}${d.resolutionCode ? `; resolved ${d.resolutionCode} by ${text(d.resolvedBy)}` : ""}. ${text(d.notes)}` };
    case "notifications": return { event: `Notification ${text(d.purpose)} ${record.status}`, detail: `${text(d.channel)}; ${text(d.class)} class; accepted ${d.acceptedAt ? watStamp(String(d.acceptedAt)) : "not accepted"}; delivered ${d.deliveredAt ? watStamp(String(d.deliveredAt)) : "not delivered"}. Text: ${text(d.renderedText)}` };
    case "retry-decisions": return {
      event: `Retry decision: ${text(d.decision).replace(/_/g, " ")}`,
      detail: `Row ${text(d.rule)}; policy v${text(d.policyVersion)}; ${text(d.reason)}${d.nextAt ? ` Next attempt ${watStamp(String(d.nextAt))}.` : ""}${notice ? ` Notice required: ${text(notice.purpose)}${notice.requiredBy ? ` by ${watStamp(String(notice.requiredBy))}` : ""}, ${notice.evidenced ? "evidenced" : "not evidenced"}.` : ""}${d.experimentArm ? ` Arm ${d.experimentArm}.` : ""} Inputs: code ${text(inputs?.code) || "none"}, attempt ${text(inputs?.attemptNumber)} of ${text(inputs?.ceiling)}.`,
    };
    case "audit": return { event: `Action ${record.name}`, detail: `${text(d.actor)}: ${text(d.summary)}` };
    case "case-events": return { event: record.name, detail: `${text(d.note)} Assignee: ${text(d.after?.assigneeName)}. Next action: ${text(d.after?.nextAction)}; follow-up ${d.after?.nextActionAt ? watStamp(String(d.after.nextActionAt)) : 'not set'}. Evidence: ${text(d.after?.evidenceIds || [])}.` };
    default: return { event: `${record.kind} ${record.status}`, detail: text(record.name) };
  }
}

/** One customer's complete evidence, sorted oldest first, with the governing versions resolved per event. */
export function buildDisputePack(state: DomainState, ctx: Context, customerId: string): DisputePack {
  const customer = recordsOf(state, "customers").find((record) => record.id === customerId);
  if (!customer) throw Object.assign(new Error("Customer not found."), { status: 404 });
  const related = [customer, ...state.records.filter((record) => record.customerId === customerId && record.id !== customerId)];
  const relatedIds = new Set(related.map((record) => record.id));
  const actions = recordsOf(state, "audit").filter((record) => relatedIds.has(String(record.data.objectId)) || record.data.objectId === customerId);
  const documents = governingDocuments(state);
  // Every amount in its own currency: a payment's or evidence's, and an exception's as it names it or as its money is (one an
  // earlier build raised names none until the next reconciliation); anything else is naira.
  const byId = new Map(state.records.map((record) => [record.id, record]));
  const money = (kind: string, id: string) => { const found = byId.get(id); return found?.kind === kind ? found : undefined; };
  const currencyFor = (record: ValopayRecord): string => record.kind === "exceptions" ? exceptionCurrency(record, money)
    : record.kind === "payments" || record.kind === "observations" ? currencyOf(record) : "NGN";
  const timeline: TimelineEvent[] = [...related, ...actions].map((record) => {
    const at = eventTime(record);
    const { event, detail } = describe(record);
    return {
      at, kind: record.kind, event, status: record.status, reference: record.reference, amountKobo: record.amountKobo, currency: currencyFor(record), detail: detail + (record.data.importIdentity ? ` Imported from ${text(record.data.importIdentity.source)}; source row ${text(record.data.importIdentity.rowId)}${record.data.importIdentity.batchId ? `; batch ${text(record.data.importIdentity.batchId)}` : ''}.` : ''),
      actor: ['audit', 'case-events'].includes(record.kind) ? text(record.data.actor) || null : record.data.confirmedBy || record.data.reviewedBy || record.data.resolvedBy || null,
      policyVersion: governing(documents, "policies", at)?.version ?? null,
      templateVersion: governing(documents, "templates", at)?.version ?? null,
      cutoverId: governing(documents, "cutovers", at)?.id ?? null,
      recordId: record.id,
    };
  }).sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind));
  const by = (kind: string) => related.filter((record) => record.kind === kind);
  const mandates = by("mandates"), dueItems = by("due-items"), attempts = by("attempts"), payments = by("payments"), exceptions = by("exceptions"), notifications = by("notifications");
  const consent = mandates.map((mandate) => ({ mandate: mandate.reference, evidence: text(mandate.data.consentEvidence), gaps: Array.isArray(mandate.data.consentGaps) ? mandate.data.consentGaps : [], provenance: text(customer.data.consentProvenance) }));
  // Naira totals as the close keeps them: money in another currency is listed beside them, never added in.
  const unallocatedOther = unallocatedOtherCurrencies(payments);
  return {
    kind: "dispute-pack", environment: "synthetic_sandbox",
    merchant: { id: state.merchant.id, name: state.merchant.name, provider: state.merchant.provider, mode: state.merchant.mode },
    generatedAt: ctx.now, generatedBy: ctx.actor,
    customer: { id: customer.id, name: customer.name, reference: customer.reference, status: customer.status, bankName: customer.data.bankName ?? null, accountMasked: customer.data.accountMasked ?? null, phoneMasked: customer.data.phoneMasked ?? null, consentProvenance: customer.data.consentProvenance ?? null },
    position: { ...positionFor(state, customerId), ...(unallocatedOther ? { unallocatedOtherCurrencies: unallocatedOther } : {}) },
    summary: {
      mandates: { count: mandates.length, active: mandates.filter((m) => m.status === "active").length, pendingActivation: mandates.filter((m) => m.status === "pending_activation").length },
      dueItems: { count: dueItems.length, paid: dueItems.filter((d) => d.status === "paid").length, inCollection: dueItems.filter((d) => ["in_collection", "partially_paid"].includes(d.status)).length, unpaidFinal: dueItems.filter((d) => d.status === "unpaid_final").length, inDispute: dueItems.filter((d) => d.status === "in_dispute").length },
      attempts: { count: attempts.length, failed: attempts.filter((a) => a.status === "failed").length, succeeded: attempts.filter((a) => a.status === "succeeded").length, cancelled: attempts.filter((a) => a.status === "cancelled").length },
      payments: { ...inNaira(payments, (p) => p.amountKobo), reversed: payments.filter((p) => p.data.reversalStatus === "reversed").length },
      allocations: { confirmed: by("allocations").filter((a) => a.status === "confirmed").length, superseded: by("allocations").filter((a) => a.status === "superseded").length },
      exceptions: { open: exceptions.filter((e) => ["open", "assigned", "in_progress"].includes(e.status)).length, resolved: exceptions.filter((e) => ["resolved", "closed"].includes(e.status)).length },
      notifications: { count: notifications.length, accepted: notifications.filter((n) => n.data.acceptedAt).length, delivered: notifications.filter((n) => n.data.deliveredAt).length },
      retryDecisions: by("retry-decisions").length,
      humanActions: actions.length,
      consent,
      governingVersions: { policies: documents.filter((d) => d.kind === "policies").map((d) => `v${d.version} from ${watStamp(d.appliesFrom)}`), templates: documents.filter((d) => d.kind === "templates").map((d) => `v${d.version} from ${watStamp(d.appliesFrom)}`), cutovers: documents.filter((d) => d.kind === "cutovers").map((d) => `${d.name} (${d.status}) from ${watStamp(d.appliesFrom)}`) },
      events: timeline.length,
    },
    timeline, documents,
    auditVerification: verifyAudit(state),
    note: "Sample data only, not live evidence. Amounts are stored in whole kobo and displayed in naira (NGN); money in another currency is stored in that currency's minor unit, shown in its own currency and never added to a naira total. Times use West Africa Time (WAT). Valo Pay never holds money. Each file has a SHA-256 checksum to check its integrity, saved with the export record and download link.",
  };
}

/** CSV of the timeline rows, one row per event, with the pack identity repeated on every row so the file stands alone. */
export function disputePackCsv(pack: DisputePack): string {
  const escape = (value: unknown) => {
    let cell = text(value);
    if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
    return `"${cell.replaceAll('"', '""')}"`;
  };
  const header = ["environment", "merchant", "customer", "customerReference", "generatedAt", "at", "atWAT", "kind", "event", "status", "reference", "amountKobo", "currency", "detail", "actor", "policyVersion", "templateVersion", "cutoverId", "recordId"];
  const rows = pack.timeline.map((event) => [pack.environment, pack.merchant.name, String(pack.customer.name), String(pack.customer.reference), pack.generatedAt, event.at, watStamp(event.at), event.kind, event.event, event.status, event.reference, event.amountKobo, event.currency, event.detail, event.actor ?? "", event.policyVersion ?? "", event.templateVersion ?? "", event.cutoverId ?? "", event.recordId]);
  return [header.join(","), ...rows.map((row) => row.map(escape).join(","))].join("\r\n");
}

// ---------- PDF ----------

/**
 * The PDF standard fonts encode WinAnsi only, which has no Yoruba or Igbo letters
 * (ẹ, ọ, ṣ), no tone-marked vowels and no naira sign, so the packs embed their own
 * typeface: a Latin subset of Liberation Sans, metrically the same as Helvetica
 * (src/fonts/README.md). It ships as base64 inside the bundle and is decoded once.
 */
let fontFiles: { regular: Buffer; bold: Buffer } | undefined;
export function packFonts(): { regular: Buffer; bold: Buffer } {
  fontFiles ??= { regular: Buffer.from(VALO_PACK_SANS_REGULAR.replace(/\s+/g, ""), "base64"), bold: Buffer.from(VALO_PACK_SANS_BOLD.replace(/\s+/g, ""), "base64") };
  return fontFiles;
}

/** Control characters other than line breaks are dropped; everything else, the naira sign included, is rendered by the embedded typeface. */
function pdfSafe(value: unknown): string {
  const source = text(value);
  if (source.length > 50_000) throw Object.assign(new Error('A PDF field exceeds the supported layout size. Use JSON or CSV for this record.'), { exportPdfFieldTooLarge: true });
  return source.replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" || character === "\t" ? character : ""));
}

/** Rendering options; compress false for a test that reads the PDF back. */
export interface PdfOptions { compress?: boolean; signal?: AbortSignal; timeoutMs?: number }

/** A4 pack: page one is the summary, the timeline follows as a paginated table, then the governing documents; every page is numbered. */
export async function renderDisputePackPdf(pack: DisputePack, options: PdfOptions = {}): Promise<Buffer> {
    options.signal?.throwIfAborted();
    const margin = 40;
    const document = new PDFDocument({ size: "A4", lang: "en-GB", margin, bufferPages: true, compress: options.compress ?? true, info: { Title: `Dispute pack ${text(pack.customer.reference)}`, Author: "Valo Pay", Subject: "AUD-02 dispute pack (synthetic sandbox)" } });
    const result = collectExportBytes(document, options.signal, 32 * 1024 * 1024, options.timeoutMs ?? 30_000);
    void result.catch(() => {});
    const deadline = performance.now() + (options.timeoutMs ?? 30_000);
    const check = () => { options.signal?.throwIfAborted(); if (performance.now() > deadline) throw new Error('PDF rendering exceeded its time limit.'); };
    try {
    const fonts = packFonts();
    document.registerFont("Sans", fonts.regular).registerFont("Sans-Bold", fonts.bold);
    const width = document.page.width - margin * 2;
    const bottom = document.page.height - margin - 24;
    const line = (label: string, value: unknown) => { document.font("Sans-Bold").fontSize(9).text(pdfSafe(label), { continued: true }).font("Sans").text(`  ${pdfSafe(value)}`); };
    const heading = (title: string) => { document.moveDown(0.6); document.font("Sans-Bold").fontSize(12).fillColor("#102E2A").text(pdfSafe(title)); document.fillColor("#222222").moveDown(0.3); };

    // ---- Page 1: summary ----
    document.font("Sans-Bold").fontSize(20).fillColor("#102E2A").text("VALO PAY  -  Dispute pack");
    document.font("Sans").fontSize(9).fillColor("#9B6524").text("SYNTHETIC SANDBOX - NOT LIVE EVIDENCE").fillColor("#222222").moveDown(0.5);
    line("Customer", `${text(pack.customer.name)} (${text(pack.customer.reference)}) - ${text(pack.customer.status)}`);
    line("Lender", `${pack.merchant.name} - provider ${pack.merchant.provider} - ${pack.merchant.mode} mode`);
    line("Bank", `${text(pack.customer.bankName) || "n/a"} ${text(pack.customer.accountMasked)}  phone ${text(pack.customer.phoneMasked) || "n/a"}`);
    line("Generated", `${watStamp(pack.generatedAt)} by ${pack.generatedBy}`);
    line("Audit chain", `${pack.auditVerification.valid ? "verified intact" : "BROKEN"}; ${counted(pack.auditVerification.count, "entry", "entries")}; head ${pack.auditVerification.headHash.slice(0, 16)}`);
    heading("Customer position (from instalments and payment records; no funds held)");
    line("Total instalments", kobo(pack.position.obligationsKobo));
    line("Allocated", kobo(pack.position.allocatedKobo));
    line("Outstanding", kobo(pack.position.outstandingKobo));
    // Money in another currency is listed beside the naira totals, never added to them.
    const beside = (other: OtherCurrencies | undefined) => other ? ` and ${otherCurrenciesText(other)}` : "";
    const heldElsewhere = pack.position.unallocatedOtherCurrencies;
    line("Unallocated payments", `${kobo(pack.position.unallocatedKobo)}${heldElsewhere ? `${beside(heldElsewhere)} in ${Object.keys(heldElsewhere).length === 1 ? "another currency" : "other currencies"}, held for Finance` : ""}`);
    heading("Summary");
    const s = pack.summary as Record<string, any>;
    line("Mandates", `${s.mandates.count} (${s.mandates.active} active, ${s.mandates.pendingActivation} awaiting activation)`);
    line("Instalments", `${s.dueItems.count} (${s.dueItems.paid} paid, ${s.dueItems.inCollection} in collection, ${s.dueItems.unpaidFinal} unpaid after final attempt, ${s.dueItems.inDispute} in dispute)`);
    line("Attempts", `${s.attempts.count} (${s.attempts.succeeded} succeeded, ${s.attempts.failed} failed, ${s.attempts.cancelled} cancelled)`);
    line("Payments", `${s.payments.count} totalling ${kobo(s.payments.kobo)}${beside(s.payments.otherCurrencies)} (${s.payments.reversed} reversed)`);
    line("Allocations", `${s.allocations.confirmed} confirmed, ${s.allocations.superseded} superseded`);
    line("Exceptions", `${s.exceptions.open} open, ${s.exceptions.resolved} resolved`);
    line("Notifications", `${s.notifications.count} (${s.notifications.accepted} accepted by the provider, ${s.notifications.delivered} delivered)`);
    line("Retry decisions", `${s.retryDecisions}`);
    line("Staff actions", `${s.humanActions}`);
    heading("Customer consent");
    if (!s.consent.length) document.font("Sans").fontSize(9).text("No mandate on file.");
    for (const item of s.consent as Array<{ mandate: string; evidence: string; gaps: string[]; provenance: string }>) {
      check();
      line(item.mandate, `evidence ${item.evidence || "none"}; provenance ${item.provenance || "n/a"}${item.gaps.length ? `; GAPS: ${item.gaps.join(", ")}` : "; no gaps"}`);
    }
    heading("Versions in effect at the time (AUD-06)");
    line("Retry policy", s.governingVersions.policies.join("; ") || "no approved version");
    line("Notice template", s.governingVersions.templates.join("; ") || "no approved version");
    line("Cutover contract", s.governingVersions.cutovers.join("; ") || "none");
    document.moveDown(0.6);
    document.font("Sans").fontSize(8).fillColor("#555555").text(pdfSafe(pack.note)).fillColor("#222222");

    // ---- Timeline pages ----
    const columns = [
      { key: "at", title: "When (WAT)", x: margin, width: 82 },
      { key: "event", title: "Event", x: margin + 86, width: 120 },
      { key: "detail", title: "Detail", x: margin + 210, width: width - 210 - 62 - 34 },
      { key: "amount", title: "Amount", x: margin + width - 92, width: 62 },
      { key: "policy", title: "Pol.", x: margin + width - 28, width: 28 },
    ] as const;
    const tableHeader = () => {
      document.font("Sans-Bold").fontSize(8).fillColor("#102E2A");
      const top = document.y;
      for (const column of columns) document.text(column.title, column.x, top, { width: column.width, lineBreak: false });
      const y = top + 12;
      document.moveTo(margin, y).lineTo(margin + width, y).lineWidth(0.5).strokeColor("#888888").stroke();
      document.y = y + 4;
      document.fillColor("#222222").font("Sans").fontSize(7.5);
    };
    document.addPage();
    document.font("Sans-Bold").fontSize(12).fillColor("#102E2A").text(`Timeline: ${counted(pack.timeline.length, "event")}, oldest first`, margin, margin, { width }).fillColor("#222222").moveDown(0.4);
    tableHeader();
    for (const event of pack.timeline) {
      check();
      const cells: Record<string, string> = { at: watStamp(event.at), event: pdfSafe(`${event.event}${event.actor ? ` (${event.actor})` : ""}`), detail: pdfSafe(event.detail), amount: event.amountKobo ? moneyText(event.amountKobo, event.currency) : "", policy: event.policyVersion ? `v${event.policyVersion}` : "-" };
      const height = Math.max(...columns.map((column) => document.heightOfString(cells[column.key] || " ", { width: column.width }))) + 4;
      if (document.y + height > bottom) { document.addPage(); document.y = margin; tableHeader(); }
      const y = document.y;
      for (const column of columns) document.text(cells[column.key] || "", column.x, y, { width: column.width });
      document.y = y + height;
      document.moveTo(margin, document.y - 2).lineTo(margin + width, document.y - 2).lineWidth(0.25).strokeColor("#dddddd").stroke();
    }

    // ---- Governing documents ----
    document.addPage();
    document.font("Sans-Bold").fontSize(12).fillColor("#102E2A").text("Documents in effect at the time (AUD-06)", margin, margin, { width }).fillColor("#222222").moveDown(0.4);
    if (!pack.documents.length) document.font("Sans").fontSize(9).text("No approved policy version, template or cutover contract applied to this customer's events.", margin, document.y, { width });
    for (const item of pack.documents) {
      check();
      const title = `${item.kind === "policies" ? "Retry policy" : item.kind === "templates" ? "Notice template" : "Cutover contract"} ${item.version ? `v${item.version} ` : ""}- ${item.name} (${item.status}); applied from ${watStamp(item.appliesFrom)}${item.appliesUntil ? ` until ${watStamp(item.appliesUntil)}` : " onwards"}`;
      const body = pdfSafe(item.text);
      const needed = document.heightOfString(title, { width }) + document.heightOfString(body, { width }) + 16;
      if (document.y + needed > bottom) { document.addPage(); document.y = margin; }
      document.font("Sans-Bold").fontSize(9).text(pdfSafe(title), margin, document.y, { width });
      document.font("Sans").fontSize(8.5).text(body, margin, document.y, { width }).moveDown(0.6);
    }

    // ---- Footers ----
    const range = document.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index++) {
      check();
      document.switchToPage(index);
      // Writing inside the bottom margin would otherwise make pdfkit open a new page.
      document.page.margins.bottom = 0;
      document.font("Sans").fontSize(7.5).fillColor("#666666").text(pdfSafe(`Page ${index - range.start + 1} of ${range.count}  |  Valo Pay dispute pack  |  ${text(pack.customer.reference)}  |  synthetic sandbox  |  generated ${watStamp(pack.generatedAt)}`), margin, document.page.height - margin + 4, { width, align: "center", lineBreak: false });
    }
    document.end();
    } catch (error) { document.destroy(error instanceof Error ? error : new Error(String(error))); }
    return result;
}
