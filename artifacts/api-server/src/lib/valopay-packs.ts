/**
 * AUD-02 dispute pack: one customer, a one-page summary followed by the whole
 * timeline (AUD-01), as a paginated PDF plus CSV and JSON of the same data.
 * AUD-06: the retry policy, the notification template and the cutover contract
 * are shown as they applied at the time of each event, never the current ones.
 * Everything here is pure; storage and checksums live in valopay-exports.
 */
import PDFDocument from "pdfkit";
import { VALO_PACK_SANS_BOLD, VALO_PACK_SANS_REGULAR } from "../fonts/valo-pack-sans";
import { collectionOwnerText, counted, dayText, evidenceSourceText, instantText, lenderModeText, moneyText, nairaText, notFoundText, optionText, otherCurrenciesText, recordTypeTitle, supersededReasonText, valueLabel, valueWords, WAT_OFFSET_MS } from "@workspace/valopay-schema";
import type { Context, DomainState, ValopayRecord } from "../domain/types";
import { inNaira, positionFor, unallocatedOtherCurrencies, type CustomerPosition, type OtherCurrencies } from "../domain/close";
import { currencyOf, exceptionCurrency } from "../domain/reconciliation";
import { policySummary, retryRuleText } from "../domain/policy-engine";
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
/** The CSV's atWAT column: a WAT time other systems read, kept in its original form. */
const watStamp = (iso: string): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "n/a";
  return `${new Date(ms + WAT_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ")} WAT`;
};
const text = (value: unknown): string => value === undefined || value === null || value === "" ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
/** A stored instant as people read it, "18 Sept 2026, 08:00 WAT", or "not recorded". */
const when = (value: unknown): string => typeof value === "string" && Number.isFinite(Date.parse(value)) ? instantText(value) : "not recorded";
/** A message channel in words: "SMS". */
const channelText = (channel: unknown): string => String(channel) === "sms" ? "SMS" : valueLabel(channel);
/** Why a match was taken out of use, in today's words. */
const noLongerApplied = (reason: unknown): string => {
  const why = supersededReasonText(reason);
  return /^(No longer applied|An accuracy review)/.test(why) ? why : `No longer applied: ${why}`;
};
const yesNo = (value: unknown): string => value ? "yes" : "no";
/** How a mandate is activated, after "Activation method:". */
const activationText = (workflow: unknown): string => {
  const phrases: Record<string, string> = { transfer_to_activate: "bank transfer", hosted_consent: "consent through the provider", paper_mandate: "paper mandate" };
  const code = String(workflow ?? "");
  return Object.hasOwn(phrases, code) ? phrases[code]! : valueWords(code);
};

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
    text: `${policySummary(policy)} Rules it follows: ${text(policy.data.complianceMapping).replace(/\.$/, "") || "not recorded"}. Approved by ${text(policy.data.reviewer) || "not recorded"}; written by ${text(policy.data.author) || "not recorded"}.`,
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
      ? `Collection returned to ${collectionOwnerText(cutover.data.fallbackOwner)}: ${(cutover.data.checklist as string[] | undefined)?.join("; ") ?? ""}. Confirmation: ${text(cutover.data.confirmation) || "none"}`
      : `Collection systems: ${text(cutover.data.inventory) || "not recorded"}. Previous collection system switched off: ${yesNo(cutover.data.incumbentDisabled)}; its collection attempts imported: ${yesNo(cutover.data.externalAttemptsImported)}; parallel-run day complete: ${yesNo(cutover.data.dualRunComplete)}; named person: ${text(cutover.data.accountableUser) || "not named"}; collection returns to: ${collectionOwnerText(cutover.data.fallbackOwner)}. Confirmation: ${text(cutover.data.confirmation) || "none"}`,
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
  const status = valueWords(record.status);
  switch (record.kind) {
    case "customers": return { event: "Customer record", detail: `Consent source: ${text(d.consentProvenance) || "not recorded"}.` };
    case "mandates": return { event: `Mandate: ${status}`, detail: `Activation method: ${activationText(d.workflow)}; origin: ${valueWords(d.origin)}; consent evidence: ${text(d.consentEvidence) || "none"}${Array.isArray(d.consentGaps) && d.consentGaps.length ? `; missing consent evidence: ${d.consentGaps.join(", ")}` : ""}; debit limit ${kobo(record.amountKobo)}.` };
    case "due-items": return { event: `Instalment ${record.reference}: ${status}`, detail: `Due ${d.dueDate ? dayText(d.dueDate) : "date not recorded"}; collected by ${collectionOwnerText(d.owner)}; outstanding ${kobo(Number(d.outstandingKobo ?? record.amountKobo))}${d.experimentArm ? `; recovery test: ${valueWords(d.experimentArm)}` : ""}${d.amendedAt ? `; corrected ${when(d.amendedAt)}` : ""}.` };
    case "attempts": return { event: `Collection attempt${d.number ? ` ${text(d.number)}` : ""}: ${status}`, detail: `${d.source === "external" ? "Recorded from another collection system" : `Source: ${valueWords(d.source)}`}${d.failureCode ? `; failure: ${valueLabel(d.failureCode)} (${d.failureCode})` : ""}${d.rawFailureCode && d.rawFailureCode !== d.failureCode ? `; code as received: ${d.rawFailureCode}` : ""}${d.providerReference ? `; provider reference ${d.providerReference}` : ""}${d.cancellationReason ? `; ${d.cancellationReason}` : ""}.` };
    case "observations": return { event: `Payment evidence from ${evidenceSourceText(d.source)}`, detail: `${valueLabel(record.status)}${d.resolutionKey ? `, matched by ${valueWords(d.resolutionKey)}` : ""}${d.paymentId ? `; linked to payment record ${d.paymentId}` : ""}${d.resolvedTo ? `; resolved to ${text(d.resolvedTo)}` : ""}${d.batchReference ? `; settlement batch ${d.batchReference}` : ""}.` };
    case "payments": return { event: `Payment ${record.reference}: ${status}`, detail: `Channel: ${valueWords(d.channel)}; collection: ${valueWords(d.collectionStatus)}; settlement: ${valueWords(d.settlementStatus)}; reversal: ${valueWords(d.reversalStatus)}; refund: ${valueWords(d.refundStatus)}; allocated ${moneyText(Number(d.allocatedKobo || 0), currencyOf(record))}${d.explanation ? `; ${text(d.explanation).replace(/\.$/, "")}` : ""}.` };
    case "allocations": return { event: `Allocation: ${status}`, detail: `${valueLabel(d.confidence)} match${d.automatic ? ", made automatically" : ""} (rule ${text(d.rule) || "not recorded"}). ${text(d.explanation)}${d.supersededReason ? ` ${noLongerApplied(d.supersededReason)}` : ""}${typeof d.reviewed === "boolean" ? ` Reviewed as ${d.reviewed ? "correct" : "wrong"} by ${text(d.reviewedBy)}.` : ""}` };
    case "exceptions": return { event: `Exception: ${valueLabel(d.type)} (${status})`, detail: `Owner: ${text(d.owner) || "not set"}; severity: ${valueWords(d.severity)}; deadline ${d.dueBy ? when(d.dueBy) : "not set"}${d.resolutionCode ? `; resolved as ${optionText(d.resolutionCode)} by ${text(d.resolvedBy)}` : ""}. ${text(d.notes)}` };
    case "notifications": return { event: `Customer message: ${valueWords(d.purpose)} (${status})`, detail: `${channelText(d.channel)}; ${valueWords(d.class)} message; ${d.acceptedAt ? `accepted by the provider ${when(d.acceptedAt)}` : "not yet accepted by the provider"}; ${d.deliveredAt ? `delivered ${when(d.deliveredAt)}` : "not delivered"}. Text: ${text(d.renderedText)}` };
    case "retry-decisions": return {
      event: `Retry decision: ${valueWords(d.decision)}`,
      detail: `Rule: ${retryRuleText(d.rule)}; retry policy version ${text(d.policyVersion) || "not recorded"}. ${text(d.reason)}${d.nextAt ? ` Next attempt ${when(d.nextAt)}.` : ""}${notice ? ` Notice needed: ${valueWords(notice.purpose)}${notice.requiredBy ? ` by ${when(notice.requiredBy)}` : ""}, ${notice.evidenced ? "confirmed" : "not confirmed"}.` : ""}${d.experimentArm ? ` Recovery test: ${valueWords(d.experimentArm)}.` : ""} Inputs: failure ${inputs?.code ? valueLabel(inputs.code) : "none"}, attempt ${text(inputs?.attemptNumber)} of ${text(inputs?.ceiling)}.`,
    };
    case "audit": return { event: `Action: ${valueLabel(record.name)}`, detail: `${text(d.actor)}: ${text(d.summary)}` };
    case "case-events": {
      const evidence = Array.isArray(d.after?.evidenceIds) ? (d.after.evidenceIds as unknown[]).map(String) : [];
      return { event: record.name, detail: `${text(d.note)} Assigned to: ${text(d.after?.assigneeName) || "no one"}. Next step: ${text(d.after?.nextAction) || "not set"}; follow-up ${d.after?.nextActionAt ? when(d.after.nextActionAt) : "not set"}. Evidence: ${evidence.length ? evidence.join(", ") : "none"}.` };
    }
    default: return { event: `${recordTypeTitle(record.kind)}: ${status}`, detail: text(record.name) };
  }
}

/** One customer's complete evidence, sorted oldest first, with the governing versions resolved per event. */
export function buildDisputePack(state: DomainState, ctx: Context, customerId: string): DisputePack {
  const customer = recordsOf(state, "customers").find((record) => record.id === customerId);
  if (!customer) throw Object.assign(new Error(notFoundText("customer")), { status: 404 });
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
      at, kind: record.kind, event, status: record.status, reference: record.reference, amountKobo: record.amountKobo, currency: currencyFor(record), detail: detail + (record.data.importIdentity ? ` Imported from ${text(record.data.importIdentity.source)}; source row ID ${text(record.data.importIdentity.rowId)}${record.data.importIdentity.batchId ? `; import batch ${text(record.data.importIdentity.batchId)}` : ''}.` : ''),
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
      governingVersions: { policies: documents.filter((d) => d.kind === "policies").map((d) => `version ${d.version} from ${when(d.appliesFrom)}`), templates: documents.filter((d) => d.kind === "templates").map((d) => `version ${d.version} from ${when(d.appliesFrom)}`), cutovers: documents.filter((d) => d.kind === "cutovers").map((d) => `${d.name} (${valueWords(d.status)}) from ${when(d.appliesFrom)}`) },
      events: timeline.length,
    },
    timeline, documents,
    auditVerification: verifyAudit(state),
    note: "Sample data only, not live evidence. Amounts are stored in whole kobo and shown in naira (₦). Money in another currency is stored in that currency’s smallest unit, shown in its own currency and never added to a naira total. Times are in West Africa Time (WAT). Valo Pay never holds money. Each file has a SHA-256 checksum, saved with its export record, to show the file has not changed.",
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
    const document = new PDFDocument({ size: "A4", lang: "en-GB", margin, bufferPages: true, compress: options.compress ?? true, info: { Title: `Dispute pack ${text(pack.customer.reference)}`, Author: "Valo Pay", Subject: "Dispute pack (sample data)" } });
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
    document.font("Sans-Bold").fontSize(20).fillColor("#102E2A").text("Valo Pay dispute pack");
    document.font("Sans").fontSize(9).fillColor("#9B6524").text("Sample data only: not live evidence").fillColor("#222222").moveDown(0.5);
    line("Customer", `${text(pack.customer.name)} (${text(pack.customer.reference)}) · ${valueWords(pack.customer.status)}`);
    line("Lender", `${pack.merchant.name} · provider ${pack.merchant.provider} · mode: ${lenderModeText(pack.merchant.mode)}`);
    line("Bank", `${text(pack.customer.bankName) || "not recorded"} ${text(pack.customer.accountMasked)} · phone ${text(pack.customer.phoneMasked) || "not recorded"}`);
    line("Prepared", `${when(pack.generatedAt)} by ${pack.generatedBy}`);
    line("Audit log", `${pack.auditVerification.valid ? "every entry checked and intact" : "the check failed; ask an Admin to investigate"} (${counted(pack.auditVerification.count, "entry", "entries")})`);
    heading("Customer position (from instalments and payments; Valo Pay never holds money)");
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
    line("Collection attempts", `${s.attempts.count} (${s.attempts.succeeded} succeeded, ${s.attempts.failed} failed, ${s.attempts.cancelled} cancelled)`);
    line("Payments", `${s.payments.count} totalling ${kobo(s.payments.kobo)}${beside(s.payments.otherCurrencies)} (${s.payments.reversed} reversed)`);
    line("Allocations", `${s.allocations.confirmed} confirmed, ${s.allocations.superseded} no longer applied`);
    line("Exceptions", `${s.exceptions.open} open, ${s.exceptions.resolved} resolved`);
    line("Customer messages", `${s.notifications.count} (${s.notifications.accepted} accepted by the provider, ${s.notifications.delivered} delivered)`);
    line("Retry decisions", `${s.retryDecisions}`);
    line("Staff actions", `${s.humanActions}`);
    heading("Customer consent");
    if (!s.consent.length) document.font("Sans").fontSize(9).text("No mandate on file.");
    for (const item of s.consent as Array<{ mandate: string; evidence: string; gaps: string[]; provenance: string }>) {
      check();
      line(item.mandate, `evidence ${item.evidence || "none"}; consent source ${item.provenance || "not recorded"}${item.gaps.length ? `; missing evidence: ${item.gaps.join(", ")}` : "; nothing missing"}`);
    }
    heading("Versions in effect at the time");
    line("Retry policy", s.governingVersions.policies.join("; ") || "no approved version");
    line("Message template", s.governingVersions.templates.join("; ") || "no approved version");
    line("Collection transfer", s.governingVersions.cutovers.join("; ") || "none");
    document.moveDown(0.6);
    document.font("Sans").fontSize(8).fillColor("#555555").text(pdfSafe(pack.note));
    // An auditor's check of the audit log needs its last entry's hash: shown once, under its own heading, saying what it is for.
    if (pack.auditVerification.count) document.moveDown(0.3).text(pdfSafe(`Technical details: the last audit log entry’s hash is ${pack.auditVerification.headHash.slice(0, 16)}. An auditor can compare it with the audit log to show no entry was changed.`));
    document.fillColor("#222222");

    // ---- Timeline pages ----
    const columns = [
      { key: "at", title: "When (WAT)", x: margin, width: 82 },
      { key: "event", title: "Event", x: margin + 86, width: 120 },
      { key: "detail", title: "Detail", x: margin + 210, width: width - 210 - 62 - 34 },
      { key: "amount", title: "Amount", x: margin + width - 92, width: 62 },
      { key: "policy", title: "Policy", x: margin + width - 28, width: 28 },
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
      const cells: Record<string, string> = { at: when(event.at), event: pdfSafe(`${event.event}${event.actor ? ` (${event.actor})` : ""}`), detail: pdfSafe(event.detail), amount: event.amountKobo ? moneyText(event.amountKobo, event.currency) : "", policy: event.policyVersion ? `v${event.policyVersion}` : "-" };
      const height = Math.max(...columns.map((column) => document.heightOfString(cells[column.key] || " ", { width: column.width }))) + 4;
      if (document.y + height > bottom) { document.addPage(); document.y = margin; tableHeader(); }
      const y = document.y;
      for (const column of columns) document.text(cells[column.key] || "", column.x, y, { width: column.width });
      document.y = y + height;
      document.moveTo(margin, document.y - 2).lineTo(margin + width, document.y - 2).lineWidth(0.25).strokeColor("#dddddd").stroke();
    }

    // ---- Governing documents ----
    document.addPage();
    document.font("Sans-Bold").fontSize(12).fillColor("#102E2A").text("Documents in effect at the time", margin, margin, { width }).fillColor("#222222").moveDown(0.4);
    if (!pack.documents.length) document.font("Sans").fontSize(9).text("No approved retry policy version, message template or collection transfer applied to this customer’s events.", margin, document.y, { width });
    for (const item of pack.documents) {
      check();
      const title = `${item.kind === "policies" ? "Retry policy" : item.kind === "templates" ? "Message template" : "Collection transfer"} ${item.version ? `version ${item.version} ` : ""}· ${item.name} (${valueWords(item.status)}); in effect from ${when(item.appliesFrom)}${item.appliesUntil ? ` until ${when(item.appliesUntil)}` : " onwards"}`;
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
      document.font("Sans").fontSize(7.5).fillColor("#666666").text(pdfSafe(`Page ${index - range.start + 1} of ${range.count}  ·  Valo Pay dispute pack  ·  ${text(pack.customer.reference)}  ·  sample data only  ·  prepared ${when(pack.generatedAt)}`), margin, document.page.height - margin + 4, { width, align: "center", lineBreak: false });
    }
    document.end();
    } catch (error) { document.destroy(error instanceof Error ? error : new Error(String(error))); }
    return result;
}
