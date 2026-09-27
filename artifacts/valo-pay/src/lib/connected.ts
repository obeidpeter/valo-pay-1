import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "./workspace-context";
import { useSubmissionRecovery } from './submission-recovery';
import {
  definitiveRefusal,
  nothingSaved,
  outcomeIsUnconfirmed,
  requestClosed,
  savedAnswerWithheld,
  submissionFingerprint,
} from "./safe-mutations";
import { useUnsavedChanges } from "./unsaved-changes";
import { answerProblem, readAnswer, UNREADABLE_ANSWER } from "./answers";
import { connectedActionResultFor, connectedViewSchema, type ConnectedView as SharedConnectedView } from "@workspace/valopay-schema";

/** A consent or payment intent as the connected view lists it; its data is read field by field. */
export type ConnectedRecord = Omit<SharedConnectedView["payments"]["intents"][number], "data"> & { data: Record<string, any>; effectiveStatus?: string };
/** The connected workspace as the shared schema reads it, its consents and intents with data read field by field. */
export type ConnectedView = Omit<SharedConnectedView, "consents" | "payments"> & {
  consents: Array<ConnectedRecord & { effectiveStatus: SharedConnectedView["consents"][number]["effectiveStatus"] }>;
  payments: Omit<SharedConnectedView["payments"], "intents"> & { intents: ConnectedRecord[] };
};
/** Shown for a connected action whose answer does not confirm the expected sample result: the action may have been saved. */
const UNCONFIRMED_SAMPLE = "The response did not confirm the expected sample result. Retry the original request to recover its outcome.";
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
      new Error(body?.error || "The request could not be completed."),
      { status: response.status, data: body ?? {} },
    );
  // An unreadable success is no confirmation: without a status, a write stays unconfirmed.
  if (body === undefined)
    throw new Error(
      "The service returned an unreadable answer. Retry the original request to recover its outcome.",
    );
  return body;
}
export function useConnected() {
  const { merchantId, workspace } = useWorkspace(),
    client = useQueryClient();
  const recovery = useSubmissionRecovery();
  const scope = `${merchantId ?? ""}:${workspace?.actor ?? ""}:${workspace?.role ?? ""}`;
  const previousScope = useRef(scope);
  const attempt = useRef<{
    fingerprint: string;
    key: string;
    body: string;
    input: {
      action: string;
      data: Record<string, unknown>;
      recordId?: string;
      reason: string;
    };
    unconfirmed: boolean;
    pending: boolean;
    recovery: typeof recovery;
  } | null>(null);
  if (previousScope.current !== scope || (attempt.current?.recovery && attempt.current.recovery.scope !== recovery?.scope)) {
    const original = attempt.current;
    if (original?.recovery) queueMicrotask(() => original.recovery?.keep(original.key));
    previousScope.current = scope;
    attempt.current = null;
  }
  useEffect(() => () => { if (attempt.current) attempt.current.recovery?.keep(attempt.current.key); }, []);
  const query = useQuery<ConnectedView>({
    queryKey: ["connected", merchantId],
    enabled: !!merchantId,
    queryFn: async ({ signal }) => {
      // The view the API checked, read through the same schema: a malformed answer is a load problem, never a page.
      const view = readAnswer(
        connectedViewSchema,
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
  const mutation = useMutation({
    retry: false,
    mutationFn: async (input: {
      action: string;
      data: Record<string, unknown>;
      recordId?: string;
      reason: string;
    }) => {
      if (!merchantId || !query.data)
        throw new Error("Wait for the workspace to load.");
      // A refreshed revision is not a new user intention. Keep the exact first
      // request after a lost/ambiguous response so the server can replay its
      // committed answer even though the workspace now has a newer revision.
      const fingerprint = submissionFingerprint({ scope, input });
      if (attempt.current?.pending)
        throw new Error(
          "The original request is still in progress. Wait for its result.",
        );
      if (
        attempt.current?.unconfirmed &&
        attempt.current.fingerprint !== fingerprint
      )
        throw new Error(
          "The previous request has an unconfirmed outcome. Retry the original request before changing it.",
        );
      recovery?.assertAvailable(attempt.current?.key);
      if (!attempt.current || attempt.current.fingerprint !== fingerprint)
        attempt.current = {
          fingerprint,
          key: crypto.randomUUID(),
          body: JSON.stringify({
            ...input,
            expectedRevision: query.data.revision,
          }),
          input: structuredClone(input),
          unconfirmed: false,
          pending: false,
          recovery,
        };
      const current = attempt.current;
      recovery?.remember(current.key, { method: 'POST', path: '/v1/connected/actions', merchantId });
      current.pending = true;
      try {
        const result = await request(
          `/api/v1/connected/actions?merchantId=${encodeURIComponent(merchantId)}`,
          {
            method: "POST",
            headers: { "Idempotency-Key": current.key },
            body: current.body,
          },
        );
        // Only the confirmation this action gives counts, with its record in this lender (a Cash Desk action's
        // outcome, every other action's record): anything else leaves the outcome unconfirmed.
        if (!readAnswer(connectedActionResultFor(current.input.action, merchantId), result)) throw answerProblem(UNCONFIRMED_SAMPLE);
        current.recovery?.forget(current.key);
        if (attempt.current === current) attempt.current = null;
      } catch (error) {
        // A definite request rejection did not commit; a reviewed retry may
        // use the newly fetched revision. Network/timeout/5xx stays ambiguous.
        // A later authentication/revision rejection can happen before replay
        // lookup. It does not prove that an earlier unknown write failed,
        // unless the service says the key's journal entry is cancelled: then
        // nothing sent with the key was saved or can be. Nor is it unknown
        // once the service says the request completed earlier but withholds
        // its saved answer (savedAnswerWithheld): retrying cannot recover it,
        // so the request is over and the page is free for the next action.
        const over = requestClosed(error) || savedAnswerWithheld(error);
        current.unconfirmed = over
          ? false
          : current.unconfirmed || outcomeIsUnconfirmed(error);
        // A finished request (refused for good, saved nothing, or saved with
        // its answer withheld) cannot run again under its key: the next action
        // needs a new one. A 401 or 429 is not final (any journal entry it
        // left stays pending), so the same action keeps its key, as in
        // useSafeMutation.
        if (
          !current.unconfirmed &&
          attempt.current === current &&
          (over || nothingSaved(error) || definitiveRefusal(error))
        ) { current.recovery?.forget(current.key); attempt.current = null; }
        throw error;
      } finally {
        current.pending = false;
      }
    },
    // Every outcome reloads the workspace, a refusal's included: one that ends a held request shows what it left.
    onSettled: () => client.invalidateQueries(),
  });
  useUnsavedChanges(
    mutation.isPending || Boolean(attempt.current?.unconfirmed),
  );
  return {
    ...query,
    run: async (
      action: string,
      data: Record<string, unknown> = {},
      recordId?: string,
      reason = "Explore the synthetic workflow",
    ) => {
      await mutation.mutateAsync({ action, data, recordId, reason });
    },
    pending: mutation.isPending,
    scope,
    hasUnconfirmedOutcome: Boolean(attempt.current?.unconfirmed),
    retryUnconfirmed: async () => {
      if (!attempt.current?.unconfirmed)
        throw new Error("There is no unconfirmed request to retry.");
      await mutation.mutateAsync(attempt.current.input);
    },
    /** Discards private in-memory fields; server recovery must settle the retained request identity. */
    abandonUnconfirmed: () => {
      if (attempt.current?.pending) return;
      if (attempt.current) attempt.current.recovery?.keep(attempt.current.key);
      attempt.current = null;
      mutation.reset();
    },
    canWrite: !!workspace && workspace.role !== "Read-only",
  };
}
