import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "wouter";
import {
  useListCloseHistory,
  getListCloseHistoryQueryKey,
  useGetCloseDetail,
  getGetCloseDetailQueryKey,
  type ValopayRecord,
} from "@workspace/api-client-react";
import { useWorkspace } from "@/lib/workspace-context";
import { useUrlPagination } from "@/lib/use-url-pagination";
import { keepRowsWhilePaging } from "@/lib/use-record-pagination";
import { closeHistory } from "@/lib/close-history";
import {
  formatCount,
  formatDate,
  formatKobo,
  formatNumber,
} from "@/lib/formatters";
import { formatWithOtherCurrencies, otherCurrencyEntries } from "@/lib/currencies";
import { hasFeeSchedule } from "@workspace/valopay-schema";
import { Button } from "./ui/button";
import { RecordPagination } from "./record-pagination";
import { LoadProblem, RefreshProblem } from "./load-problem";
import { readableLabel } from "./record-label";

/** A matching rule by its name ("Rule R1"); any other key, such as a manual allocation, through the shared labels. */
const ruleName = (rule: string) => (/^R\d+$/.test(rule) ? `Rule ${rule}` : readableLabel(rule));

function CloseEvidence({ close }: { close: ValopayRecord }) {
  const { merchantId } = useWorkspace();
  const [open, setOpen] = useState(false);
  const params = { merchantId: merchantId! };
  const query = useGetCloseDetail(close.id, params, {
    query: {
      enabled: open && !!merchantId,
      queryKey: getGetCloseDetailQueryKey(close.id, params),
    },
  });
  const report = query.data?.data?.report as Record<string, any> | undefined;
  // A count from the recorded report, grouped the market's way; one the report left out is 0.
  const count = (value: unknown) => formatNumber(Number(value ?? 0));
  // The payments the report counts, their naira, and any money in another currency in that currency, never added to the naira.
  const money = (value: any) =>
    `${count(value?.count)} · ${formatWithOtherCurrencies(Number(value?.kobo || 0), value?.otherCurrencies, "payment")}`;
  // The batches in variance and the fee differences of the naira ones; a batch in another currency is listed apart, in its
  // currency, and where no fee schedule exists for that currency its fees were not checked, so it has no fee difference.
  const differences = (value: any) => {
    const amounts = [formatKobo(Number(value?.feeVarianceKobo || 0)), ...otherCurrencyEntries(value?.otherCurrencies, "batch", "batches").map(({ code, money, counted }) => hasFeeSchedule(code) ? `${money} (${counted})` : `${counted} in ${code}, fees not checked`)];
    return `${count(value?.count)} · ${amounts.length === 1 ? amounts[0] : `${amounts.slice(0, -1).join(", ")} and ${amounts.at(-1)}`}`;
  };
  const measures = report
    ? [
        ["Unallocated at start", money(report.openingUnallocated)],
        [
          "Payment evidence received",
          count(report.observations?.received),
        ],
        [
          "Payment evidence by source",
          Object.entries(report.observations?.bySource || {})
            .map(
              ([key, v]: [string, any]) =>
                `${readableLabel(key)}: ${formatCount(Number(v.received ?? 0), "record")} linked to ${formatCount(v.paymentsResolvedTo, "payment")}`,
            )
            .join("; ") || "None",
        ],
        [
          "Matches by rule",
          Object.entries(report.allocatedByRule || {})
            .map(([key, v]: [string, any]) => `${ruleName(key)}: ${count(v.count)}`)
            .join("; ") || "None",
        ],
        ["Matches to review", money(report.proposed)],
        [
          "Unallocated at close",
          `${money(report.unallocated)} · ${count(report.unallocated?.olderThan24Hours)} older than 24 hours`,
        ],
        ["Settlement differences", differences(report.variances)],
        [
          "Exceptions",
          `${count(report.exceptions?.opened?.count)} opened · ${count(report.exceptions?.closed?.count)} closed · ${count(report.exceptions?.openAtClose)} open`,
        ],
        [
          "Customer balances changed",
          count(report.customerPositionsChanged?.length),
        ],
        [
          "Retry decisions",
          `${count(report.retryDecisions?.recorded)} recorded · ${formatCount(Number(report.retryDecisions?.finalAttempts ?? 0), "final attempt")} · ${count(report.retryDecisions?.noticesNotEvidenced)} deferred for missing notice evidence`,
        ],
      ]
    : [];
  return (
    <details
      className="min-w-0 rounded-lg border bg-card print:hidden"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-medium">
        View close details
      </summary>
      {open && (
        <div className="space-y-3 border-t p-3 text-xs [overflow-wrap:anywhere]">
          {query.error ? (
            <LoadProblem
              what="this close report"
              error={query.error}
              retry={() => {
                void query.refetch();
              }}
            />
          ) : query.isLoading ? (
            <p role="status">Loading close details…</p>
          ) : report ? (
            <dl className="space-y-3">
              {measures.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="mt-1 font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p>Detailed reports were not available when this close ran.</p>
          )}
          {query.data?.data?.positionAlert === true && (
            <p className="text-destructive">Customer balances need review. Open Reconciliation to check them.</p>
          )}
          {!!query.data?.data?.schedule && (
            <p>
              {(query.data.data.schedule as any).trigger === "scheduled" ? "Started automatically" : "Run by hand"}
              {(query.data.data.schedule as any).late
                ? ` · ${formatCount(Number((query.data.data.schedule as any).delayMinutes ?? 0), "minute")} late`
                : ""}
            </p>
          )}
        </div>
      )}
    </details>
  );
}

export function CloseHistorySection({ active }: { active: boolean }) {
  const { merchantId } = useWorkspace();
  const [search, setSearch] = useSearchParams();
  const from = search.get("from") || "",
    to = search.get("to") || "",
    validation = closeHistory([], from, to);
  const pagination = useUrlPagination(merchantId, "close-");
  const params = {
    merchantId: merchantId!,
    from: from || undefined,
    to: to || undefined,
    limit: pagination.pageSize,
    offset: pagination.offset,
  };
  const closesKey = getListCloseHistoryQueryKey(params);
  const client = useQueryClient();
  const query = useListCloseHistory(params, {
    query: {
      enabled: !!merchantId && active && !validation.error,
      queryKey: closesKey,
      // Paging keeps the closes shown until the next page arrives, so the pager and the control pressed stay.
      placeholderData: keepRowsWhilePaging(closesKey, client),
    },
  });
  useEffect(() => {
    // The previous page's closes, shown while this one loads, say nothing of where this page is.
    if (query.data && !query.isPlaceholderData && query.data.offset !== pagination.offset)
      pagination.correctPage(Math.floor(query.data.offset / pagination.pageSize));
  }, [query.data, query.isPlaceholderData, pagination.offset, pagination.pageSize]);
  const history = closeHistory(
    query.data?.first && query.data.latest
      ? query.data.first.id === query.data.latest.id
        ? [query.data.first]
        : [query.data.first, query.data.latest]
      : [],
    "",
    "",
  );
  const apply = (values?: FormData) =>
    setSearch((current) => {
      const next = new URLSearchParams(current);
      next.delete("close-page");
      for (const key of ["from", "to"]) {
        const value = String(values?.get(key) || "");
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    });
  return (
    <>
      <div className="space-y-4 border-b p-5">
        <Link href="/close-review" className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline print:hidden">Open Close review</Link>
        <form
          key={`${merchantId}:${from}:${to}`}
          className="flex flex-wrap items-end gap-3 print:hidden"
          onSubmit={(event) => {
            event.preventDefault();
            apply(new FormData(event.currentTarget));
          }}
        >
          <label className="grid gap-1 text-xs font-medium">
            From date (WAT)
            <input
              type="date"
              name="from"
              defaultValue={from}
              aria-invalid={!!validation.error}
              aria-describedby="close-range-help"
              className="min-h-10 max-w-full rounded-md border bg-background px-3"
            />
          </label>
          <label className="grid gap-1 text-xs font-medium">
            To date (WAT)
            <input
              type="date"
              name="to"
              defaultValue={to}
              aria-invalid={!!validation.error}
              aria-describedby="close-range-help"
              className="min-h-10 max-w-full rounded-md border bg-background px-3"
            />
          </label>
          <Button type="submit" variant="outline">
            Apply dates
          </Button>
          {(from || to) && (
            <Button type="button" variant="ghost" onClick={() => apply()}>
              Clear dates
            </Button>
          )}
        </form>
        <p id="close-range-help" className="text-xs text-muted-foreground">
          {validation.error ||
            (query.data
              ? `Showing ${formatCount(query.data.total, "recorded close")}${from ? ` from ${formatDate(from)}` : ""}${to ? ` ${from ? "to" : "up to"} ${formatDate(to)}` : ""}. Each date includes the whole day in WAT. These dates do not change the totals above.`
              : "Loading recorded closes…")}
        </p>
        {!validation.error && (
          <RefreshProblem what="The close history" shown="closes" query={query} />
        )}
        {validation.error ? (
          <p role="alert" className="text-sm text-destructive">
            Correct the dates above to see the daily closes.
          </p>
        ) : query.error && !query.data ? (
          <LoadProblem
            what="daily close history"
            pager="recorded closes"
            error={query.error}
            retry={() => {
              void query.refetch();
            }}
          />
        ) : (
          query.data && (
            <div className="rounded-lg bg-secondary/25 p-4">
              <h3 className="text-sm font-semibold">
                Change between recorded closes
              </h3>
              {query.data.total < 2 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  You need at least two recorded closes in this date range to
                  see a change.
                </p>
              ) : (
                <>
                  <p className="mt-2 text-xs text-muted-foreground">
                    First: {formatDate(history.first!.createdAt)} · Latest:{" "}
                    {formatDate(history.latest!.createdAt)}. These are balances at
                    each close, not money collected in the period. Money in
                    other currencies is left out here. Each close’s details
                    list it.
                  </p>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    {history.metrics.map((metric) => (
                      <div key={metric.label}>
                        <p className="text-xs text-muted-foreground">
                          {metric.label}
                        </p>
                        <p className="mt-1 text-lg font-semibold tabular-nums">
                          {metric.change === null
                            ? "Not available"
                            : `${metric.change > 0 ? "+" : ""}${metric.money ? formatKobo(metric.change) : formatNumber(metric.change)}`}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {metric.change === null
                            ? "One or both closes did not record this figure."
                            : `From ${metric.money ? formatKobo(metric.before) : formatNumber(metric.before)} to ${metric.money ? formatKobo(metric.after) : formatNumber(metric.after)}`}
                        </p>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )
        )}
      </div>
      {!validation.error && query.data && (
        <>
          {!query.data.items.length ? (
            <div className="p-5">
              <p className="font-medium">
                {query.data.allTotal
                  ? "No daily closes match these dates"
                  : "No daily closes yet"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {query.data.allTotal
                  ? "Choose other dates, or select Clear dates."
                  : "Select Run daily close above to check the day’s records. Each daily close then appears here with its results."}
              </p>
            </div>
          ) : (
            <ol aria-label="Recorded daily closes" className="divide-y">
              {query.data.items.map((close) => (
                <li
                  key={close.id}
                  className="grid min-w-0 gap-3 p-5 md:grid-cols-[9rem_minmax(0,1fr)_minmax(12rem,1fr)]"
                >
                  <time
                    dateTime={close.createdAt}
                    className="text-xs font-medium tabular-nums"
                  >
                    {formatDate(close.createdAt)}
                  </time>
                  <p className="min-w-0 text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                    {String(close.data.summary || "Recorded daily close")}
                  </p>
                  <div className="min-w-0 space-y-2"><CloseEvidence key={`${merchantId}:${close.id}`} close={close} /><Link href={`/close-review?close=${encodeURIComponent(close.id)}`} className="inline-flex min-h-11 items-center text-sm text-primary underline print:hidden">Open Close review</Link></div>
                </li>
              ))}
            </ol>
          )}
          <p className="hidden px-5 py-2 text-xs print:block">
            Close summaries only. Open a close in Valo Pay to see its full
            evidence.
          </p>
          <RecordPagination
            pagination={pagination}
            total={query.data.total}
            label="recorded closes"
            busy={query.isFetching}
          />
        </>
      )}
    </>
  );
}
