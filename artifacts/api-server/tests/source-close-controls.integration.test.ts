import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

if (process.env.VALOPAY_RUN_INTEGRATION !== '1') { console.log('Source-close controls require a disposable local PostgreSQL database.'); process.exit(0); }
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL || '').hostname), 'Refuse a non-local integration database.');
const names = ['VALOPAY_STAFF_ACCESS', 'VALOPAY_STAFF_ISSUER', 'VALOPAY_STAFF_ORIGINS', 'VALOPAY_RUNTIME_ISOLATION', 'VALOPAY_PAYLOAD_ENCRYPTION', 'PRIVATE_OBJECT_DIR'] as const;
const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
Object.assign(process.env, { VALOPAY_STAFF_ACCESS: 'staging', VALOPAY_STAFF_ISSUER: 'https://identity.example', VALOPAY_STAFF_ORIGINS: 'https://pilot.example', VALOPAY_RUNTIME_ISOLATION: 'off', VALOPAY_PAYLOAD_ENCRYPTION: 'off', PRIVATE_OBJECT_DIR: '/private/synthetic' });
const { pool } = await import('@workspace/db');
const store = await import('../src/lib/valopay-store');
const { default: router } = await import('../src/routes/index');
const { errorHandler } = await import('../src/lib/error-handler');
const identities = new Map<string, any>();
const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as any).auth = Object.assign(() => identities.get(String(req.header('X-Test-Identity'))) || { userId: null }, { [Symbol.for('@clerk/express.auth')]: true }); (req as any).log = { info() {}, warn() {}, error() {} }; next(); });
app.use('/api', router); app.use(errorHandler);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as any).port}/api`, workspaces: string[] = [];
async function call(path: string, who = 'admin', method = 'GET', body?: unknown, key = randomUUID()) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Test-Identity': who, 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
const ok = (result: { status: number; data: any }) => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
try {
  for (const name of ['003_pilot_workflow.sql', '004_staff_lender_access.sql']) await pool.query(await readFile(new URL(`../../../lib/db/migrations/${name}`, import.meta.url), 'utf8'));
  const org = `org_${randomUUID().replaceAll('-', '')}`, admin = `user_${randomUUID().replaceAll('-', '')}`, finance = `user_${randomUUID().replaceAll('-', '')}`, replacement = `user_${randomUUID().replaceAll('-', '')}`;
  const auth = (userId: string) => ({ userId, orgId: org, sessionId: `sess_${userId}`, tokenType: 'session_token', sessionStatus: 'active', factorVerificationAge: [0, 0], sessionClaims: { sub: userId, sid: `sess_${userId}`, iss: 'https://identity.example', azp: 'https://pilot.example', iat: Math.floor(Date.now() / 1000) - 1, exp: Math.floor(Date.now() / 1000) + 3600 } });
  identities.set('admin', auth(admin)); identities.set('finance', auth(finance)); identities.set('replacement', auth(replacement));
  const workspace = await store.provisionStaffWorkspace(org, admin, 'Source-close controls rehearsal'); workspaces.push(workspace.workspaceId);
  const lender = ok(await call('/v1/pilot/lenders', 'admin', 'POST', { name: 'Synthetic source controls', segment: 'Consumer lending' }));
  const other = ok(await call('/v1/pilot/lenders', 'admin', 'POST', { name: 'Separate lender', segment: 'Consumer lending' }));
  const memberId = randomUUID();
  await pool.query("INSERT INTO valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES($1,$2,$3,'Synthetic Finance reviewer','Finance',now()+interval '30 days')", [memberId, workspace.workspaceId, finance]);
  const member = ok(await call('/v1/team')).members.find((item: any) => item.id === memberId);
  ok(await call(`/v1/team/members/${memberId}/lenders`, 'admin', 'PATCH', { expectedUpdatedAt: member.updatedAt, lenderIds: [lender.id], reason: 'Review the synthetic source correction and close evidence.' }));
  const replacementMemberId = randomUUID();
  await pool.query("INSERT INTO valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES($1,$2,$3,'Replacement Finance reviewer','Finance',now()+interval '30 days')", [replacementMemberId, workspace.workspaceId, replacement]);
  const replacementMember = ok(await call('/v1/team')).members.find((item: any) => item.id === replacementMemberId);
  ok(await call(`/v1/team/members/${replacementMemberId}/lenders`, 'admin', 'PATCH', { expectedUpdatedAt: replacementMember.updatedAt, lenderIds: [lender.id], reason: 'Provide an independent replacement reviewer for unavailable staff.' }));
  const query = `?merchantId=${lender.id}`, businessDate = new Date(Date.now() + 3600000).toISOString().slice(0, 10);
  const source = `controls-${randomUUID()}`;
  const sourceInput = { businessDate, files: [{ source, sourceBatchId: 'customer-file', kind: 'customers', expectedRows: 1, expectedAmountKobo: 0 }], noFilesExpected: false, reason: 'Expected source file from the synthetic lender register.', evidence: 'Synthetic delivery register for this business date.', syntheticOnly: true };
  const manifestKey = randomUUID();
  const manifest = ok(await call(`/v1/sources/manifests${query}`, 'admin', 'POST', sourceInput, manifestKey));
  assert.equal(ok(await call(`/v1/sources/manifests${query}`, 'admin', 'POST', sourceInput, manifestKey)).id, manifest.id, 'Lost-response replay must not append a second manifest.');
  assert.equal((await call(`/v1/sources?merchantId=${other.id}`, 'finance')).status, 404);
  const prepareLatest = async () => {
    ok(await call(`/v1/actions${query}`, 'admin', 'POST', { action: 'daily_close' }));
    const id = ok(await call(`/v1/pilot/close-reviews${query}`)).closes[0].id;
    const item = ok(await call(`/v1/pilot/close-reviews/${id}${query}`)).entry;
    const review = ok(await call(`/v1/pilot/close-reviews/prepare${query}`, 'admin', 'POST', {
      closeId: item.close.id, expectedUpdatedAt: item.close.updatedAt, reviewer: `Clerk:${finance}`,
      preparationNote: 'Compared the original source declaration and all saved evidence.',
      discrepancyResponses: item.issues.map((issue: any) => ({ issueId: issue.id, explanation: 'Finance owns the synthetic source investigation and next-day follow-up.' })),
      unresolvedAcceptance: item.issues.length ? 'Finance owns these source gaps and will inspect the delivery evidence tomorrow.' : '',
    }));
    return { item, review };
  };
  const missing = await prepareLatest();
  assert.equal(missing.item.close.data.reviewBasis.sourceCompleteness.status, 'incomplete');
  const closeDecision = (review: any) => ({ expectedUpdatedAt: review.updatedAt, action: 'approve', note: 'Independently checked the source file coverage and financial close.' });
  assert.equal((await call(`/v1/pilot/close-reviews/${missing.review.id}/decision${query}`, 'finance', 'POST', closeDecision(missing.review))).status, 400, 'A generic approval note must not accept missing source files.');
  const exceptions = missing.review.data.snapshot.data.reviewBasis.sourceCompleteness.issues.map((issue: any) => ({ issueId: issue.id, reason: 'Accept this synthetic missing file for the controlled rehearsal only.', evidence: 'Synthetic delivery register and accountable Finance investigation.' }));
  const acceptedMissing = ok(await call(`/v1/pilot/close-reviews/${missing.review.id}/decision${query}`, 'finance', 'POST', { ...closeDecision(missing.review), sourceExceptions: exceptions }));
  assert.deepEqual(acceptedMissing.data.sourceExceptions, exceptions);
  const originalMissingSnapshot = structuredClone(acceptedMissing.data.snapshot);
  const batchInput = { name: 'Synthetic source customers', source, sourceBatchId: 'customer-file', businessDate, kind: 'customers', csv: 'source_row_id,name,reference,consentProvenance\nrow-1,Synthetic original customer,SOURCE-C-1,Synthetic consent record', mapping: {}, identityColumn: 'source_row_id', amountUnit: 'naira', syntheticOnly: true };
  let batch = ok(await call(`/v1/pilot/batches${query}`, 'admin', 'POST', batchInput));
  batch = ok(await call(`/v1/pilot/batches/${batch.id}/commit${query}`, 'admin', 'POST', { expectedUpdatedAt: batch.updatedAt }));
  assert.equal(batch.status, 'committed');
  assert.equal(ok(await call(`/v1/pilot/close-reviews/${missing.item.close.id}${query}`)).entry.reviews[0].current, false, 'A late source arrival invalidates the current status of the earlier approval.');
  const preservedBatch = (await pool.query('SELECT data FROM valopay_records WHERE id=$1', [batch.id])).rows[0].data;
  const imported = ok(await call(`/v1/records/customers${query}`)).items.find((row: any) => row.reference === 'SOURCE-C-1');
  assert.ok(imported);
  assert.equal((await call(`/v1/records/customers/${imported.id}${query}`, 'admin', 'PATCH', { expectedUpdatedAt: imported.updatedAt, name: 'Bypassed customer change' })).status, 409);
  assert.equal((await call(`/v1/records/customers/${imported.id}${query}`, 'admin', 'PATCH', { expectedUpdatedAt: imported.updatedAt, data: { bankName: 'Unreviewed replacement bank' } })).status, 409);
  assert.equal(ok(await call(`/v1/records/customers${query}`)).items.find((row: any) => row.id === imported.id).data.bankName, imported.data.bankName);
  const previewInput = { batchId: batch.id, targetId: imported.id, expectedUpdatedAt: imported.updatedAt, changes: { name: 'Synthetic corrected customer' }, syntheticOnly: true };
  const preview = ok(await call(`/v1/pilot/import-corrections/preview${query}`, 'admin', 'POST', previewInput));
  assert.equal(preview.blockers.length, 0);
  const proposalKey = randomUUID();
  const proposalInput = { ...previewInput, previewDigest: preview.previewDigest, reviewer: `Clerk:${finance}`, reason: 'The synthetic source register confirms the corrected display name.', evidence: 'Synthetic lender register entry SOURCE-C-1.' };
  const proposal = ok(await call(`/v1/pilot/import-corrections${query}`, 'admin', 'POST', proposalInput, proposalKey));
  assert.equal(ok(await call(`/v1/pilot/import-corrections${query}`, 'admin', 'POST', proposalInput, proposalKey)).id, proposal.id);
  const decisionInput = { proposalDigest: proposal.proposalDigest, action: 'approve', reason: 'Independently compared the saved source and proposed correction.' };
  assert.equal((await call(`/v1/pilot/import-corrections/${proposal.id}/decision${query}`, 'admin', 'POST', decisionInput)).status, 403);
  assert.equal((await call(`/v1/pilot/import-corrections/${proposal.id}/decision?merchantId=${other.id}`, 'admin', 'POST', decisionInput)).status, 404);
  assert.ok(ok(await call(`/v1/work${query}&filter=review`, 'finance')).items.some((item: any) => item.sourceId === proposal.id && item.href.includes(`correction=${proposal.id}`)));
  const recoveryInput = { proposalDigest: proposal.proposalDigest, expectedAssignmentEventId: null, reviewer: `Clerk:${replacement}`, reason: 'The original reviewer is unavailable; assign the same evidence for independent review.' };
  assert.equal((await call(`/v1/pilot/import-corrections/${proposal.id}/recovery${query}`, 'finance', 'POST', recoveryInput)).status, 403);
  assert.equal((await call(`/v1/pilot/import-corrections/${proposal.id}/recovery?merchantId=${other.id}`, 'admin', 'POST', recoveryInput)).status, 404);
  assert.equal((await call(`/v1/pilot/import-corrections/${proposal.id}/recovery${query}`, 'admin', 'POST', { ...recoveryInput, reviewer: `Clerk:${admin}` })).status, 403);
  const recoveryKey = randomUUID();
  const reassigned = ok(await call(`/v1/pilot/import-corrections/${proposal.id}/recovery${query}`, 'admin', 'POST', recoveryInput, recoveryKey));
  assert.equal(reassigned.status, 'awaiting_review');
  assert.equal(reassigned.reviewer, `Clerk:${replacement}`);
  assert.equal(ok(await call(`/v1/pilot/import-corrections/${proposal.id}/recovery${query}`, 'admin', 'POST', recoveryInput, recoveryKey)).assignmentEventId, reassigned.assignmentEventId, 'A lost-response retry appends no second reassignment.');
  assert.equal((await call(`/v1/pilot/import-corrections/${proposal.id}/recovery${query}`, 'admin', 'POST', recoveryInput)).status, 409);
  assert.equal((await call(`/v1/pilot/import-corrections/${proposal.id}/decision${query}`, 'replacement', 'POST', decisionInput)).status, 409, 'An old assignment version cannot approve the newly assigned work.');
  assert.equal((await call(`/v1/pilot/import-corrections/${proposal.id}/decision${query}`, 'finance', 'POST', { ...decisionInput, assignmentEventId: reassigned.assignmentEventId })).status, 403);
  assert.ok(!ok(await call(`/v1/work${query}&filter=review`, 'finance')).items.some((item: any) => item.sourceId === proposal.id));
  assert.ok(ok(await call(`/v1/work${query}&filter=review`, 'replacement')).items.some((item: any) => item.sourceId === proposal.id));
  const assignedDecision = { ...decisionInput, assignmentEventId: reassigned.assignmentEventId };
  const correctionDecisionKey = randomUUID();
  const approved = ok(await call(`/v1/pilot/import-corrections/${proposal.id}/decision${query}`, 'replacement', 'POST', assignedDecision, correctionDecisionKey));
  assert.equal(approved.status, 'approved');
  assert.equal(ok(await call(`/v1/pilot/import-corrections/${proposal.id}/decision${query}`, 'replacement', 'POST', assignedDecision, correctionDecisionKey)).decision.id, approved.decision.id);
  assert.equal((await call(`/v1/pilot/import-corrections/${proposal.id}/decision${query}`, 'finance', 'POST', decisionInput)).status, 409);
  const corrected = ok(await call(`/v1/records/customers${query}`)).items.find((row: any) => row.id === imported.id);
  assert.equal(corrected.name, 'Synthetic corrected customer');
  assert.deepEqual(corrected.data.importIdentity, imported.data.importIdentity);
  const savedProposal = (await pool.query('SELECT data FROM valopay_records WHERE id=$1', [proposal.id])).rows[0].data;
  assert.equal(savedProposal.before.name, 'Synthetic original customer');
  assert.equal(savedProposal.after.name, corrected.name);
  assert.equal(savedProposal.reviewer, `Clerk:${finance}`, 'The original reviewer remains in immutable proposal evidence.');
  assert.equal(Number((await pool.query("SELECT count(*) FROM valopay_records WHERE kind='import-correction-events' AND data->>'proposalId'=$1", [proposal.id])).rows[0].count), 2);
  assert.deepEqual((await pool.query('SELECT data FROM valopay_records WHERE id=$1', [batch.id])).rows[0].data, preservedBatch);
  const complete = await prepareLatest();
  assert.equal(complete.item.close.data.reviewBasis.sourceCompleteness.status, 'complete');
  const completeApproval = ok(await call(`/v1/pilot/close-reviews/${complete.review.id}/decision${query}`, 'finance', 'POST', closeDecision(complete.review)));
  assert.equal(completeApproval.status, 'approved');
  const exportJob = ok(await call(`/v1/exports${query}`, 'finance', 'POST', { kind: 'reviewed-close', format: 'json', closeReviewId: complete.review.id }));
  assert.equal(exportJob.status, 'queued');
  assert.equal(exportJob.kind, 'reviewed-close');
  const revisedManifest = ok(await call(`/v1/sources/manifests${query}`, 'admin', 'POST', { ...sourceInput, files: [{ ...sourceInput.files[0], expectedRows: 2 }], previousManifestId: manifest.id, expectedUpdatedAt: manifest.updatedAt, reason: 'The synthetic lender register confirms a second expected customer row.' }));
  assert.notEqual(revisedManifest.id, manifest.id);
  const staleReview = ok(await call(`/v1/pilot/close-reviews/${complete.item.close.id}${query}`)).entry;
  assert.equal(staleReview.reviews[0].current, false, 'A changed source declaration invalidates an existing approval.');
  assert.equal((await call(`/v1/exports${query}`, 'finance', 'POST', { kind: 'reviewed-close', format: 'json', closeReviewId: complete.review.id })).status, 409);
  const oldReview = (await pool.query('SELECT data FROM valopay_records WHERE id=$1', [missing.review.id])).rows[0].data;
  assert.deepEqual(oldReview.snapshot, originalMissingSnapshot);
  assert.deepEqual(oldReview.sourceExceptions, exceptions);
  const dueBatchInput = { ...batchInput, name: 'Synthetic unpaid instalment', sourceBatchId: 'instalment-file', kind: 'due-items', csv: 'source_row_id,name,reference,customerId,amount,dueDate,owner\ndue-1,Synthetic instalment,SOURCE-D-1,SOURCE-C-1,50000,2028-12-01,lms' };
  let dueBatch = ok(await call(`/v1/pilot/batches${query}`, 'admin', 'POST', dueBatchInput));
  dueBatch = ok(await call(`/v1/pilot/batches/${dueBatch.id}/commit${query}`, 'admin', 'POST', { expectedUpdatedAt: dueBatch.updatedAt }));
  const due = ok(await call(`/v1/records/due-items${query}`)).items.find((row: any) => row.reference === 'SOURCE-D-1');
  assert.equal((await call(`/v1/records/due-items/${due.id}${query}`, 'admin', 'PATCH', { expectedUpdatedAt: due.updatedAt, reference: 'UNREVIEWED-DUE-REF' })).status, 409);
  const dueInput = { batchId: dueBatch.id, targetId: due.id, expectedUpdatedAt: due.updatedAt, changes: { amountKobo: 6000000, dueDate: '2028-12-02' }, syntheticOnly: true };
  const duePreview = ok(await call(`/v1/pilot/import-corrections/preview${query}`, 'admin', 'POST', dueInput));
  assert.equal(duePreview.financial, true); assert.deepEqual(duePreview.blockers, []);
  assert.ok(duePreview.affected.some((row: any) => row.id === complete.item.close.id));
  const dueProposal = ok(await call(`/v1/pilot/import-corrections${query}`, 'admin', 'POST', { ...dueInput, previewDigest: duePreview.previewDigest, reviewer: `Clerk:${finance}`, reason: 'The synthetic source owner supplied a corrected instalment schedule.', evidence: 'Synthetic corrected schedule reference SOURCE-D-1.' }));
  ok(await call(`/v1/pilot/import-corrections/${dueProposal.id}/decision${query}`, 'finance', 'POST', { proposalDigest: dueProposal.proposalDigest, action: 'approve', reason: 'Independently compared amount and due date to the revised source schedule.' }));
  const amendedDue = ok(await call(`/v1/records/due-items${query}`)).items.find((row: any) => row.id === due.id);
  assert.equal(amendedDue.amountKobo, 6000000); assert.equal(amendedDue.data.outstandingKobo, 6000000);
  assert.equal(amendedDue.reference, 'SOURCE-D-1'); assert.equal(amendedDue.data.dueDate, '2028-12-02');
  assert.deepEqual(amendedDue.data.importIdentity, due.data.importIdentity);
  const pendingClose = await prepareLatest(), originalReview = structuredClone(pendingClose.review);
  const reassignInput = { expectedUpdatedAt: pendingClose.review.updatedAt, reviewer: `Clerk:${replacement}`, reason: 'The original reviewer is unavailable; another Finance colleague will inspect the same evidence.' };
  assert.equal((await call(`/v1/pilot/close-reviews/${pendingClose.review.id}/reassign${query}`, 'finance', 'POST', reassignInput)).status, 403);
  assert.equal((await call(`/v1/pilot/close-reviews/${pendingClose.review.id}/reassign?merchantId=${other.id}`, 'admin', 'POST', reassignInput)).status, 404);
  assert.equal((await call(`/v1/pilot/close-reviews/${pendingClose.review.id}/reassign${query}`, 'admin', 'POST', { ...reassignInput, reviewer: `Clerk:${admin}` })).status, 403);
  const reassignmentKey = randomUUID(), reassignedClose = ok(await call(`/v1/pilot/close-reviews/${pendingClose.review.id}/reassign${query}`, 'admin', 'POST', reassignInput, reassignmentKey));
  assert.equal(reassignedClose.status, 'awaiting_review');
  assert.deepEqual(reassignedClose.data.snapshot, originalReview.data.snapshot);
  assert.equal(reassignedClose.data.snapshotDigest, originalReview.data.snapshotDigest);
  assert.equal(reassignedClose.data.preparedBy, originalReview.data.preparedBy);
  assert.deepEqual(ok(await call(`/v1/pilot/close-reviews/${pendingClose.review.id}/reassign${query}`, 'admin', 'POST', reassignInput, reassignmentKey)), reassignedClose, 'A retry returns the same reassignment receipt.');
  assert.equal((await call(`/v1/pilot/close-reviews/${pendingClose.review.id}/reassign${query}`, 'admin', 'POST', { ...reassignInput, reviewer: `Clerk:${finance}` })).status, 409, 'An old assignment version cannot replace the current assignee.');
  assert.equal((await call(`/v1/pilot/close-reviews/${pendingClose.review.id}/decision${query}`, 'finance', 'POST', { ...closeDecision(reassignedClose), action: 'return' })).status, 403, 'The earlier reviewer immediately loses decision authority.');
  const assignmentHistory = ok(await call(`/v1/pilot/close-reviews/${pendingClose.item.close.id}${query}`)).events.filter((event: any) => event.data.action === 'reassign');
  assert.equal(assignmentHistory.length, 1); assert.equal(assignmentHistory[0].data.previousReviewer, `Clerk:${finance}`);
  // Populate additional dated snapshots without changing the target's original evidence.
  // The target now falls outside both the first page and loadState's full-report week.
  for (let index = 1; index <= 30; index++) {
    const at = new Date(Date.now() + index * 86_400_000).toISOString(), data = structuredClone(pendingClose.item.close.data);
    data.reviewBasis.sourceCompleteness.businessDate = at.slice(0, 10);
    data.summary = `Synthetic history fixture ${index}`;
    await pool.query("INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at) VALUES($1,$2,'closes',$3,'completed',$4,0,'',$5,$6,$6)", [randomUUID(), lender.id, `Historical paging ${index}`, `HISTORY-${index}`, data, at]);
  }
  const firstPage = ok(await call(`/v1/pilot/close-reviews${query}`));
  assert.equal(firstPage.closes.length, 25);
  assert.equal(firstPage.closes.some((item: any) => item.id === pendingClose.item.close.id), false);
  const nextPage = ok(await call(`/v1/pilot/close-reviews${query}&offset=25`));
  assert.equal(nextPage.closes.some((item: any) => item.id === pendingClose.item.close.id), true);
  const olderDetail = ok(await call(`/v1/pilot/close-reviews/${pendingClose.item.close.id}${query}`, 'replacement'));
  assert.deepEqual(olderDetail.entry.close.data.report, originalReview.data.snapshot.data.report, 'The direct historical route fetches the complete saved report.');
  assert.equal(olderDetail.entry.reviews[0].current, true, 'Newer closes for other business dates do not invalidate this unchanged date.');
  assert.equal((await call(`/v1/pilot/close-reviews/${pendingClose.item.close.id}?merchantId=${other.id}`)).status, 404);
  const replacementDecision = { ...closeDecision(reassignedClose), sourceExceptions: reassignedClose.data.snapshot.data.reviewBasis.sourceCompleteness.issues.map((issue: any) => ({ issueId: issue.id, reason: 'Independent acceptance within the synthetic historical-access rehearsal.', evidence: 'Historical access and reassignment rehearsal evidence.' })) };
  const reviewedHistorical = ok(await call(`/v1/pilot/close-reviews/${pendingClose.review.id}/decision${query}`, 'replacement', 'POST', replacementDecision));
  assert.equal(reviewedHistorical.status, 'approved', 'A legitimate older business-date close loads its whole evidence for the decision.');
  assert.deepEqual(reviewedHistorical.data.snapshot, originalReview.data.snapshot);
  assert.equal((await call(`/v1/pilot/close-reviews/${pendingClose.review.id}/reassign${query}`, 'admin', 'POST', { ...reassignInput, expectedUpdatedAt: reviewedHistorical.updatedAt, reviewer: `Clerk:${finance}` })).status, 409, 'Completed decisions cannot be reassigned.');
  assert.equal(ok(await call(`/v1/actions${query}`, 'admin', 'POST', { action: 'verify_audit' })).data.valid, true);
  console.log('Source-close controls: dated manifest replay, lender isolation, independent correction approval, durable replay and retained source provenance passed.');
} finally {
  server.close(); await once(server, 'close');
  for (const id of workspaces) {
    for (const table of ['valopay_staff_events', 'valopay_staff_invitations', 'valopay_staff_memberships', 'valopay_teams']) await pool.query(`DELETE FROM ${table} WHERE workspace_id=$1`, [id]);
    for (const table of ['valopay_operations', 'valopay_idempotency', 'valopay_records']) await pool.query(`DELETE FROM ${table} WHERE merchant_id IN(SELECT id FROM valopay_merchants WHERE workspace_id=$1)`, [id]);
    await pool.query('DELETE FROM valopay_merchants WHERE workspace_id=$1', [id]); await pool.query('DELETE FROM valopay_workspaces WHERE id=$1', [id]);
  }
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await pool.end();
}
