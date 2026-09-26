import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRight,
  Building2,
  ChartNoAxesCombined,
  Check,
  CircleHelp,
  Download,
  FileCheck2,
  Landmark,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Users,
  Wallet,
} from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loading } from "@/components/loading";
import { LoadProblem } from "@/components/load-problem";
import {
  ConnectedFrame,
  ConnectedRecovery,
  ConnectedState,
} from "@/components/connected-frame";
import { useConnected } from "@/lib/connected";
import { useWorkspace } from "@/lib/workspace-context";
import { useDialogFocusReturn } from "@/lib/focus";
import {
  formatCompactDate,
  formatCount,
  formatDate,
  formatKobo,
  formatPercent,
} from "@/lib/formatters";
import { nairaToKobo } from "@/lib/money-input";
import { useFormDraft } from "@/lib/unsaved-changes";

type Point = {
  day: number;
  date: string;
  inflowMinor: number;
  outflowMinor: number;
  closingMinor: number;
  afterPlanningBufferMinor: number;
  shortfallMinor: number;
};
type CashView = {
  initialised: boolean;
  name: string;
  scope: { tenantId: string; legalEntityId: string; currency: string };
  permissions: { read: boolean; erp: boolean; payroll: boolean };
  accounts: Array<{
    id: string;
    name: string;
    bookedMinor: number;
    availableMinor: number | null;
    pendingMinor: number | null;
    balanceAsOf: string;
    source: string;
  }>;
  positions: Array<{
    currency: string;
    bookedMinor: number;
    availableMinor: number | null;
    accountCount: number;
    qualified: boolean;
    warnings: string[];
  }>;
  commitments: Array<{
    id: string;
    label: string;
    direction: string;
    amountMinor: number;
    dueAt: string;
    source: string;
  }>;
  forecast: null | {
    version: string;
    asOf: string;
    status: string;
    openingMinor: number;
    planningBufferMinor: number;
    scenarios: Array<{ name: string; points: Point[] }>;
    warnings: string[];
  };
  /** The latest saved forecast; to be prepared again (its figures withheld) once its permission or source changed. */
  savedForecast: null | {
    id: string;
    createdAt: string;
    state: "current" | "prepare_again";
  };
  erpDrafts: Array<{
    id: string;
    name: string;
    status: string;
    manifest?: unknown;
    draft: {
      input: {
        maker: string;
        grossMinor: number;
        netMinor: number;
        feeMinor: number;
        mapping: { version: string; companyId: string; taxCode: string };
      };
      residuals: Array<{
        invoiceId: string;
        beforeMinor: number;
        paymentMinor: number;
        creditNoteMinor: number;
        afterMinor: number;
      }>;
      review?: { reviewer: string };
      reasons: string[];
    };
  }>;
  vat: null | {
    period: string;
    outputVatMinor: number;
    eligibleInputVatMinor: number;
    blockedInputVatMinor: number;
    expectedClosingMinor: number;
    ledgerClosingMinor: number;
    varianceMinor: number;
    status: string;
    excludedBankCreditsMinor: number;
    missingEvidence: string[];
    lines: Array<{
      invoiceId: string;
      kind: string;
      netMinor: number;
      vatMinor: number;
      paidMinor: number;
      evidenceComplete: boolean;
    }>;
  };
  /** Saved schedules; one to be prepared again is listed without its schedule. */
  vatExports: Array<{
    id: string;
    createdAt: string;
    schedule?: unknown;
    reviewer: string;
    state: "current" | "prepare_again";
  }>;
  payrollPlans: Array<{
    id: string;
    status: string;
    manifest?: unknown;
    plan: {
      maker: string;
      checker?: string;
      fundingStatus: string;
      approvalStatus: string;
      totalNetMinor: number;
      requiredMinor: number;
      availableMinor: number | null;
      shortfallMinor: number | null;
      estimatedFeesMinor: number;
      bufferMinor: number;
      commitmentsMinor: number;
      paymentDate: string;
      asOf: string;
      items: Array<{
        id: string;
        employeeReference: string;
        beneficiaryReference: string;
        netMinor: number;
        status: string;
      }>;
    };
    summary: { status: string; itemCount: number };
  }>;
  payrollReconciliation: Array<{
    id: string;
    runId: string;
    items: Array<{
      id: string;
      employeeReference: string;
      netMinor: number;
      status: string;
    }>;
  }>;
};
type PendingAction = {
  action: string;
  title: string;
  detail: string;
  data?: Record<string, unknown>;
  recordId?: string;
};
const label = (text: string) =>
  text.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
const amount = (value: number | null | undefined) =>
  value == null ? "Needs review" : formatKobo(value);
const saveJson = (name: string, value: unknown) => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
function Section({
  title,
  detail,
  children,
  action,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b p-5">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {detail && (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {detail}
            </p>
          )}
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}
function Metric({
  title,
  value,
  detail,
  accent = false,
}: {
  title: string;
  value: string;
  detail: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-5 ${accent ? "border-primary/20 bg-primary/5" : "bg-card"}`}
    >
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <p className="mt-3 text-xl font-semibold tracking-tight tabular-nums break-words 2xl:text-2xl">
        {value}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}
function Gate({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-sm">
      <LockKeyhole aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        {text}{" "}
        <Link
          href="/connections"
          className="font-medium underline underline-offset-4"
        >
          Review permissions
        </Link>
      </span>
    </p>
  );
}
function ForecastChart({
  base,
  downside,
  opening,
}: {
  base: Point[];
  downside: Point[];
  opening: number;
}) {
  const id = useId();
  const all = [
    opening,
    ...base.map((p) => p.closingMinor),
    ...downside.map((p) => p.closingMinor),
  ];
  const low = Math.min(0, ...all),
    high = Math.max(1, ...all) * 1.1;
  const y = (value: number) => 145 - ((value - low) / (high - low)) * 122;
  const path = (points: Point[]) =>
    [
      `M 12 ${y(opening)}`,
      ...points.map((p) => `L ${12 + (p.day / 30) * 586} ${y(p.closingMinor)}`),
    ].join(" ");
  return (
    <svg
      viewBox="0 0 610 175"
      role="img"
      aria-labelledby={id}
      className="my-4 w-full overflow-visible"
    >
      <title id={id}>
        Cash forecast comparison. Exact base and downside amounts are listed in
        the table below.
      </title>
      {[0, 1, 2].map((n) => (
        <line
          key={n}
          x1="12"
          x2="598"
          y1={25 + n * 60}
          y2={25 + n * 60}
          stroke="currentColor"
          strokeOpacity=".1"
        />
      ))}
      <path
        d={path(base)}
        fill="none"
        stroke="currentColor"
        className="text-primary"
        strokeWidth="3"
      />
      <path
        d={path(downside)}
        fill="none"
        stroke="currentColor"
        className="text-amber-600 dark:text-amber-400"
        strokeWidth="2.5"
        strokeDasharray="7 5"
      />
      <text
        x="12"
        y="170"
        fill="currentColor"
        className="text-muted-foreground"
        fontSize="11"
      >
        Today
      </text>
      <text
        x="555"
        y="170"
        fill="currentColor"
        className="text-muted-foreground"
        fontSize="11"
      >
        30 days
      </text>
    </svg>
  );
}
const TITLE = "Cash Desk",
  DESCRIPTION =
    "A clearer view of business cash, commitments and the work ahead.";
export default function CashDeskPage() {
  const api = useConnected();
  const { data, isLoading, error, refetch, run, pending, canWrite } = api;
  const { workspace, merchantId } = useWorkspace();
  const cash = data?.cash as CashView | undefined;
  const [tab, setTab] = useState("cash");
  const [action, setAction] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState("");
  const [success, setSuccess] = useState("");
  const [forecastErrors, setForecastErrors] = useState<Record<string, string>>(
    {},
  );
  const [downside, setDownside] = useState("70");
  const [delay, setDelay] = useState("7");
  const [buffer, setBuffer] = useState("1500000");
  // A confirmed step can remove or disable the button that opened its review, so focus then goes to the result.
  const result = useRef<HTMLParagraphElement>(null);
  const restoreFocus = useDialogFocusReturn(!!action, () => result.current);
  // Planning inputs, or a review note, typed but not saved are a draft: leaving asks first.
  const draft = useFormDraft({
    downside,
    delay,
    buffer,
    reason: action ? reason : "",
  });
  useEffect(() => {
    setAction(null);
    setReason("");
    setProblem("");
    setSuccess("");
    setForecastErrors({});
    setDownside("70");
    setDelay("7");
    setBuffer("1500000");
    setTab("cash");
    draft.reset({ downside: "70", delay: "7", buffer: "1500000", reason: "" });
  }, [merchantId]);
  const maker = ["Admin", "Operations"].includes(workspace?.role ?? "");
  const finance = workspace?.role === "Finance";
  const ask = (next: PendingAction) => {
    setAction(next);
    setReason("");
    setProblem("");
    setSuccess("");
  };
  const act = async () => {
    if (!action) return;
    draft.sending(
      action.action === "cash.forecast"
        ? { downside, delay, buffer, reason: "" }
        : null,
    );
    try {
      await run(action.action, action.data, action.recordId, reason);
      draft.saved();
      const message: Record<string, string> = {
        "cash.initialize":
          "Sample Cash Desk set up. Review the account timestamps and planning assumptions before preparing work.",
        "cash.forecast":
          "New sample forecast saved. Your source balances and commitments are unchanged.",
        "cash.refresh_sample":
          "Sample source timestamps refreshed. Review the updated balances before preparing new work.",
        "cash.erp.prepare":
          "Sample accounting draft prepared. A different Finance reviewer must check it before export.",
        "cash.erp.refresh":
          "Accounting review refreshed using current evidence and permissions. A different Finance reviewer must approve it again before export.",
        "cash.erp.review":
          "Sample accounting review recorded. The draft can be prepared for export if its evidence is still current. Nothing has been posted.",
        "cash.erp.export":
          "Sample accounting export prepared. Download the review file below. Nothing has been posted to accounting software.",
        "cash.vat.export":
          "Sample VAT review schedule saved. Review its evidence gaps before use. No tax return was filed or paid.",
        "cash.payroll.export":
          "Sample payroll export prepared. Download the review file below. Payroll remains unpaid.",
        "cash.payroll.prepare":
          "Sample payroll funding plan prepared. A different Finance reviewer must check the funding and items before export. Payroll remains unpaid.",
        "cash.payroll.refresh":
          "New sample funding review saved. Previous approval and export readiness have ended; Finance must review again. Existing item outcomes remain recorded.",
        "cash.payroll.approve":
          "Sample funding approval recorded. An export still requires current funding and source checks. Payroll remains unpaid.",
        "cash.payroll.reconcile":
          "Sample payroll item evidence recorded. Review each item's status; unknown outcomes stay on hold and must not be exported again.",
      };
      setSuccess(
        message[action.action] ??
          `${action.title} completed. The sample record is saved; review its current status below. No live financial instruction was sent.`,
      );
      setAction(null);
    } catch (err) {
      setProblem(
        err instanceof Error
          ? err.message
          : "Unable to save this action. Please try again.",
      );
    }
  };
  const reviewForecast = () => {
    const errors: Record<string, string> = {};
    let bufferMinor = 0,
      downsideInflowBps = 0;
    try {
      bufferMinor = nairaToKobo(buffer);
    } catch (error) {
      errors["cash-buffer"] = (error as Error).message;
    }
    if (!/^\d+(?:\.\d{1,2})?$/.test(downside) || Number(downside) > 100) {
      errors["cash-receipts"] =
        "Enter a percentage from 0 to 100 with no more than 2 decimal places.";
    } else {
      downsideInflowBps = nairaToKobo(downside);
    }
    if (!/^\d+$/.test(delay) || Number(delay) > 30)
      errors["cash-delay"] = "Enter a whole number of days from 0 to 30.";
    setForecastErrors(errors);
    if (Object.keys(errors).length) {
      const first = ["cash-receipts", "cash-delay", "cash-buffer"].find(
        (id) => errors[id],
      );
      document.getElementById(first!)?.focus();
      return;
    }
    ask({
      action: "cash.forecast",
      title: "Save forecast version",
      detail: `Keep ${formatPercent(downsideInflowBps / 10000)} of expected receipts, delayed by ${formatCount(Number(delay), "day")}, with a ${formatKobo(bufferMinor)} planning buffer. The base case keeps approved amounts. No bank balance or commitment will be changed.`,
      data: {
        downsideInflowBps,
        downsideDelayDays: Number(delay),
        bufferMinor,
      },
    });
  };
  if (isLoading) return <Loading what="Cash Desk" heading />;
  if (error && !cash)
    return (
      <ConnectedState title={TITLE} description={DESCRIPTION}>
        <LoadProblem
          what="Cash Desk"
          error={error}
          retry={() => {
            void refetch();
          }}
        />
        <ConnectedRecovery recovery={api} />
      </ConnectedState>
    );
  if (!cash) return <Loading what="Cash Desk" heading />;
  const position = cash.positions.find((p) => p.currency === "NGN");
  const base =
    cash.forecast?.scenarios.find((s) => s.name === "base")?.points ?? [];
  const stress =
    cash.forecast?.scenarios.find((s) => s.name === "downside")?.points ?? [];
  const canOperate = canWrite && cash.initialised && cash.permissions.read;
  return (
    <ConnectedFrame
      title={TITLE}
      description={DESCRIPTION}
      recovery={api}
      onRecovered={() => {
        setProblem("");
        setAction(null);
        setReason("");
        draft.saved();
      }}
      onReleased={() => setProblem("")}
    >
      {success && (
        <p className="connected-note" role="status" ref={result}>
          {success}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Building2 className="h-4 w-4" aria-hidden="true" />
          {cash.name}
        </p>
        <p className="text-xs text-muted-foreground">
          Separate SME entity · NGN · sample data
        </p>
      </div>
      {!cash.initialised ? (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-primary/20 bg-primary/5 p-5">
          <div className="max-w-2xl">
            <h2 className="font-semibold">
              Explore the sample, then make it your workspace
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Preview two business accounts and a 30-day plan. Enable
              business-account read permission to save forecasts and prepare
              reviewed exports.
            </p>
          </div>
          <Button
            disabled={!maker || !canWrite || !cash.permissions.read || pending}
            onClick={() =>
              ask({
                action: "cash.initialize",
                title: "Set up sample Cash Desk",
                detail:
                  "Save the sample SME accounts and approved planning inputs. This will not connect to a real bank.",
              })
            }
          >
            Set up sample Cash Desk
            <ArrowRight />
          </Button>
        </div>
      ) : !cash.permissions.read ? (
        <Gate text="Business-account permission has expired or been revoked. New forecasts and preparation actions are paused." />
      ) : null}
      {!cash.permissions.read && !cash.initialised && (
        <Gate text="Business-account read permission is needed before saving changes." />
      )}
      <nav
        aria-label="Cash Desk sections"
        className="flex gap-1 overflow-x-auto rounded-xl border bg-card p-1.5"
      >
        {[
          { id: "cash", title: "Cash & forecast", Icon: ChartNoAxesCombined },
          { id: "accounting", title: "Accounting", Icon: FileCheck2 },
          { id: "vat", title: "VAT evidence", Icon: ShieldCheck },
          { id: "payroll", title: "Payroll funding", Icon: Users },
        ].map(({ id, title, Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={`flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary"}`}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {title}
          </button>
        ))}
      </nav>
      {tab === "cash" && (
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
                          <tr
                            key={point.day}
                            className="border-b last:border-0"
                          >
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
                    Planning buffer: {amount(cash.forecast.planningBufferMinor)}
                    . The buffer does not change your bank balance.
                  </p>
                </>
              ) : cash.savedForecast?.state === "prepare_again" ? (
                <p className="text-sm text-muted-foreground">
                  The figures of the forecast saved{" "}
                  {formatDate(cash.savedForecast.createdAt)} are withheld: the
                  permission it was saved under, or the balances and commitments
                  it was made from, have changed or cannot be confirmed. Save a
                  new forecast version under the current permission.
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
                      onChange={(e) => setDownside(e.target.value)}
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
                <label
                  className="block text-sm font-medium"
                  htmlFor="cash-delay"
                >
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
                      onChange={(e) => setDelay(e.target.value)}
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
                <label
                  className="block text-sm font-medium"
                  htmlFor="cash-buffer"
                >
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
                    onChange={(e) => setBuffer(e.target.value)}
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
                  disabled={
                    !canOperate ||
                    !["Admin", "Operations", "Finance"].includes(
                      workspace?.role ?? "",
                    ) ||
                    pending
                  }
                  onClick={reviewForecast}
                >
                  Save forecast
                  <ArrowRight />
                </Button>
                <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                  <CircleHelp className="mt-0.5 h-4 w-4 shrink-0" />
                  Only information known at the forecast date is included. Draft
                  commitments and future knowledge are excluded. An approved
                  outflow past its due date counts as due now; an overdue
                  receipt is left out.
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
                      <p className="text-xs text-muted-foreground">
                        {a.source}
                      </p>
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
                      <dt className="text-xs text-muted-foreground">
                        Available
                      </dt>
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
      )}
      {tab === "accounting" && (
        <div className="space-y-5">
          {!cash.permissions.erp && (
            <Gate text="Accounting-draft permission is needed to prepare and export a receipt." />
          )}
          <Section
            title="Receipts ready for Finance"
            detail="Match the bank receipt, invoice residual, fee and credit note before exporting an accounting draft. Xero is the first planned integration; live posting is gated."
            action={
              <Button
                disabled={
                  !canOperate ||
                  !maker ||
                  !cash.permissions.erp ||
                  pending ||
                  cash.erpDrafts.length > 0
                }
                onClick={() =>
                  ask({
                    action: "cash.erp.prepare",
                    title: "Prepare sample accounting draft",
                    detail:
                      "Create one draft for the sample receipt. It includes a partial invoice payment, evidenced fee and approved credit note.",
                  })
                }
              >
                <FileCheck2 />
                Prepare sample draft
              </Button>
            }
          >
            {!cash.erpDrafts.length ? (
              <div className="rounded-xl border border-dashed p-8 text-center">
                <FileCheck2 className="mx-auto h-8 w-8 text-muted-foreground" />
                <h3 className="mt-3 font-medium">
                  A clear path from receipt to accounting
                </h3>
                <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                  Operations prepares the draft. A different Finance reviewer
                  checks the exact company, invoice, tax code and amounts before
                  export.
                </p>
              </div>
            ) : (
              cash.erpDrafts.map((r) => (
                <div key={r.id} className="space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="font-semibold">{r.name}</h3>
                    <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium">
                      {label(r.status)} · not posted
                    </span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Metric
                      title="Gross receipt"
                      value={amount(r.draft.input.grossMinor)}
                      detail="Amount applied to the invoice"
                    />
                    <Metric
                      title="Evidenced fee"
                      value={amount(r.draft.input.feeMinor)}
                      detail="Separate fee ledger code"
                    />
                    <Metric
                      title="Net bank receipt"
                      value={amount(r.draft.input.netMinor)}
                      detail="Gross receipt less fee"
                    />
                  </div>
                  {r.draft.residuals.map((residual) => (
                    <div
                      key={residual.invoiceId}
                      className="rounded-xl border p-4 text-sm"
                    >
                      <p className="font-semibold">{residual.invoiceId}</p>
                      <dl className="mt-3 grid gap-3 sm:grid-cols-4">
                        {[
                          ["Original residual", residual.beforeMinor],
                          ["Payment allocation", residual.paymentMinor],
                          ["Credit note", residual.creditNoteMinor],
                          ["Remaining due", residual.afterMinor],
                        ].map(([name, value]) => (
                          <div key={name}>
                            <dt className="text-xs text-muted-foreground">
                              {name}
                            </dt>
                            <dd className="mt-1 font-medium">
                              {amount(value as number)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    Mapping {r.draft.input.mapping.version} ·{" "}
                    {r.draft.input.mapping.companyId} · tax code{" "}
                    {r.draft.input.mapping.taxCode}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Prepared by {r.draft.input.maker}.
                    {r.status === "review_required"
                      ? " Permissions changed since this review. Refresh the accounting review, then obtain a new Finance approval."
                      : r.draft.review
                        ? ` Reviewed by ${r.draft.review.reviewer}.`
                        : " A different Finance reviewer is required."}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={
                        !canOperate ||
                        !maker ||
                        !cash.permissions.erp ||
                        pending
                      }
                      onClick={() =>
                        ask({
                          action: "cash.erp.refresh",
                          title: "Refresh accounting review",
                          detail:
                            "Recheck current permissions, invoice balances, mapping and period locks. Keep the same receipt identity and preserve the previous review as history; a different Finance reviewer must approve again.",
                          recordId: r.id,
                        })
                      }
                    >
                      <RefreshCw />
                      Refresh accounting review
                    </Button>
                    <Button
                      disabled={
                        !canOperate ||
                        !cash.permissions.erp ||
                        !finance ||
                        pending ||
                        r.status !== "proposed"
                      }
                      onClick={() =>
                        ask({
                          action: "cash.erp.review",
                          title: "Review accounting draft",
                          detail:
                            "Confirm the entity, mapping version, invoice allocation, fee and credit note. This approval does not post to the ERP.",
                          recordId: r.id,
                        })
                      }
                    >
                      <Check />
                      Approve draft
                    </Button>
                    <Button
                      variant="outline"
                      disabled={
                        !canOperate ||
                        !cash.permissions.erp ||
                        !finance ||
                        pending ||
                        !["reviewed", "exported"].includes(r.status)
                      }
                      onClick={() =>
                        ask({
                          action: "cash.erp.export",
                          title: "Prepare reviewed ERP export",
                          detail:
                            "Recheck the approved draft and prepare its manifest. No external accounting entry will be created.",
                          recordId: r.id,
                        })
                      }
                    >
                      <Download />
                      Prepare export
                    </Button>
                    {!!r.manifest && (
                      <Button
                        variant="outline"
                        onClick={() =>
                          saveJson("valo-sample-erp-review.json", r.manifest)
                        }
                      >
                        <Download />
                        Download review file
                      </Button>
                    )}
                  </div>
                  {!finance && (
                    <p className="text-xs text-muted-foreground">
                      Switch to a different Finance reviewer to approve or
                      prepare the export.
                    </p>
                  )}
                </div>
              ))
            )}
          </Section>
        </div>
      )}
      {tab === "vat" && (
        <div className="space-y-5">
          <Section
            title="VAT evidence review"
            detail="Invoice amounts, bank allocations and the ledger control remain separate. A bank credit alone does not create VAT or prove input-tax recovery."
            action={
              <Button
                variant="outline"
                disabled={
                  !canOperate || !finance || !cash.permissions.erp || pending
                }
                onClick={() =>
                  ask({
                    action: "cash.vat.export",
                    title: "Save VAT review schedule",
                    detail:
                      "Save the invoice-to-bank-to-ledger evidence schedule with outstanding gaps. This does not file a return or remit tax.",
                  })
                }
              >
                <FileCheck2 />
                Save review schedule
              </Button>
            }
          >
            {cash.vat ? (
              <div className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Metric
                    title="Output VAT"
                    value={amount(cash.vat.outputVatMinor)}
                    detail="Approved sales invoice tax amounts"
                  />
                  <Metric
                    title="Recoverable input"
                    value={amount(cash.vat.eligibleInputVatMinor)}
                    detail="Requires an approved recovery decision"
                  />
                  <Metric
                    title="Input needing review"
                    value={amount(cash.vat.blockedInputVatMinor)}
                    detail="Excluded until evidence is approved"
                  />
                  <Metric
                    title="Ledger difference"
                    value={amount(cash.vat.varianceMinor)}
                    detail="Ledger control less expected balance"
                  />
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">
                      VAT invoice evidence for {cash.vat.period}
                    </caption>
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="py-3">Invoice</th>
                        <th className="py-3 text-right">Net value</th>
                        <th className="py-3 text-right">Invoice VAT</th>
                        <th className="py-3 text-right">Bank allocation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cash.vat.lines.map((line) => (
                        <tr
                          className="border-b last:border-0"
                          key={line.invoiceId}
                        >
                          <td className="py-4">
                            <span className="font-medium">
                              {line.invoiceId}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {label(line.kind)}
                            </span>
                          </td>
                          <td className="py-4 text-right tabular-nums">
                            {amount(line.netMinor)}
                          </td>
                          <td className="py-4 text-right tabular-nums">
                            {amount(line.vatMinor)}
                          </td>
                          <td className="py-4 text-right tabular-nums">
                            {amount(line.paidMinor)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="rounded-xl border bg-secondary/30 p-4">
                  <p className="text-sm font-medium">
                    {amount(cash.vat.excludedBankCreditsMinor)} of bank credits
                    excluded from the VAT calculation
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Loan proceeds and own-account transfers are not treated as
                    sales invoices.
                  </p>
                </div>
                {cash.vat.missingEvidence.map((issue) => (
                  <p
                    key={issue}
                    className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-sm"
                  >
                    {issue}
                  </p>
                ))}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    Period {cash.vat.period} · {label(cash.vat.status)} · not
                    filed
                  </p>
                  <Button
                    variant="outline"
                    onClick={() =>
                      saveJson("valo-sample-vat-evidence.json", cash.vat)
                    }
                  >
                    <Download />
                    Download sample schedule
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Restore business-account permission to review the evidence
                schedule.
              </p>
            )}
            <>
              {cash.vatExports?.map((exported) => (
                <div
                  key={exported.id}
                  className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3"
                >
                  <p className="text-xs text-muted-foreground">
                    Saved by {exported.reviewer} ·{" "}
                    {formatDate(exported.createdAt)}
                  </p>
                  {exported.schedule ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        saveJson(
                          "valo-vat-reviewed-schedule.json",
                          exported.schedule,
                        )
                      }
                    >
                      <Download />
                      Download saved review
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Its figures are withheld: the permission it was saved
                      under, or its evidence, has changed or cannot be
                      confirmed. Save the schedule again under the current
                      permission.
                    </p>
                  )}
                </div>
              ))}
            </>
          </Section>
        </div>
      )}
      {tab === "payroll" && (
        <div className="space-y-5">
          {!cash.permissions.payroll && (
            <Gate text="Payroll-preparation permission is needed for a funding plan and reviewed bank export." />
          )}
          <Section
            title="Fund the approved payroll"
            detail="Use the approved net-pay run to check the source account, other commitments, fees and buffer. Payroll calculations remain in your payroll system."
            action={
              <Button
                disabled={
                  !canOperate ||
                  !maker ||
                  !cash.permissions.payroll ||
                  pending ||
                  cash.payrollPlans.length > 0
                }
                onClick={() =>
                  ask({
                    action: "cash.payroll.prepare",
                    title: "Prepare payroll funding plan",
                    detail:
                      "Use the approved sample net-pay run and the operating account balance. A separate Finance checker must review the plan.",
                  })
                }
              >
                <Users />
                Prepare sample plan
              </Button>
            }
          >
            {!cash.payrollPlans.length ? (
              <div className="rounded-xl border border-dashed p-8 text-center">
                <Users className="mx-auto h-8 w-8 text-muted-foreground" />
                <h3 className="mt-3 font-medium">
                  Know the funding gap before payday
                </h3>
                <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
                  Create a funding plan, have a different person check it, then
                  prepare a bank export. Exporting does not pay employees or
                  reserve funds.
                </p>
              </div>
            ) : (
              cash.payrollPlans.map((r) => (
                <div key={r.id} className="space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">
                        Approved sample net-pay run
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatCount(r.summary.itemCount, "item")} · planned for{" "}
                        {formatCompactDate(r.plan.paymentDate)} · source balance{" "}
                        {formatDate(r.plan.asOf)}
                      </p>
                    </div>
                    <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium">
                      {label(r.summary.status)}
                    </span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <Metric
                      title="Approved net pay"
                      value={amount(r.plan.totalNetMinor)}
                      detail="No payroll or statutory calculations performed"
                    />
                    <Metric
                      title="Total funding need"
                      value={amount(r.plan.requiredMinor)}
                      detail="Net pay + other commitments + fees + buffer"
                    />
                    <Metric
                      title="Source available"
                      value={amount(r.plan.availableMinor)}
                      detail="Operating account · timestamped snapshot"
                    />
                    <Metric
                      title="Funding gap"
                      value={amount(r.plan.shortfallMinor)}
                      detail={label(r.plan.fundingStatus)}
                    />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Other commitments {amount(r.plan.commitmentsMinor)} ·
                    estimated fees {amount(r.plan.estimatedFeesMinor)} · buffer{" "}
                    {amount(r.plan.bufferMinor)}
                  </p>
                  {r.status === "review_required" && (
                    <p className="text-sm text-muted-foreground">
                      Permissions changed since this review. Refresh the funding
                      review, then obtain a new Finance approval. Recorded item
                      outcomes remain unchanged.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={
                        !canOperate ||
                        !maker ||
                        !cash.permissions.payroll ||
                        pending
                      }
                      onClick={() =>
                        ask({
                          action: "cash.payroll.refresh",
                          title: "Refresh funding review",
                          detail:
                            "Use the latest sample source balance and preserve every item outcome. Previous checker approval is invalidated; a different Finance reviewer must approve the new version.",
                          recordId: r.id,
                        })
                      }
                    >
                      <RefreshCw />
                      Refresh funding review
                    </Button>
                    <Button
                      disabled={
                        !canOperate ||
                        !cash.permissions.payroll ||
                        !finance ||
                        pending ||
                        r.status === "review_required" ||
                        r.plan.approvalStatus === "approved" ||
                        r.plan.fundingStatus !== "ready_for_review"
                      }
                      onClick={() =>
                        ask({
                          action: "cash.payroll.approve",
                          title: "Check payroll funding plan",
                          detail:
                            "Confirm the net-pay total, source account, beneficiaries, payment date, commitments and fees. This freezes the plan for export, not payment.",
                          recordId: r.id,
                        })
                      }
                    >
                      <Check />
                      Approve funding plan
                    </Button>
                    <Button
                      variant="outline"
                      disabled={
                        !canOperate ||
                        !cash.permissions.payroll ||
                        !finance ||
                        pending ||
                        r.plan.approvalStatus !== "approved"
                      }
                      onClick={() =>
                        ask({
                          action: "cash.payroll.export",
                          title: "Prepare bank export",
                          detail:
                            "Include only unsent items. Exported items remain unpaid until their bank outcomes are reconciled.",
                          recordId: r.id,
                        })
                      }
                    >
                      <Download />
                      Prepare bank export
                    </Button>
                    {!!r.manifest && (
                      <Button
                        variant="outline"
                        onClick={() =>
                          saveJson(
                            "valo-sample-payroll-export.json",
                            r.manifest,
                          )
                        }
                      >
                        <Download />
                        Download approved manifest
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Maker: {r.plan.maker} · Checker:{" "}
                    {r.plan.checker ??
                      "A different Finance reviewer is required"}
                    . Bank signatory authority remains separate.
                  </p>
                  <div className="divide-y rounded-xl border px-4">
                    {r.plan.items.map((item) => (
                      <div
                        key={item.id}
                        className="flex flex-wrap items-center gap-3 py-4"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">
                            {item.employeeReference}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {item.beneficiaryReference}
                          </p>
                        </div>
                        <span className="text-sm font-medium tabular-nums">
                          {amount(item.netMinor)}
                        </span>
                        <span
                          className={`rounded-full px-3 py-1 text-xs ${item.status === "unknown" ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : "bg-secondary"}`}
                        >
                          {label(item.status)}
                        </span>
                        {["exported", "unknown"].includes(item.status) && (
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                !canOperate ||
                                !finance ||
                                !cash.permissions.payroll ||
                                pending
                              }
                              onClick={() =>
                                ask({
                                  action: "cash.payroll.reconcile",
                                  title: "Record sample success evidence",
                                  detail:
                                    "Simulate matching bank evidence for this one item. This does not send a payment and does not retry any other item.",
                                  recordId: r.id,
                                  data: {
                                    itemId: item.id,
                                    status: "succeeded",
                                  },
                                })
                              }
                            >
                              Sample success
                            </Button>
                            {item.status === "exported" && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={
                                  !canOperate ||
                                  !finance ||
                                  !cash.permissions.payroll ||
                                  pending
                                }
                                onClick={() =>
                                  ask({
                                    action: "cash.payroll.reconcile",
                                    title: "Record an unknown outcome",
                                    detail:
                                      "Hold this sample item for bank lookup. It cannot be blindly retried or included in a new export.",
                                    recordId: r.id,
                                    data: {
                                      itemId: item.id,
                                      status: "unknown",
                                    },
                                  })
                                }
                              >
                                Sample unknown
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </Section>
        </div>
      )}
      {tab === "payroll" && !!cash.payrollReconciliation?.length && (
        <Section
          title="Reconcile retained payroll evidence"
          detail="Preparation permission is unavailable. Finance can record sample outcomes for previously exported items without new bank access. Funding details and new exports remain restricted."
        >
          {cash.payrollReconciliation.map((run) => (
            <div key={run.id} className="space-y-3">
              <h3 className="text-sm font-semibold">{run.runId}</h3>
              {run.items.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center gap-3 rounded-xl border p-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {item.employeeReference}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Retained sample item · {label(item.status)}
                    </p>
                  </div>
                  <span className="text-sm font-medium tabular-nums">
                    {amount(item.netMinor)}
                  </span>
                  {["exported", "submitted", "unknown"].includes(
                    item.status,
                  ) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canWrite || !finance || pending}
                      onClick={() =>
                        ask({
                          action: "cash.payroll.reconcile",
                          title: "Reconcile retained sample evidence",
                          detail:
                            "Record matching sample success evidence for this previously exported item. This does not access a bank, renew permission, export a file or send a payment.",
                          recordId: run.id,
                          data: { itemId: item.id, status: "succeeded" },
                        })
                      }
                    >
                      Record sample success
                    </Button>
                  )}
                  {item.status === "succeeded" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canWrite || !finance || pending}
                      onClick={() =>
                        ask({
                          action: "cash.payroll.reconcile",
                          title: "Record retained sample reversal",
                          detail:
                            "Record sample reversal evidence against the original approved item. This does not send a refund or create another payment.",
                          recordId: run.id,
                          data: { itemId: item.id, status: "reversed" },
                        })
                      }
                    >
                      Record sample reversal
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </Section>
      )}
      <div className="flex items-start gap-3 rounded-xl border bg-secondary/20 p-4 text-xs leading-relaxed text-muted-foreground">
        <Wallet className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Valo Pay does not hold this money. This workspace uses synthetic SME
          data. Live bank connections, ERP posting, tax submission and payroll
          payments require their own approvals and are disabled.
        </p>
      </div>
      <Dialog
        open={!!action}
        onOpenChange={(open) => {
          if (!open && !pending && !api.hasUnconfirmedOutcome) setAction(null);
        }}
      >
        <DialogContent onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>{action?.title}</DialogTitle>
            <DialogDescription>{action?.detail}</DialogDescription>
          </DialogHeader>
          <ConnectedRecovery
            recovery={api}
            onReleased={() => setProblem("")}
            onRecovered={() => {
              setProblem("");
              setAction(null);
              setReason("");
              draft.saved();
              setSuccess(
                "Original sample request confirmed. Review the refreshed records below. No live financial instruction was sent.",
              );
            }}
          />
          <label htmlFor="cash-action-reason" className="text-sm font-medium">
            Review note
            <textarea
              id="cash-action-reason"
              disabled={pending || api.hasUnconfirmedOutcome}
              className="mt-2 min-h-24 w-full rounded-lg border bg-background p-3 text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              placeholder="Explain why you are taking this action (at least 8 characters)."
            />
          </label>
          {problem && !api.hasUnconfirmedOutcome && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending || api.hasUnconfirmedOutcome}
              onClick={() => setAction(null)}
            >
              Cancel
            </Button>
            <Button
              busy={pending}
              busyLabel="Saving…"
              disabled={reason.trim().length < 8 || api.hasUnconfirmedOutcome}
              onClick={() => {
                void act();
              }}
            >
              Confirm and save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConnectedFrame>
  );
}
