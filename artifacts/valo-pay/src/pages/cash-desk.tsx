import {
  ConnectedFrame,
  ConnectedRecovery,
  ConnectedState,
  describedBy,
  FieldHint,
  roleRefusal,
  tooShort,
} from "@/components/connected-frame";
import { FieldError } from "@/components/form-field";
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
import type { PendingAction, RoleRefusal } from "@/features/cash-desk/types";
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
    "Cash Desk works on a sample business, separate from the lender. A different Finance reviewer approves each accounting draft and payroll plan before export.";
const cashSections = [
  { id: "cash", label: "Cash and forecast", icon: ChartNoAxesCombined, description: "Check each balance’s timestamp and your assumptions before you save a forecast. A planning buffer does not set money aside." },
  { id: "accounting", label: "Accounting", icon: FileCheck2, description: "Admin or Operations prepares the draft. A different Finance reviewer approves it before export. Your accounting software stays the official record." },
  { id: "vat", label: "VAT evidence", icon: ShieldCheck, description: "Check invoice, bank and ledger evidence with an accountant. Saving a VAT schedule does not file a VAT return or pay tax." },
  { id: "payroll", label: "Payroll funding", icon: Users, description: "Check there is enough money for the approved payroll (net pay). A different Finance reviewer approves the plan. Approving the plan and exporting the file do not pay anyone." },
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
  const [reasonError, setReasonError] = useState("");
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
  // Planning inputs, or a reason, typed but not saved are a draft: leaving asks first.
  const draft = useFormDraft({
    downside,
    delay,
    buffer,
    reason: action ? reason : "",
  });
  useEffect(() => {
    setAction(null);
    setReason("");
    setReasonError("");
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
  const refuse: RoleRefusal = (roles, what) =>
    roleRefusal(roles, what, workspace?.role ?? "", workspace?.accessMode);
  const ask = (next: PendingAction) => {
    setAction(next);
    setReason("");
    setReasonError("");
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
          "Sample balance timestamps refreshed. Nothing was sent to a bank. Check the updated balances before you prepare new work.",
        "cash.erp.prepare":
          "Sample accounting draft prepared. A different Finance reviewer must approve it before export.",
        "cash.erp.refresh":
          "Accounting review refreshed using current evidence and permissions. A different Finance reviewer must approve it again before export.",
        "cash.erp.review":
          "Sample accounting draft approved. You can prepare its export file while its evidence is still current. Nothing was posted to accounting software.",
        "cash.erp.export":
          "Sample accounting export file prepared. Download it below. Nothing was posted to accounting software.",
        "cash.vat.export":
          "Sample VAT schedule saved. Check its evidence gaps before you use it. No VAT return was filed and no tax was paid.",
        "cash.payroll.export":
          "Sample payroll export file prepared. Download it below. No one has been paid.",
        "cash.payroll.prepare":
          "Sample funding plan prepared. A different Finance reviewer must approve it before export. No one has been paid.",
        "cash.payroll.refresh":
          "Funding review refreshed. The earlier approval no longer applies, so a different Finance reviewer must approve again. Item results already recorded are kept.",
        "cash.payroll.approve":
          "Sample funding plan approved. You can prepare the bank export file while the balances are current. No one has been paid.",
        "cash.payroll.reconcile":
          "Sample result recorded for this item. Items with an unknown outcome stay on hold and must not be exported again.",
      };
      setSuccess(
        message[action.action] ??
          "Sample record saved. Check its status below. Nothing was sent to a bank.",
      );
      setAction(null);
    } catch (err) {
      setProblem(
        err instanceof Error
          ? err.message
          : "This action was not saved. Try again.",
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
      title: "Save forecast?",
      detail: `Cautious case: ${formatPercent(downsideInflowBps / 10000)} of expected receipts arrive, ${formatCount(Number(delay), "day")} late. Planning buffer: ${formatKobo(bufferMinor)}. The expected case uses the approved amounts. No bank balance or commitment will change.`,
      confirm: "Save forecast",
      busy: "Saving…",
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
          Amounts in naira
        </p>
      </div>
      {!cash.initialised ? (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-primary/20 bg-primary/5 p-5">
          <div className="max-w-2xl">
            <h2 className="font-semibold">
              Preview the sample, then set it up
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Preview two business accounts and a 30-day plan. To save
              forecasts and prepare exports, grant the Read business accounts
              permission, then set up Cash Desk.
            </p>
          </div>
          <Button
            disabled={!maker || !canWrite || !cash.permissions.read || pending}
            aria-describedby="cash-setup-help"
            onClick={() =>
              ask({
                action: "cash.initialize",
                title: "Set up Cash Desk?",
                detail:
                  "This saves the sample business’s accounts and approved plans. It does not connect to a real bank.",
                confirm: "Set up Cash Desk",
                busy: "Setting up…",
              })
            }
          >
            Set up Cash Desk
            <ArrowRight />
          </Button>
          <p id="cash-setup-help" className="w-full text-xs text-muted-foreground">
            {!maker ? refuse(["Admin", "Operations"], "set up Cash Desk")
              : !canWrite ? "Your role is Read-only. Ask an Admin for a role that can make changes."
              : !cash.permissions.read ? "First, grant the Read business accounts permission in Permissions and readiness."
              : "Set up Cash Desk, then save a forecast or choose a section below."}
          </p>
        </div>
      ) : !cash.permissions.read ? (
        <Gate text="The Read business accounts permission has expired or been withdrawn. You cannot save forecasts or prepare work until it is granted again." />
      ) : null}
      {!cash.permissions.read && !cash.initialised && (
        <Gate text="Grant the Read business accounts permission before you save changes." />
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
          refuse={refuse}
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
          refuse={refuse}
          ask={ask}
        />
      )}
      {tab === "vat" && (
        <CashVatSection
          cash={cash}
          canOperate={canOperate}
          finance={finance}
          pending={pending}
          refuse={refuse}
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
          refuse={refuse}
          ask={ask}
        />
      )}
      </div>

      <div className="flex items-start gap-3 rounded-xl border bg-secondary/20 p-4 text-xs leading-relaxed text-muted-foreground">
        <Wallet className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Valo Pay never holds money. Sample data only. Bank connections,
          posting to accounting software, VAT filing and payroll payments are
          switched off. Each would need its own approval.
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
            <DialogDescription>
              {action?.detail} Sample data only.
            </DialogDescription>
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
                "Original request confirmed. Check the updated records below. Nothing was sent to a bank.",
              );
            }}
          />
          <div>
            <label htmlFor="cash-action-reason" className="text-sm font-medium">
              Reason
              <textarea
                id="cash-action-reason"
                disabled={pending || api.hasUnconfirmedOutcome}
                className="mt-2 min-h-24 w-full rounded-lg border bg-background p-3 text-sm"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setReasonError("");
                }}
                maxLength={500}
                aria-invalid={reasonError ? true : undefined}
                aria-describedby={describedBy("cash-action-reason", reasonError)}
                placeholder="Why are you taking this action?"
              />
            </label>
            <FieldHint id="cash-action-reason-help" minLength={8} />
            <FieldError id="cash-action-reason" message={reasonError} />
          </div>
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
              busyLabel={action?.busy}
              disabled={api.hasUnconfirmedOutcome}
              onClick={() => {
                const short = tooShort(reason, "a reason", 8);
                setReasonError(short);
                if (short) {
                  document.getElementById("cash-action-reason")?.focus();
                  return;
                }
                void act();
              }}
            >
              {action?.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConnectedFrame>
  );
}
