/** Reads are repeated at most this many times, with TanStack Query's growing delay (1 s, then 2 s). */
export const QUERY_RETRIES = 2;

/**
 * Whether a failed read is worth repeating: only when no answer arrived (a
 * network failure or a timeout) or the service failed or timed out (5xx, 408).
 * A refusal (400, 401, 403, 404, 409, 410 ...) answers the same way again, and
 * a 429 asks for a minute's wait, so they show at once. An answer that arrived
 * but could not be read or checked is not repeated either.
 */
export function retryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= QUERY_RETRIES) return false;
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status >= 500 || status === 408;
  return error instanceof TypeError
    || (typeof DOMException !== 'undefined' && error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'NetworkError'));
}

/**
 * How long the service asked the caller to wait, from the Retry-After header
 * a refusal carries (a 429, or a 503 while a lender is busy): whole seconds or
 * an HTTP date, measured from `now`. Undefined when it asked for no wait.
 */
export function retryAfterMs(error: unknown, now = Date.now()): number | undefined {
  const headers = (error as { headers?: { get?: (name: string) => string | null } } | null)?.headers;
  const value = headers?.get?.('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** The workspace is asked for again every thirty seconds, so a role or lender change elsewhere reaches an open console. */
export const WORKSPACE_REFRESH_MS = 30_000;

type WorkspaceQueryState = { state: { status: string; error: unknown; errorUpdatedAt: number } };

/** After a refresh the service refused with a wait (Retry-After), the time before which the workspace is not asked again. */
export function workspaceWaitUntil(query: WorkspaceQueryState): number | undefined {
  if (query.state.status !== 'error') return undefined;
  const wait = retryAfterMs(query.state.error, query.state.errorUpdatedAt);
  return wait === undefined ? undefined : query.state.errorUpdatedAt + wait;
}

/** The next automatic workspace refresh: thirty seconds on, or once the wait the service asked for has passed if that is later. */
export function workspaceRefreshInterval(query: WorkspaceQueryState, now = Date.now()): number {
  const until = workspaceWaitUntil(query);
  return until === undefined ? WORKSPACE_REFRESH_MS : Math.max(WORKSPACE_REFRESH_MS, until - now);
}

/** Returning to the tab refreshes a stale workspace, except while the service's wait lasts. */
export function workspaceRefreshOnFocus(query: WorkspaceQueryState, now = Date.now()): boolean {
  const until = workspaceWaitUntil(query);
  return until === undefined || now >= until;
}
