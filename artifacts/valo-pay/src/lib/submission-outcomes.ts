import { canonicalJson, definitiveRefusalStatuses } from '@workspace/valopay-schema';

/** Object key order must not turn an unchanged retry into another operation, in any browser locale. */
export function submissionFingerprint(value: unknown): string {
  return canonicalJson(value);
}

/** A structured rejection confirms no write; transport/parse/5xx errors do not. */
export function outcomeIsUnconfirmed(error: unknown): boolean {
  if (nothingSaved(error) || requestClosed(error)) return false;
  const response = error as { status?: number; data?: { error?: unknown } } | null;
  return !(response?.status && response.status >= 400 && response.status < 500 && response.status !== 408 && typeof response.data?.error === 'string');
}

/** The server rolled the request back and says so: nothing was saved, whatever the status. */
export function nothingSaved(error: unknown): boolean {
  const response = error as { status?: number; data?: { error?: unknown; committed?: unknown } } | null;
  return Boolean(response?.status && response.status >= 500 && response.data?.committed === false && typeof response.data.error === 'string');
}

/** A cancelled journal entry proves nothing sent with its key was saved or can still be saved. */
export function requestClosed(error: unknown): boolean {
  const response = error as { status?: number; data?: { error?: unknown; operation?: unknown } } | null;
  return Boolean(response?.status && response.status >= 400 && response.data?.operation === 'cancelled' && typeof response.data.error === 'string');
}

/** Keep a key the service says was saved, is running, or is not yet confirmed, even if this answer refused it. */
export function requestOpen(error: unknown): boolean {
  const operation = (error as { data?: { operation?: unknown } } | null)?.data?.operation;
  return operation === 'completed' || operation === 'running' || operation === 'pending';
}

/** A final structured refusal cannot run again under its key. Authentication and rate-limit refusals are not final. */
export function definitiveRefusal(error: unknown): boolean {
  const response = error as { status?: number; data?: { error?: unknown } } | null;
  return (definitiveRefusalStatuses as readonly number[]).includes(response?.status ?? 0) && typeof response?.data?.error === 'string' && !requestOpen(error);
}

/** A 4xx for an earlier completed request withholds its saved answer; a 5xx may still recover that answer. */
export function savedAnswerWithheld(error: unknown): boolean {
  const response = error as { status?: number; data?: { error?: unknown; operation?: unknown } } | null;
  return Boolean(response?.status && response.status >= 400 && response.status < 500 && response.data?.operation === 'completed' && typeof response.data.error === 'string');
}
