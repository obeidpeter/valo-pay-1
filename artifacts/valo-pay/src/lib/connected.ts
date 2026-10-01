import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "./workspace-context";
import { connectedSubmissionPolicy, useSubmissionAttempt } from './submission-attempt';
import { submissionFingerprint } from './submission-outcomes';
import { useUnsavedChanges } from "./unsaved-changes";
import { answerProblem, readAnswer, UNREADABLE_ANSWER } from "./answers";
import { connectedActionResultFor } from "@workspace/valopay-schema";
import { consoleConnectedViewSchema, type ConnectedView } from './connected-view';
export type { ConnectedRecord, ConnectedView } from './connected-view';
/** Shown for a connected action whose answer does not confirm the expected sample result: the action may have been saved. */
const UNCONFIRMED_SAMPLE = "Valo Pay’s answer did not confirm this action. Check the original request again.";
type ConnectedInput = {
  action: string;
  data: Record<string, unknown>;
  recordId?: string;
  reason: string;
};

async function request(url: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    signal: options.signal ?? AbortSignal.timeout(25000),
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  // A proxy's HTML error page is not JSON: the status still says what happened (a 5xx is worth repeating).
  const body = await response.json().catch(() => undefined);
  if (!response.ok)
    throw Object.assign(
      new Error(body?.error || "Valo Pay could not complete the request. Try again in a moment."),
      { status: response.status, data: body ?? {} },
    );
  // An unreadable success is no confirmation: without a status, a write stays unconfirmed.
  if (body === undefined)
    throw new Error(
      "Valo Pay’s answer could not be read. Try again in a moment.",
    );
  return body;
}
export function useConnected() {
  const { merchantId, workspace } = useWorkspace(),
    client = useQueryClient();
  const scope = `${merchantId ?? ""}:${workspace?.actor ?? ""}:${workspace?.role ?? ""}`;
  const query = useQuery<ConnectedView>({
    queryKey: ["connected", merchantId],
    enabled: !!merchantId,
    queryFn: async ({ signal }) => {
      // The view the API checked, read through the same schema: a malformed answer is a load problem, never a page.
      const view = readAnswer(
        consoleConnectedViewSchema,
        await request(
          `/api/v1/connected?merchantId=${encodeURIComponent(merchantId!)}`,
          { signal },
        ),
      );
      if (!view) throw answerProblem(UNREADABLE_ANSWER);
      return view;
    },
    staleTime: 10000,
  });
  const attempt = useSubmissionAttempt({
    scope,
    fingerprint: (input: ConnectedInput) => submissionFingerprint({ scope, input }),
    // A refreshed revision is not a new user intention. Prepare once, then replay the exact first body.
    prepare: (input: ConnectedInput) => JSON.stringify({ ...input, expectedRevision: query.data!.revision }),
    identity: () => ({ method: 'POST' as const, path: '/v1/connected/actions', merchantId: merchantId! }),
    policy: connectedSubmissionPolicy,
    pendingMessage: 'The original request is still in progress. Wait for its result.',
  });
  const mutation = useMutation({
    retry: false,
    mutationFn: async (input: ConnectedInput) => {
      if (!merchantId || !query.data)
        throw new Error("Wait for the page to load.");
      await attempt.execute(input, async ({ payload, key, input: original }) => {
        const result = await request(
          `/api/v1/connected/actions?merchantId=${encodeURIComponent(merchantId)}`,
          {
            method: "POST",
            headers: { "Idempotency-Key": key },
            body: payload,
          },
        );
        // Only the confirmation this action gives counts, with its record in this lender (a Cash Desk action's
        // outcome, every other action's record): anything else leaves the outcome unconfirmed.
        if (!readAnswer(connectedActionResultFor(original.action, merchantId), result)) throw answerProblem(UNCONFIRMED_SAMPLE);
      });
    },
    // Every outcome reloads the workspace, a refusal's included: one that ends a held request shows what it left.
    onSettled: () => client.invalidateQueries(),
  });
  useUnsavedChanges(
    mutation.isPending || attempt.hasUnconfirmedOutcome,
  );
  return {
    ...query,
    run: async (
      action: string,
      data: Record<string, unknown> = {},
      recordId?: string,
      reason = "Sample connected banking action",
    ) => {
      await mutation.mutateAsync({ action, data, recordId, reason });
    },
    pending: mutation.isPending,
    scope,
    hasUnconfirmedOutcome: attempt.hasUnconfirmedOutcome,
    retryUnconfirmed: async () => {
      await mutation.mutateAsync(attempt.unconfirmedInput());
    },
    /** Discards private in-memory fields; server recovery must settle the retained request identity. */
    abandonUnconfirmed: () => {
      if (attempt.abandon()) mutation.reset();
    },
    canWrite: !!workspace && workspace.role !== "Read-only",
  };
}
