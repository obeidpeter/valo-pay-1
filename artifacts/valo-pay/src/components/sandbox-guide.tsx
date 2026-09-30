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
  // The service lets a Compliance reviewer claim a case and record its next action too (coordinateCase), but not resolve it.
  const coordinator = role === 'Compliance reviewer';
  const mayExport = exportPermitted(role, 'customer-pack');
  return [
    { title: 'Look up a customer', href: '/customers', action: 'Open Customers', instruction: 'Choose a sample customer and open their history.', outcome: 'You see their mandate, instalments and payment evidence in one place. Permission to read an account is not permission to take money from it.' },
    { title: 'Understand a payment match', href: '/reconciliation?view=review', action: 'Open Matches to review', instruction: `Compare a payment with its instalment and read the matching explanation. ${finance ? 'Check both records before you confirm or reject the match.' : 'Admin or Finance must confirm or reject the match. You can read the evidence.'} If the list is empty, look at an existing match instead.`, outcome: 'A match waiting for review has not allocated the payment yet. Confirming a match does not show that the provider has paid the money out.' },
    { title: 'Follow an exception to its next step', href: '/exceptions?view=overdue', action: 'Open overdue exceptions', instruction: `Open an exception and check the customer, owner, deadline and case history. ${operator ? 'Record a next step or a handover when needed. Some financial holds need Admin or Finance.' : coordinator ? 'Claim an exception that has no owner, then record a next step or a handover. Admin, Operations or Finance must record how it was resolved.' : 'Your role cannot resolve this exception. Ask its owner to record the next step.'} If none are overdue, choose All open.`, outcome: 'Assigning or handing over an exception does not resolve it. How it was resolved, and why, stays in the case history.' },
    { title: 'Understand the daily close', href: '/close-review', action: 'Open Close review', instruction: `Look at the latest daily close and anything still open. ${operator ? 'When a close is needed, Admin, Operations or Finance runs it on Reports, then prepares it for review.' : 'Admin, Operations or Finance must run and prepare a daily close.'} A different person, a Finance team member, must review it.`, outcome: 'Running a close, approving it and exporting a report are separate steps. Opening this page does none of them.' },
    { title: 'Find the evidence you can use', href: mayExport ? '/customers' : helpHref('exports', returnTo), action: mayExport ? 'Open Customers' : 'Read the export guide', instruction: mayExport ? 'Choose a customer, open their history, then select Export dispute pack (PDF). Download it from Saved exports when it is ready.' : 'Only Admin, Finance or a Compliance reviewer can export a customer dispute pack. Read the export guide, then ask one of them to export it.', outcome: 'A sample report is not evidence of a real collection. Reading this tip exports nothing.' },
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

/** Tips: optional reading, hidden on Overview, which has Your next step. Browser preferences never represent completed work. */
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
    <section aria-label="Tips" className="mb-5 rounded-xl border bg-card print:hidden">
      <button ref={toggle} type="button" aria-expanded={!progress.hidden} aria-controls="sandbox-guide-details" className="flex min-h-12 w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm hover:bg-secondary/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" onClick={() => save({ ...progress, hidden: !progress.hidden })}>
        <BookOpen aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
        <span className="font-medium">Tips</span>
        <span className="hidden text-muted-foreground sm:inline">{progress.read ? 'All tips read' : `Tip ${progress.step + 1} of ${steps.length} · ${step.title}`}</span>
        <span className="ml-auto text-xs text-muted-foreground">{progress.hidden ? 'Show' : 'Hide'}</span>
        <ChevronDown aria-hidden="true" className={`h-4 w-4 shrink-0 ${progress.hidden ? '' : 'rotate-180'}`} />
      </button>
      <div id="sandbox-guide-details" hidden={progress.hidden} className="border-t p-4 sm:p-5">
        <p className="mb-3 text-xs text-muted-foreground">Optional tips. Sample data only. You can hide these tips and come back to them later.</p>
        <h2 aria-live="polite" className="font-semibold">{progress.read ? 'You have read all the tips' : step.title}</h2>
        {progress.read ? <>
          <p className="mt-2 text-sm text-muted-foreground">This saves only how far you have read, in this browser. It does not show that any task or check is done. Pilot journey shows progress from saved records.</p>
          <div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => { toggle.current?.focus(); save({ ...initial, hidden: false }); }}>Read the tips again</Button><Button asChild size="sm"><Link href="/pilot">Open Pilot journey</Link></Button></div>
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
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => { toggle.current?.focus(); save({ ...progress, hidden: true }); }}>Hide for now</Button>
      </div>
    </section>
  );
}
