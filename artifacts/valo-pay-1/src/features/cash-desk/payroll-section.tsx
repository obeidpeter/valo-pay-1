import { ConnectedStatus, connectedStatusLabel } from "@/components/connected-frame";
import { Button } from "@/components/ui/button";
import { formatCompactDate, formatCount, formatDate } from "@/lib/formatters";
import { Check, Download, RefreshCw, Users } from "lucide-react";
import { amount, Gate, Metric, saveJson, Section, SET_UP_FIRST } from "./shared";
import type { CashView, ReviewAction, RoleRefusal } from "./types";

type Props = {
  cash: CashView;
  canOperate: boolean;
  canWrite: boolean;
  maker: boolean;
  finance: boolean;
  pending: boolean;
  refuse: RoleRefusal;
  ask: ReviewAction;
};

export function CashPayrollSection({
  cash,
  canOperate,
  canWrite,
  maker,
  finance,
  pending,
  refuse,
  ask,
}: Props) {
  return (
    <>
      <div className="space-y-5">
        {!cash.permissions.payroll && (
          <Gate text="Grant the Prepare payroll funding permission before you prepare a funding plan or a bank export file." />
        )}
        <Section
          title="Payroll funding"
          detail="Use the approved payroll (net pay) to check the paying account, other payments due, fees and buffer. Pay is still calculated in your payroll system."
          action={
            <Button
              aria-describedby="payroll-prepare-help"
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
                  title: "Prepare funding plan?",
                  detail:
                    "This uses the approved sample payroll (net pay) and the operating account balance. A different Finance reviewer must then approve the plan.",
                  confirm: "Prepare funding plan",
                  busy: "Preparing…",
                })
              }
            >
              <Users />
              Prepare funding plan
            </Button>
          }
        >
          <p id="payroll-prepare-help" className="mb-4 text-xs leading-relaxed text-muted-foreground">
            {cash.payrollPlans.length > 0 ? "A funding plan already exists. Continue with it below. Confirmed items and items with an unknown outcome must not be exported again."
              : !maker ? refuse(["Admin", "Operations"], "prepare a funding plan")
              : !cash.permissions.payroll ? "Grant the Prepare payroll funding permission in Permissions and readiness first."
              : !canOperate ? SET_UP_FIRST
              : "Prepare a funding plan for the approved payroll (net pay). A planning buffer does not set money aside."}
          </p>
          {!cash.payrollPlans.length ? (
            <div className="rounded-xl border border-dashed p-8 text-center">
              <Users className="mx-auto h-8 w-8 text-muted-foreground" />
              <h3 className="mt-3 font-medium">No funding plan yet</h3>
              <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
                Select Prepare funding plan to start. A different Finance
                reviewer approves the plan before you prepare a bank export
                file. Exporting does not pay employees or set money aside.
              </p>
            </div>
          ) : (
            cash.payrollPlans.map((r) => (
              <div key={r.id} className="space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">
                      Approved sample payroll (net pay)
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatCount(r.summary.itemCount, "payment")} · pay date{" "}
                      {formatCompactDate(r.plan.paymentDate)} · balance at{" "}
                      {formatDate(r.plan.asOf)}
                    </p>
                  </div>
                  <ConnectedStatus record="payroll-run" status={r.summary.status} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Metric
                    title="Approved net pay"
                    value={amount(r.plan.totalNetMinor)}
                    detail="Valo Pay 1 does not calculate pay, tax or pension"
                  />
                  <Metric
                    title="Total funding need"
                    value={amount(r.plan.requiredMinor)}
                    detail="Net pay, other payments due, fees and buffer"
                  />
                  <Metric
                    title="Available in operating account"
                    value={amount(r.plan.availableMinor)}
                    detail="Balance at the time shown above"
                  />
                  <Metric
                    title="Funding gap"
                    value={amount(r.plan.shortfallMinor)}
                    detail={connectedStatusLabel("payroll-funding", r.plan.fundingStatus)}
                  />
                </div>
                <p className="text-sm text-muted-foreground">
                  Other payments due {amount(r.plan.commitmentsMinor)} ·
                  estimated fees {amount(r.plan.estimatedFeesMinor)} · buffer{" "}
                  {amount(r.plan.bufferMinor)}
                </p>
                {r.status === "review_required" && (
                  <p className="text-sm text-muted-foreground">
                    Permissions changed since this review. Refresh the funding
                    review, then get a new Finance approval. Item results
                    already recorded are kept.
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
                        title: "Refresh funding review?",
                        detail:
                          "This uses the latest sample balance. Item results already recorded are kept. The earlier approval no longer applies, so a different Finance reviewer must approve again.",
                        confirm: "Refresh funding review",
                        busy: "Refreshing…",
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
                        title: "Approve funding plan?",
                        detail:
                          "Check the net pay total, the paying account, the employees’ accounts, the pay date, other payments and fees. Approving locks the plan for export. It does not pay anyone.",
                        confirm: "Approve funding plan",
                        busy: "Approving…",
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
                        title: "Prepare bank export file?",
                        detail:
                          "Only items not yet sent are included. Exported items stay unpaid until the bank confirms each payment.",
                        confirm: "Prepare bank export file",
                        busy: "Preparing…",
                        recordId: r.id,
                      })
                    }
                  >
                    <Download />
                    Prepare bank export file
                  </Button>
                  {!!r.manifest && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        saveJson("valo-sample-payroll-export.json", r.manifest)
                      }
                    >
                      <Download />
                      Download payroll export file
                    </Button>
                  )}
                </div>
                {!finance && (
                  <p className="text-xs text-muted-foreground">
                    {refuse(
                      ["Finance"],
                      "approve the funding plan, prepare its bank export file or record payment results",
                    )}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Prepared by {r.plan.maker}.{" "}
                  {r.plan.checker
                    ? `Approved by ${r.plan.checker}.`
                    : "A different Finance reviewer must approve it."}{" "}
                  The people who sign payments at your bank still approve them
                  separately.
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
                      <ConnectedStatus record="payroll-item" status={item.status} />
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
                                title: "Simulate a confirmed payment?",
                                detail:
                                  "This simulates bank evidence that this one item was paid. It does not send a payment or retry any other item.",
                                confirm: "Simulate confirmed payment",
                                busy: "Simulating…",
                                recordId: r.id,
                                data: {
                                  itemId: item.id,
                                  status: "succeeded",
                                },
                              })
                            }
                          >
                            Simulate confirmed payment
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
                                  title: "Simulate an unknown outcome?",
                                  detail:
                                    "This item will be held until the bank confirms what happened. It cannot be retried or added to a new export.",
                                  confirm: "Simulate unknown outcome",
                                  busy: "Simulating…",
                                  recordId: r.id,
                                  data: {
                                    itemId: item.id,
                                    status: "unknown",
                                  },
                                })
                              }
                            >
                              Simulate unknown outcome
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
      {!!cash.payrollReconciliation?.length && (
        <Section
          title="Record results for payroll items already exported"
          detail="The Prepare payroll funding permission is not active. Finance can still record sample results for items already exported. Funding details and new exports stay hidden until the permission is granted again."
        >
          {!finance && (
            <p className="mb-4 text-xs text-muted-foreground">
              {refuse(["Finance"], "record payment results")}
            </p>
          )}
          {cash.payrollReconciliation.map((run) => (
            <div key={run.id} className="space-y-3">
              <h3 className="text-sm font-semibold">
                Approved sample payroll ({run.runId})
              </h3>
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
                      Sample item · {connectedStatusLabel("payroll-item", item.status)}
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
                          title: "Simulate a confirmed payment?",
                          detail:
                            "This records a sample confirmed payment for this exported item. It does not contact a bank, renew a permission, export a file or send a payment.",
                          confirm: "Simulate confirmed payment",
                          busy: "Simulating…",
                          recordId: run.id,
                          data: { itemId: item.id, status: "succeeded" },
                        })
                      }
                    >
                      Simulate confirmed payment
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
                          title: "Simulate a reversal?",
                          detail:
                            "This records a sample reversal against the original approved item. It does not send a refund or create another payment.",
                          confirm: "Simulate reversal",
                          busy: "Simulating…",
                          recordId: run.id,
                          data: { itemId: item.id, status: "reversed" },
                        })
                      }
                    >
                      Simulate reversal
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </Section>
      )}
    </>
  );
}
