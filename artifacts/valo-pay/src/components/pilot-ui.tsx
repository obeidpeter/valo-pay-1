import { useRef, type ReactNode, type RefObject } from "react";
import { Link } from "wouter";
import { Button } from "./ui/button";
import { usePageProblemFocus } from "./record-pagination";
import { saidBy } from "@/lib/notify";
import { DiscardOriginalRequest } from "./discard-original-request";

export const pilotField =
  "w-full min-w-0 min-h-11 rounded-lg border border-input bg-background px-3 py-2 text-sm";
export function PilotHeading({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <header className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-primary">
        Pilot workspace
      </p>
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">{children}</p>
    </header>
  );
}
export function PilotPanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-xl border bg-card p-5 sm:p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}
/** Said when a page's information could not be read and the service gave no words of its own: nothing was asked of it but to read. */
export const READ_PROBLEM =
  "This information could not be loaded. Check your connection and try again.";
/**
 * Said when a change the operations journal records got no answer: it may have been saved, so it is never called a
 * failure, and if it reached Valo Pay, Request history (the Operations page) has it with what happened.
 */
export const JOURNALED_WRITE_PROBLEM =
  "The request was not confirmed. If Valo Pay received it, Request history shows what happened.";
/** Said when a change Request history does not record (team, access and new lender changes) got no answer: the page itself shows whether it was saved. */
export const UNJOURNALED_WRITE_PROBLEM =
  "The request was not confirmed. Refresh this page to see whether it was saved before you try again.";

/**
 * A request's problem in the service's words, or in the fallback's when it
 * gave none (no answer, or a proxy's error page). A read and a change need
 * different fallbacks: a failed read changed nothing and is simply tried
 * again, while a change may have been saved and is checked where it is
 * recorded (`READ_PROBLEM` by default). A read's problem that took the place
 * of its list's page buttons after a page press takes their focus, where
 * `pager` names them (usePageProblemFocus).
 */
export function PilotError({
  error,
  retry,
  fallback = READ_PROBLEM,
  noticeRef,
  pager,
}: {
  error: unknown;
  retry?: () => void;
  fallback?: string;
  /** The notice, for a page that moves focus to it. */
  noticeRef?: RefObject<HTMLDivElement | null>;
  /** The label of the list's page buttons that this notice takes the place of when a page fails. */
  pager?: string;
}) {
  const notice = useRef<HTMLDivElement>(null);
  const again = usePageProblemFocus(notice, pager);
  return error ? (
    <div
      ref={(element) => {
        notice.current = element;
        if (noticeRef) noticeRef.current = element;
      }}
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
    >
      <p>{saidBy(error, fallback)}</p>
      {retry && (
        <Button
          className="mt-3"
          variant="outline"
          onClick={() => {
            again();
            retry();
          }}
        >
          Try again
        </Button>
      )}
    </div>
  ) : null;
}
/** Said on a notice about a change Request history records whose outcome is unconfirmed: a request Valo Pay received
 * outlives the form, so after closing or reloading it is found in Request history. */
export const KEPT_IN_OPERATIONS =
  "If Valo Pay received the request, you can check it in Request history, even after you close this form or reload the page.";
/** The way from such a notice to Request history (the Operations page, /operations). */
export function OpenOperations() {
  return (
    <Link
      href="/operations"
      className="inline-flex min-h-11 items-center text-primary underline"
    >
      Open Request history
    </Link>
  );
}
/**
 * A change whose answer was lost, in the standard's words for it (Request not
 * confirmed): Check original request, Open Request history for a change it
 * records, and Discard original request, which moves focus to `next`, the
 * control that sent the request where the page names it, and otherwise to the
 * page's own nearest control.
 */
export function RecoveryNotice({
  mutation,
  persistent = true,
  next,
  noticeRef,
}: {
  persistent?: boolean;
  next?: () => HTMLElement | null | undefined;
  /** Whichever notice shows, a lost answer's or a refusal's, for a page that moves focus to it. */
  noticeRef?: RefObject<HTMLDivElement | null>;
  mutation: {
    hasUnconfirmedOutcome: boolean;
    isPending: boolean;
    error: unknown;
    retryUnconfirmed(): Promise<unknown>;
    abandonUnconfirmed(): void;
  };
}) {
  return mutation.hasUnconfirmedOutcome ? (
    <div
      ref={noticeRef}
      role="alert"
      className="space-y-3 rounded-lg border border-warning-border bg-warning/20 p-4 text-sm"
    >
      <p className="font-semibold">Request not confirmed</p>
      <p>
        {persistent
          ? "We do not know yet whether Valo Pay saved this. Check the original request before you change anything. If Valo Pay received it, it stays in Request history after you leave or reload. If the check does not work, look there before you discard the original request."
          : "We do not know yet whether Valo Pay saved this. Check the original request before you change anything. This page cannot check it once you leave or reload, so it asks before you go. If the check does not work, discard the original request, then refresh this page to see whether it was saved."}
      </p>
      <PilotError error={mutation.error} fallback={persistent ? JOURNALED_WRITE_PROBLEM : UNJOURNALED_WRITE_PROBLEM} />
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          busy={mutation.isPending}
          busyLabel="Checking original request…"
          onClick={() => {
            void mutation.retryUnconfirmed().catch(() => {});
          }}
        >
          Check original request
        </Button>
        {persistent && <OpenOperations />}
        <DiscardOriginalRequest
          disabled={mutation.isPending}
          onDiscard={mutation.abandonUnconfirmed}
          next={next}
        />
      </div>
    </div>
  ) : (
    <PilotError error={mutation.error} fallback={persistent ? JOURNALED_WRITE_PROBLEM : UNJOURNALED_WRITE_PROBLEM} noticeRef={noticeRef} />
  );
}
