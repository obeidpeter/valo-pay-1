import { Button } from "@/components/ui/button";
import { ScrollFrame } from "@/components/scroll-frame";
import { formatCompactDate, formatCount, formatDate } from "@/lib/formatters";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  CircleHelp,
  Landmark,
  RefreshCw,
} from "lucide-react";
import { ForecastChart } from "./forecast-chart";
import { amount, label, Metric, Section } from "./shared";
import type { CashView, ForecastAssumptions, ReviewAction } from "./types";
import { Link } from "wouter";

// An absent source value is not a zero balance. The service supplies qualification and warnings.
const sourceAmount = (value: number | null | undefined) =>
  value == null ? "Unavailable" : amount(value);
const sourceTime = (value: string | null | undefined) =>
  value ? formatDate(value) : "Unavailable";

type Props = {
  cash: CashView;
  assumptions: ForecastAssumptions;
  forecastErrors: Record<string, string>;
  onAssumptionChange: (field: keyof ForecastAssumptions, value: string) => void;
  canOperate: boolean;
  canPrepareForecast: boolean;
  maker: boolean;
  pending: boolean;
  reviewForecast: () => void;
  ask: ReviewAction;
};

export function CashForecastSection({
  cash,
  assumptions,
  forecastErrors,
  onAssumptionChange,
  canOperate,
  canPrepareForecast,
  maker,
  pending,
  reviewForecast,
  ask,
}: Props) {
  const { downside, delay, buffer } = assumptions;
  const position = cash.positions.find((p) => p.currency === "NGN");
  const hasBalances = !!position?.accountCount;
  const base =
    cash.forecast?.scenarios.find((s) => s.name === "base")?.points ?? [];
  const stress =
    cash.forecast?.scenarios.find((s) => s.name === "downside")?.points ?? [];
  return (
    <div className="space-y-6">
      <section
        aria-labelledby="cash-source-title"
        className="rounded-2xl border bg-card p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id="cash-source-title" className="text-sm font-semibold">
              Sample balance sources
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {hasBalances
                ? `${formatCount(position!.accountCount, "business account")} included`
                : "No account balances are available for this view."}
            </p>
          </div>
          <p className={`text-xs font-medium ${position?.qualified ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400"}`}>
            {position?.qualified ? "No source warnings reported" : "Review source limits"}
          </p>
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">Oldest sample bank timestamp</dt>
            <dd className="mt-1 font-medium">{sourceTime(position?.oldestBalanceAsOf)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Latest retrieval time</dt>
            <dd className="mt-1 font-medium">{sourceTime(position?.latestFetchedAt)}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          The bank timestamp says when the sample balance applies. Retrieval says when its source was received.
          A later retrieval does not make an older bank balance current. These are sample records, not live bank data.
        </p>
        {!!position?.warnings.length && (
          <div role="status" className="mt-4 space-y-1 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-sm">
            {position.warnings.map((warning) => <p key={warning}>{warning}</p>)}
          </div>
        )}
      </section>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          title="Booked cash"
          value={sourceAmount(hasBalances ? position?.bookedMinor : null)}
          detail="Recorded source balances; review the timestamps and coverage above"
          accent
        />
        <Metric
          title="Available cash"
          value={sourceAmount(hasBalances ? position?.availableMinor : null)}
          detail={position?.availableMinor == null || !hasBalances
            ? "Review the source limits above; unavailable does not mean zero"
            : "Bank-reported amount; pending items are kept separate"}
        />
        <Metric
          title="Base · day 30"
          value={amount(base.at(-1)?.closingMinor)}
          detail="Approved commitments plus explicit planning assumptions"
        />
        <Metric
          title="Downside · day 30"
          value={amount(stress.at(-1)?.closingMinor)}
          detail="Lower and later receipts; committed outflows remain due"
        />
      </div>
      <p className="text-sm text-muted-foreground">
        <Link href="/cash-desk?view=accounting" className="font-medium text-foreground underline underline-offset-4">
          Review accounting drafts
        </Link>{" "}
        alongside these balances. An accounting draft or export has not been posted to accounting software.
      </p>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(280px,1fr)]">
        <Section
          title="Your next 30 days"
          detail="Base and downside views use the same commitments. A forecast is a planning estimate, not money held or reserved."
        >
          {cash.forecast ? (
            <>
              <div className="flex flex-wrap gap-4 text-xs">
                <span className="flex items-center gap-2">
                  <span className="h-1 w-6 rounded bg-primary" />
                  Base scenario
                </span>
                <span className="flex items-center gap-2">
                  <span className="h-0 w-6 border-t-2 border-dashed border-amber-600" />
                  Downside scenario
                </span>
                <span className="ml-auto text-muted-foreground">
                  {cash.forecast.version} ·{" "}
                  {formatCompactDate(cash.forecast.asOf)}
                </span>
              </div>
              <ForecastChart
                base={base}
                downside={stress}
                opening={cash.forecast.openingMinor}
              />
              <ScrollFrame label="Weekly base and downside cash balances">
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    Weekly base and downside cash balances
                  </caption>
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-3 font-medium">Date</th>
                      <th className="py-3 text-right font-medium">
                        Base balance
                      </th>
                      <th className="py-3 text-right font-medium">
                        Downside balance
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {base.map((point, index) => (
                      <tr key={point.day} className="border-b last:border-0">
                        <td className="py-3">Day {point.day}</td>
                        <td className="py-3 text-right tabular-nums">
                          {amount(point.closingMinor)}
                        </td>
                        <td
                          className={`py-3 text-right tabular-nums ${(stress[index]?.closingMinor ?? 0) < 0 ? "font-medium text-destructive" : ""}`}
                        >
                          {amount(stress[index]?.closingMinor)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollFrame>
              <p className="mt-3 text-xs text-muted-foreground">
                Planning buffer: {amount(cash.forecast.planningBufferMinor)}.
                The buffer does not change your bank balance.
              </p>
            </>
          ) : cash.savedForecast?.state === "prepare_again" ? (
            <p className="text-sm text-muted-foreground">
              The figures of the forecast saved{" "}
              {formatDate(cash.savedForecast.createdAt)} are withheld: the
              permission it was saved under, or the balances and commitments it
              was made from, have changed or cannot be confirmed. Save a new
              forecast version under the current permission.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Restore business-account permission to create a new forecast.
            </p>
          )}
        </Section>
        <Section
          title="Test a downside"
          detail="Change the assumptions, then save a new forecast version."
        >
          <div className="space-y-5">
            <label
              className="block text-sm font-medium"
              htmlFor="cash-receipts"
            >
              Expected receipts retained
              <span className="mt-2 flex items-center gap-3">
                <input
                  id="cash-receipts"
                  className="h-10 w-full rounded-lg border bg-background px-3"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  aria-invalid={!!forecastErrors["cash-receipts"]}
                  aria-describedby={
                    forecastErrors["cash-receipts"]
                      ? "cash-receipts-error"
                      : undefined
                  }
                  value={downside}
                  onChange={(e) =>
                    onAssumptionChange("downside", e.target.value)
                  }
                />
                <span className="text-muted-foreground">%</span>
              </span>
              {forecastErrors["cash-receipts"] && (
                <span
                  id="cash-receipts-error"
                  role="alert"
                  className="block mt-2 text-xs text-destructive"
                >
                  {forecastErrors["cash-receipts"]}
                </span>
              )}
            </label>
            <label className="block text-sm font-medium" htmlFor="cash-delay">
              Receipt delay
              <span className="mt-2 flex items-center gap-3">
                <input
                  id="cash-delay"
                  className="h-10 w-full rounded-lg border bg-background px-3"
                  type="number"
                  min="0"
                  max="30"
                  aria-invalid={!!forecastErrors["cash-delay"]}
                  aria-describedby={
                    forecastErrors["cash-delay"]
                      ? "cash-delay-error"
                      : undefined
                  }
                  value={delay}
                  onChange={(e) => onAssumptionChange("delay", e.target.value)}
                />
                <span className="text-muted-foreground">days</span>
              </span>
              {forecastErrors["cash-delay"] && (
                <span
                  id="cash-delay-error"
                  role="alert"
                  className="block mt-2 text-xs text-destructive"
                >
                  {forecastErrors["cash-delay"]}
                </span>
              )}
            </label>
            <label className="block text-sm font-medium" htmlFor="cash-buffer">
              Planning buffer (₦)
              <input
                id="cash-buffer"
                className="mt-2 h-10 w-full rounded-lg border bg-background px-3"
                inputMode="decimal"
                aria-invalid={!!forecastErrors["cash-buffer"]}
                aria-describedby={
                  forecastErrors["cash-buffer"]
                    ? "cash-buffer-error"
                    : undefined
                }
                value={buffer}
                onChange={(e) => onAssumptionChange("buffer", e.target.value)}
              />
              {forecastErrors["cash-buffer"] && (
                <span
                  id="cash-buffer-error"
                  role="alert"
                  className="block mt-2 text-xs text-destructive"
                >
                  {forecastErrors["cash-buffer"]}
                </span>
              )}
            </label>
            <Button
              className="w-full"
              disabled={!canOperate || !canPrepareForecast || pending}
              aria-describedby="forecast-save-help"
              onClick={reviewForecast}
            >
              Save forecast
              <ArrowRight />
            </Button>
            <p id="forecast-save-help" className="text-xs leading-relaxed text-muted-foreground">
              {!canPrepareForecast ? "An Admin, Operations or Finance user can save a forecast."
                : !canOperate ? "Set up the sample Cash Desk with active business-account read permission before saving."
                : "Review these assumptions before confirming a new forecast version. Existing versions remain in history."}
            </p>
            <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <CircleHelp className="mt-0.5 h-4 w-4 shrink-0" />
              Only information known at the forecast date is included. Draft
              commitments and future knowledge are excluded. An approved outflow
              past its due date counts as due now; an overdue receipt is left
              out.
            </p>
          </div>
        </Section>
      </div>
      <Section
        title="Business accounts"
        detail="Balances retain their bank timestamp and source. No currencies or legal entities are combined."
        action={
          <Button
            size="sm"
            variant="outline"
            disabled={!canOperate || !maker || pending}
            onClick={() =>
              ask({
                action: "cash.refresh_sample",
                title: "Refresh sample balances",
                detail:
                  "Refresh the synthetic balance timestamps without contacting any bank. This does not approve an old payroll plan.",
              })
            }
          >
            <RefreshCw />
            Refresh sample
          </Button>
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          {cash.accounts.map((a) => (
            <article key={a.id} className="rounded-xl border p-4">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-secondary p-3">
                  <Landmark className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold">{a.name}</h3>
                  <p className="text-xs text-muted-foreground">{a.source}</p>
                </div>
              </div>
              <dl className="mt-5 grid grid-cols-3 gap-3">
                <div>
                  <dt className="text-xs text-muted-foreground">Booked</dt>
                  <dd className="mt-1 text-sm font-medium tabular-nums">
                    {sourceAmount(a.bookedMinor)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Available</dt>
                  <dd className="mt-1 text-sm font-medium tabular-nums">
                    {sourceAmount(a.availableMinor)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Pending</dt>
                  <dd className="mt-1 text-sm font-medium tabular-nums">
                    {sourceAmount(a.pendingMinor)}
                  </dd>
                </div>
              </dl>
              <dl className="mt-4 space-y-3 border-t pt-3 text-xs">
                <div>
                  <dt className="text-muted-foreground">Sample bank timestamp</dt>
                  <dd className="mt-1">{sourceTime(a.balanceAsOf)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Retrieved</dt>
                  <dd className="mt-1">{sourceTime(a.fetchedAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Transaction coverage</dt>
                  <dd className={`mt-1 ${a.coverageComplete ? "" : "font-medium text-amber-700 dark:text-amber-400"}`}>
                    {a.coverageComplete ? "Complete in this sample" : "Partial — some transactions may be missing"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Balance definition</dt>
                  <dd className="mt-1 leading-relaxed">{a.sourceDefinition || "Not supplied"}</dd>
                </div>
              </dl>
            </article>
          ))}
          {!cash.accounts.length && <p className="text-sm text-muted-foreground">No account details are available in this view.</p>}
        </div>
      </Section>
      <Section
        title="Approved commitments"
        detail="The timing and source behind the forecast."
      >
        <div className="divide-y">
          {cash.commitments.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
            >
              <span
                className={`rounded-lg p-2 ${c.direction === "inflow" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-secondary text-muted-foreground"}`}
              >
                {c.direction === "inflow" ? (
                  <ArrowDownLeft className="h-4 w-4" />
                ) : (
                  <ArrowUpRight className="h-4 w-4" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{c.label}</p>
                <p className="text-xs text-muted-foreground">
                  {label(c.source)} · {formatCompactDate(c.dueAt)}
                </p>
              </div>
              <span className="text-sm font-medium tabular-nums">
                {c.direction === "inflow" ? "+" : "−"}
                {amount(c.amountMinor)}
              </span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
