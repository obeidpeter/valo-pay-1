import { Button } from "@/components/ui/button";
import { formatCompactDate, formatCount, formatDate } from "@/lib/formatters";
import { Check, Download, RefreshCw, Users } from "lucide-react";
import { amount, Gate, label, Metric, saveJson, Section } from "./shared";
import type { CashView, ReviewAction } from "./types";

type Props = {
  cash: CashView;
  canOperate: boolean;
  canWrite: boolean;
  maker: boolean;
  finance: boolean;
  pending: boolean;
  ask: ReviewAction;
};

export function CashPayrollSection({
  cash,
  canOperate,
  canWrite,
  maker,
  finance,
  pending,
  ask,
}: Props) {
  return (
    <>
      <div className="space-y-5">
        {!cash.permissions.payroll && (
          <Gate text="Payroll-preparation permission is needed for a funding plan and reviewed bank export." />
        )}
        <Section
          title="Fund the approved payroll"
          detail="Use the approved net-pay run to check the source account, other commitments, fees and buffer. Payroll calculations remain in your payroll system."
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
          <p id="payroll-prepare-help" className="mb-4 text-xs leading-relaxed text-muted-foreground">
            {cash.payrollPlans.length > 0 ? "A funding plan already exists. Continue its review below; successful or unknown items must not be exported again."
              : !maker ? "An Admin or Operations user prepares the plan; a different Finance reviewer checks the funding."
              : !cash.permissions.payroll ? "Grant payroll-preparation permission in Permissions & readiness before preparing a plan."
              : !canOperate ? "Set up the sample Cash Desk with active business-account read permission first."
              : "Prepare a funding plan for the approved net-pay run. A planning buffer does not reserve bank funds."}
          </p>
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
                        saveJson("valo-sample-payroll-export.json", r.manifest)
                      }
                    >
                      <Download />
                      Download approved manifest
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Maker: {r.plan.maker} · Checker:{" "}
                  {r.plan.checker ?? "A different Finance reviewer is required"}
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
      {!!cash.payrollReconciliation?.length && (
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
    </>
  );
}
