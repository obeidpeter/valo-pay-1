import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Keyboard paths the console keeps the same everywhere (Nielsen 4 and 7;
 * universal design: operable by keyboard, low physical effort).
 */

/** Focus the page's main region, the way a page load would start the reader at the top of what changed. */
export function focusMain(): void {
  document.getElementById('main')?.focus({ preventScroll: true });
}

/** A field that takes typing or opens a picker, which a phone moves the document to show above its keyboard. */
function takesInput(element: Element | null): boolean {
  if (element instanceof HTMLInputElement) return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(element.type);
  return element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || (element instanceof HTMLElement && element.isContentEditable);
}

/**
 * The console scrolls its main region, while public pages scroll the document.
 * CSS hides document overflow, but focus and browser restoration can still move
 * it, even after mount. Keep that outer offset at zero while the console exists,
 * except while the reader has pinch-zoomed, as iOS Safari moves it when they pan,
 * or a field has focus, as a phone moves it to show the field above the keyboard:
 * the next scroll with neither resets it.
 * Route/filter changes within the mounted console keep useQueuePosition's
 * independent saved offsets; neither focus nor main-region scroll is changed.
 */
export function useConsoleViewportReset(): void {
  useLayoutEffect(() => {
    const resetDocument = () => {
      if (window.scrollX === 0 && window.scrollY === 0) return;
      if ((window.visualViewport?.scale ?? 1) > 1 || takesInput(document.activeElement)) return;
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    };
    // Non-capturing: internal queue scroll events must remain independent.
    window.addEventListener('scroll', resetDocument, { passive: true });
    window.addEventListener('pageshow', resetDocument);
    resetDocument();
    return () => {
      window.removeEventListener('scroll', resetDocument);
      window.removeEventListener('pageshow', resetDocument);
    };
  }, []);
}

type Activation = { target: HTMLElement };
const currentActivations = new WeakMap<Document, Activation>();

/** Safari does not always focus clicked buttons. Remember only this click's
 * visible control, without changing focus or retaining an unrelated last click. */
export function useDialogActivationTracking(): void {
  useEffect(() => {
    let activation: Activation | undefined;
    let expiry: number | undefined;
    const clear = () => {
      if (activation && currentActivations.get(document) === activation) currentActivations.delete(document);
      activation = undefined;
      if (expiry !== undefined) window.clearTimeout(expiry);
      expiry = undefined;
    };
    const capture = (event: MouseEvent) => {
      clear();
      const target = event.composedPath().find(node => node instanceof HTMLElement && node.matches('button:not(:disabled), a[href], [role="button"], [role="link"]'));
      if (!(target instanceof HTMLElement) || !target.isConnected || target.getClientRects().length === 0 || target.closest('[inert]') || getComputedStyle(target).visibility !== 'visible') return;
      activation = { target };
      currentActivations.set(document, activation);
      // Discrete React click updates commit before this next task. A later
      // asynchronous/programmatic opening must use its own focused context.
      expiry = window.setTimeout(clear, 0);
    };
    document.addEventListener('click', capture, true);
    return () => { document.removeEventListener('click', capture, true); clear(); };
  }, []);
}

/**
 * Snapshot at opening, before the dialog's autofocus effect moves focus. On
 * closing, focus returns to the control that opened the dialog. A confirmed
 * step often removes or disables its own button; then focus goes to the
 * `result` the page names, such as the message that says what happened, and
 * only without one to the page's main region, never to the page body.
 */
export function useDialogFocusReturn(isOpen: boolean, result?: () => HTMLElement | null | undefined): (event?: { preventDefault(): void }) => void {
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!isOpen) return;
    const activated = currentActivations.get(document)?.target;
    const focused = document.activeElement;
    opener.current = activated?.isConnected ? activated : focused instanceof HTMLElement && focused !== document.body && focused !== document.documentElement ? focused : null;
  }, [isOpen]);
  return event => {
    event?.preventDefault();
    const target = opener.current;
    if (target?.isConnected) {
      target.focus({ preventScroll: true });
      if (document.activeElement === target) return;
    }
    const outcome = result?.();
    if (outcome?.isConnected) {
      // A message is not a keyboard stop, but it can hold focus so reading continues from it.
      if (!outcome.hasAttribute('tabindex')) outcome.tabIndex = -1;
      outcome.focus();
      if (document.activeElement === outcome) return;
    }
    focusMain();
  };
}

/** Whether focus has fallen to the page itself: nothing focused, the body, or an element that is no longer on the page. */
export function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active === document.documentElement || !active.isConnected;
}

/**
 * After an action whose button was disabled while it ran, or removed when it
 * finished (often only once the refreshed records arrive, after the message),
 * focus falls to the page body, or a dialog that sent it returned focus to the
 * page's main region because nothing better was there yet. From the time
 * `shown` says what happened (a result or problem message) until that message
 * has focus or is replaced, each update that finds focus fallen, or resting on
 * the main region, moves it to the message, so reading continues from there
 * rather than from the top of the page. Focus still on a field or another
 * control is left where it is. With `scope`, the part of the page that sent
 * the request (one member's card, say), an update that finds focus on
 * something outside it ends the watch: the person has moved on to other work,
 * whose own messages take the focus when its buttons go.
 */
export function useFocusWhenLost(message: RefObject<HTMLElement | null>, shown: unknown, scope?: RefObject<HTMLElement | null>): void {
  const watching = useRef(false);
  useEffect(() => { watching.current = Boolean(shown); }, [shown]);
  useEffect(() => {
    const target = message.current, active = document.activeElement;
    if (!watching.current || !target?.isConnected) return;
    if (!(focusLost() || active === document.getElementById('main'))) {
      if (scope && !scope.current?.contains(active)) watching.current = false;
      return;
    }
    watching.current = false;
    // A message is not a keyboard stop, but it can hold focus so reading continues from it.
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.focus();
  });
}

/** True while the keyboard is typing into something, so a shortcut must not steal the key. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

/** Pressing "/" anywhere on the page, outside a field, puts the caret in the search box. */
export function useSearchShortcut(ref: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      event.preventDefault();
      ref.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [ref]);
}

/** The shortcuts the console offers, listed on the settings page so they can be found rather than guessed. */
export const keyboardShortcuts: Array<{ keys: string; does: string }> = [
  { keys: 'Tab / Shift+Tab', does: 'Move through the links, fields and buttons in reading order. The first stop on every page skips to its content.' },
  { keys: '/', does: 'Put the caret in the search box on a page that has one (Customers, Audit log).' },
  { keys: 'Escape', does: 'Clear the search box you are in, or close the dialog or menu that is open.' },
  { keys: '← → Home End', does: 'Move between the filter tabs on Exceptions; the list follows the tab.' },
  { keys: 'Enter / Space', does: 'Activate the focused link, button, tab or menu item.' },
  { keys: 'F8', does: 'Jump to the notices in the corner, then Tab to their Dismiss or Open.' },
];
