import { useState } from 'react';
import { Link } from 'wouter';
import { ArrowRight, CheckCircle2, ChevronDown, Circle, Info } from 'lucide-react';
import { pilotProgressSchema } from '@workspace/valopay-schema';
import type { Overview } from '@workspace/api-client-react';
import { useWorkspace } from '@/lib/workspace-context';
import { usePilotQuery } from '@/lib/pilot';
import { helpHref, type HelpTopicId } from '@/lib/help-content';
import { Button } from './ui/button';

type NextAction = { title: string; description: string; label: string; href: string };
/** Guidance uses the server's role. Choosing or reading a guide never grants authority. */
function nextAction(role: string, overview?: Overview): NextAction {
  const waiting = (key: string) => overview?.queues.some(queue => queue.key === key && queue.value > 0);
  if (role === 'Read-only') return { title: 'Start with a customer’s history', description: 'You can inspect records and reports. An authorised colleague must make changes or record financial decisions.', label: 'Explore customer records', href: '/customers' };
  if (role === 'Compliance reviewer') return { title: 'Find work awaiting compliance review', description: 'Review policy and notice wording in its context. A different reviewer must decide on anything you prepared yourself.', label: 'Review policies and templates', href: '/policies' };
  if (role === 'Finance') return waiting('review')
    ? { title: 'A payment match needs review', description: 'Compare the payment, instalment and explanation before recording a decision. A proposed match has not yet applied the payment.', label: 'Review proposed payment matches', href: '/reconciliation?view=review' }
    : { title: 'Check the evidence behind the daily close', description: 'Inspect the latest close and its review status. Preparing a close does not approve it; a separate Finance reviewer must decide.', label: 'Open close review', href: '/close-review' };
  if (role === 'Operations') return waiting('overdue')
    ? { title: 'An overdue issue needs an owner and next step', description: 'Open the issue, check its evidence and coordinate the next action. Admin or Finance must decide payment matches and financial holds.', label: 'Review overdue issues', href: '/exceptions?view=overdue' }
    : { title: 'Start with your assigned work', description: 'Find issues, handovers and deadlines for this lender. If records have not arrived yet, use Import batches to review a sample file first.', label: 'Open my work', href: '/work' };
  if (role === 'Admin') return waiting('review')
    ? { title: 'A payment match needs review', description: 'Check the underlying records or ask Finance to review them. Starting a task does not bypass its required approval.', label: 'Review proposed payment matches', href: '/reconciliation?view=review' }
    : { title: 'Bring the lender’s sample records together', description: 'Start with customers, then their instalments and payment evidence. Preview each import and correct its errors before committing it.', label: 'Open import batches', href: '/imports' };
  return { title: 'Check what your workspace allows', description: 'Your role could not be recognised here. Read the access guide before asking an administrator to confirm your membership.', label: 'Read the access guide', href: helpHref('start', '/overview') };
}

const stateLabels = { not_started: 'Not started', in_progress: 'In progress', awaiting_review: 'Awaiting review', completed: 'Recorded', blocked: 'Needs attention' };
const checklist: Array<{ id: string; title: string; completedLabel: string; href: string; help: HelpTopicId }> = [
  { id: 'ingest', title: 'Bring in sample records', completedLabel: 'Committed', href: '/imports', help: 'imports' },
  { id: 'reconcile', title: 'Match payments to instalments', completedLabel: 'Matched', href: '/reconciliation', help: 'matching' },
  { id: 'close', title: 'Review the daily close', completedLabel: 'Approved', href: '/close-review', help: 'close' },
];

function Checklist({ role }: { role: string }) {
  // This existing scoped read is mounted only while the optional checklist is open.
  // The full Pilot journey remains the source of detailed progress and evidence.
  const progress = usePilotQuery('/pilot/progress', pilotProgressSchema);
  const mayImport = ['Admin', 'Finance', 'Operations'].includes(role);
  return <div className="border-t pt-4">
    <p className="text-sm text-muted-foreground">Optional guide · Progress belongs to this lender and comes from saved records, not clicks. You can leave and return at any time.</p>
    {progress.isLoading && <p role="status" className="mt-4 text-sm">Checking the lender’s saved progress…</p>}
    {progress.error && <div role="alert" className="mt-4 rounded-lg border p-3 text-sm"><p>{progress.data ? 'Progress could not be refreshed. The last loaded status is shown below; check the task before acting.' : 'We could not check saved progress. No steps are being marked complete.'}</p><Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { void progress.refetch(); }} busy={progress.isFetching}>Check progress again</Button></div>}
    {progress.data && <ol className="mt-4 grid gap-3 lg:grid-cols-3">
      {checklist.map((item, index) => {
        const step = progress.data.steps.find(candidate => candidate.id === item.id);
        const recorded = step?.state === 'completed';
        const restricted = item.id === 'ingest' && !mayImport;
        const boundary = item.id === 'ingest' ? (mayImport ? 'A saved batch is a draft until you commit it.' : 'Admin, Operations or Finance must import records. You can read the guide and inspect customer records.') : item.id === 'reconcile' ? (['Admin', 'Finance'].includes(role) ? 'Confirm a match only after checking the payment and instalment.' : 'Admin or Finance must decide proposed matches. You can inspect the evidence.') : 'A close needs a separate authorised Finance reviewer; running it is not approval.';
        return <li key={item.id} className="min-w-0 rounded-lg border bg-background/70 p-4">
          <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">{recorded ? <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-success" /> : <Circle aria-hidden="true" className="h-4 w-4" />}Step {index + 1} · {recorded ? item.completedLabel : step ? stateLabels[step.state] : 'Status unavailable'}</p>
          <h3 className="mt-2 text-sm font-semibold">{item.title}</h3>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{boundary}</p>
          {step?.missing[0] && <p className="mt-2 text-xs leading-relaxed"><span className="font-medium">Still needed in this lender: </span>{step.missing[0]}</p>}
          <Link className="mt-3 inline-flex min-h-10 items-center gap-1 text-sm font-semibold text-primary underline-offset-4 hover:underline" href={restricted ? helpHref(item.help, '/overview') : item.href}>{restricted ? 'Read the import guide' : recorded ? 'Inspect saved evidence' : 'Open this task'}<ArrowRight aria-hidden="true" className="h-4 w-4" /></Link>
        </li>;
      })}
    </ol>}
    <div className="mt-4 flex items-start gap-2 rounded-lg bg-secondary/40 p-3 text-xs leading-relaxed text-muted-foreground"><Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /><p><strong className="font-medium text-foreground">Separate administrator and external setup.</strong> Staff invitations, provider connections and acceptance for real data are separate checks. {role === 'Admin' ? 'Review the Pilot journey and Team & access with the responsible owners.' : 'Ask your administrator to arrange them; you do not need bank credentials to review these sample records.'} Sample progress does not establish live readiness.</p></div>
    <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm"><Link href="/pilot" className="inline-flex min-h-10 items-center text-primary underline">View the full pilot journey</Link><Link href={helpHref('start', '/overview')} className="inline-flex min-h-10 items-center text-primary underline">Understand your access</Link></div>
  </div>;
}

export function GetStarted({ overview }: { overview?: Overview }) {
  const { workspace, merchantId } = useWorkspace();
  if (!workspace || !merchantId) return null;
  const scope = `${workspace.viewerScope || workspace.actor}:${merchantId}`;
  return <WorkspaceStart key={scope} scope={scope} role={workspace.role} overview={overview} />;
}

function WorkspaceStart({ scope, role, overview }: { scope: string; role: string; overview?: Overview }) {
  const storageKey = `valopay-start-v1:${scope}`;
  const [expanded, setExpanded] = useState(() => { try { return localStorage.getItem(storageKey) === 'open'; } catch { return false; } });
  const action = nextAction(role, overview);
  function toggle() {
    setExpanded(!expanded);
    try { localStorage.setItem(storageKey, expanded ? 'closed' : 'open'); } catch { /* The optional guide also works without browser storage. */ }
  }
  return <section aria-label="Where to start" className="rounded-xl border border-primary/20 bg-card p-5 shadow-sm print:hidden">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="max-w-2xl"><p className="text-xs font-semibold text-primary">Your next step · {role}</p><h2 className="mt-2 text-lg font-semibold">{action.title}</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{action.description}</p></div>
      <Button asChild className="max-w-full whitespace-normal text-left h-auto min-h-11 py-2"><Link href={action.href}>{action.label}<ArrowRight aria-hidden="true" className="ml-2 h-4 w-4 shrink-0" /></Link></Button>
    </div>
    <button type="button" aria-expanded={expanded} aria-controls="get-started-checklist" onClick={toggle} className="mt-4 flex min-h-11 items-center gap-2 rounded-md text-sm font-semibold underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{expanded ? 'Hide getting started' : 'Get started · 3 steps'}<ChevronDown aria-hidden="true" className={`h-4 w-4 ${expanded ? 'rotate-180' : ''}`} /></button>
    <div id="get-started-checklist" hidden={!expanded}>{expanded && <Checklist role={role} />}</div>
  </section>;
}
