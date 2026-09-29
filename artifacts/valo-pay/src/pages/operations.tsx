import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { lenderPath, pilotRequest, usePilotMutation } from "@/lib/pilot";
import { operationListSchema, type OperationSummary } from "@workspace/valopay-schema";
import { getCountPendingOperationsQueryKey } from "@workspace/api-client-react";
import {
  PilotError,
  PilotHeading,
  RecoveryNotice,
} from "@/components/pilot-ui";
import { Button } from "@/components/ui/button";
import { PageButtons } from "@/components/record-pagination";
import { keepRowsWhilePaging } from "@/lib/use-record-pagination";
import { formatDate, formatNumber } from "@/lib/formatters";
import { recordPage } from "@/lib/record-navigation";
import { readableLabel } from "@/components/record-label";

/** What a request asked, in one line: the record it names and the few fields it named. */
function summaryLine(summary: OperationSummary): string {
  const record = [summary.targetKind && readableLabel(summary.targetKind), summary.targetId].filter(Boolean).join(" ");
  return [record && `Record: ${record}`, ...summary.details.map((detail) => `${detail.name}: ${detail.value}`)].filter(Boolean).join(" · ");
}

export default function OperationsPage() {
  const { merchantId, workspace } = useWorkspace(),
    [offset, setOffset] = useState(0),
    [message, setMessage] = useState("");
  useEffect(() => {
    setOffset(0);
    setMessage("");
  }, [merchantId, workspace?.actor]);
  const listKey = ["pilot", "operations", workspace?.actor, merchantId, { offset }], client = useQueryClient();
  const list = useQuery({
    queryKey: listKey,
    enabled: !!merchantId,
    // Paging keeps the requests shown, and so the page buttons and the one pressed, until the next page arrives.
    placeholderData: keepRowsWhilePaging(listKey, client),
    refetchInterval: 15000,
    queryFn: ({ signal }) =>
      pilotRequest(lenderPath("/operations", merchantId, offset), operationListSchema, { signal }),
  });
  const action = usePilotMutation((result) => {
    setMessage(
      (typeof result.message === 'string' && result.message) ||
        "The original request has completed. Its records have been refreshed.",
    );
  });
  // A refused check or cancel can settle the request for good (a check refused for good cancels it, and a cancel is
  // refused once it completed), so the list and the count on the Operations link are read again at once. A saved
  // one refreshes every read (usePilotMutation).
  useEffect(() => {
    if (!action.error) return;
    void client.invalidateQueries({ queryKey: ["pilot", "operations"] });
    void client.invalidateQueries({ queryKey: getCountPendingOperationsQueryKey() });
  }, [action.error, client]);
  return (
    <div className="space-y-6">
      <PilotHeading title="Operations">
        Your requests for this lender, saved on the server. Reopening a request
        uses its original data and request key. A pending result is not proof
        that a payment failed.
      </PilotHeading>
      <div className="rounded-xl border bg-secondary/20 p-4 text-sm">
        History follows your signed-in account or this anonymous sandbox. Sign
        in to the same account to return to its history. Requests that never
        reached the service will not appear here.
      </div>
      <PilotError
        error={list.error}
        pager="operations"
        retry={() => {
          void list.refetch();
        }}
      />
      <RecoveryNotice mutation={action} />
      <p role="status" className="text-sm">
        {message || (list.isLoading ? "Loading saved operations…" : "")}
      </p>
      <div className="space-y-3">
        {list.data?.items.map((item) => {
          // What the request asked, read from a few of its fields (never its body): the record it names can be
          // checked where its kind is shown, and a saved result opened there.
          const target = item.summary?.targetId && item.status !== "completed" ? recordPage(item.summary.targetKind, item.summary.targetId, merchantId || "") : null;
          const saved = item.status === "completed" && item.recordId ? recordPage(item.recordKind, item.recordId, merchantId || "") : null;
          const line = item.summary ? summaryLine(item.summary) : "";
          return (
          <article
            key={item.id}
            className="flex flex-col justify-between gap-4 rounded-xl border bg-card p-5 sm:flex-row"
          >
            <div className="min-w-0 space-y-2">
              <h2 className={`font-semibold ${item.summary ? "" : "capitalize"}`}>{item.summary?.action ?? item.label}</h2>
              {line && <p className="break-all text-sm">{line}</p>}
              <p className="text-sm text-muted-foreground">{item.message}</p>
              {target && (
                <Link className="inline-block text-sm text-primary underline" href={target}>
                  Open the record
                </Link>
              )}
              {saved && (
                <Link className="inline-block text-sm text-primary underline" href={saved}>
                  Open saved result
                </Link>
              )}
              <p className="text-xs text-muted-foreground">
                {formatDate(item.createdAt)} · {item.role}
              </p>
              <p className="break-all font-mono text-xs text-muted-foreground">
                Request {item.id.slice(0, 12)}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <span className="rounded-full bg-secondary px-3 py-1 text-xs font-semibold capitalize">
                {item.status}
              </span>
              {item.status === "pending" && (
                <>
                  <Button
                    busy={
                      action.isPending &&
                      action.variables?.path.includes(item.id)
                    }
                    disabled={action.isPending || workspace?.role !== item.role}
                    onClick={() => {
                      setMessage("");
                      action.mutate({ path: `/operations/${item.id}/retry` });
                    }}
                  >
                    Check original request
                  </Button>
                  <Button
                    variant="outline"
                    disabled={action.isPending || workspace?.role !== item.role}
                    onClick={() => {
                      setMessage("");
                      action.mutate({ path: `/operations/${item.id}/cancel` });
                    }}
                  >
                    Cancel if unfinished
                  </Button>
                </>
              )}
            </div>
          </article>
          );
        })}
      </div>
      {list.data?.total === 0 && (
        <p className="rounded-xl border bg-card p-8 text-sm text-muted-foreground">
          No received requests yet. Saved imports, case changes, reconciliation
          and evidence requests will appear here.{" "}
          {/* The next step, and something to focus: a keyboard user can then scroll the page on a short screen. */}
          <Link className="text-primary underline" href="/imports">
            Start with an import batch
          </Link>
        </p>
      )}
      {list.data && list.data.total > 25 && (
        <div className="flex items-center gap-3">
          <PageButtons
            label="operations"
            busy={list.isPlaceholderData}
            atStart={!offset}
            atEnd={offset + 25 >= list.data.total}
            onPrevious={() => setOffset((n) => Math.max(0, n - 25))}
            onNext={() => setOffset((n) => n + 25)}
          >
            <span className="text-sm">
              {formatNumber(offset + 1)}–
              {formatNumber(Math.min(offset + 25, list.data.total))} of{" "}
              {formatNumber(list.data.total)}
            </span>
          </PageButtons>
        </div>
      )}
      <p className="max-w-3xl text-xs text-muted-foreground">
        Cancellation waits for any in-progress transaction. It succeeds only
        when this request has not completed, then prevents it from running
        later. It does not reverse a saved financial record. Your current
        permissions are checked again for every recovery attempt.
      </p>
    </div>
  );
}
