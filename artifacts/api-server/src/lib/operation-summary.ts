/**
 * What Operations says of a journal entry's request, so a person who lost a form can find its request (backlog item
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
  /** The action or route in plain words. */
  action: string;
  targetKind: string | null; targetId: string | null;
  /** At most three of the action, decision, status, kind and format the body names. */
  details: Array<{ name: string; value: string }>;
}
/** An action's name in words: mandate_suspend is "Mandate suspend". */
const words = (value: string) => { const text = value.replaceAll('_', ' ').trim(); return text.charAt(0).toUpperCase() + text.slice(1); };
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
  { method: 'POST', path: /^\/v1\/records\/([^/]+)$/, says: 'Create a record' },
  { method: 'PATCH', path: /^\/v1\/settings$/, says: 'Change the settings' },
  { method: 'POST', path: /^\/v1\/actions$/, says: (facts) => facts.action ? words(facts.action) : 'Workspace action', named: 'action' },
  { method: 'POST', path: /^\/v1\/imports$/, says: 'Import records' },
  { method: 'POST', path: /^\/v1\/connected\/actions$/, says: (facts) => facts.action ? `Connected banking: ${words(facts.action).toLowerCase()}` : 'Connected banking action', named: 'action' },
  { method: 'POST', path: /^\/v1\/exports$/, says: 'Request an export', kind: 'exports', answerIsKind: true },
  { method: 'POST', path: /^\/v1\/exports\/([^/]+)\/retry$/, says: 'Retry an export', kind: 'exports', answerIsKind: true },
  { method: 'POST', path: /^\/v1\/pilot\/batches$/, says: 'Save a new import batch', kind: 'import-batches' },
  { method: 'POST', path: /^\/v1\/pilot\/batches\/([^/]+)\/save$/, says: 'Save an import batch', kind: 'import-batches' },
  { method: 'POST', path: /^\/v1\/pilot\/batches\/([^/]+)\/commit$/, says: 'Commit an import batch', kind: 'import-batches' },
  { method: 'POST', path: /^\/v1\/pilot\/cases\/([^/]+)$/, says: 'Update a case', kind: 'exceptions' },
  { method: 'POST', path: /^\/v1\/pilot\/import-corrections$/, says: 'Propose an import correction', kind: 'import-corrections' },
  { method: 'POST', path: /^\/v1\/pilot\/import-corrections\/([^/]+)\/decision$/, says: 'Decide an import correction', kind: 'import-corrections' },
  { method: 'POST', path: /^\/v1\/pilot\/import-corrections\/([^/]+)\/recovery$/, says: 'Recover an import correction review', kind: 'import-corrections' },
  { method: 'POST', path: /^\/v1\/pilot\/close-reviews\/prepare$/, says: 'Prepare a close review', kind: 'close-reviews' },
  { method: 'POST', path: /^\/v1\/pilot\/close-reviews\/([^/]+)\/decision$/, says: 'Decide a close review', kind: 'close-reviews' },
  { method: 'POST', path: /^\/v1\/pilot\/close-reviews\/([^/]+)\/reassign$/, says: 'Reassign a close review', kind: 'close-reviews' },
  { method: 'POST', path: /^\/v1\/sources\/manifests$/, says: 'Declare a source delivery', kind: 'source-manifests' },
  { method: 'POST', path: /^\/v1\/sources\/profiles$/, says: 'Create a source profile', kind: 'source-profiles' },
  { method: 'POST', path: /^\/v1\/sources\/profiles\/([^/]+)\/save$/, says: 'Save a source profile', kind: 'source-profiles' },
  { method: 'POST', path: /^\/v1\/sources\/paystack\/fixtures$/, says: 'Record a Paystack test event', kind: 'provider-events' },
  { method: 'POST', path: /^\/v1\/sources\/events\/([^/]+)\/replay$/, says: 'Replay a provider event', kind: 'provider-events' },
  { method: 'POST', path: /^\/v1\/work\/notifications\/read$/, says: 'Mark notifications read', kind: 'work-events' },
  { method: 'POST', path: /^\/v1\/work\/handovers\/acknowledge$/, says: 'Acknowledge a handover', kind: 'work-events' },
  { method: 'POST', path: /^\/v1\/lifecycle\/policy$/, says: 'Change the retention policy' },
  { method: 'POST', path: /^\/v1\/lifecycle\/holds$/, says: 'Change the retention holds' },
  { method: 'POST', path: /^\/v1\/lifecycle\/runs$/, says: 'Preview a retention run', kind: 'retention-runs' },
  { method: 'POST', path: /^\/v1\/lifecycle\/runs\/([^/]+)\/approve$/, says: 'Approve a retention run', kind: 'retention-runs' },
  { method: 'POST', path: /^\/v1\/lifecycle\/runs\/([^/]+)\/execute$/, says: 'Carry out a retention run', kind: 'retention-runs' },
];
/** A path segment as the route read it: percent-decoded, or as stored when it does not decode. */
function segment(value: string | undefined): string | null {
  if (!value) return null;
  try { return decodeURIComponent(value); } catch { return value; }
}
const DETAILS = [['action', 'Action'], ['decision', 'Decision'], ['status', 'Status'], ['kind', 'Kind'], ['format', 'Format']] as const;
/**
 * An entry's summary, and the kind of record its answer names (`resultKind`, for Operations' "Open saved result"):
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
      .slice(0, 3).map(([field, name]) => ({ name, value: facts[field]! }));
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
