import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFocusWhenLost } from '@/lib/focus';
import { formatCount } from '@/lib/formatters';
import { errorWords } from '@/lib/notify';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import { useWorkspace } from '@/lib/workspace-context';
import {
  preparationOffered, preparationStatusLabels, preparationSteps, preparePresentation,
  type PreparationResult, type PreparationStatus, type PreparationStepId,
} from '@/lib/presentation-preparation';

type StepState = { status: PreparationStatus; reason?: string };
const waiting = (): Record<PreparationStepId, StepState> =>
  Object.fromEntries(preparationSteps.map(step => [step.id, { status: 'waiting' }])) as Record<PreparationStepId, StepState>;
/** Each status's colour, as the shared status badges colour them (StatusBadge). */
const tones: Record<PreparationStatus, string> = {
  waiting: 'bg-secondary text-secondary-foreground border-border',
  running: 'bg-warning text-warning-foreground border-warning-border',
  completed: 'bg-success/10 text-success border-success/20',
  'already-done': 'bg-success/10 text-success border-success/20',
  failed: 'bg-destructive/10 text-destructive border-destructive/20',
};
function StatusIcon({ status }: { status: PreparationStatus }) {
  if (status === 'running') return <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />;
  if (status === 'failed') return <XCircle aria-hidden="true" className="h-3.5 w-3.5" />;
  if (status === 'waiting') return <Circle aria-hidden="true" className="h-3.5 w-3.5" />;
  return <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />;
}

/**
 * The Presentation page's Prepare for presentation section: fills the active lender's pages with the sample work the
 * presentation shows (lib/presentation-preparation.ts). Offered only in the sandbox, never in a staff pilot.
 */
export function PresentationPreparation() {
  const { workspace, merchantId } = useWorkspace();
  if (!workspace || !merchantId || !preparationOffered(workspace)) return null;
  const lender = workspace.merchants.find(item => item.id === merchantId)?.name || 'this lender';
  return <LenderPreparation key={merchantId} merchantId={merchantId} lender={lender} />;
}

function LenderPreparation({ merchantId, lender }: { merchantId: string; lender: string }) {
  const queryClient = useQueryClient();
  const [steps, setSteps] = useState(waiting);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PreparationResult | null>(null);
  const [problem, setProblem] = useState('');
  const controller = useRef<AbortController | null>(null);
  const summary = useRef<HTMLParagraphElement>(null);
  // Leaving the page asks first; once left, the run stops before its next request and still puts the demo role back.
  useUnsavedChanges(running);
  useEffect(() => () => controller.current?.abort(), []);
  useFocusWhenLost(summary, result || problem);

  async function prepare() {
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setResult(null);
    setProblem('');
    setSteps(waiting());
    try {
      setResult(await preparePresentation({
        merchantId,
        signal: abort.signal,
        onProgress: ({ id, status, reason }) => setSteps(current => ({ ...current, [id]: { status, reason } })),
      }));
    } catch (error) {
      if (!abort.signal.aborted) setProblem(errorWords(error, 'Valo Pay 1 gave no reason. Try again.'));
    } finally {
      controller.current = null;
      setRunning(false);
      // Every page shows what was prepared, and the demo role as it is now.
      void queryClient.invalidateQueries();
    }
  }

  const failed = result?.failed ?? 0;
  return <section aria-labelledby="presentation-preparation" className="rounded-xl border bg-card p-5 sm:p-6">
    <h2 id="presentation-preparation" className="text-lg font-semibold">Sample records for the presentation</h2>
    <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">Fill {lender}’s pages with sample work: import batches, a case, Pay by Bank checkouts, daily closes, a close review, Credit Desk, Cash Desk and saved exports. Steps already done are left as they are. Your demo role is put back at the end.</p>
    <p className="mt-2 text-sm font-medium">Sample data only. No money moves and nothing is sent to a bank.</p>
    <Button className="mt-4" busy={running} busyLabel="Preparing for presentation…" onClick={() => { void prepare(); }}>Prepare for presentation</Button>
    <ol className="mt-5 divide-y border-y">
      {preparationSteps.map((step, index) => {
        const state = steps[step.id];
        return <li key={step.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
          <div className="min-w-0 flex-1 basis-64">
            <p className="text-sm font-medium">{index + 1}. {step.label}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.description}</p>
            {state.status === 'failed' && state.reason && <p className="mt-1 text-xs leading-5 text-destructive">{state.reason}</p>}
          </div>
          <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${tones[state.status]}`}><StatusIcon status={state.status} />{preparationStatusLabels[state.status]}</span>
        </li>;
      })}
    </ol>
    <p ref={summary} role="status" className="mt-4 text-sm font-medium">
      {result && (failed
        ? <>{formatCount(failed, 'step')} failed. Select Prepare for presentation to try {failed === 1 ? 'it' : 'them'} again.</>
        : <>All {formatCount(result.steps.length, 'step')} are done. <Link href="/overview" className="text-primary underline underline-offset-4">Open Overview</Link> to start.</>)}
      {result?.roleProblem && ` Your demo role was not changed back to ${result.role}. Change it in Settings.`}
      {problem && `Preparation not started. ${problem}`}
    </p>
  </section>;
}
