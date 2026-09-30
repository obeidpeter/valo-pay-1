import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { authorizePilotAccess, PilotAccessError, pilotRoles, rolePermits, type PilotAccessPolicy, type PilotAccessFailure, type ProvisionedMembership, type VerifiedClerkSession } from '../src/lib/pilot-access.js';
import { decryptField, encryptField, FieldEncryptionError, rotateField, type FieldKeyRing, type FieldScope } from '../src/lib/field-encryption.js';
import { seedMerchant } from '../src/lib/valopay-seed.js';
import { validateRecord } from '../src/domain/validation.js';
import type { Context } from '../src/domain/types.js';
import { recordsOf } from '../src/domain/records.js';
import { queueExport, retryExport } from '../src/lib/export-jobs.js';
import { executeAction } from '../src/domain/actions.js';
import { exportPermitted } from '@workspace/valopay-schema';

let checks = 0;
const now = Date.parse('2026-09-18T10:00:00Z');
const policy: PilotAccessPolicy = { enabled: true, environment: 'staging', issuer: 'https://clerk.example.test', authorisedParties: ['https://staging.example.test'], maxFactorAgeMinutes: 60, maxSensitiveFactorAgeMinutes: 10 };
const auth: VerifiedClerkSession = {
  userId: 'user_sample', sessionId: 'sess_sample', orgId: 'org_sample', tokenType: 'session_token', sessionStatus: 'active', factorVerificationAge: [0, 0],
  sessionClaims: { sub: 'user_sample', sid: 'sess_sample', iss: policy.issuer, azp: policy.authorisedParties[0], iat: now / 1000 - 30, exp: now / 1000 + 30, nbf: now / 1000 - 30 },
};
const member: ProvisionedMembership = { id: 'member_sample', userId: 'user_sample', organizationId: 'org_sample', tenantId: 'tenant_sample', role: 'Finance', status: 'active', validFrom: '2026-09-01T00:00:00Z', expiresAt: '2026-10-01T00:00:00Z' };
const request = { tenantId: 'tenant_sample', action: 'confirm_match' } as const;
const reject = (fn: () => unknown, code: PilotAccessFailure) => { assert.throws(fn, error => error instanceof PilotAccessError && error.code === code); checks++; };

{
  const grant = authorizePilotAccess(auth, member, request, policy, now);
  assert.equal(grant.role, 'Finance');
  assert.equal(grant.tenantId, member.tenantId);
  assert.equal(grant.liveOperationsAllowed, false);
  assert.equal(Object.isFrozen(grant), true);
  checks += 4;
  reject(() => authorizePilotAccess(auth, member, request, { ...policy, enabled: false }, now), 'pilot_disabled');
  reject(() => authorizePilotAccess(auth, member, request, { ...policy, environment: 'production' } as never, now), 'pilot_disabled');
  for (const patch of [{ issuer: 'http://clerk.example.test' }, { authorisedParties: [] }, { authorisedParties: ['*'] }, { maxFactorAgeMinutes: NaN }, { maxSensitiveFactorAgeMinutes: 11 }]) reject(() => authorizePilotAccess(auth, member, request, { ...policy, ...patch }, now), 'configuration_invalid');
  reject(() => authorizePilotAccess(null, member, request, policy, now), 'authentication_required');
  reject(() => authorizePilotAccess({ ...auth, tokenType: 'api_key' }, member, request, policy, now), 'authentication_required');
  reject(() => authorizePilotAccess({ ...auth, sessionStatus: 'pending' }, member, request, policy, now), 'session_invalid');
  reject(() => authorizePilotAccess({ ...auth, actor: { sub: 'user_other' } }, member, request, policy, now), 'session_invalid');
  for (const patch of [{ sub: 'user_other' }, { sid: 'session_other' }, { iss: 'https://other.example.test' }, { azp: 'https://attacker.example.test' }, { exp: now / 1000 }, { iat: now / 1000 + 1 }, { nbf: now / 1000 + 1 }, { exp: 'future' }]) reject(() => authorizePilotAccess({ ...auth, sessionClaims: { ...auth.sessionClaims, ...patch } }, member, request, policy, now), 'session_invalid');
  reject(() => authorizePilotAccess(auth, null, request, policy, now), 'membership_required');
  for (const patch of [{ userId: 'user_other' }, { organizationId: 'org_other' }, { tenantId: 'tenant_other' }]) reject(() => authorizePilotAccess(auth, { ...member, ...patch }, request, policy, now), 'membership_required');
  for (const patch of [{ status: 'revoked' as const }, { status: 'suspended' as const }, { expiresAt: '2026-09-18T10:00:00Z' }, { validFrom: '2026-09-19T00:00:00Z' }, { expiresAt: 'invalid' }, { expiresAt: '2026-09-31T00:00:00Z' }, { validFrom: '2026-02-30T00:00:00Z' }]) reject(() => authorizePilotAccess(auth, { ...member, ...patch }, request, policy, now), 'membership_inactive');
  for (const role of ['Read-only', 'Operations', 'org:admin', 'Unsupported']) reject(() => authorizePilotAccess({ ...auth, sessionClaims: { ...auth.sessionClaims, role: 'Admin' } }, { ...member, role }, request, policy, now), 'role_not_permitted');
  reject(() => authorizePilotAccess(auth, member, { ...request, action: '__proto__' } as never, policy, now), 'role_not_permitted');
  for (const ages of [null, [-1, 0], [0, -1], [0, NaN], [0, 0.5], [0]] as const) reject(() => authorizePilotAccess({ ...auth, factorVerificationAge: ages as never }, member, request, policy, now), 'mfa_required');
  for (const ages of [[10, 0], [0, 10], [61, 0]]) reject(() => authorizePilotAccess({ ...auth, factorVerificationAge: ages as [number, number] }, member, request, policy, now), 'reverification_required');
  // Token age is added to the factor age; an old signed token cannot keep a factor fresh.
  reject(() => authorizePilotAccess({ ...auth, factorVerificationAge: [9, 0], sessionClaims: { ...auth.sessionClaims, iat: now / 1000 - 61 } }, member, request, policy, now), 'reverification_required');
  assert.equal(authorizePilotAccess({ ...auth, factorVerificationAge: [9, 9] }, member, request, policy, now).role, 'Finance'); checks++;
  assert.equal(authorizePilotAccess({ ...auth, factorVerificationAge: [30, 30] }, { ...member, role: 'Read-only' }, { ...request, action: 'read' }, policy, now).role, 'Read-only'); checks++;
  reject(() => authorizePilotAccess({ ...auth, factorVerificationAge: [60, 0] }, member, { ...request, action: 'read' }, policy, now), 'reverification_required');
  assert.equal(authorizePilotAccess(auth, { ...member, role: 'Compliance reviewer' }, { ...request, action: 'approve_policy' }, policy, now).role, 'Compliance reviewer'); checks++;
  reject(() => authorizePilotAccess(auth, { ...member, role: 'Admin' }, { ...request, action: 'approve_policy' }, policy, now), 'role_not_permitted');
}

{
  const scope: FieldScope = { tenantId: 'tenant_sample', recordId: 'record_sample', field: 'providerToken' };
  const oldKey = randomBytes(32), newKey = randomBytes(32);
  const ring: FieldKeyRing = { activeKeyId: '2026-09', keys: new Map([['2026-09', oldKey], ['2026-10', newKey]]) };
  const plaintext = 'sample only — Ọbi · Adéyẹmí';
  const sealed = encryptField(plaintext, scope, ring);
  assert.equal(decryptField(sealed, scope, ring), plaintext);
  assert.equal(JSON.stringify(sealed).includes(plaintext), false);
  assert.notEqual(encryptField(plaintext, scope, ring).iv, sealed.iv);
  assert.equal(Buffer.from(sealed.iv, 'base64url').byteLength, 12);
  assert.equal(Buffer.from(sealed.tag, 'base64url').byteLength, 16);
  assert.notDeepEqual(oldKey, Buffer.alloc(32), 'internal key cleanup does not erase the caller’s keyring');
  assert.equal(decryptField(encryptField('', scope, ring), scope, ring), '');
  checks += 7;
  const denied = (fn: () => unknown) => { assert.throws(fn, FieldEncryptionError); checks++; };
  for (const changedScope of [{ ...scope, tenantId: 'other' }, { ...scope, recordId: 'other' }, { ...scope, field: 'phone' }]) denied(() => decryptField(sealed, changedScope, ring));
  const flip = (value: string) => { const bytes = Buffer.from(value, 'base64url'); bytes[0] = bytes[0]! ^ 1; return bytes.toString('base64url'); };
  for (const changed of [
    { ...sealed, ciphertext: flip(sealed.ciphertext) }, { ...sealed, tag: flip(sealed.tag) }, { ...sealed, iv: flip(sealed.iv) },
    { ...sealed, tag: sealed.tag.slice(0, -2) }, { ...sealed, iv: '' }, { ...sealed, ciphertext: `${sealed.ciphertext}=` },
    { ...sealed, version: 2 }, { ...sealed, algorithm: 'none' }, { ...sealed, keyId: 'missing' },
  ]) denied(() => decryptField(changed, scope, ring));
  denied(() => decryptField(sealed, scope, { ...ring, keys: new Map([['2026-09', newKey]]) }));
  // Even aliasing the same key under another id fails because the version id is authenticated.
  denied(() => decryptField({ ...sealed, keyId: 'alias' }, scope, { ...ring, keys: new Map([['alias', oldKey]]) }));
  denied(() => decryptField(plaintext, scope, ring));
  denied(() => encryptField(plaintext, { ...scope, tenantId: '' }, ring));
  denied(() => encryptField('x'.repeat(16 * 1024 + 1), scope, ring));
  denied(() => encryptField(plaintext, scope, { activeKeyId: 'short', keys: new Map([['short', randomBytes(16)]]) }));
  for (const malformedId of [undefined, null, 123]) denied(() => encryptField(plaintext, scope, { activeKeyId: malformedId, keys: new Map([[malformedId, oldKey]]) } as never));
  denied(() => encryptField('Unpaired surrogate: \uD800', scope, ring));
  const rotated = rotateField(sealed, scope, { ...ring, activeKeyId: '2026-10' });
  assert.equal(rotated.keyId, '2026-10');
  assert.notEqual(rotated.iv, sealed.iv);
  const activeOnly: FieldKeyRing = { activeKeyId: '2026-10', keys: new Map([['2026-10', newKey]]) };
  assert.equal(decryptField(rotated, scope, activeOnly), plaintext);
  assert.equal(decryptField(sealed, scope, ring), plaintext, 'old records remain readable during rotation');
  checks += 4;
  denied(() => decryptField(sealed, scope, activeOnly));
  const joinedScope = { tenantId: 'a|b', recordId: 'c', field: 'd' };
  denied(() => decryptField(encryptField(plaintext, joinedScope, ring), { tenantId: 'a', recordId: 'b|c', field: 'd' }, ring));
}

// ---- Governance decisions of the 23 September 2026 audit ----
const staffAt = (role: string, user: string, at = '2026-09-18T10:00:00.000Z'): Context => ({ actor: `Clerk:${user}`, principalId: `principal:${user}`, role, now: at, accessMode: 'staff' });
const refusedWith = (fn: () => unknown, status: number, message: RegExp) => { assert.throws(fn, (error: any) => (error.status ?? 400) === status && message.test(error.message)); checks++; };

{
  // Fortnightly reviews (MEA-05): the reviewer is the person recording the review and the time is the service's; neither is typed in.
  const state = seedMerchant('governance-reviews');
  const finance = staffAt('Finance', 'user_finance');
  const review = (data: Record<string, unknown> = {}) => ({ name: 'Fortnightly review', status: 'recorded', data: { confirmedJobs: ['mandates', 'retries', 'reconciliation', 'audit'], note: 'Checked the four tasks.', ...data } as Record<string, unknown> });
  const recorded = review();
  validateRecord(state, finance, 'reviews', recorded);
  assert.deepEqual([recorded.data.reviewer, recorded.data.reviewedAt], ['Clerk:user_finance', '2026-09-18T10:00:00.000Z'], 'the reviewer and the time come from the request, not the form'); checks++;
  const named = review({ reviewer: 'Clerk:user_finance' });
  validateRecord(state, finance, 'reviews', named);
  assert.equal(named.data.reviewer, 'Clerk:user_finance', 'naming oneself is accepted'); checks++;
  refusedWith(() => validateRecord(state, finance, 'reviews', review({ reviewer: 'Someone else' })), 400, /Valo Pay records you as the reviewer\. Leave the reviewer blank\./);
  refusedWith(() => validateRecord(state, finance, 'reviews', review({ reviewedAt: '2026-09-01' })), 400, /Valo Pay records the review time when you save\. Leave the review date blank\./);
  // The business calendar (SCH-04) decides when collections run: only Admin and Operations maintain it.
  const holiday = () => ({ name: 'Public holiday', status: 'active', data: { date: '2027-12-24' } });
  for (const role of ['Finance', 'Compliance reviewer', 'Read-only']) refusedWith(() => validateRecord(state, staffAt(role, 'user_other'), 'calendar', holiday()), 403, /Only an Admin or Operations team member can add or edit calendar days\.|Your role is Read-only, so you can view records but not change them\./);
  for (const role of ['Admin', 'Operations']) { assert.doesNotThrow(() => validateRecord(state, staffAt(role, 'user_calendar'), 'calendar', holiday()), role); checks++; }
}

{
  // export_sensitive (lib/pilot-access.ts) is enforced when an export is queued or retried (and, in the route, downloaded): dispute packs
  // under either name, the customer register and the audit trail are for Admin, Finance and Compliance reviewer only.
  const sensitiveRoles = ['Admin', 'Finance', 'Compliance reviewer'];
  for (const role of pilotRoles) { assert.equal(rolePermits(role, 'export_sensitive'), sensitiveRoles.includes(role), role); checks++; }
  const state = seedMerchant('governance-exports'), customerId = recordsOf(state, 'customers')[0]!.id;
  const request = (kind: string) => ({ kind, format: 'pdf' as const, ...(kind.endsWith('-pack') && kind !== 'gate-pack' ? { customerId } : {}) });
  // Each queued job is marked finished at once, so the lender's queue limit of ten never refuses one here.
  const queue = (ctx: Context, kind: string) => { const job = queueExport(state, ctx, request(kind), '/private-bucket/valopay'); state.records.find(record => record.id === job.id)!.status = 'ready'; return job; };
  for (const kind of ['dispute-pack', 'customer-pack', 'customers', 'audit']) {
    for (const role of ['Operations', 'Read-only']) refusedWith(() => queue(staffAt(role, `user_${role}`), kind), 403, /Only an Admin, Finance or Compliance reviewer can export or download/);
    for (const role of sensitiveRoles) { assert.doesNotThrow(() => queue(staffAt(role, `user_${role.replace(' ', '_')}`), kind), `${role} ${kind}`); checks++; }
    assert.equal(exportPermitted('Read-only', kind), false); checks++;
  }
  // Other exports stay open to every working role.
  for (const kind of ['gate-pack', 'billing', 'closes', 'payments']) { assert.doesNotThrow(() => queue(staffAt('Operations', 'user_operations'), kind), kind); checks++; }
  // A retry regenerates the file, so it is refused the same way; the pack's own record is not touched.
  const pack = recordsOf(state, 'exports').find(record => record.data.kind === 'dispute-pack')!;
  pack.status = 'failed'; pack.data.lastError = 'Synthetic failure.';
  for (const role of ['Operations', 'Read-only']) refusedWith(() => retryExport(state, staffAt(role, `user_${role}`), pack.id), 403, /Only an Admin, Finance or Compliance reviewer/);
  assert.equal(pack.status, 'failed'); checks++;
  assert.equal(retryExport(state, staffAt('Finance', 'user_finance'), pack.id).status, 'queued'); checks++;
}

{
  // The emergency stop (kill_switch): any administrator turns it on at once; in a staff pilot, turning it off is a request that a
  // second, different administrator approves (approve_kill_switch_off), both recorded. The sandbox's one person lifts it at once.
  const state = seedMerchant('governance-stop'), first = staffAt('Admin', 'user_first'), second = staffAt('Admin', 'user_second');
  executeAction(state, first, { action: 'kill_switch', reason: 'Suspected duplicate debit instructions.', data: { enabled: true } });
  assert.equal(state.merchant.killSwitch, true); checks++;
  const requested = executeAction(state, first, { action: 'kill_switch', reason: 'The duplicate instructions were explained.', data: { enabled: false } });
  assert.equal(state.merchant.killSwitch, true, 'turning the stop off waits for a second administrator'); checks++;
  assert.match(requested.message, /stays on until a different Admin approves turning it off\./); assert.equal(requested.data.releaseRequested, true); checks += 2;
  assert.deepEqual(state.settings.emergencyStopReleases?.lender && { by: state.settings.emergencyStopReleases.lender.requestedBy, reason: state.settings.emergencyStopReleases.lender.reason }, { by: 'Clerk:user_first', reason: 'The duplicate instructions were explained.' }); checks++;
  refusedWith(() => executeAction(state, first, { action: 'approve_kill_switch_off', reason: 'Approving my own request.', data: {} }), 403, /A different Admin must approve turning off the emergency stop\./);
  refusedWith(() => executeAction(state, { ...first, principalId: 'principal:another-session' }, { action: 'approve_kill_switch_off', reason: 'The same person again.', data: {} }), 403, /A different Admin must approve turning off the emergency stop\./);
  refusedWith(() => executeAction(state, staffAt('Operations', 'user_operations'), { action: 'approve_kill_switch_off', reason: 'Not an administrator.', data: {} }), 403, /Only an Admin can approve turning off the emergency stop\./);
  const approved = executeAction(state, second, { action: 'approve_kill_switch_off', reason: 'Checked the incident notes with Operations.', data: {} });
  assert.equal(state.merchant.killSwitch, false, 'a second administrator lifts it'); checks++;
  assert.deepEqual([approved.data.requestedBy, approved.data.enabled, state.settings.emergencyStopReleases?.lender], ['Clerk:user_first', false, undefined]); checks++;
  assert.match(String(approved.data.auditNote), /Approved the request by Clerk:user_first/); checks++;
  refusedWith(() => executeAction(state, second, { action: 'approve_kill_switch_off', reason: 'Nothing is waiting.', data: {} }), 409, /No request to turn off/);
  // Turning the stop on again settles a waiting request: the stop stays on and nothing is left to approve.
  executeAction(state, first, { action: 'kill_switch', reason: 'A second incident.', data: { enabled: true } });
  executeAction(state, first, { action: 'kill_switch', reason: 'The second incident is over.', data: { enabled: false } });
  executeAction(state, second, { action: 'kill_switch', reason: 'Keep the stop on until the review.', data: { enabled: true } });
  assert.equal(state.settings.emergencyStopReleases?.lender, undefined); checks++;
  refusedWith(() => executeAction(state, second, { action: 'approve_kill_switch_off', reason: 'Nothing is waiting.', data: {} }), 409, /No request to turn off/);
  // A policy version's stop follows the same rule.
  const policy = recordsOf(state, 'policies')[0]!;
  executeAction(state, first, { action: 'kill_switch', reason: 'Stop this policy version.', data: { enabled: true, policyId: policy.id } });
  executeAction(state, first, { action: 'kill_switch', reason: 'Resume this policy version.', data: { enabled: false, policyId: policy.id } });
  assert.equal(state.settings.policyKillSwitches[policy.id], true); checks++;
  executeAction(state, second, { action: 'approve_kill_switch_off', reason: 'The policy review is complete.', data: { policyId: policy.id } });
  assert.equal(state.settings.policyKillSwitches[policy.id], false); checks++;
  // The anonymous sandbox has one person playing every role: the stop is lifted at once, and the console explains the pilot rule.
  const sandbox = { actor: 'Sandbox Admin', principalId: 'sandbox-principal', role: 'Admin', now: '2026-09-18T10:00:00.000Z' };
  const demo = seedMerchant('governance-stop-sandbox');
  executeAction(demo, sandbox, { action: 'kill_switch', reason: 'Rehearse the stop.', data: { enabled: true } });
  executeAction(demo, sandbox, { action: 'kill_switch', reason: 'Rehearsal over.', data: { enabled: false } });
  assert.equal(demo.merchant.killSwitch, false); checks++;
}

console.log(`Pilot security foundation tests passed (${checks} checks): verified-session context, provisioned membership, role/MFA denial, field binding, tamper refusal and key rotation. No live access enabled.`);
