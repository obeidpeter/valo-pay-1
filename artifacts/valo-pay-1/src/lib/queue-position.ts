import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Session-only offsets, never records/drafts; discard them when lender or authority changes.
 * Another page starts at its remembered offset, or at the top. Paging, filtering or searching
 * on the same page changes only the query string, so the view stays with the table in use.
 */
export function useQueuePosition(main: RefObject<HTMLElement | null>, route: string, scope: string) {
  const positions = useRef(new Map<string, { top: number; left: number }>());
  const priorScope = useRef(scope);
  const priorPage = useRef<string | null>(null);
  useLayoutEffect(() => {
    const sameScope = scope === priorScope.current;
    if (!sameScope) { positions.current.clear(); priorScope.current = scope; }
    const node = main.current;
    if (!node) return;
    const page = route.split('?')[0];
    const samePage = sameScope && page === priorPage.current;
    priorPage.current = page;
    const saved = samePage ? { top: node.scrollTop, left: node.scrollLeft } : positions.current.get(route) || { top: 0, left: 0 };
    let latest = { ...saved };
    let restoring = !samePage;
    let observer: ResizeObserver | undefined;
    const stop = () => { restoring = false; observer?.disconnect(); };
    const restore = () => {
      if (!restoring) return;
      node.scrollTop = saved.top;
      node.scrollLeft = saved.left;
      if (node.scrollHeight - node.clientHeight >= saved.top) stop();
    };
    // Cached content normally restores immediately; allow lazy pages to acquire height.
    if (restoring && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(restore);
      for (const child of node.children) observer.observe(child);
    }
    restore();
    const remember = () => { if (!restoring) latest = { top: node.scrollTop, left: node.scrollLeft }; };
    node.addEventListener('scroll', remember, { passive: true });
    const timer = window.setTimeout(stop, 10000);
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) node.addEventListener(event, stop, { passive: true });
    return () => {
      window.clearTimeout(timer); stop();
      node.removeEventListener('scroll', remember);
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) node.removeEventListener(event, stop);
      // The new route may already have shortened the DOM and clamped scrollTop
      // before this cleanup. Keep the last observed offset of the old route.
      positions.current.set(route, latest);
      // Bound memory for a long session. These are offsets only and disappear on reload.
      if (positions.current.size > 30) positions.current.delete(positions.current.keys().next().value!);
    };
  }, [main, route, scope]);
}
