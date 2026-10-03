import { browserStorageKey } from '@/lib/browser-identity';
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { ArrowRight, Presentation, X } from 'lucide-react';
import { useListRecords, getListRecordsQueryKey } from '@workspace/valo-pay-1-api-client-react';
import { useWorkspace } from '@/lib/workspace-context';
import { PRESENTATION_CUSTOMER, presentationChecks, presentationSteps } from '@/lib/presentation';
import { Button } from './ui/button';
import { focusMain } from '@/lib/focus';

type Rehearsal = { active: boolean; step: number; checked: string[] };
const initial = (): Rehearsal => ({ active: false, step: 0, checked: [] });
function read(key: string): Rehearsal {
  try {
    const v = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (v && typeof v.active === 'boolean' && Number.isInteger(v.step) && v.step >= 0 && v.step < presentationSteps.length && Array.isArray(v.checked)) {
      return { active: v.active, step: v.step, checked: presentationChecks.filter(c => v.checked.includes(c.id)).map(c => c.id) };
    }
  } catch { /* Rehearsal controls also work without browser storage. */ }
  return initial();
}
const Context = createContext<{ state: Rehearsal; save: (next: Rehearsal) => void } | null>(null);
export function PresentationProvider({ children }: { children: ReactNode }) {
  const { workspace, merchantId } = useWorkspace();
  const scope = JSON.stringify([workspace?.viewerScope || workspace?.actor || 'anonymous', merchantId]);
  const storageKey = browserStorageKey(`presentation-v1:${scope}`);
  const [stored, setStored] = useState(() => ({ key: storageKey, value: read(storageKey) }));
  // Reset only this optional guide when the viewer/lender changes. Remounting
  // the console here would discard forms and uncertain-request recovery state.
  let state = stored.value;
  if (stored.key !== storageKey) {
    state = read(storageKey);
    setStored({ key: storageKey, value: state });
  }
  function save(next: Rehearsal) {
    setStored({ key: storageKey, value: next });
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* In-memory progress remains available. */ }
  }
  return <Context.Provider value={{ state, save }}>{children}</Context.Provider>;
}
export function usePresentation() {
  const context = useContext(Context);
  if (!context) throw new Error('Presentation controls need their provider.');
  return context;
}

type PresentationStep = (typeof presentationSteps)[number];
/**
 * Where a talking point's link goes. The match step opens the sample customer's
 * history, where the automatic R1 match and its explanation are shown, once the
 * pack is imported for this lender; until then it opens the customer search for
 * it, which says plainly that the customer is not there yet. Read only while
 * `enabled`, so the guide asks nothing on the other talking points.
 */
export function usePresentationHref(enabled: boolean): (step: PresentationStep) => string {
  const { merchantId } = useWorkspace();
  const params = { merchantId: merchantId!, search: PRESENTATION_CUSTOMER, limit: 5 };
  const found = useListRecords('customers', params, { query: { enabled: enabled && !!merchantId, queryKey: getListRecordsQueryKey('customers', params) } });
  const customer = found.data?.items.find(item => item.reference === PRESENTATION_CUSTOMER);
  return step => 'customer' in step && customer ? `/customers/${encodeURIComponent(customer.id)}` : step.href;
}

export function PresentationGuide() {
  const { state, save } = usePresentation();
  const { workspace } = useWorkspace();
  const step = presentationSteps[state.step];
  const visible = state.active && workspace?.environment === 'sandbox';
  const hrefFor = usePresentationHref(visible && 'customer' in step);
  // Next talking point is unavailable on the last talking point, so reaching it would drop the focus to the page body.
  // It goes to the list of talking points instead, where the arrow keys, or typing a talking point's number, move on.
  const list = useRef<HTMLSelectElement>(null), reachedLast = useRef(false);
  useLayoutEffect(() => {
    if (!reachedLast.current) return;
    reachedLast.current = false;
    list.current?.focus();
  }, [state.step]);
  if (!visible) return null;
  const last = presentationSteps.length - 1;
  // The title keeps at least 16rem, so where the row is too narrow for it and the actions (a phone, or a tablet
  // beside the sidebar) the actions wrap under it instead of squeezing it to a word a line; on a phone the guide
  // is tighter, so the page it is guiding stays in view.
  return <section aria-label="Presentation guide" className="mb-4 rounded-xl border border-primary/25 bg-card p-3 sm:mb-5 sm:p-4 print:hidden">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex min-w-[min(100%,16rem)] flex-1 items-center gap-3">
        <Presentation className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0"><p className="text-xs font-medium text-muted-foreground">Presentation · Sample data only</p><p className="mt-0.5 text-sm font-semibold sm:mt-1" aria-live="polite">{state.step + 1} of {presentationSteps.length} · {step.title}</p></div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm"><Link href={hrefFor(step)}>{step.action}<ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" /></Link></Button>
        {/* Ending removes the guide and this button with it, so the reader continues from the top of the page's content. */}
        <Button variant="ghost" size="sm" className="px-2 sm:px-3" onClick={() => { save({ ...state, active: false }); focusMain(); }}><X className="mr-1 h-4 w-4" aria-hidden="true" />End presentation</Button>
      </div>
    </div>
    {/* On a phone the list of talking points takes its own row, so it shows the talking point's title rather than its
        first word or two, and Next talking point goes under it with Back to Presentation. */}
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t pt-2 sm:mt-3 sm:pt-3">
      <div className="flex min-w-0 basis-full items-center gap-2 sm:basis-auto">
        <label htmlFor="presentation-step" className="shrink-0 text-xs font-medium">Talking point</label>
        <select ref={list} id="presentation-step" className="min-h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm sm:flex-none" value={state.step} onChange={e => save({ ...state, step: Number(e.target.value) })}>
          {presentationSteps.map((s, i) => <option key={s.href} value={i}>{i + 1}. {s.title}</option>)}
        </select>
      </div>
      <Button size="sm" variant="outline" disabled={state.step === last} onClick={() => { reachedLast.current = state.step + 1 === last; save({ ...state, step: state.step + 1 }); }}>Next talking point</Button>
      <Link href="/presentation" className="ml-auto inline-flex min-h-9 items-center text-sm text-primary underline underline-offset-4">Back to Presentation</Link>
    </div>
    <details key={state.step} className="mt-1 text-sm sm:mt-3"><summary className="min-h-9 cursor-pointer py-2 font-medium">Show presenter notes (visible on this screen)</summary><p className="mt-2">{step.show}</p><p className="mt-2 text-muted-foreground">Say: {step.say}</p><p className="mt-2 text-muted-foreground">If something goes wrong: {step.fallback}</p></details>
  </section>;
}
