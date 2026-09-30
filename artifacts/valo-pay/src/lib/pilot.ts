import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { z, ZodTypeAny } from "zod";
import { useWorkspace } from "./workspace-context";
import { keepRowsWhilePaging } from "./use-record-pagination";
import { submissionIdentity, useSafeMutation } from "./safe-mutations";
import { answerProblem, INCOMPLETE_CONFIRMATION, readAnswer, UNREADABLE_ANSWER } from "./answers";
import {
  encryptionVerificationSchema, importCorrectionViewSchema, invitationCreatedSchema, lifecycleRunViewSchema, lifecycleViewSchema, merchantSchema,
  messageSchema, operationReplaySchema, payloadProtectionSchema, paystackFixtureResultSchema, providerEventViewSchema, staffLenderAccessSchema,
  staffChangeResultSchema, valopayRecordSchema, workReceiptSchema,
} from "@workspace/valopay-schema";

/**
 * One pilot, team or operations request, its answer read through the shared
 * schema the API checked it with. A refusal throws with its status and body;
 * an answer the schema does not describe throws `unreadable` in plain words
 * (for a read, the page shows the problem; for a write, the outcome is held
 * as unconfirmed), so a malformed answer is never shown as data.
 */
export async function pilotRequest<S extends ZodTypeAny>(
  path: string,
  schema: S,
  options: RequestInit = {},
  unreadable = UNREADABLE_ANSWER,
): Promise<z.output<S>> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: "same-origin",
    ...options,
    signal: options.signal || AbortSignal.timeout(25000),
    headers: new Headers({
      "Content-Type": "application/json",
      ...Object.fromEntries(new Headers(options.headers)),
    }),
  });
  // A proxy's HTML error page is not JSON: the status still says what happened (a 5xx is worth repeating).
  const data = await response.json().catch(() => undefined);
  if (!response.ok)
    throw Object.assign(
      new Error(data?.error || "The request could not be completed."),
      { status: response.status, data: data ?? {} },
    );
  const answer = readAnswer(schema, data);
  if (answer === undefined) throw answerProblem(unreadable);
  return answer;
}
export function lenderPath(
  path: string,
  merchantId: string | null,
  offset?: number,
) {
  return `${path}${path.includes("?") ? "&" : "?"}merchantId=${encodeURIComponent(merchantId || "")}${offset ? `&offset=${offset}` : ""}`;
}
/**
 * A pilot read through its shared answer schema, scoped to the selected lender unless `lender` is false. Another page
 * of the same list (its path's `offset` or `limit`) keeps the rows shown until it arrives.
 */
export function usePilotQuery<S extends ZodTypeAny>(path: string, schema: S, lender = true) {
  const { merchantId, workspace } = useWorkspace();
  const queryKey = ["pilot", workspace?.actor, merchantId, path], client = useQueryClient();
  return useQuery<z.output<S>>({
    queryKey,
    enabled: Boolean(workspace) && (!lender || !!merchantId),
    placeholderData: keepRowsWhilePaging(queryKey, client),
    queryFn: ({ signal }) =>
      pilotRequest(lender ? lenderPath(path, merchantId) : path, schema, { signal }),
  });
}
type Receipt = { merchantId?: unknown; kind?: unknown; actor?: unknown; preview?: { batchId?: unknown; targetId?: unknown }; proposalDigest?: unknown; event?: { mode?: unknown } };
/**
 * What each pilot write answers: its schema, and what must hold of it for this
 * request (the lender, the kind of record, the proposal). A write whose path
 * is not here fails closed, as an incomplete confirmation.
 */
const receipts: Array<{ path: RegExp; schema: ZodTypeAny; matches?: (answer: Receipt, input: Record<string, unknown>, merchantId: string | null, actor?: string) => boolean }> = [
  { path: /^\/pilot\/lenders$/, schema: merchantSchema },
  { path: /^\/pilot\/batches(?:\/[^/]+\/(?:save|commit))?$/, schema: valopayRecordSchema, matches: (answer, _input, merchantId) => answer.kind === "import-batches" && answer.merchantId === merchantId },
  { path: /^\/pilot\/cases\/[^/]+$/, schema: valopayRecordSchema, matches: (answer, _input, merchantId) => answer.kind === "exceptions" && answer.merchantId === merchantId },
  { path: /^\/pilot\/close-reviews\/(?:prepare|[^/]+\/(?:decision|reassign))$/, schema: valopayRecordSchema, matches: (answer, _input, merchantId) => answer.kind === "close-reviews" && answer.merchantId === merchantId },
  { path: /^\/pilot\/import-corrections(?:\/[^/]+\/(?:decision|recovery))?$/, schema: importCorrectionViewSchema, matches: (answer, input, merchantId) => answer.merchantId === merchantId && (!input.batchId || answer.preview?.batchId === input.batchId) && (!input.targetId || answer.preview?.targetId === input.targetId) && (!input.proposalDigest || answer.proposalDigest === input.proposalDigest) },
  { path: /^\/sources\/profiles(?:\/[^/]+\/save)?$/, schema: valopayRecordSchema, matches: (answer, _input, merchantId) => answer.kind === "source-profiles" && answer.merchantId === merchantId },
  { path: /^\/sources\/manifests$/, schema: valopayRecordSchema, matches: (answer, _input, merchantId) => answer.kind === "source-manifests" && answer.merchantId === merchantId },
  { path: /^\/sources\/paystack\/fixtures$/, schema: paystackFixtureResultSchema, matches: (answer) => answer.event?.mode === "fixture" },
  { path: /^\/sources\/events\/[^/]+\/replay$/, schema: providerEventViewSchema },
  { path: /^\/work\/(?:notifications\/read|handovers\/acknowledge)$/, schema: workReceiptSchema, matches: (answer, _input, merchantId, actor) => answer.merchantId === merchantId && answer.actor === actor },
  { path: /^\/lifecycle\/runs(?:\/[^/]+\/(?:approve|execute))?$/, schema: lifecycleRunViewSchema, matches: (answer, _input, merchantId) => answer.merchantId === merchantId },
  { path: /^\/lifecycle\/(?:policy|holds)$/, schema: lifecycleViewSchema, matches: (answer, _input, merchantId) => answer.merchantId === merchantId },
  { path: /^\/team\/invitations$/, schema: invitationCreatedSchema },
  { path: /^\/team\/invitations\/[^/]+\/(?:revoke|approve)$/, schema: messageSchema },
  { path: /^\/team\/members\/[^/]+$/, schema: staffChangeResultSchema },
  { path: /^\/team\/changes\/[^/]+\/approve$/, schema: staffChangeResultSchema },
  { path: /^\/team\/changes\/[^/]+\/decline$/, schema: messageSchema },
  { path: /^\/team\/members\/[^/]+\/lenders$/, schema: staffLenderAccessSchema },
  { path: /^\/team\/readiness\/encryption$/, schema: encryptionVerificationSchema },
  { path: /^\/team\/readiness\/protect$/, schema: payloadProtectionSchema },
  // A recovered request answers what its own route answers.
  { path: /^\/operations\/[^/]+\/retry$/, schema: operationReplaySchema },
  { path: /^\/operations\/[^/]+\/cancel$/, schema: messageSchema },
];
/** The answer schema and check for a pilot write's path; undefined for a path the console does not write. */
export function pilotReceipt(path: string) {
  return receipts.find((receipt) => receipt.path.test(path));
}
/** A mixed-route mutation exposes only fields the caller has narrowed. */
export function usePilotMutation(onSuccess?: (data: Record<string, unknown>) => void) {
  return useTypedPilotMutation(operationReplaySchema, onSuccess);
}

/** A workflow's own receipt schema keeps its callback and result typed, after the route and lender checks. */
export function useTypedPilotMutation<S extends ZodTypeAny>(schema: S, onSuccess?: (data: z.output<S>) => void) {
  const { merchantId, workspace } = useWorkspace(),
    cache = useQueryClient();
  return useSafeMutation(
    async (
      v: {
        path: string;
        data?: unknown;
        method?: "POST" | "PATCH";
        lender?: boolean;
      },
      options,
    ) => {
      const receipt = pilotReceipt(v.path);
      if (!receipt) throw answerProblem(INCOMPLETE_CONFIRMATION);
      const result = await pilotRequest(
        v.lender === false ? v.path : lenderPath(v.path, merchantId),
        receipt.schema,
        {
          ...options,
          method: v.method || "POST",
          body: JSON.stringify(v.data || {}),
        },
        INCOMPLETE_CONFIRMATION,
      );
      if (receipt.matches && !receipt.matches(result as Receipt, (v.data ?? {}) as Record<string, unknown>, merchantId, workspace?.actor))
        throw answerProblem("Valo Pay’s reply does not match this lender or request. Check Request history before you try again.");
      const answer = readAnswer(schema, result);
      if (answer === undefined) throw answerProblem(INCOMPLETE_CONFIRMATION);
      return answer;
    },
    {
      recovery: v => v.lender === false ? null : submissionIdentity(v.method || 'POST', `/v1${v.path}`, merchantId || '', v.data),
      mutation: {
        onSuccess: (data) => {
          void cache.invalidateQueries();
          onSuccess?.(data);
        },
      },
    },
    `${merchantId}:${workspace?.actor}:${workspace?.role}`,
  );
}
