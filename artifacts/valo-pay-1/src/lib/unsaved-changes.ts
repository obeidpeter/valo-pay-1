import { useEffect, useRef, useState } from 'react';

const drafts = new Set<{ current: boolean }>();
const message = 'Discard your unsaved changes? Choose Cancel to keep editing. A request already sent may still finish.';

export function confirmUnsavedChanges(): boolean {
  return ![...drafts].some(draft => draft.current) || window.confirm(message);
}

/** Warn without retaining names, payment data, reasons or other sensitive drafts in storage. */
export function useUnsavedChanges(dirty: boolean) {
  const draft = useRef(dirty);
  draft.current = dirty;
  useEffect(() => { drafts.add(draft); return () => { drafts.delete(draft); }; }, []);
  return { confirmDiscard: () => !draft.current || window.confirm(message) };
}

/**
 * A form that keeps its inputs after it is sent, as the connected pages do for
 * the next run: its values are a draft while they differ from where the form
 * started or was last saved, and values put back as they were (a discarded
 * draft) release the guard. Before any request, `sending` names what the form
 * keeps if that request is this form's (null when it is another action's);
 * `saved`, once the request is answered or recovered, makes those values the
 * new starting point, so a sent draft releases the guard and a later edit is a
 * new draft. A refused request leaves the draft as it was.
 */
export function useFormDraft(values: Record<string, unknown>) {
  const current = JSON.stringify(values);
  const [settled, setSettled] = useState(current);
  const sent = useRef<string | null>(null);
  const dirty = current !== settled;
  return {
    ...useUnsavedChanges(dirty),
    dirty,
    sending: (kept: Record<string, unknown> | null) => { sent.current = kept && JSON.stringify(kept); },
    saved: () => { if (sent.current !== null) setSettled(sent.current); sent.current = null; },
    /** Starts afresh from these values, as when another lender's workspace resets the form. */
    reset: (start: Record<string, unknown>) => { sent.current = null; setSettled(JSON.stringify(start)); },
  };
}

let uninstallGuard: (() => void) | null = null;

/**
 * Guard links, keyboard navigation, browser Back/Forward and document unload.
 * Install it once, before the router first subscribes to the browser's
 * location (App.tsx does so when it loads): listeners on window run in the
 * order they were added, and Chromium keeps that order even for a capturing
 * listener, so a guard added after the router's popstate listener would be
 * asked only once Back had already unmounted the draft. Its own listener does
 * not capture, so every browser, jsdom included, runs it first for the same
 * reason. Installing again returns the guard already in place.
 */
export function installUnsavedNavigationGuard(): () => void {
  if (uninstallGuard) return uninstallGuard;
  const push = window.history.pushState;
  const replace = window.history.replaceState;
  const marker = '__valoNavigationIndex';
  let index = Number(window.history.state?.[marker] ?? 0);
  let restoring = false;
  replace.call(window.history, { ...window.history.state, [marker]: index }, '', window.location.href);
  const changesPage = (url?: string | URL | null) => url != null && new URL(String(url), window.location.href).pathname !== window.location.pathname;
  window.history.pushState = function (state, unused, url) {
    if (changesPage(url) && !confirmUnsavedChanges()) return;
    index += 1;
    push.call(this, { ...state, [marker]: index }, unused, url);
  };
  window.history.replaceState = function (state, unused, url) {
    if (changesPage(url) && !confirmUnsavedChanges()) return;
    replace.call(this, { ...state, [marker]: index }, unused, url);
  };
  const pop = (event: PopStateEvent) => {
    const nextIndex = event.state?.[marker];
    if (restoring) { restoring = false; event.stopImmediatePropagation(); return; }
    if (typeof nextIndex === 'number' && !confirmUnsavedChanges()) {
      event.stopImmediatePropagation();
      restoring = true;
      window.history.go(index - nextIndex);
      return;
    }
    if (typeof nextIndex === 'number') index = nextIndex;
  };
  const unload = (event: BeforeUnloadEvent) => {
    if ([...drafts].some(draft => draft.current)) { event.preventDefault(); event.returnValue = ''; }
  };
  window.addEventListener('popstate', pop);
  window.addEventListener('beforeunload', unload);
  uninstallGuard = () => {
    window.history.pushState = push; window.history.replaceState = replace;
    window.removeEventListener('popstate', pop); window.removeEventListener('beforeunload', unload);
    uninstallGuard = null;
  };
  return uninstallGuard;
}
