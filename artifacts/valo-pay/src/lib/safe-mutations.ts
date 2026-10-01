import { useMutation, type UseMutationOptions } from '@tanstack/react-query';
import {
  performAction, createRecord, updateRecord, updateSettings, importRecords, createExport, retryExportJob,
  type PerformActionMutationVariables, type CreateRecordMutationVariables,
  type UpdateRecordMutationVariables, type UpdateSettingsMutationVariables,
  type ImportRecordsMutationVariables, type CreateExportMutationVariables, type RetryExportJobMutationVariables,
} from '@workspace/api-client-react';
import type { ZodTypeAny } from 'zod';
import { actionResultSchema, exportResultSchema, importResultSchema, recoverableOperation, settingsViewSchema, valopayRecordSchema } from '@workspace/valopay-schema';
import { INCOMPLETE_CONFIRMATION, readAnswer } from './answers';
import type { SubmissionIdentity } from './submission-recovery';
import { standardSubmissionPolicy, useSubmissionAttempt } from './submission-attempt';
export { definitiveRefusal, nothingSaved, outcomeIsUnconfirmed, requestClosed, requestOpen, savedAnswerWithheld, submissionFingerprint } from './submission-outcomes';

type RequestOptions = Parameters<typeof performAction>[2];
type Options<Result, Variables> = { mutation?: UseMutationOptions<Result, Error, Variables>; request?: RequestOptions; recovery?: (variables: Variables) => SubmissionIdentity | null };

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
    throw recoveryError(INCOMPLETE_CONFIRMATION);
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
  const attempt = useSubmissionAttempt({
    scope,
    prepare: (variables: Variables) => variables,
    identity: variables => options.recovery?.(variables),
    writes,
    policy: standardSubmissionPolicy,
    pendingMessage: 'This request is still in progress. Wait for its result.',
    problem: recoveryError,
  });
  const mutation = useMutation<Result, Error, Variables>({
    ...options.mutation,
    retry: false,
    mutationFn: variables => attempt.execute(variables, ({ payload, key }) => {
      const headers = new Headers(options.request?.headers);
      headers.set('Idempotency-Key', key);
      return send(payload, { ...options.request, headers });
    }),
  });
  return {
    ...mutation,
    hasUnconfirmedOutcome: attempt.hasUnconfirmedOutcome,
    retryUnconfirmed: async (): Promise<Result> => mutation.mutateAsync(attempt.unconfirmedInput()),
    /** Discards private in-memory fields. A journaled request's identity remains until server recovery settles it. */
    abandonUnconfirmed: () => {
      if (attempt.abandon()) mutation.reset();
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
