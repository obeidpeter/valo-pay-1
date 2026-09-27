import { useEffect, useRef } from 'react';
import { useMutation, type UseMutationOptions } from '@tanstack/react-query';
import {
  performAction, createRecord, updateRecord, updateSettings, importRecords, createExport, retryExportJob,
  type PerformActionMutationVariables, type CreateRecordMutationVariables,
  type UpdateRecordMutationVariables, type UpdateSettingsMutationVariables,
  type ImportRecordsMutationVariables, type CreateExportMutationVariables, type RetryExportJobMutationVariables,
} from '@workspace/api-client-react';
import type { ZodTypeAny } from 'zod';
import { actionResultSchema, canonicalJson, definitiveRefusalStatuses, exportResultSchema, importResultSchema, recoverableOperation, settingsViewSchema, valopayRecordSchema } from '@workspace/valopay-schema';
import { readAnswer } from './answers';
import { useSubmissionRecovery, type SubmissionIdentity } from './submission-recovery';

/** Object key order must not turn an unchanged retry into another operation: the canonical form, the same in any browser locale. */
export function submissionFingerprint(value: unknown): string {
  return canonicalJson(value);
}

type RequestOptions = Parameters<typeof performAction>[2];
type Options<Result, Variables> = { mutation?: UseMutationOptions<Result, Error, Variables>; request?: RequestOptions; recovery?: (variables: Variables) => SubmissionIdentity | null };

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

/** The service says the request's journal entry is cancelled (`operation: "cancelled"`): a cancelled entry never
 * completes, so neither this request nor an earlier one with its key was or can be saved. Proof even for a request
 * held as unconfirmed. */
export function requestClosed(error: unknown): boolean {
  const response = error as { status?: number; data?: { error?: unknown; operation?: unknown } } | null;
  return Boolean(response?.status && response.status >= 400 && response.data?.operation === 'cancelled' && typeof response.data.error === 'string');
}

/** The service says a request with this key was saved, is still running or is not confirmed yet (`operation`
 * completed, running or pending): whatever this answer refused, the key is kept to recover its result. */
export function requestOpen(error: unknown): boolean {
  const operation = (error as { data?: { operation?: unknown } } | null)?.data?.operation;
  return operation === 'completed' || operation === 'running' || operation === 'pending';
}

/** A structured refusal the service treats as final for its key (400, 403, 404, 409, 410, 413, 415, 422): the same
 * request would be refused again, and its key cannot run again. A 401 or 429 keeps the key, as does a refusal that
 * says a request with the key was saved or is still open (requestOpen). */
export function definitiveRefusal(error: unknown): boolean {
  const response = error as { status?: number; data?: { error?: unknown } } | null;
  return (definitiveRefusalStatuses as readonly number[]).includes(response?.status ?? 0) && typeof response?.data?.error === 'string' && !requestOpen(error);
}

/** A refusal of a request the service saved earlier (a 4xx with `operation: "completed"`): its saved answer is
 * withheld, because the permission or review it was made under changed, or retention removed it. Retrying the same
 * request cannot recover it, so the request is over; a failure (5xx) may still give the answer on a retry. */
export function savedAnswerWithheld(error: unknown): boolean {
  const response = error as { status?: number; data?: { error?: unknown; operation?: unknown } } | null;
  return Boolean(response?.status && response.status >= 400 && response.status < 500 && response.data?.operation === 'completed' && typeof response.data.error === 'string');
}

function recoveryError(message: string) {
  return Object.assign(new Error(message), { data: { error: message } });
}

/**
 * HTTP success alone is not confirmation when its receipt is missing or malformed. Receipts are read with the
 * shared schemas the contract checks field for field (lib/valopay-schema), not the whole generated contract, so a
 * page that writes does not load every schema the API has; a field a newer service added is accepted (readAnswer).
 */
async function checkedResponse<Result>(response: Promise<Result>, schema: ZodTypeAny, matches: (value: Result) => boolean = () => true): Promise<Result> {
  const value = await response;
  if (readAnswer(schema, value) === undefined || !matches(value)) {
    throw recoveryError('The service returned an incomplete confirmation. The request may have been saved. Retry the original request to check its result.');
  }
  return value;
}

const exportReceipt = (value: Awaited<ReturnType<typeof createExport>>) => Boolean(value.id && value.downloadUrl && ((value.status && value.status !== 'ready') || value.checksum));

/**
 * A key belongs to one form/action session and unchanged payload (including lender).
 * Keep it when a response is lost: the server can replay its already committed result.
 * A changed submission is allowed only after a confirmed outcome: a receipt, a
 * refusal of the first attempt, or a refusal the service marks as cancelled. A
 * finished request cannot run again under its key, so an identical resubmission
 * after it gets a new key. Discarding the original (abandonUnconfirmed) is a
 * person's deliberate choice after a warning, never automatic. Only the opaque
 * request identity is remembered for a reload, never its body or fingerprint.
 */
export function useSafeMutation<Result, Variables>(send: (variables: Variables, request: RequestOptions) => Promise<Result>, options: Options<Result, Variables> = {}, scope?: unknown, writes: (variables: Variables) => boolean = () => true) {
  const recovery = useSubmissionRecovery();
  const attempt = useRef<{ fingerprint: string; key: string; variables: Variables; pending: boolean; unconfirmed: boolean; recovery: typeof recovery } | null>(null);
  const previousScope = useRef(scope);
  if (previousScope.current !== scope || (attempt.current?.recovery && attempt.current.recovery.scope !== recovery?.scope)) {
    const original = attempt.current;
    previousScope.current = scope; attempt.current = null;
    // Closing/reopening a mounted dialog must promote its marker too. Notify the parent after this render.
    if (original?.recovery) queueMicrotask(() => original.recovery?.keep(original.key));
  }
  useEffect(() => () => { if (attempt.current) attempt.current.recovery?.keep(attempt.current.key); }, []);
  const mutation = useMutation<Result, Error, Variables>({
    ...options.mutation,
    retry: false,
    mutationFn: async variables => {
      const fingerprint = submissionFingerprint(variables);
      if (attempt.current?.pending) throw recoveryError('This request is still in progress. Wait for its result.');
      if (attempt.current?.unconfirmed && attempt.current.fingerprint !== fingerprint) throw recoveryError('The previous request has an unconfirmed outcome. Retry the original request before changing it.');
      const identity = options.recovery?.(variables);
      if (identity) recovery?.assertAvailable(attempt.current?.key);
      if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, key: crypto.randomUUID(), variables: structuredClone(variables), pending: false, unconfirmed: false, recovery: identity ? recovery : null };
      const current = attempt.current;
      if (identity && writes(current.variables)) recovery?.remember(current.key, identity);
      current.pending = true;
      const headers = new Headers(options.request?.headers);
      headers.set('Idempotency-Key', current.key);
      try {
        const result = await send(current.variables, { ...options.request, headers });
        current.recovery?.forget(current.key);
        if (attempt.current === current) attempt.current = null;
        return result;
      } catch (error) {
        // A later auth/policy rejection can occur before replay lookup. It does
        // not establish whether the original request committed, unless the
        // service says the key's journal entry is cancelled: then nothing sent
        // with it was saved or can be.
        const over = requestClosed(error);
        current.unconfirmed = over ? false : current.unconfirmed || (writes(current.variables) && outcomeIsUnconfirmed(error));
        // A finished request (refused for good, or saved nothing) cannot run again under its key: the next submission needs a new one.
        if (!current.unconfirmed && (over || nothingSaved(error) || definitiveRefusal(error))) { current.recovery?.forget(current.key); if (attempt.current === current) attempt.current = null; }
        throw error;
      } finally {
        current.pending = false;
      }
    },
  });
  return {
    ...mutation,
    hasUnconfirmedOutcome: Boolean(attempt.current?.unconfirmed),
    retryUnconfirmed: (): Promise<Result> => {
      if (!attempt.current?.unconfirmed) return Promise.reject(recoveryError('There is no unconfirmed request to retry.'));
      return mutation.mutateAsync(attempt.current.variables);
    },
    /** Discards private in-memory fields. A journaled request's identity remains until server recovery settles it. */
    abandonUnconfirmed: () => {
      if (attempt.current?.pending) return;
      if (attempt.current) attempt.current.recovery?.keep(attempt.current.key);
      attempt.current = null;
      mutation.reset();
    },
  };
}

/** Metadata only; identical route rules are used by the server's journal middleware. */
export function submissionIdentity(method: 'POST' | 'PATCH', path: string, merchantId: string, data: unknown): SubmissionIdentity | null {
  return merchantId && recoverableOperation(method, path, data) ? { method, path, merchantId } : null;
}

export function useSafePerformAction(options?: Options<Awaited<ReturnType<typeof performAction>>, PerformActionMutationVariables>, scope?: unknown) {
  return useSafeMutation((v: PerformActionMutationVariables, request) => checkedResponse(performAction(v.data, v.params, request), actionResultSchema, value => Boolean(value.message.trim()) && (!value.record || value.record.merchantId === v.params.merchantId)), { ...options, recovery: v => submissionIdentity('POST', '/v1/actions', v.params.merchantId, v.data) }, scope);
}
export function useSafeCreateRecord(options?: Options<Awaited<ReturnType<typeof createRecord>>, CreateRecordMutationVariables>, scope?: unknown) {
  return useSafeMutation((v: CreateRecordMutationVariables, request) => checkedResponse(createRecord(v.kind, v.data, v.params, request), valopayRecordSchema, value => Boolean(value.id) && value.merchantId === v.params.merchantId && value.kind === v.kind), { ...options, recovery: v => submissionIdentity('POST', `/v1/records/${v.kind}`, v.params.merchantId, v.data) }, scope);
}
export function useSafeUpdateRecord(options?: Options<Awaited<ReturnType<typeof updateRecord>>, UpdateRecordMutationVariables>, scope?: unknown) {
  return useSafeMutation((v: UpdateRecordMutationVariables, request) => checkedResponse(updateRecord(v.kind, v.id, v.data, v.params, request), valopayRecordSchema, value => value.id === v.id && value.merchantId === v.params.merchantId && value.kind === v.kind), { ...options, recovery: v => submissionIdentity('PATCH', `/v1/records/${v.kind}/${v.id}`, v.params.merchantId, v.data) }, scope);
}
export function useSafeUpdateSettings(options?: Options<Awaited<ReturnType<typeof updateSettings>>, UpdateSettingsMutationVariables>, scope?: unknown) {
  return useSafeMutation((v: UpdateSettingsMutationVariables, request) => checkedResponse(updateSettings(v.data, v.params, request), settingsViewSchema, value => value.merchant.id === v.params.merchantId), { ...options, recovery: v => submissionIdentity('PATCH', '/v1/settings', v.params.merchantId, v.data) }, scope);
}
export function useSafeImportRecords(options?: Options<Awaited<ReturnType<typeof importRecords>>, ImportRecordsMutationVariables>, scope?: unknown) {
  return useSafeMutation((v: ImportRecordsMutationVariables, request) => checkedResponse(importRecords(v.data, v.params, request), importResultSchema, value => [value.valid, value.invalid, value.imported, value.skipped ?? 0].every(count => Number.isSafeInteger(count) && count >= 0)), { ...options, recovery: v => submissionIdentity('POST', '/v1/imports', v.params.merchantId, v.data) }, scope, v => Boolean(v.data.commit));
}
export function useSafeCreateExport(options?: Options<Awaited<ReturnType<typeof createExport>>, CreateExportMutationVariables>, scope?: unknown) {
  return useSafeMutation((v: CreateExportMutationVariables, request) => checkedResponse(createExport(v.data, v.params, request), exportResultSchema, exportReceipt), { ...options, recovery: v => submissionIdentity('POST', '/v1/exports', v.params.merchantId, v.data) }, scope);
}
export function useSafeRetryExportJob(options?: Options<Awaited<ReturnType<typeof retryExportJob>>, RetryExportJobMutationVariables>, scope?: unknown) {
  return useSafeMutation((v: RetryExportJobMutationVariables, request) => checkedResponse(retryExportJob(v.id, v.params, request), exportResultSchema, value => value.id === v.id && exportReceipt(value)), { ...options, recovery: v => submissionIdentity('POST', `/v1/exports/${v.id}/retry`, v.params.merchantId, {}) }, scope);
}
