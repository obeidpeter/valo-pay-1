import { z } from "zod";

/** An operations-journal entry's state: waiting for confirmation, saved, or closed without saving. */
export const operationStatuses = ["pending", "completed", "cancelled"] as const;
/**
 * What a journal entry asked, safe to show: the action or route in plain words, the record it names (its kind and ID)
 * and at most three short fields the request named (an action, a decision, a status, a kind, a format). Never a name,
 * reference, reason, amount or file, and never the body.
 */
export const operationSummarySchema = z.object({
  action: z.string(), targetKind: z.string().nullable(), targetId: z.string().nullable(),
  details: z.array(z.object({ name: z.string(), value: z.string() }).strict()).max(3),
}).strict();
/** An entry's summary. */
export type OperationSummary = z.infer<typeof operationSummarySchema>;
/** One journal entry: what was asked, by whom, in which role, and whether the service confirmed it; a completed entry
 * names the record it produced. `summary` is null when the request is sealed by payload encryption or its payload
 * expired under retention. */
export const operationViewSchema = z.object({
  id: z.string(), label: z.string(), actor: z.string(), role: z.string(), status: z.enum(operationStatuses),
  createdAt: z.string(), updatedAt: z.string(), message: z.string(), recordId: z.string().nullable(), recordKind: z.string().nullable(),
  summary: operationSummarySchema.nullable(),
}).strict();
/** One journal entry as the Operations page lists it. */
export type OperationView = z.infer<typeof operationViewSchema>;
/** The caller's journal for one lender, newest first, 25 rows a page. */
export const operationListSchema = z.object({ items: z.array(operationViewSchema).max(25), total: z.number().int().min(0), offset: z.number().int().min(0) }).strict();
/** How many of the caller's requests in one lender wait for confirmation. */
export const pendingOperationsSchema = z.object({ pending: z.number().int().min(0) }).strict();
/** A recovered or repeated journal entry's answer: the original route's own answer, whatever its shape. */
export const operationReplaySchema = z.record(z.unknown());
/** Browser recovery identifies its own original request without sending its payload or exposing a key in a URL. */
export const operationLookupInputSchema = z.object({ key: z.string().uuid(), method: z.enum(['POST', 'PATCH']), path: z.string().max(1000).regex(/^\/v1\/[^?#\\\s]+$/) }).strict();
/** The same owner, actor, role and lender's entry, or no received request; absence is not proof of cancellation. */
export const operationLookupSchema = z.object({ operation: operationViewSchema.nullable() }).strict();
/** Only writes whose body and receipt are journaled in one workspace transaction can recover after a reload. */
export function recoverableOperation(method: string, path: string, body: unknown): boolean {
  if (method === 'PATCH') return /^\/v1\/records\/[^/]+\/[^/]+$/.test(path) || path === '/v1/settings';
  if (method !== 'POST') return false;
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  if (path === '/v1/actions') return input.action !== 'set_role';
  if (path === '/v1/imports') return input.commit === true;
  return path === '/v1/connected/actions' || /^\/v1\/records\/[^/]+$/.test(path) || path === '/v1/exports'
    || /^\/v1\/exports\/[^/]+\/retry$/.test(path)
    || /^\/v1\/pilot\/batches(?:\/[^/]+\/(?:save|commit))?$/.test(path)
    || /^\/v1\/pilot\/cases\/[^/]+$/.test(path)
    || /^\/v1\/pilot\/import-corrections(?:\/[^/]+\/(?:decision|recovery))?$/.test(path)
    || /^\/v1\/pilot\/close-reviews\/(?:prepare|[^/]+\/(?:decision|reassign))$/.test(path)
    || /^\/v1\/sources\/(?:manifests|profiles(?:\/[^/]+\/save)?|paystack\/fixtures|events\/[^/]+\/replay)$/.test(path)
    || /^\/v1\/work\/(?:notifications\/read|handovers\/acknowledge)$/.test(path)
    || /^\/v1\/lifecycle\/(?:policy|holds|runs(?:\/[^/]+\/(?:approve|execute))?)$/.test(path);
}
