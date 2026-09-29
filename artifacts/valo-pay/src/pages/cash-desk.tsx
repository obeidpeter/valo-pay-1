import {
  ConnectedFrame,
  ConnectedRecovery,
  ConnectedState,
} from "@/components/connected-frame";
import { LoadProblem } from "@/components/load-problem";
import { Loading } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { SectionNavigation } from "@/components/section-navigation";
import { useSearchParams } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CashAccountingSection } from "@/features/cash-desk/accounting-section";
import { CashForecastSection } from "@/features/cash-desk/forecast-section";
import { CashPayrollSection } from "@/features/cash-desk/payroll-section";
import { Gate } from "@/features/cash-desk/shared";
import type { PendingAction } from "@/features/cash-desk/types";
import { CashVatSection } from "@/features/cash-desk/vat-section";
import { useConnected } from "@/lib/connected";
import { useDialogFocusReturn } from "@/lib/focus";
import { formatCount, formatKobo, formatPercent } from "@/lib/formatters";
import { nairaToKobo } from "@/lib/money-input";
import { useFormDraft } from "@/lib/unsaved-changes";
import { useWorkspace } from "@/lib/workspace-context";
import {
  ArrowRight,
  Building2,
  ChartNoAxesCombined,
  FileCheck2,
  ShieldCheck,
  Users,
  Wallet,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

const TITLE = "Cash Desk",
  DESCRIPTION =
    "A clearer view of business cash, commitments and the work ahead.";
const cashSections = [
  { id: "cash", label: "Cash & forecast", icon: ChartNoAxesCombined, description: "Review timestamped balances and assumptions before saving a forecast. Planning buffers do not reserve bank funds." },
  { id: "accounting", label: "Accounting", icon: FileCheck2, description: "Operations prepares the draft; a different Finance reviewer checks it before export. The accounting system remains authoritative." },
  { id: "vat", label: "VAT evidence", icon: ShieldCheck, description: "Review invoice, bank and ledger evidence with an accountant. Preparing a schedule does not file or pay a tax return." },
  { id: "payroll", label: "Payroll funding", icon: Users, description: "Check an approved net-pay run, obtain independent review and track every item. Funding approval and export do not establish payment." },
] as const;
export default function CashDeskPage() {
  const api = useConnected();
  const { data, isLoading, error, refetch, run, pending, canWrite } = api;
  const { workspace, merchantId } = useWorkspace();
  const cash = data?.cash;
  const [search, setSearch] = useSearchParams();
  const tab = cashSections.some(section => section.id === search.get("view")) ? search.get("view")! : "cash";
  const setTab = (view: string) => setSearch(current => {
    const next = new URLSearchParams(current);
    if (view === "cash") next.delete("view"); else next.set("view", view);
    return next;
  });
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
            aria-describedby="cash-setup-help"
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
          <p id="cash-setup-help" className="w-full text-xs text-muted-foreground">
            {!maker ? "An Admin or Operations user must set up this sample workspace."
              : !canWrite ? "This workspace is read-only. Ask an administrator to review your access."
              : !cash.permissions.read ? "Grant business-account read permission in Permissions & readiness first."
              : "Save the sample workspace, then prepare a forecast or choose a review task below."}
          </p>
        </div>
      ) : !cash.permissions.read ? (
        <Gate text="Business-account permission has expired or been revoked. New forecasts and preparation actions are paused." />
      ) : null}
      {!cash.permissions.read && !cash.initialised && (
        <Gate text="Business-account read permission is needed before saving changes." />
      )}
      <SectionNavigation label="Cash Desk sections" sections={cashSections} value={tab} onChange={setTab} controls="cash-desk-view" />
      <div id="cash-desk-view">
      {tab === "cash" && (
        <CashForecastSection
          cash={cash}
          assumptions={{ downside, delay, buffer }}
          forecastErrors={forecastErrors}
          onAssumptionChange={(field, value) =>
            ({ downside: setDownside, delay: setDelay, buffer: setBuffer })[
              field
            ](value)
          }
          canOperate={canOperate}
          canPrepareForecast={["Admin", "Operations", "Finance"].includes(
            workspace?.role ?? "",
          )}
          maker={maker}
          pending={pending}
          reviewForecast={reviewForecast}
          ask={ask}
        />
      )}
      {tab === "accounting" && (
        <CashAccountingSection
          cash={cash}
          canOperate={canOperate}
          maker={maker}
          finance={finance}
          pending={pending}
          ask={ask}
        />
      )}
      {tab === "vat" && (
        <CashVatSection
          cash={cash}
          canOperate={canOperate}
          finance={finance}
          pending={pending}
          ask={ask}
        />
      )}
      {tab === "payroll" && (
        <CashPayrollSection
          cash={cash}
          canOperate={canOperate}
          canWrite={canWrite}
          maker={maker}
          finance={finance}
          pending={pending}
          ask={ask}
        />
      )}
      </div>

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
