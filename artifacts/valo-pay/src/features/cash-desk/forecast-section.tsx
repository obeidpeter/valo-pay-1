import { Button } from "@/components/ui/button";
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
  const base =
    cash.forecast?.scenarios.find((s) => s.name === "base")?.points ?? [];
  const stress =
    cash.forecast?.scenarios.find((s) => s.name === "downside")?.points ?? [];
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          title="Booked cash"
          value={amount(position?.bookedMinor)}
          detail={`${formatCount(position?.accountCount ?? 0, "business account")} · own-account transfers excluded from income`}
          accent
        />
        <Metric
          title="Available cash"
          value={amount(position?.availableMinor)}
          detail="Bank-reported amount; pending items are kept separate"
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
      {!!position?.warnings.length && (
        <div
          role="status"
          className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm"
        >
          {position.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}
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
              <div className="overflow-x-auto">
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
              </div>
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
              onClick={reviewForecast}
            >
              Save forecast
              <ArrowRight />
            </Button>
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
            <div key={a.id} className="rounded-xl border p-4">
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
                    {amount(a.bookedMinor)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Available</dt>
                  <dd className="mt-1 text-sm font-medium tabular-nums">
                    {amount(a.availableMinor)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Pending</dt>
                  <dd className="mt-1 text-sm font-medium tabular-nums">
                    {amount(a.pendingMinor)}
                  </dd>
                </div>
              </dl>
              <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
                Bank as of {formatDate(a.balanceAsOf)}
              </p>
            </div>
          ))}
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
