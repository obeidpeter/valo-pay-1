import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { LookedFor, Notice } from '@/components/notice';
import { PublicFrame } from '@/components/public-frame';
import { AuthShow } from '@/lib/auth';
import { formatDate } from '@/lib/formatters';
import { referenceOf } from '@/lib/notify';
import type { WorkspaceRefreshFailure } from '@/lib/workspace-context';
import { StaffSession } from './staff-session';
import { ContextualHelp } from './contextual-help';

/**
 * Shown in place of the console when the workspace cannot be loaded at all.
 * Nothing in the console works without a workspace, so this replaces the pages
 * rather than sitting inside them, in the same frame and card as the other
 * notices. It says what happened in the words the situation calls for, points
 * to Operations for a change saved just before, and offers Try again with its
 * progress visible, the start and, where sign-in exists, sign-in (Nielsen 1
 * and 9; Dix: recoverability; Shneiderman: informative feedback). A workspace
 * already on the screen whose refresh fails is not this: see
 * WorkspaceRefreshProblem.
 */

export type WorkspaceExplanation = { title: string; lines: string[]; reportTime?: boolean; reference?: string };

/** What the service said, when it said something written for the person reading it. */
function serviceWords(error: unknown): string {
  const said = (error as { data?: { error?: unknown } } | null)?.data?.error;
  return typeof said === 'string' && said.trim() ? said.trim() : '';
}

/**
 * The API's own 4xx wording is plain language written for the person
 * reading it (a refused new sandbox, the request limit), so it is shown as
 * is. A 5xx body may carry internals, so it is not shown; a network failure
 * has no body at all.
 */
export function explainWorkspaceError(error: unknown): WorkspaceExplanation {
  const status = (error as { status?: unknown } | null)?.status;
  const message = serviceWords(error);
  if (typeof status !== 'number') return { title: 'We could not load your workspace', lines: ['Valo Pay could not be reached. Check your connection and try again.'] };
  if (status === 429) return { title: 'Please wait before trying again', lines: [message || 'Too many requests were sent from your connection. Try again shortly.'] };
  if (status >= 500) return { title: 'We could not load your workspace', lines: ['Valo Pay is not available right now. Try again in a few minutes.'], reportTime: true, reference: referenceOf(error) };
  if (status === 401) return { title: 'Sign in to open this workspace', lines: [message || 'Your sign-in session is missing or has ended.', 'Sign in with the account your organisation invited. Then check access again.'] };
  if (status === 403) return { title: 'Your account cannot open this workspace', lines: [message || 'Your account does not have access to this workspace.', 'Check that you chose the right organisation. If you did, ask an Admin there to check your invitation and lender access. Choosing an organisation does not give you access.'] };
  return { title: 'We could not load your workspace', lines: [message || 'Try again.'] };
}

/** Where a person checks a change whose answer they did not see: Request history lists every request that reached Valo Pay, with its outcome. */
const CHECK_OPERATIONS = 'If you had just saved a change, check Request history once your workspace opens, before you send it again.';

export function WorkspaceUnavailable({ error, retry, busy }: { error: unknown; retry: () => void; busy: boolean }) {
  const [at] = useState(() => new Date().toISOString());
  const { title, lines, reportTime, reference } = explainWorkspaceError(error);
  useEffect(() => { document.title = 'Workspace unavailable · Valo Pay'; }, []);
  return (
    <PublicFrame>
      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16 focus:outline-none">
        <Notice
          role="alert"
          title={title}
          actions={<>
            <Button onClick={retry} busy={busy} busyLabel="Trying again…">Try again</Button>
            <AuthShow when="signed-out"><Button asChild variant="outline"><Link href="/sign-in">Sign in</Link></Button></AuthShow>
            <Button asChild variant="outline"><Link href="/">Back to home</Link></Button>
          </>}
        >
          {lines.map((line) => <p key={line}>{line}</p>)}
          {reportTime && (reference
            ? <p>When reporting the problem, include this time and support reference: <LookedFor>{formatDate(at)}</LookedFor>, <LookedFor>{reference}</LookedFor>.</p>
            : <p>When reporting the problem, include this time: <LookedFor>{formatDate(at)}</LookedFor>.</p>)}
          <p>{CHECK_OPERATIONS}</p>
          {[401,403].includes(Number((error as { status?: number })?.status)) && <StaffSession />}
          <ContextualHelp topic={[401,403].includes(Number((error as { status?: number })?.status)) ? 'access' : 'recovery'} />
        </Notice>
      </main>
    </PublicFrame>
  );
}

/** Why a refresh failed, in a sentence: the service's own words for a refusal, general words for a failure, with its support reference. */
function refreshReason(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  const message = serviceWords(error);
  if (typeof status !== 'number') return 'Valo Pay could not be reached.';
  if (status >= 500) {
    const reference = referenceOf(error);
    return `Valo Pay could not answer.${reference ? ` Support reference: ${reference}.` : ''}`;
  }
  if (status === 429) return message || 'Too many requests were sent from your connection.';
  return message || 'Valo Pay refused the request.';
}

/**
 * A refresh of the workspace on the screen that failed: the pages, their
 * forms and dialogs, drafts and requests waiting to be confirmed all stay,
 * and this notice above the page says the workspace could not be refreshed,
 * why, when what is shown was loaded, and when the next automatic refresh is
 * if the service asked for a wait. It claims nothing about what changed: a
 * save whose answer was lost is checked in Operations, which it links to.
 * Try again refreshes now (Nielsen 1, 3 and 9; Dix: robustness).
 */
export function WorkspaceRefreshProblem({ failure, staff = false }: { failure: WorkspaceRefreshFailure; staff?: boolean }) {
  const updated = failure.updatedAt ? new Date(failure.updatedAt).toISOString() : '';
  const next = failure.waitUntil ? new Date(failure.waitUntil).toISOString() : '';
  const status = Number((failure.error as { status?: unknown } | null)?.status);
  return (
    <div role="status" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning-border bg-warning px-4 py-3 text-xs text-warning-foreground print:hidden">
      <div className="min-w-[min(100%,16rem)] flex-1 space-y-1">
        <p><span className="font-semibold">Your workspace could not be refreshed.</span> {refreshReason(failure.error)} {updated ? <>Showing the workspace loaded <time dateTime={updated}>{formatDate(updated)}</time>.</> : <>Showing the workspace loaded earlier.</>}{next && <> The next automatic refresh is after <time dateTime={next}>{formatDate(next)}</time>.</>}</p>
        <p>Open pages and forms are kept. If a save was not confirmed, check it in <Link href="/operations" className="font-medium underline underline-offset-2">Request history</Link> before you send it again.</p>
        {staff && [401, 403].includes(status) && <StaffSession />}
      </div>
      <Button variant="outline" size="sm" busy={failure.busy} busyLabel="Trying again…" onClick={failure.retry}>Try again</Button>
    </div>
  );
}
