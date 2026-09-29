import { useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowRight, BookOpen, ChevronDown } from 'lucide-react';
import { exportPermitted } from '@workspace/valopay-schema';
import { useWorkspace } from '@/lib/workspace-context';
import { helpHref } from '@/lib/help-content';
import { Button } from './ui/button';

function guideSteps(role: string, returnTo: string) {
  const finance = ['Admin', 'Finance'].includes(role);
  const operator = ['Admin', 'Operations', 'Finance'].includes(role);
  const mayExport = exportPermitted(role, 'customer-pack');
  return [
    { title: 'Inspect a customer', href: '/customers', action: 'Open customers', instruction: 'Choose a sample customer and open their timeline.', outcome: 'Find their permission for recurring debits, instalments and payment evidence together. Account-read permission is a different permission from permission to debit.' },
    { title: 'Understand a payment match', href: '/reconciliation?view=review', action: 'Review proposed matches', instruction: `Compare a proposed payment with its instalment and read the matching explanation. ${finance ? 'Check both records before deciding to confirm or reject a match.' : 'Admin or Finance must confirm or reject the match; your role can inspect the evidence.'} If the queue is empty, inspect an existing match instead.`, outcome: 'A proposed match has not yet applied the payment. Confirmed matching does not itself prove external settlement.' },
    { title: 'Follow an issue to its next step', href: '/exceptions?view=overdue', action: 'Review overdue issues', instruction: `Open an issue and check the customer, owner, deadline and case history. ${operator ? 'Record a next step or handover when appropriate. Some financial holds require Admin or Finance.' : 'Ask the assigned operator to record the next action; your role cannot resolve the issue.'} If no items are overdue, switch to All open.`, outcome: 'Assigning or handing over an issue does not resolve it. The recorded resolution and its reason remain in the case history.' },
    { title: 'Understand the daily close', href: '/close-review', action: 'Open close review', instruction: `Inspect the latest close and any unresolved items. ${operator ? 'When a close is needed, an authorised operator can run it in Reports, then prepare it for review.' : 'Admin, Operations or Finance must run and prepare a close.'} A separate authorised Finance reviewer must decide on the submitted review.`, outcome: 'A recorded close, an approved close and an exported report are distinct states. Opening this page does not advance any of them.' },
    { title: 'Find the evidence you can use', href: mayExport ? '/customers' : helpHref('exports', returnTo), action: mayExport ? 'Open a customer timeline' : 'Read the evidence guide', instruction: mayExport ? 'Choose a customer, then request Export dispute pack (PDF). Wait for the export to be ready before downloading it. You can check the result again in Saved exports.' : 'Admin, Finance or a Compliance reviewer must request or download a customer dispute pack. Read the evidence guide and ask an authorised colleague for the appropriate review.', outcome: 'A sample report is not evidence of a real collection. Reading this tip does not request or download an export.' },
  ];
}

type Progress = { step: number; hidden: boolean; read: boolean };
const initial: Progress = { step: 0, hidden: true, read: false };
function readProgress(key: string, length: number): Progress {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved && Number.isInteger(saved.step) && saved.step >= 0 && saved.step < length && typeof saved.hidden === 'boolean' && typeof saved.read === 'boolean') return { step: saved.step, hidden: saved.hidden, read: saved.read };
  } catch { /* Reading tips still works when browser storage is unavailable. */ }
  return { ...initial };
}

/** Optional reading tips. Browser preferences never represent completed operational work. */
export function SandboxGuide() {
  const { merchantId, workspace } = useWorkspace();
  if (!merchantId || !workspace || workspace.environment !== 'sandbox') return null;
  const scope = `${workspace.viewerScope || workspace.actor}:${merchantId}`;
  return <LenderGuide key={scope} scope={scope} role={workspace.role} />;
}

function LenderGuide({ scope, role }: { scope: string; role: string }) {
  const [location] = useLocation();
  const steps = guideSteps(role, location);
  const key = `valopay-guide-v2:${scope}`;
  const [progress, setProgress] = useState<Progress>(() => readProgress(key, steps.length));
  const toggle = useRef<HTMLButtonElement>(null);
  function save(next: Progress) {
    setProgress(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Session-only reading position is sufficient. */ }
  }
  const step = steps[progress.step]!;
  return (
    <section aria-label="Sandbox guide" className="mb-5 rounded-xl border bg-card print:hidden">
      <button ref={toggle} type="button" aria-expanded={!progress.hidden} aria-controls="sandbox-guide-details" className="flex min-h-12 w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm hover:bg-secondary/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" onClick={() => save({ ...progress, hidden: !progress.hidden })}>
        <BookOpen aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
        <span className="font-medium">Sandbox guide</span>
        <span className="hidden text-muted-foreground sm:inline">{progress.read ? 'All tips read' : `Tip ${progress.step + 1} of ${steps.length} · ${step.title}`}</span>
        <span className="ml-auto text-xs text-muted-foreground">{progress.hidden ? 'Open' : 'Collapse'}</span>
        <ChevronDown aria-hidden="true" className={`h-4 w-4 shrink-0 ${progress.hidden ? '' : 'rotate-180'}`} />
      </button>
      <div id="sandbox-guide-details" hidden={progress.hidden} className="border-t p-4 sm:p-5">
        <p className="mb-3 text-xs text-muted-foreground">Optional reading tips · Sample data only · You can close this guide and return here later.</p>
        <h2 aria-live="polite" className="font-semibold">{progress.read ? 'You have read the workflow tips' : step.title}</h2>
        {progress.read ? <>
          <p className="mt-2 text-sm text-muted-foreground">This saves only your reading position in this browser. It does not confirm that operational tasks or readiness checks passed. The Pilot journey shows progress from saved records.</p>
          <div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => { toggle.current?.focus(); save({ ...initial, hidden: false }); }}>Read the tips again</Button><Button asChild size="sm"><Link href="/pilot">View saved pilot progress</Link></Button></div>
        </> : <>
          <p className="mt-2 text-sm text-muted-foreground">{step.instruction}</p>
          <p className="mt-2 text-sm"><span className="font-medium">What to look for: </span>{step.outcome}</p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button asChild size="sm" className="gap-2"><Link href={step.href}>{step.action}<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button>
            <Button variant="outline" size="sm" onClick={() => { if (progress.step === steps.length - 1) toggle.current?.focus(); save({ ...progress, step: Math.min(progress.step + 1, steps.length - 1), read: progress.step === steps.length - 1 }); }}>{progress.step === steps.length - 1 ? 'Finish reading' : 'Next tip'}</Button>
            {progress.step > 0 && <Button variant="ghost" size="sm" onClick={() => save({ ...progress, step: progress.step - 1 })}>Previous tip</Button>}
            <span className="text-xs text-muted-foreground">Tip {progress.step + 1} of {steps.length} · Reading does not complete a task</span>
          </div>
        </>}
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => { toggle.current?.focus(); save({ ...progress, hidden: true }); }}>Close for now</Button>
      </div>
    </section>
  );
}
