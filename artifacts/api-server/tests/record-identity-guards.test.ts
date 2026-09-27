// Defensive regression coverage for generic-write and provider/customer identity boundaries.
import assert from 'node:assert/strict';
import { observationEventKey, providerConnectionKey } from '@workspace/valopay-schema';
import { seedMerchant } from '../src/lib/valopay-seed';
import { validateRecord } from '../src/domain/validation';
import { mergeData } from '../src/lib/edit-versions';
import { importCsv } from '../src/lib/valopay-import';
import { executeAction } from '../src/domain/actions';
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
const { assertFinalState } = await import('../src/lib/valopay-store');
const now = '2026-09-26T10:00:00.000Z';
const operations = { actor: 'Operations reviewer', role: 'Operations', now };
const admin = { ...operations, actor: 'Administrator', role: 'Admin' };
const compliance = { ...operations, actor: 'Compliance reviewer', role: 'Compliance reviewer' };
let checks = 0;
const refused = (run: () => unknown, pattern: RegExp) => { assert.throws(run, pattern); checks++; };

{
 const state = seedMerchant('decision-guards');
 const exception = state.records.find(record => record.kind === 'exceptions')!;
 // Legitimate operational editing of an open case remains available.
 const open = { ...exception, data: { ...exception.data, notes: 'Contact the provider for supporting evidence.' } };
 assert.doesNotThrow(() => validateRecord(state, operations, 'exceptions', open, true)); checks++;
 refused(() => validateRecord(state, compliance, 'exceptions', open, true), /not permitted/);
 for (const field of ['resolutionCode', 'resolvedBy', 'resolvedAt', 'resolutionRuleVersion', 'conditionCleared', 'confirmedFailureCode', 'confirmedProviderIdentity', 'legacyResolutionReview', 'legacyIdentityReview']) {
   const values: Record<string, unknown> = { resolvedAt: now, resolutionRuleVersion: 1, conditionCleared: { at: now, by: operations.actor, reason: 'Recorded' }, legacyResolutionReview: { priorExceptionId: 'prior' } };
   const candidate = { ...exception, data: { ...exception.data, [field]: values[field] ?? 'recorded' } };
   refused(() => validateRecord(state, operations, 'exceptions', candidate, true), /dedicated resolution workflow/);
 }
 // A decision recorded through its action remains attributable and immutable.
 executeAction(state, admin, { action: 'resolve_exception', recordId: exception.id, reason: 'Recorded after reviewing supporting evidence.', data: { resolutionCode: exception.data.type === 'unallocated_payment' ? 'held_credit' : 'observation_only' } });
 const before = structuredClone(state);
 const closing = { ...exception, status: 'closed', data: { ...exception.data } };
 assert.doesNotThrow(() => validateRecord(state, operations, 'exceptions', closing, true)); checks++;
 for (const [field, value] of Object.entries({ resolutionCode: 'not_ours', resolvedBy: 'Someone else', resolvedAt: '2026-09-25T10:00:00Z', resolutionRuleVersion: null, notes: null, condition: 'different', linkedRecordId: null, type: 'unknown_outcome' })) {
   const candidate = { ...exception, data: mergeData(exception.data, { [field]: value }) };
   refused(() => validateRecord(state, operations, 'exceptions', candidate, true), /completed exception decision/);
   const after = structuredClone(before);
   Object.assign(after.records.find(record => record.id === exception.id)!, candidate);
   refused(() => assertFinalState(before, after, state.merchant.id, now), /completed exception decision/);
 }
 assert.doesNotThrow(() => assertFinalState(before, structuredClone(before), state.merchant.id, now)); checks++;
 const due = state.records.find(record => record.kind === 'due-items')!;
 refused(() => validateRecord(state, operations, 'due-items', { ...due, data: { ...due.data, legacyReversalReviewIds: ['review-a'] } }, true), /recorded by reconciliation/);
 // The status a hold paused is what reconciliation gives back: an edit may not write it.
 refused(() => validateRecord(state, operations, 'due-items', { ...due, data: { ...due.data, legacyReversalReviewPause: { status: 'paid', pausedAt: now } } }, true), /recorded by reconciliation/);
 const observation = state.records.find(record => record.kind === 'observations')!;
 refused(() => validateRecord(state, operations, 'observations', { ...observation, data: { ...observation.data, legacyReversalReviewAppliedId: 'review-a' } }), /recorded by reconciliation/);
}
{
 for (const mode of ['reversal', 'settlement'] as const) {
   const state = seedMerchant(`open-review-subject-${mode}`);
   const exception = state.records.find(record => record.kind === 'exceptions')!;
   const observation = state.records.find(record => record.kind === 'observations')!;
   const linked = mode === 'reversal' ? observation : { ...structuredClone(observation), id: 'held-settlement', kind: 'settlement-batches', status: 'variance', data: { providerIdentityReview: { detectedAt: now, identities: ['provider a', 'provider b'], observationIds: [] } } };
   if (mode === 'settlement') state.records.push(linked);
   Object.assign(exception.data, { type: mode === 'reversal' ? 'provider_status_mismatch' : 'settlement_variance', linkedRecordId: linked.id, condition: `${mode}:${linked.id}:review` });
   if (mode === 'reversal') exception.data.legacyResolutionReview = { priorExceptionId: 'earlier-decision' };
   for (const [field, value] of Object.entries({ type: 'unknown_outcome', condition: 'different', linkedRecordId: null, linkedKind: 'customers', amountKobo: exception.amountKobo + 1, customerId: '' })) {
     const candidate = ['amountKobo', 'customerId'].includes(field) ? { ...exception, [field]: value } : { ...exception, data: mergeData(exception.data, { [field]: value }) };
     refused(() => validateRecord(state, operations, 'exceptions', candidate, true), /subject of a historical evidence review/);
     const after = structuredClone(state); Object.assign(after.records.find(record => record.id === exception.id)!, candidate);
     refused(() => assertFinalState(state, after, state.merchant.id, now), /subject of a historical evidence review/);
   }
   const coordinated = { ...exception, data: { ...exception.data, notes: 'Finance is obtaining the original provider evidence.', owner: 'Finance' } };
   assert.doesNotThrow(() => validateRecord(state, operations, 'exceptions', coordinated, true)); checks++;
 }
}
{
 const state = seedMerchant('batch-identity-guards');
 const batch = { ...structuredClone(state.records[0]!), id: 'reviewed-batch', kind: 'settlement-batches', status: 'pending', reference: 'BATCH-A', customerId: '', amountKobo: 0,
   data: { provider: 'Provider A', providerConnection: 'Provider A', providerIdentityKey: '["provider a","BATCH-A"]', batchReference: 'BATCH-A', grossKobo: 0, feeKobo: 0, netKobo: 0, currency: 'NGN', providerIdentityReview: { detectedAt: now, identities: ['provider a'], observationIds: [] } } };
 state.records.push(batch);
 for (const field of ['provider', 'providerConnection', 'providerIdentityKey', 'providerIdentityReview', 'batchReference']) {
   const candidate = { ...batch, data: mergeData(batch.data, { [field]: field === 'providerIdentityReview' ? null : 'changed' }) };
   refused(() => validateRecord(state, admin, 'settlement-batches', candidate, true), /reconciliation|provider lines/);
   const after = structuredClone(state); Object.assign(after.records.find(record => record.id === batch.id)!, candidate);
   refused(() => assertFinalState(state, after, state.merchant.id, now), /settlement provider/);
 }
 const renamed = { ...batch, reference: 'OTHER-BATCH' };
 refused(() => validateRecord(state, admin, 'settlement-batches', renamed, true), /reference cannot be changed/);
 // Only reconciliation releases a held batch: an edit that wrote the release would lift a genuine hold.
 const released = { ...batch, data: mergeData(batch.data, { providerIdentityRelease: { releasedAt: now, identity: '["provider a","BATCH-A"]', heldLineIds: [] } }) };
 refused(() => validateRecord(state, admin, 'settlement-batches', released, true), /providerIdentityRelease is recorded by reconciliation/);
 // Nor may an edit write the history of earlier releases, or which other batch claims a held batch's identity.
 for (const [field, value] of Object.entries({ providerIdentityHistory: [], providerIdentityClaimedBy: [{ identity: '["provider a","BATCH-A"]', batchId: 'other', reference: 'BATCH-A', handEntered: true }] })) {
   refused(() => validateRecord(state, admin, 'settlement-batches', { ...batch, data: mergeData(batch.data, { [field]: value }) }, true), new RegExp(`${field} is recorded by reconciliation`));
 }
}
{
 const state = seedMerchant('customer-guards'), customers = state.records.filter(record => record.kind === 'customers');
 const candidate = { ...customers[1]!, reference: customers[0]!.reference, data: { ...customers[1]!.data } };
 refused(() => validateRecord(state, operations, 'customers', candidate, true), /customer reference is already used/);
 const after = structuredClone(state); after.records.find(record => record.id === candidate.id)!.reference = candidate.reference;
 refused(() => assertFinalState(state, after, state.merchant.id, now), /Customer references must be unique/);
 // Legacy ambiguous references never silently choose whichever customer happens to occur first.
 state.records.find(record => record.id === candidate.id)!.reference = candidate.reference;
 const result = importCsv(state, operations, { kind: 'due-items', csv: `row_id,reference,customerId,amountKobo,dueDate,owner\nr1,NEW-DUE,${candidate.reference},1000000,2026-10-01,lms`, syntheticOnly: true, commit: true, identityColumn: 'row_id', amountUnit: 'kobo' });
 assert.equal(result.imported, 0); assert.match(result.rows[0]!.detail ?? result.rows[0]!.message, /more than one customer/); checks++;
}
{
 const state = seedMerchant('event-guards');
 const row = (provider: string, id: string, source = 'webhook', event = 'evt-shared') => importCsv(state, operations, {
   kind: 'observations', csv: `row_id,reference,amountKobo,source,eventId,providerConnection\n${id},REF-${id},1000000,${source},${event},${provider}`,
   syntheticOnly: true, commit: true, identityColumn: 'row_id', amountUnit: 'kobo',
 });
 assert.equal(row('Provider A', 'a').imported, 1); checks++;
 assert.equal(row('Provider B', 'b').imported, 1); checks++;
 assert.equal(row('provider a', 'same').imported, 0); checks++;
 assert.equal(row('Provider A', 'settlement', 'settlement').imported, 1); checks++;
 assert.equal(row('x'.repeat(201), 'oversized').imported, 0); checks++;
 const a = state.records.find(record => record.reference === 'REF-a')!;
 assert.equal(observationEventKey(a.data), observationEventKey({ ...a.data, providerConnection: ' PROVIDER A ' })); checks++;
 assert.notEqual(observationEventKey({ ...a.data, eventId: undefined }), observationEventKey({ ...a.data, eventId: 'undefined' })); checks++;
 const after = structuredClone(state);
 after.records.push({ ...structuredClone(a), id: 'duplicate-delivery', reference: 'NEW-REF', data: { ...a.data, providerConnection: ' PROVIDER A ' } });
 refused(() => assertFinalState(state, after, state.merchant.id, now), /Observation already exists/);
 assert.doesNotThrow(() => assertFinalState(state, structuredClone(state), state.merchant.id, now)); checks++;
 assert.equal(providerConnectionKey(' Provider A '), 'provider a'); checks++;
 assert.equal(providerConnectionKey('İ'), 'İ', 'normalisation is independent of PostgreSQL locale'); checks++;
}
{
 // Reconciliation alone links payment evidence to a settlement batch, or marks where a line is counted: the record API and
 // an import refuse these links, as they refuse a payment or a resolution.
 const state = seedMerchant('evidence-links');
 const evidence = { name: 'Settlement line', status: 'unresolved', reference: 'PSK-LINK', amountKobo: 1_000_000, customerId: '', data: { source: 'settlement', eventId: 'link-1', batchReference: 'B-1', provider: 'Provider A' } };
 for (const [field, value] of Object.entries({ settlementBatchId: 'batch-a', resolvedTo: 'batch:batch-a', countedInBatchId: 'batch-a', duplicateSettlementLine: true, otherCurrencyLine: true })) {
   refused(() => validateRecord(state, operations, 'observations', { ...structuredClone(evidence), data: { ...evidence.data, [field]: value } }), /Valo Pay links payment evidence to its settlement batch/);
 }
 assert.doesNotThrow(() => validateRecord(state, operations, 'observations', structuredClone(evidence))); checks++;
 const imported = importCsv(state, operations, { kind: 'observations', csv: 'row_id,reference,amountKobo,source,eventId,settlementBatchId\nl1,PSK-LINK-2,1000000,settlement,link-2,batch-a', syntheticOnly: true, commit: true, identityColumn: 'row_id', amountUnit: 'kobo' });
 assert.equal(imported.imported, 0); checks++;
 assert.match(JSON.stringify(imported.rows[0]), /links payment evidence to its settlement batch/); checks++;
}
console.log(`Record identity and decision guards passed (${checks} checks).`);
