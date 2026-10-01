import { z } from "zod";
import { connectedConsentPurposes, type ConnectedActionInput } from "@workspace/valopay-schema";
import type { Context, DomainState, ValopayRecord } from "./types";
import { makeRecord, touch } from "./records";
import { allow, owned, reject } from "./connected-context";
import { permissionActive } from "./connected-permission-validity";

export const consentPurposes = connectedConsentPurposes;
export const purposeLabels: Record<string, string> = {
  account_read: "Read applicant accounts",
  credit_assessment: "Assess an application",
  merchant_account_read: "Read business accounts",
  erp_draft: "Prepare accounting drafts and VAT schedules",
  payroll_prepare: "Prepare payroll funding",
  one_time_payment: "Authorise one payment",
};
export function consentActive(r: ValopayRecord, now: string) {
  return permissionActive({
    status: r.status,
    validFrom: r.data.validFrom ?? r.createdAt,
    expiresAt: r.data.expiresAt,
    version: r.data.version,
  }, now);
}
export function addConsent(
  state: DomainState,
  ctx: Context,
  data: Record<string, unknown>,
) {
  allow(ctx, ["Admin", "Operations"], "grant permissions");
  const input = z
    .object({
      purpose: z.enum(consentPurposes),
      subjectId: z.string().min(1),
      days: z.number().int().min(1).max(90).default(30),
    })
    .strict()
    .parse(data);
  const sme = [
    "merchant_account_read",
    "erp_draft",
    "payroll_prepare",
  ].includes(input.purpose);
  if (
    sme
      ? input.subjectId !== "sme"
      : !state.records.some(
          (r) => r.kind === "customers" && r.id === input.subjectId,
        )
  )
    reject("Choose a customer of this lender, or the sample business.");
  const existing = state.records.find(
    (r) =>
      r.kind === "connected-consents" &&
      r.data.subjectId === input.subjectId &&
      r.data.purpose === input.purpose &&
      consentActive(r, ctx.now),
  );
  if (existing) return existing;
  return makeRecord(state, "connected-consents", {
    name: purposeLabels[input.purpose],
    status: "active",
    createdAt: ctx.now,
    data: {
      ...input,
      entityId: sme ? `${state.merchant.id}:sme` : state.merchant.id,
      version: 1,
      expiresAt: new Date(
        Date.parse(ctx.now) + input.days * 86400000,
      ).toISOString(),
      grantedBy: ctx.actor,
      authority: "simulated",
      noticeVersion: "connected-2026-09",
      source: "synthetic_permission_journey",
    },
  });
}

/** Revocation changes the current grant version; it never changes a recorded payment outcome. */
export function revokeConsent(state: DomainState, ctx: Context, input: ConnectedActionInput) {
  allow(ctx, ["Admin", "Operations", "Compliance reviewer"], "withdraw permissions");
  const consent = owned(state, input.recordId, "connected-consents");
  if (consent.status === "revoked") return consent;
  consent.status = "revoked";
  consent.data.revokedAt = ctx.now;
  consent.data.revokedBy = ctx.actor;
  consent.data.revocationReason = input.reason;
  consent.data.version = Number(consent.data.version || 0) + 1;
  touch(consent, ctx.now);
  return consent;
}
