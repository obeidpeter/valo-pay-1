import { useEffect, useRef } from 'react';
import { useLocationProperty } from 'wouter/use-browser-location';

// An arrival is a page and its fragment. Paging or filtering on the page changes only the query string: the same visit.
const arrival = () => `${window.location.pathname}${window.location.hash}`;

/**
 * Resolve deep links after an asynchronous page has rendered its target, once
 * per arrival: paging a table on the page, which reloads that table, never
 * brings the view or the focus back to the target. Reaching the address again
 * from another page or fragment is a new arrival.
 */
export function useHashTarget(ids: string | readonly string[], ready: boolean): void {
  // Wouter also publishes pushState/replaceState changes, which do not emit hashchange.
  const address = useLocationProperty(arrival);
  const handled = useRef(false);
  useEffect(() => { handled.current = false; }, [address]);
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (handled.current || !ready || !(typeof ids === 'string' ? id === ids : ids.includes(id))) return;
    // Run after the shell's route focus/reset so it cannot overwrite the target.
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(id);
      if (!target) return;
      handled.current = true;
      // Sections outside the normal tab order still need a readable focus destination.
      if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
      target.focus({ preventScroll: true });
      // No animation, including when the user requests reduced motion.
      target.scrollIntoView({ block: 'start', behavior: 'instant' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ids, ready, address]);
}
