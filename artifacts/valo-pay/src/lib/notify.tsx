import type { ReactNode } from 'react';
import { toast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';

/**
 * The two kinds of notice the console raises after an action, and nothing
 * else. A "done" notice confirms what happened and where its result is; it
 * is announced politely and goes away on its own after a moment, pausing
 * while pointed at or focused. A "problem" notice says what did not happen
 * and what to do; it is announced at once and stays until dismissed,
 * because an error that disappears before it is read is no error message
 * at all. Anything whose result is shown on the page itself gets no notice
 * (Nielsen 1, 3, 8 and 9; Shneiderman: informative feedback; universal
 * design: perceptible information, low physical effort).
 */
export const DONE_DURATION_MS = 6000;

/** An action offered on a done notice, such as Open for a pack the browser kept closed. */
export type NoticeAction = { label: string; altText: string; onClick: () => void };

/** A done notice: what happened and where its result is; it goes away on its own. */
export function notifyDone(title: string, description?: string, action?: NoticeAction) {
  return toast({
    title,
    description,
    type: 'background',
    duration: DONE_DURATION_MS,
    action: action ? <ToastAction altText={action.altText} onClick={action.onClick}>{action.label}</ToastAction> : undefined,
  });
}

/** A problem notice: what did not happen and what to do, such as a link to where to do it; it stays until dismissed. */
export function notifyProblem(title: string, description?: ReactNode) {
  return toast({ title, description, variant: 'destructive', type: 'foreground', duration: Infinity });
}

/** The request's reference from the service: the requestId in its error body, or the X-Request-Id header when the body has none. */
export function referenceOf(error: unknown): string | undefined {
  const inBody = (error as { data?: { requestId?: unknown } } | null)?.data?.requestId;
  if (typeof inBody === 'string' && inBody.trim()) return inBody.trim();
  const headers = (error as { headers?: { get?: (name: string) => string | null } } | null)?.headers;
  const inHeader = headers?.get?.('x-request-id');
  return typeof inHeader === 'string' && inHeader.trim() ? inHeader.trim() : undefined;
}

/** Said when no answer came back at all: the browser's own words for that ("Failed to fetch", "signal timed out") mean nothing to the reader. */
export const NO_ANSWER = 'No answer came back from Valo Pay.';

/**
 * An error in words for the reader: the service's own (`data.error`), plain
 * words when no answer arrived (a network failure or a timeout), the fallback
 * when an answer came without words of its own (a proxy's error page, an
 * unreadable body), and otherwise the console's own message. Never the
 * browser's error text or an HTTP status line.
 */
export function errorWords(error: unknown, fallback: string): string {
  const said = (error as { data?: { error?: unknown } } | null)?.data?.error;
  if (typeof said === 'string' && said.trim()) return said.trim();
  if (error instanceof TypeError || (typeof DOMException !== 'undefined' && error instanceof DOMException)) return NO_ANSWER;
  if (typeof (error as { status?: unknown } | null)?.status === 'number') return fallback;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.trim() ? message.trim() : fallback;
}

/**
 * The words the server gave, or a plain fallback; never an HTTP status line.
 * When the service itself failed (a 5xx), its words are general, so the
 * request's reference follows them: quoting it finds the request in the log.
 */
export function saidBy(error: unknown, fallback: string): string {
  const said = (error as { data?: { error?: unknown } } | null)?.data?.error;
  const words = typeof said === 'string' && said.trim() ? said.trim() : fallback;
  const status = (error as { status?: unknown } | null)?.status;
  const reference = typeof status === 'number' && status >= 500 ? referenceOf(error) : undefined;
  return reference ? `${words} Support reference: ${reference}.` : words;
}
