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
import { valueLabel } from "@workspace/valopay-schema";
import { ForecastChart } from "./forecast-chart";
import { amount, Metric, Section, SET_UP_FIRST } from "./shared";
import type { CashView, ForecastAssumptions, ReviewAction, RoleRefusal } from "./types";
import { Link } from "wouter";

// An absent source value is not a zero balance. The service supplies qualification and warnings.
const sourceAmount = (value: number | null | undefined) =>
  value == null ? "Unavailable" : amount(value);
const sourceTime = (value: string | null | undefined) =>
  value ? formatDate(value) : "Unavailable";
/** A forecast's version in words: the service names a preview "sample-preview" and a saved forecast "sample-2". */
const forecastVersion = (version: string) => {
  if (version === "sample-preview") return "Preview, not saved";
  const saved = /^sample-(\d+)$/.exec(version);
  return saved ? `Saved version ${saved[1]}` : version;
};

type Props = {
  cash: CashView;
  assumptions: ForecastAssumptions;
  forecastErrors: Record<string, string>;
  onAssumptionChange: (field: keyof ForecastAssumptions, value: string) => void;
  canOperate: boolean;
  canPrepareForecast: boolean;
  maker: boolean;
  pending: boolean;
  refuse: RoleRefusal;
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
  refuse,
  reviewForecast,
  ask,
}: Props) {
  const { downside, delay, buffer } = assumptions;
  const position = cash.positions.find((p) => p.currency === "NGN");
  const hasBalances = !!position?.accountCount;
  // The service's "base" and "downside" scenarios are shown as the expected and cautious cases.
  const expected =
    cash.forecast?.scenarios.find((s) => s.name === "base")?.points ?? [];
  const cautious =
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
                : "No account balances to show. Check the Read business accounts permission."}
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
          detail="Balances the bank has recorded. Check the timestamps and coverage above."
          accent
        />
        <Metric
          title="Available cash"
          value={sourceAmount(hasBalances ? position?.availableMinor : null)}
          detail={position?.availableMinor == null || !hasBalances
            ? "Check the source limits above. Unavailable does not mean zero."
            : "The amount the bank reports. Pending items are kept separate."}
        />
        <Metric
          title="Expected · day 30"
          value={amount(expected.at(-1)?.closingMinor)}
          detail="Approved payments in and out, plus your planning assumptions"
        />
        <Metric
          title="Cautious · day 30"
          value={amount(cautious.at(-1)?.closingMinor)}
          detail="Less money arrives, and later. Approved payments out are still due."
        />
      </div>
      <p className="text-sm text-muted-foreground">
        <Link href="/cash-desk?view=accounting" className="font-medium text-foreground underline underline-offset-4">
          Open Accounting
        </Link>{" "}
        to check drafts against these balances. Drafts and export files are not posted to accounting software.
      </p>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(280px,1fr)]">
        <Section
          title="Your next 30 days"
          detail="The expected case uses the approved amounts. The cautious case assumes that less money comes in, and later, while payments out stay due. A forecast is a planning estimate, not money held or set aside."
        >
          {cash.forecast ? (
            <>
              <div className="flex flex-wrap gap-4 text-xs">
                <span className="flex items-center gap-2">
                  <span className="h-1 w-6 rounded bg-primary" />
                  Expected case
                </span>
                <span className="flex items-center gap-2">
                  <span className="h-0 w-6 border-t-2 border-dashed border-amber-600" />
                  Cautious case
                </span>
                <span className="ml-auto text-muted-foreground">
                  {forecastVersion(cash.forecast.version)} ·{" "}
                  {formatCompactDate(cash.forecast.asOf)}
                </span>
              </div>
              <ForecastChart
                base={expected}
                downside={cautious}
                opening={cash.forecast.openingMinor}
              />
              <ScrollFrame label="Weekly expected and cautious cash balances">
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    Weekly expected and cautious cash balances
                  </caption>
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-3 font-medium">Day</th>
                      <th className="py-3 text-right font-medium">
                        Expected balance
                      </th>
                      <th className="py-3 text-right font-medium">
                        Cautious balance
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {expected.map((point, index) => (
                      <tr key={point.day} className="border-b last:border-0">
                        <td className="py-3">Day {point.day}</td>
                        <td className="py-3 text-right tabular-nums">
                          {amount(point.closingMinor)}
                        </td>
                        <td
                          className={`py-3 text-right tabular-nums ${(cautious[index]?.closingMinor ?? 0) < 0 ? "font-medium text-destructive" : ""}`}
                        >
                          {amount(cautious[index]?.closingMinor)}
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
              The forecast saved on {formatDate(cash.savedForecast.createdAt)}{" "}
              is hidden. Its permission, balances or commitments have changed,
              or cannot be checked. Save a new forecast to see current figures.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Grant the Read business accounts permission to create a forecast.
            </p>
          )}
        </Section>
        <Section
          title="Test a cautious case"
          detail="Change the assumptions, then save a new forecast."
        >
          <div className="space-y-5">
            <label
              className="block text-sm font-medium"
              htmlFor="cash-receipts"
            >
              Share of expected receipts that arrive
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
              {!canPrepareForecast ? refuse(["Admin", "Operations", "Finance"], "save a forecast")
                : !canOperate ? SET_UP_FIRST
                : "Check these assumptions before you save. Saving creates a new version of the forecast."}
            </p>
            <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <CircleHelp className="mt-0.5 h-4 w-4 shrink-0" />
              The forecast uses only what was known on its date. Draft
              commitments are left out. An approved payment out that is overdue
              counts as due today. An overdue receipt is left out.
            </p>
          </div>
        </Section>
      </div>
      <Section
        title="Business accounts"
        detail="Each balance keeps its bank timestamp and source. Different currencies and businesses are never added together."
        action={
          <Button
            size="sm"
            variant="outline"
            disabled={!canOperate || !maker || pending}
            onClick={() =>
              ask({
                action: "cash.refresh_sample",
                title: "Refresh sample balances?",
                detail:
                  "This updates the timestamps on the sample balances. No bank is contacted. It does not approve an old payroll plan.",
                confirm: "Refresh sample balances",
                busy: "Refreshing…",
              })
            }
          >
            <RefreshCw />
            Refresh sample balances
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
                    {a.coverageComplete ? "Complete in this sample" : "Partial: some transactions may be missing"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Balance definition</dt>
                  <dd className="mt-1 leading-relaxed">{a.sourceDefinition || "Not recorded"}</dd>
                </div>
              </dl>
            </article>
          ))}
          {!cash.accounts.length && <p className="text-sm text-muted-foreground">No accounts to show. Check the Read business accounts permission.</p>}
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
                  {valueLabel(c.source)} · {formatCompactDate(c.dueAt)}
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
