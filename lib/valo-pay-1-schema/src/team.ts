import { z } from "zod";
import { merchantSchema, recordDataSchema } from "./api";
import { pilotRoleSchema } from "./pilot";

/** A staff membership's state. */
export const membershipStatuses = ["active", "suspended", "revoked"] as const;
/**
 * The roles whose grant takes effect only once a second administrator approves it: the roles that approve or review
 * other people's work (administration, Finance's close and correction reviews, Compliance's policy approvals). The
 * administrator who proposed the grant cannot approve it.
 */
export const approvalRoles = ["Admin", "Finance", "Compliance reviewer"] as const;
/** Whether a membership change grants one of `approvalRoles`: it leaves the membership active in such a role that it did not already hold actively (a new role, or a suspended membership reactivated). */
export function grantNeedsApproval(before: { role: string; status: string }, after: { role: string; status: string }): boolean {
  return after.status === "active" && (approvalRoles as readonly string[]).includes(after.role) && !(before.status === "active" && before.role === after.role);
}
/** A staff membership as a change answers it: its role, state, expiry and version. */
export const staffMemberSchema = z.object({
  id: z.string(), actor: z.string(), name: z.string(), role: pilotRoleSchema, status: z.enum(membershipStatuses), expiresAt: z.string(), updatedAt: z.string(),
}).strict();
/**
 * A membership in the team directory, with the lenders it may open; an administrator opens every lender and names
 * none. A viewer who is not an administrator sees only colleagues who share a lender with them, only the lenders they
 * share, and no one's expiry but their own (`expiresAt` null).
 */
export const staffDirectoryMemberSchema = staffMemberSchema.extend({ expiresAt: z.string().nullable(), lenderIds: z.array(z.string()), allLenders: z.boolean() }).strict();
/** An invitation's state. */
export const invitationStatuses = ["pending", "accepted", "revoked"] as const;
/** Whether an invitation needs a second administrator's approval before it can be accepted (`approvalRoles`), and whether it has it. */
export const invitationApprovalStates = ["not_required", "awaiting", "approved"] as const;
/** A pending, accepted or revoked invitation, who sent it and its approval; its token is shown once, at creation. */
export const staffInvitationSchema = z.object({
  id: z.string(), email: z.string(), role: pilotRoleSchema, status: z.enum(invitationStatuses), expiresAt: z.string(),
  invitedBy: z.string(), approval: z.enum(invitationApprovalStates), approvedBy: z.string().nullable(),
}).strict();
/** A membership's role and state, before or after a change. */
export const staffAccessSchema = z.object({ role: pilotRoleSchema, status: z.enum(membershipStatuses) }).strict();
/** A membership change that grants one of `approvalRoles` and waits for a second administrator: who asked, when and why. Approving it applies exactly this change; a later change to the membership leaves it out of date, and it is no longer listed. */
export const staffChangeRequestSchema = z.object({
  id: z.string(), memberId: z.string(), name: z.string(), from: staffAccessSchema, to: staffAccessSchema,
  reason: z.string(), requestedBy: z.string(), requestedAt: z.string(),
}).strict();
/** One entry of the team's access history. */
export const staffEventSchema = z.object({ id: z.string(), actor: z.string(), action: z.string(), subject: z.string(), detail: recordDataSchema, createdAt: z.string() }).strict();
/** The team as the caller may see it: members as `staffDirectoryMemberSchema` describes; lenders, invitations, changes awaiting a second administrator and history for administrators. In the sandbox every list is empty and the message says why. */
export const staffDirectorySchema = z.object({
  mode: z.enum(["sandbox", "staff"]), actor: z.string(), members: z.array(staffDirectoryMemberSchema), lenders: z.array(merchantSchema),
  invitations: z.array(staffInvitationSchema).max(100), changes: z.array(staffChangeRequestSchema).max(100), events: z.array(staffEventSchema).max(100), message: z.string(),
}).strict();
/** The team directory as GET /v1/team answers it. */
export type StaffDirectory = z.infer<typeof staffDirectorySchema>;
/** A membership change's answer: the membership as it now stands, what happened in plain words, and the request when the change waits for a second administrator (the membership is then unchanged). */
export const staffChangeResultSchema = staffMemberSchema.extend({ message: z.string(), pendingChange: staffChangeRequestSchema.nullable() }).strict();
/** A new invitation, its one-time acceptance token and whether it waits for a second administrator's approval; no email is sent. */
export const invitationCreatedSchema = z.object({ id: z.string(), token: z.string().regex(/^[a-f0-9]{64}$/), approval: z.enum(["not_required", "awaiting"]), message: z.string() }).strict();
/** The acceptance token from an invitation link. */
export const acceptInvitationInputSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
/** The new membership's role, confirmed. */
export const invitationAcceptedSchema = z.object({ message: z.string(), role: pilotRoleSchema }).strict();
/** A non-administrator membership with the lenders it may now open. */
export const staffLenderAccessSchema = staffMemberSchema.extend({ lenderIds: z.array(z.string()), allLenders: z.literal(false), message: z.string() }).strict();
/** One readiness control (identity, MFA, origins, database isolation, encryption) with its state on this host and what that means. */
export const readinessCheckSchema = z.object({
  id: z.enum(["identity", "mfa", "origin", "database", "encryption"]), name: z.string(),
  state: z.enum(["verified_this_request", "configured", "configured_not_verified", "not_configured"]), detail: z.string(),
}).strict();
/** The staff-access and encryption controls as this request observed them; configuration only, never a secret. */
export const accessReadinessSchema = z.object({ syntheticOnly: z.literal(true), canCommission: z.boolean(), checkedAt: z.string(), checks: z.array(readinessCheckSchema) }).strict();
/** A synthetic payload sealed and opened with the configured managed key. */
export const encryptionVerificationSchema = z.object({ message: z.string(), checkedAt: z.string(), verified: z.literal(true) }).strict();
/** How many stored payloads one bounded run protected, and whether another run is needed. */
export const payloadProtectionSchema = z.object({ message: z.string(), protectedCount: z.number().int().min(0), mayHaveMore: z.boolean() }).strict();
