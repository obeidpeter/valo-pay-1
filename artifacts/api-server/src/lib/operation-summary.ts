import { valueLabel } from "@workspace/valo-pay-1-schema";
import { connectedActionRequest, recordTypesName, workspaceActionRequest } from "./action-names";

/**
 * What Request history says of a journal entry's request, so a person who lost a form can find its request (backlog item
 * UX-B02-X3). It is built from what the operations list reads of a stored request by jsonb operators, never the body:
 * the method and path, a few body fields that name an action or a choice, and the record the body names with its
 * kind. Each is a short string or nothing. Names, references, reasons, amounts and files are never read, so a summary
 * carries no personal data. A sealed or purged request gives none.
 */
export interface RequestFacts {
  method: string | null; path: string | null;
  action: string | null; decision: string | null; status: string | null; kind: string | null; format: string | null;
  /** The record the body names (its recordId, targetId, closeId or batchId), and that record's kind in the lender. */
  target: string | null; targetKind: string | null;
}
export interface OperationSummary {
  /** The action or route in plain words, as its button names it ("Suspend mandate"), never a code. */
  action: string;
  targetKind: string | null; targetId: string | null;
  /** At most three of the action, decision, status, kind and format the body names, each value in words. */
  details: Array<{ name: string; value: string }>;
}
type Route = {
  method: 'POST' | 'PATCH'; path: RegExp;
  /** The route in words; an action route names its action. */
  says: string | ((facts: RequestFacts) => string);
  /** The kind of record the path's id names, and of the record the answer's id names when the answer names none. */
  kind?: string;
  /** The answer names a kind that is not its own (an export names the kind it exports): its record is `kind`. */
  answerIsKind?: true;
  /** The body field `says` already names, left out of the details. */
  named?: 'action';
};
// The routes recoverableRequest (operation-recovery.ts) journals, the path's id as its last parameter.
const routes: Route[] = [
  { method: 'PATCH', path: /^\/v1\/records\/([^/]+)\/([^/]+)$/, says: 'Change a record' },
  { method: 'POST', path: /^\/v1\/records\/([^/]+)$/, says: 'Add a record' },
  { method: 'PATCH', path: /^\/v1\/settings$/, says: 'Change the settings' },
  { method: 'POST', path: /^\/v1\/actions$/, says: (facts) => facts.action ? workspaceActionRequest(facts.action) : 'Lender action', named: 'action' },
  { method: 'POST', path: /^\/v1\/imports$/, says: 'Import records' },
  { method: 'POST', path: /^\/v1\/connected\/actions$/, says: (facts) => facts.action ? connectedActionRequest(facts.action) : 'Connected banking action', named: 'action' },
  { method: 'POST', path: /^\/v1\/exports$/, says: 'Create an export', kind: 'exports', answerIsKind: true },
  { method: 'POST', path: /^\/v1\/exports\/([^/]+)\/retry$/, says: 'Retry an export', kind: 'exports', answerIsKind: true },
  { method: 'POST', path: /^\/v1\/pilot\/batches$/, says: 'Save a new import batch', kind: 'import-batches' },
  { method: 'POST', path: /^\/v1\/pilot\/batches\/([^/]+)\/save$/, says: 'Save an import batch', kind: 'import-batches' },
  { method: 'POST', path: /^\/v1\/pilot\/batches\/([^/]+)\/commit$/, says: 'Import a checked batch', kind: 'import-batches' },
  { method: 'POST', path: /^\/v1\/pilot\/cases\/([^/]+)$/, says: 'Update a case', kind: 'exceptions' },
  { method: 'POST', path: /^\/v1\/pilot\/import-corrections$/, says: 'Propose an import correction', kind: 'import-corrections' },
  { method: 'POST', path: /^\/v1\/pilot\/import-corrections\/([^/]+)\/decision$/, says: 'Decide on an import correction', kind: 'import-corrections' },
  { method: 'POST', path: /^\/v1\/pilot\/import-corrections\/([^/]+)\/recovery$/, says: 'Change the import correction reviewer', kind: 'import-corrections' },
  { method: 'POST', path: /^\/v1\/pilot\/close-reviews\/prepare$/, says: 'Prepare a close review', kind: 'close-reviews' },
  { method: 'POST', path: /^\/v1\/pilot\/close-reviews\/([^/]+)\/decision$/, says: 'Decide on a close review', kind: 'close-reviews' },
  { method: 'POST', path: /^\/v1\/pilot\/close-reviews\/([^/]+)\/reassign$/, says: 'Reassign a close review', kind: 'close-reviews' },
  { method: 'POST', path: /^\/v1\/sources\/manifests$/, says: 'Save expected files', kind: 'source-manifests' },
  { method: 'POST', path: /^\/v1\/sources\/profiles$/, says: 'Create a source profile', kind: 'source-profiles' },
  { method: 'POST', path: /^\/v1\/sources\/profiles\/([^/]+)\/save$/, says: 'Save a source profile', kind: 'source-profiles' },
  { method: 'POST', path: /^\/v1\/sources\/paystack\/fixtures$/, says: 'Simulate a Paystack message', kind: 'provider-events' },
  { method: 'POST', path: /^\/v1\/sources\/events\/([^/]+)\/replay$/, says: 'Recheck a Paystack message', kind: 'provider-events' },
  { method: 'POST', path: /^\/v1\/work\/notifications\/read$/, says: 'Mark notifications read', kind: 'work-events' },
  { method: 'POST', path: /^\/v1\/work\/handovers\/acknowledge$/, says: 'Acknowledge a handover', kind: 'work-events' },
  { method: 'POST', path: /^\/v1\/lifecycle\/policy$/, says: 'Change the retention policy' },
  { method: 'POST', path: /^\/v1\/lifecycle\/holds$/, says: 'Change a retention hold' },
  { method: 'POST', path: /^\/v1\/lifecycle\/runs$/, says: 'Prepare a deletion preview', kind: 'retention-runs' },
  { method: 'POST', path: /^\/v1\/lifecycle\/runs\/([^/]+)\/approve$/, says: 'Approve a deletion run', kind: 'retention-runs' },
  { method: 'POST', path: /^\/v1\/lifecycle\/runs\/([^/]+)\/execute$/, says: 'Carry out a deletion run', kind: 'retention-runs' },
];
/** A path segment as the route read it: percent-decoded, or as stored when it does not decode. */
function segment(value: string | undefined): string | null {
  if (!value) return null;
  try { return decodeURIComponent(value); } catch { return value; }
}
const DETAILS = [['action', 'Action'], ['decision', 'Decision'], ['status', 'Status'], ['kind', 'Record type'], ['format', 'Format']] as const;
/** A detail's value in words, never a code: a status or choice through the shared labels, a kind by its name, a format in capitals. */
function detailWords(field: (typeof DETAILS)[number][0], value: string): string {
  return field === 'kind' ? recordTypesName(value) : field === 'format' ? value.toUpperCase() : valueLabel(value);
}
/**
 * An entry's summary, and the kind of record its answer names (`resultKind`, for Request history's "Open saved result"):
 * the answer's own kind unless `resultOverrides`, when the answer's kind is something else (an export's). Undefined
 * when the request is sealed, purged or on a route the journal does not record.
 */
export function summariseRequest(facts: RequestFacts): { summary: OperationSummary; resultKind: string | null; resultOverrides: boolean } | null {
  if (!facts.method || !facts.path) return null;
  for (const route of routes) {
    const matched = facts.method === route.method ? route.path.exec(facts.path) : null;
    if (!matched) continue;
    const records = route.path.source.startsWith('^\\/v1\\/records');
    const kind = records ? segment(matched[1]) : route.kind ?? null;
    const pathId = records ? segment(matched[2]) : segment(matched[1]);
    const details = DETAILS.filter(([field]) => field !== route.named && facts[field] && !(field === 'kind' && facts.kind === kind))
      .slice(0, 3).map(([field, name]) => ({ name, value: detailWords(field, facts[field]!) }));
    return {
      summary: {
        action: typeof route.says === 'string' ? route.says : route.says(facts),
        // A new record's kind is named, as its path names it; a route's own words already say what else it saves.
        targetKind: pathId || records ? kind : facts.target ? facts.targetKind : null,
        targetId: pathId ?? facts.target,
        details,
      },
      resultKind: kind,
      resultOverrides: route.answerIsKind === true,
    };
  }
  return null;
}
/**
 * The label a new journal entry stores, which Request history shows once its request can no longer be read (sealed or
 * purged): the route in words, or its action's words, from the request as it was sent. Never a code or a path.
 */
export function requestLabel(request: { method: string; path: string; body?: unknown }): string {
  const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
  const action = typeof body.action === 'string' && body.action ? body.action.slice(0, 100) : null;
  return summariseRequest({ method: request.method, path: request.path, action, decision: null, status: null, kind: null, format: null, target: null, targetKind: null })?.summary.action ?? 'Saved change';
}
