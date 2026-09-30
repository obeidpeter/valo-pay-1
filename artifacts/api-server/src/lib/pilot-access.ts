/**
 * Staging access foundation. Input must be the result of Clerk's server middleware,
 * never a decoded-but-unverified token, browser role, request body or sandbox persona.
 * Signature, issuer and authorised-party verification still belong to that middleware.
 */
import { sensitiveExportRoles, type PilotAccessFailureCode } from '@workspace/valopay-schema';
import { onlyRoles } from './refusal-words';
export interface VerifiedClerkSession {
  userId?: string | null;
  sessionId?: string | null;
  orgId?: string | null;
  tokenType?: string | null;
  sessionStatus?: string | null;
  actor?: unknown;
  factorVerificationAge?: readonly [number, number] | null;
  sessionClaims?: Record<string, unknown> | null;
}

export const pilotRoles = ['Admin', 'Operations', 'Finance', 'Compliance reviewer', 'Read-only'] as const;
export type PilotRole = (typeof pilotRoles)[number];
export type PilotAction = 'read' | 'record_operations' | 'confirm_match' | 'approve_policy' | 'manage_settings' | 'export_sensitive';

/** Load from server-controlled provisioning for every request. Do not trust a supplied membership object. */
export interface ProvisionedMembership {
  id: string;
  userId: string;
  organizationId: string;
  tenantId: string;
  role: string;
  status: 'active' | 'suspended' | 'revoked';
  validFrom: string;
  expiresAt: string;
}
export interface PilotAccessPolicy {
  enabled: boolean;
  /** This foundation cannot be used to approve live operations. */
  environment: 'staging';
  issuer: string;
  authorisedParties: readonly string[];
  maxFactorAgeMinutes: number;
  maxSensitiveFactorAgeMinutes: number;
}
export interface PilotAccessGrant {
  readonly userId: string;
  readonly sessionId: string;
  readonly organizationId: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly role: PilotRole;
  readonly action: PilotAction;
  readonly liveOperationsAllowed: false;
}

/** Why staff access was refused; the codes the error body's `code` names (lib/valopay-schema api.ts). */
export type PilotAccessFailure = PilotAccessFailureCode;
export class PilotAccessError extends Error {
  readonly status: number;
  constructor(readonly code: PilotAccessFailure, message: string) {
    super(message); this.name = 'PilotAccessError';
    this.status = code === 'authentication_required' || code === 'session_invalid' ? 401 : 403;
  }
}
function refuse(code: PilotAccessFailure, message: string): never { throw new PilotAccessError(code, message); }
const rolesForAction: Record<PilotAction, readonly PilotRole[]> = {
  read: pilotRoles,
  record_operations: ['Admin', 'Operations'],
  confirm_match: ['Admin', 'Finance'],
  approve_policy: ['Compliance reviewer'],
  manage_settings: ['Admin'],
  // Dispute packs, the customer register and the audit trail (sensitiveExportKinds): lib/export-jobs.ts checks it when one is queued, retried or downloaded.
  export_sensitive: sensitiveExportRoles,
};
/** Each action as a role refusal names it: "Only Admin can change lender settings." */
const actionWords: Record<PilotAction, string> = {
  read: 'use this lender', record_operations: 'record collection work', confirm_match: 'confirm matches',
  approve_policy: 'approve retry policies', manage_settings: 'change lender settings', export_sensitive: 'export sensitive records',
};
/** Whether a provisioned role may perform an action, by the table authorizePilotAccess checks. For a rule the per-request check does not name, such as export_sensitive, which depends on what is exported. */
export function rolePermits(role: string, action: PilotAction): boolean {
  const allowed = Object.prototype.hasOwnProperty.call(rolesForAction, action) ? rolesForAction[action] : undefined;
  return !!allowed && (allowed as readonly string[]).includes(role);
}
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const seconds = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const minutes = (value: unknown, maximum: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maximum;
function httpsOrigin(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; }
}
function instant(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  // Date.parse normalises dates such as 31 September into the next month.
  // A malformed provisioned expiry must never silently extend membership.
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19) ? parsed : NaN;
}

/** Authorises only the requested staging action against a current, matching membership and both MFA factors. */
export function authorizePilotAccess(auth: VerifiedClerkSession | null | undefined, membership: ProvisionedMembership | null | undefined, request: { tenantId: string; action: PilotAction }, policy: PilotAccessPolicy, nowMs = Date.now()): PilotAccessGrant {
  if (policy?.enabled !== true || policy.environment !== 'staging') refuse('pilot_disabled', 'Team member sign-in is not switched on at this address. Contact the Valo Pay team if you need it.');
  if (!Number.isFinite(nowMs) || !httpsOrigin(policy.issuer) || !Array.isArray(policy.authorisedParties) || policy.authorisedParties.length === 0 || !policy.authorisedParties.every(httpsOrigin) || !minutes(policy.maxFactorAgeMinutes, 1440) || !minutes(policy.maxSensitiveFactorAgeMinutes, 10) || policy.maxSensitiveFactorAgeMinutes > policy.maxFactorAgeMinutes) refuse('configuration_invalid', 'Team member sign-in is not set up correctly. Contact the Valo Pay team.');
  if (!auth || !nonempty(auth.userId) || !nonempty(auth.sessionId) || auth.tokenType !== 'session_token') refuse('authentication_required', 'Sign in, then try again.');
  const claims = auth.sessionClaims;
  if (!claims || auth.sessionStatus !== 'active' || auth.actor || claims.act || claims.sub !== auth.userId || claims.sid !== auth.sessionId || claims.iss !== policy.issuer || typeof claims.azp !== 'string' || !policy.authorisedParties.includes(claims.azp)) refuse('session_invalid', 'Your sign-in is not valid at this address. Sign out, sign in again here and try again.');
  const nowSeconds = nowMs / 1000;
  if (!seconds(claims.iat) || !seconds(claims.exp) || claims.iat > nowSeconds || claims.exp <= nowSeconds || claims.exp <= claims.iat || (claims.nbf !== undefined && (!seconds(claims.nbf) || claims.nbf > nowSeconds))) refuse('session_invalid', 'Your sign-in has expired. Sign in again, then try again.');
  if (!membership || !nonempty(membership.id) || !nonempty(request?.tenantId) || !nonempty(auth.orgId) || membership.userId !== auth.userId || membership.organizationId !== auth.orgId || membership.tenantId !== request.tenantId) refuse('membership_required', 'You do not have access to this lender. Ask an Admin to give you access.');
  const validFrom = instant(membership.validFrom), expiresAt = instant(membership.expiresAt);
  if (membership.status !== 'active' || !Number.isFinite(validFrom) || !Number.isFinite(expiresAt) || validFrom > nowMs || expiresAt <= nowMs || expiresAt <= validFrom) refuse('membership_inactive', 'Your access has ended or is paused. Ask an Admin to renew it.');
  const allowed = Object.prototype.hasOwnProperty.call(rolesForAction, request.action) ? rolesForAction[request.action] : undefined;
  if (!allowed || !pilotRoles.includes(membership.role as PilotRole) || !allowed.includes(membership.role as PilotRole)) refuse('role_not_permitted', allowed ? onlyRoles(allowed, actionWords[request.action], 'staff') : 'Your role does not allow this. Ask an Admin to check your role in Team and access.');
  const ages = auth.factorVerificationAge;
  if (!Array.isArray(ages) || ages.length !== 2 || ages.some(age => !Number.isSafeInteger(age) || age < 0)) refuse('mfa_required', 'Complete two-step verification, then try again.');
  const maxAge = request.action === 'read' ? policy.maxFactorAgeMinutes : policy.maxSensitiveFactorAgeMinutes;
  const tokenAgeMinutes = (nowSeconds - claims.iat) / 60;
  if (ages.some(age => age + tokenAgeMinutes >= maxAge)) refuse('reverification_required', 'Confirm your identity again with two-step verification, then try again.');
  return Object.freeze({ userId: auth.userId, sessionId: auth.sessionId, organizationId: auth.orgId, tenantId: membership.tenantId, membershipId: membership.id, role: membership.role as PilotRole, action: request.action, liveOperationsAllowed: false });
}
