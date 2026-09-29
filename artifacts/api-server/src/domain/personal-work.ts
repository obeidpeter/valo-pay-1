import { personalWorkQuerySchema, personalWorkViewSchema, workReceiptInputSchema, workReceiptSchema, type PersonalWorkItem, type PersonalWorkQuery, type WorkReceiptInput } from '@workspace/valopay-schema';
import type { Context, DomainState, ValopayRecord } from './types';
import { makeRecord } from './records';
import { closeReviewBasisOnce, reviewIsCurrent } from './close-review';
import { canonicalDigest } from '../lib/digests';
import { contractAnswer } from '../lib/contract';
import { importCorrectionAssignment, importCorrectionView } from './import-corrections';

export type WorkAssignee = { actor: string; name: string; role: string };
const workRoles = ['Admin', 'Operations', 'Finance', 'Compliance reviewer'];
const DAY = 24 * 60 * 60 * 1000;
const rule = 'Follow-ups are overdue at their saved due time. Follow-ups, unacknowledged handovers and pending reviews are escalated in this lender’s administrator workload after 24 hours. Escalation is an in-app flag; it does not send a message or change financial records.';
function refuse(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }
// A receipt stores the source digest it acknowledged and a repeated receipt is found by it: its first form.
function digest(value: unknown): string { return canonicalDigest(value, 'legacy-en-us-replacer'); }
function instant(value: unknown): string | null { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
function eligible(ctx: Context, people: WorkAssignee[]) { return workRoles.includes(ctx.role) && people.some(person => person.actor === ctx.actor && workRoles.includes(person.role)); }
function localRecords(state: DomainState) { return state.records.filter(record => record.merchantId === state.merchant.id); }
function caseAssignment(records: ValopayRecord[], record: ValopayRecord): { event?: ValopayRecord; ambiguous: boolean } {
  const assignment = record.data.case;
  const events = records.filter(event => event.kind === 'case-events' && event.data.exceptionId === record.id && ['claim', 'handover'].includes(event.data.action));
  if (assignment.handoverEventId) return { event: events.find(event => event.id === assignment.handoverEventId && event.data.after?.assignee === assignment.assignee), ambiguous: !events.some(event => event.id === assignment.handoverEventId && event.data.after?.assignee === assignment.assignee) };
  const matching = events.filter(event => event.data.after?.assignee === assignment.assignee).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!matching[0]) return { ambiguous: false };
  if (matching[1]?.createdAt === matching[0].createdAt) return { ambiguous: true };
  // An assignment to somebody else after the candidate means the legacy history cannot establish the current handover.
  if (events.some(event => event.createdAt > matching[0]!.createdAt)) return { ambiguous: true };
  return { event: matching[0], ambiguous: false };
}
function receiptView(record: ValopayRecord, duplicate: boolean) {
  // The answer is checked like any other: a mismatch is the service's 500 (response.invalid), never the request's 400.
  return contractAnswer(workReceiptSchema, { id: record.id, merchantId: record.merchantId, action: record.data.action, sourceId: record.data.sourceId, eventId: record.data.eventId, actor: record.data.actor, at: record.createdAt, duplicate, syntheticOnly: true, financialStatusChanged: false });
}

/** Pure read model: saved assignment/review records are the source of truth, never notification delivery state. A
 * receipt derives only its own source's item (`sourceId`). */
export function personalWorkItems(state: DomainState, ctx: Context, people: WorkAssignee[], sourceId?: string): PersonalWorkItem[] {
  const records = localRecords(state), now = Date.parse(ctx.now), events = records.filter(record => record.kind === 'work-events');
  // The reviews are checked against one input digest, computed at most once for this read.
  const reviewState = { ...state, records }, basis = closeReviewBasisOnce(reviewState);
  // A decided correction leaves the queue before it is compared again.
  const decided = new Set(records.filter(record => record.kind === 'import-correction-events' && ['approve', 'reject', 'withdraw'].includes(record.data.action)).map(record => record.data.proposalId));
  const name = (actor: string, fallback?: string) => people.find(person => person.actor === actor)?.name || fallback || 'Former or unavailable staff member';
  const result: PersonalWorkItem[] = [];
  for (const record of records) {
    if (sourceId !== undefined && record.id !== sourceId) continue;
    if (record.kind === 'exceptions' && !['resolved', 'closed'].includes(record.status) && typeof record.data.case?.assignee === 'string' && record.data.case.assignee) {
      const assignment = record.data.case, { event, ambiguous } = caseAssignment(records, record);
      const acknowledged = event && events.some(saved => saved.data.action === 'acknowledge' && saved.data.sourceId === record.id && saved.data.assignmentEventId === event.id && saved.data.actor === assignment.assignee);
      const handover = event?.data.action === 'handover' && !acknowledged;
      const dueAt = instant(assignment.nextActionAt), overdue = !!dueAt && Date.parse(dueAt) <= now;
      const handoverLate = !!handover && now - Date.parse(event!.createdAt) >= DAY;
      const followupLate = !!dueAt && now - Date.parse(dueAt) >= DAY;
      const escalated = handoverLate || followupLate;
      const phase = escalated ? 'escalated' : overdue ? 'overdue' : 'assigned';
      const sourceEvent = event?.id || assignment.eventId || record.updatedAt;
      const eventId = `case:${record.id}:${sourceEvent}:${handover ? 'handover' : 'followup'}:${phase}`;
      result.push({ id: `case:${record.id}`, eventId, sourceId: record.id, sourceVersion: record.updatedAt,
        sourceDigest: digest({ merchantId: state.merchant.id, id: record.id, updatedAt: record.updatedAt, status: record.status, assignment, assignmentEventId: event?.id || null }),
        type: handover ? 'handover' : 'case', title: record.name || 'Assigned case', nextAction: String(assignment.nextAction || 'Open the case and record the next action.'), assignee: assignment.assignee, assigneeName: name(assignment.assignee, assignment.assigneeName), dueAt, overdue, escalated,
        escalationReason: handoverLate ? 'Handover has waited at least 24 hours for acknowledgement.' : followupLate ? 'The saved follow-up is at least 24 hours overdue.' : null,
        reviewCurrent: null, href: `/cases/${encodeURIComponent(record.id)}`, readAt: events.find(saved => saved.data.action === 'read' && saved.data.eventId === eventId && saved.data.actor === assignment.assignee)?.createdAt || null,
        canAcknowledge: Boolean(handover && assignment.assignee === ctx.actor && eligible(ctx, people)), assignmentEventId: event?.id || null,
        notice: ambiguous ? 'This older assignment has ambiguous history. Ask the case owner or administrator to record a fresh handover before acknowledging it.' : !people.some(person => person.actor === assignment.assignee) ? 'The assigned staff member is no longer available. An administrator should arrange a handover.' : null,
      });
    }
    if (record.kind === 'close-reviews' && record.status === 'awaiting_review' && typeof record.data.reviewer === 'string' && record.data.reviewer) {
      const current = reviewIsCurrent(reviewState, record, basis), dueAt = instant(record.data.preparedAt) || record.createdAt;
      const principal = (ctx as Context & { principalId?: string }).principalId || (ctx.actor.startsWith('Sandbox ') ? 'unidentified-demo-person' : ctx.actor);
      const samePerson = record.data.reviewer === ctx.actor && (record.data.preparedBy === ctx.actor || record.data.preparedPrincipal === principal);
      const escalated = now - Date.parse(dueAt) >= DAY;
      const eventId = `review:${record.id}:${record.updatedAt}:${current ? 'current' : 'stale'}:${escalated ? 'escalated' : 'pending'}`;
      result.push({ id: `review:${record.id}`, eventId, sourceId: record.id, sourceVersion: record.updatedAt, sourceDigest: digest({ merchantId: state.merchant.id, id: record.id, updatedAt: record.updatedAt, status: record.status, data: record.data, current }), type: 'review', title: 'Daily close awaiting review', nextAction: samePerson ? 'A different person must review this close. Open the review to inspect its assignment.' : current ? 'Open the close, inspect the evidence and record your decision.' : 'The close evidence has changed. Open the review to see what must be prepared again.', assignee: record.data.reviewer, assigneeName: name(record.data.reviewer), dueAt: null, overdue: false, escalated, escalationReason: escalated ? 'This review has waited at least 24 hours for a decision.' : null, reviewCurrent: current, href: `/close-review?close=${encodeURIComponent(String(record.data.closeId))}`, readAt: events.find(saved => saved.data.action === 'read' && saved.data.eventId === eventId && saved.data.actor === record.data.reviewer)?.createdAt || null, canAcknowledge: false, assignmentEventId: null, notice: samePerson ? 'Changing demo roles is not independent review. The preparer cannot approve their own work.' : current ? null : 'A fresh close and review are required; this reminder does not approve the old evidence.' });
    }
    if (record.kind === 'import-corrections' && !decided.has(record.id)) {
      const proposal = importCorrectionView(reviewState, ctx, record);
      const assignment = importCorrectionAssignment(reviewState, record), current = proposal.current;
      const targetLabel = records.find(source => source.id === proposal.preview.targetId)?.name || record.data.before?.name || `Source row ${proposal.preview.rowId}`;
      const samePerson = assignment.reviewer === ctx.actor && (proposal.proposedBy === ctx.actor || proposal.proposedPrincipal === (ctx.principalId || ctx.actor));
      const unavailable = !people.some(person => person.actor === assignment.reviewer && person.role === 'Finance');
      const escalated = unavailable || now - Date.parse(record.createdAt) >= DAY;
      const eventId = `correction:${record.id}:${assignment.eventId || 'original'}:${current ? 'current' : 'stale'}:${escalated ? 'escalated' : 'pending'}`;
      result.push({ id: `correction:${record.id}`, eventId, sourceId: record.id, sourceVersion: assignment.updatedAt,
        sourceDigest: digest({ merchantId: state.merchant.id, id: record.id, proposalDigest: proposal.proposalDigest, assignment, current, unavailable }),
        type: 'correction', title: 'Import correction awaiting review', nextAction: `${targetLabel}. ${unavailable ? 'Ask an administrator to assign an active independent Finance reviewer.' : samePerson ? 'A different person must review this correction.' : current ? 'Compare the imported value with the proposed correction and its evidence, then record your decision.' : 'The source or related evidence changed. Reject or withdraw this proposal, then prepare a fresh comparison.'}`,
        assignee: assignment.reviewer, assigneeName: name(assignment.reviewer), waitingSince: record.createdAt, dueAt: null, overdue: false, escalated,
        escalationReason: unavailable ? 'The assigned Finance reviewer is no longer available in this lender.' : escalated ? 'This correction has waited at least 24 hours for a decision.' : null,
        reviewCurrent: current, href: `/imports?batch=${encodeURIComponent(proposal.preview.batchId)}&correction=${encodeURIComponent(record.id)}`,
        readAt: events.find(saved => saved.data.action === 'read' && saved.data.eventId === eventId && saved.data.actor === assignment.reviewer)?.createdAt || null,
        canAcknowledge: false, assignmentEventId: assignment.eventId,
        notice: samePerson ? 'Changing demo roles is not independent review. The proposer cannot approve their own correction.' : proposal.preview.financial ? 'This pending instalment correction blocks Finance preparation, approval and evidence export for the daily close.' : null,
      });
    }
  }
  return result.sort((a, b) => Number(b.escalated) - Number(a.escalated) || Number(b.overdue) - Number(a.overdue) || Number(b.type === 'handover') - Number(a.type === 'handover') || (a.dueAt || '9999').localeCompare(b.dueAt || '9999') || a.id.localeCompare(b.id));
}

export function derivePersonalWork(state: DomainState, ctx: Context, people: WorkAssignee[], input: Partial<PersonalWorkQuery> = {}) {
  const q = personalWorkQuerySchema.parse({ merchantId: state.merchant.id, ...input });
  if (q.merchantId !== state.merchant.id) refuse('This work queue belongs to another lender.', 403);
  if (q.scope === 'team' && ctx.role !== 'Admin') refuse('Only an administrator can view this lender’s team workload.', 403);
  const canWork = eligible(ctx, people);
  const all = personalWorkItems(state, ctx, people).filter(item => q.scope === 'team' || item.assignee === ctx.actor);
  const counts = { all: all.length, overdue: all.filter(item => item.overdue).length, handover: all.filter(item => item.type === 'handover').length, review: all.filter(item => ['review', 'correction'].includes(item.type)).length, unread: all.filter(item => !item.readAt).length, escalated: all.filter(item => item.escalated).length };
  const matches = all.filter(item => q.filter === 'all' || q.filter === 'overdue' && item.overdue || q.filter === 'handover' && item.type === 'handover' || q.filter === 'review' && ['review', 'correction'].includes(item.type) || q.filter === 'unread' && !item.readAt);
  const workload = q.scope === 'team' ? [...new Set(all.map(item => item.assignee))].sort().slice(0, 100).map(actor => {
    const items = all.filter(item => item.assignee === actor);
    return { actor, name: items[0]!.assigneeName, total: items.length, overdue: items.filter(item => item.overdue).length, handovers: items.filter(item => item.type === 'handover').length, reviews: items.filter(item => ['review', 'correction'].includes(item.type)).length, escalated: items.filter(item => item.escalated).length };
  }) : [];
  const history = localRecords(state).filter(record => record.kind === 'work-events' && record.data.actor === ctx.actor && ['read', 'acknowledge'].includes(record.data.action)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 10).map(record => ({ id: record.id, action: record.data.action, sourceId: record.data.sourceId, summary: String(record.data.summary), at: record.createdAt, href: String(record.data.href) }));
  return contractAnswer(personalWorkViewSchema, { merchantId: state.merchant.id, lenderName: state.merchant.name, actor: ctx.actor, role: ctx.role, asOf: ctx.now, syntheticOnly: true, canViewTeam: ctx.role === 'Admin', canWork, scope: q.scope, filter: q.filter, items: matches.slice(q.offset, q.offset + q.limit), total: matches.length, offset: q.offset, limit: q.limit, counts, workload, workloadTotal: q.scope === 'team' ? new Set(all.map(item => item.assignee)).size : 0, history, escalationRule: rule });
}

/** Append a recipient-owned read/ack receipt. No case, allocation, review decision or financial status is changed. */
export function recordWorkReceipt(state: DomainState, ctx: Context, people: WorkAssignee[], action: 'read' | 'acknowledge', raw: WorkReceiptInput) {
  const input = workReceiptInputSchema.parse(raw);
  if (!eligible(ctx, people)) refuse('Your current staff role cannot acknowledge work. Ask an administrator to check your access.', 403);
  const source = localRecords(state).find(record => record.id === input.sourceId);
  if (!source) refuse('This work item was not found in the selected lender.', 404);
  const intended = source.kind === 'exceptions' ? source.data.case?.assignee : source.kind === 'close-reviews' ? source.data.reviewer : source.kind === 'import-corrections' ? importCorrectionAssignment(state, source).reviewer : undefined;
  if (intended !== ctx.actor) refuse('Only the currently assigned staff member can acknowledge or mark this work as read.', 403);
  // A source has one item: only it is derived, once, so a receipt compares nothing else under the lender's write lock.
  const item = personalWorkItems(state, ctx, people, source.id)[0];
  if (!item || item.sourceVersion !== input.expectedUpdatedAt || item.sourceDigest !== input.expectedDigest) refuse('This work item changed. Refresh My work and review the current assignment before continuing.');
  const prior = localRecords(state).find(record => record.kind === 'work-events' && record.data.action === action && record.data.sourceId === input.sourceId && record.data.eventId === input.eventId && record.data.actor === ctx.actor && record.data.sourceDigest === input.expectedDigest);
  if (prior) return receiptView(prior, true);
  if (item.eventId !== input.eventId) refuse('This work item changed. Refresh My work and review the current assignment before continuing.');
  if (action === 'acknowledge' && (!item.canAcknowledge || !item.assignmentEventId)) refuse('There is no current handover for you to acknowledge. Open the case to review its assignment.');
  const record = makeRecord(state, 'work-events', { name: action === 'read' ? 'Work notification read' : 'Handover acknowledged', status: 'recorded', createdAt: ctx.now, updatedAt: ctx.now, data: { action, sourceId: item.sourceId, eventId: item.eventId, assignmentEventId: item.assignmentEventId, sourceVersion: item.sourceVersion, sourceDigest: item.sourceDigest, actor: ctx.actor, summary: item.title, href: item.href, synthetic: true } });
  return receiptView(record, false);
}
