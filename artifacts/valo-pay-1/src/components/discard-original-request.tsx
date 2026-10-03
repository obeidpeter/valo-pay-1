import { useEffect, useRef } from "react";
import { focusMain } from "@/lib/focus";
import { Button } from "./ui/button";

/** Said before a person discards a request whose outcome is unknown: it may have been saved, and it is not cancelled. */
export const DISCARD_ORIGINAL_WARNING =
  "The original request may already have been saved. Discarding it here does not cancel it. Before you send it again, check Request history or the Request not confirmed notice at the top of the page. Discard the original request?";

const controls = "a[href], button, input:not([type='hidden']), select, textarea, summary, [tabindex]";
/**
 * Where focus goes once a discarded request's notice, and this button with it,
 * has gone: the control the page names (the one that sent the request), else
 * the submit button of the form the notice is in, else the nearest control
 * before the notice or, with none, after it, within its dialog or the page's
 * own content (never the guides or other chrome above the page). Read when the
 * button is pressed, tried once the notice has gone.
 */
function nextControl(button: HTMLElement, named?: () => HTMLElement | null | undefined): () => void {
  const notice = button.closest<HTMLElement>("[role='alert']") ?? button.parentElement ?? button;
  const scope = button.closest<HTMLElement>("[role='dialog']") ?? button.closest<HTMLElement>("[data-page-content]") ?? document.getElementById("main") ?? document.body;
  const form = notice.closest("form");
  const others = [...scope.querySelectorAll<HTMLElement>(controls)].filter((element) => !notice.contains(element));
  const before = others.filter((element) => notice.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING).reverse();
  const after = others.filter((element) => notice.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
  return () => {
    const submit = form?.isConnected ? [...form.elements].filter((element): element is HTMLElement => (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) && element.type === "submit") : [];
    for (const candidate of [named?.(), ...submit, ...before, ...after]) {
      if (!candidate?.isConnected || candidate.tabIndex < 0 || (candidate as HTMLButtonElement).disabled) continue;
      candidate.focus();
      if (document.activeElement === candidate) return;
    }
    focusMain();
  };
}

/**
 * The way out of an unconfirmed request that cannot be recovered: after the
 * warning, the console forgets the form's private fields and in-memory attempt.
 * Its opaque journal identity stays in the interrupted-request notice for a
 * server check or cancellation before another submission. Retrying the
 * original stays the first choice on every recovery notice.
 * The notice goes with the discard, so focus then moves on to the next
 * sensible control (`next`, when the page names the control that sent the
 * request) rather than falling to the page; a key or pointer press before the
 * notice goes is the person moving on, and focus stays where they put it.
 */
export function DiscardOriginalRequest({
  onDiscard,
  disabled,
  next,
}: {
  onDiscard(): void;
  disabled?: boolean;
  next?: () => HTMLElement | null | undefined;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const moveOn = useRef<(() => void) | null>(null);
  useEffect(() => () => moveOn.current?.(), []);
  return (
    <Button
      ref={button}
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={() => {
        if (!window.confirm(DISCARD_ORIGINAL_WARNING)) return;
        const move = nextControl(button.current!, next);
        const events = ["keydown", "pointerdown"] as const;
        const release = () => {
          for (const event of events) document.removeEventListener(event, release, true);
          moveOn.current = null;
        };
        for (const event of events) document.addEventListener(event, release, true);
        moveOn.current = () => { release(); move(); };
        onDiscard();
      }}
    >
      Discard original request
    </Button>
  );
}
