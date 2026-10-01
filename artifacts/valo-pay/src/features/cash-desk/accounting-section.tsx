import { ConnectedStatus } from "@/components/connected-frame";
import { Button } from "@/components/ui/button";
import { Check, Download, FileCheck2, RefreshCw } from "lucide-react";
import { amount, Gate, Metric, saveJson, Section, SET_UP_FIRST } from "./shared";
import type { CashView, ReviewAction, RoleRefusal } from "./types";

type Props = {
  cash: CashView;
  canOperate: boolean;
  maker: boolean;
  finance: boolean;
  pending: boolean;
  refuse: RoleRefusal;
  ask: ReviewAction;
};

export function CashAccountingSection({
  cash,
  canOperate,
  maker,
  finance,
  pending,
  refuse,
  ask,
}: Props) {
  return (
    <div className="space-y-5">
      {!cash.permissions.erp && (
        <Gate text="Grant the Prepare accounting drafts and VAT schedules permission before you prepare or export a draft." />
      )}
      <Section
        title="Accounting"
        detail="Before you export a draft, check that the bank receipt, the amount still owed, the fee and the credit note agree. Xero is the first accounting software Valo Pay plans to connect. Posting to it is switched off."
        action={
          <Button
            aria-describedby="accounting-prepare-help"
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
                title: "Prepare accounting draft?",
                detail:
                  "This drafts the sample bank receipt for accounting. It covers part-payment of an invoice, a fee with evidence and an approved credit note.",
                confirm: "Prepare accounting draft",
                busy: "Preparing…",
              })
            }
          >
            <FileCheck2 />
            Prepare accounting draft
          </Button>
        }
      >
        <p id="accounting-prepare-help" className="mb-4 text-xs leading-relaxed text-muted-foreground">
          {cash.erpDrafts.length > 0 ? "A sample draft already exists. Continue with it below. You cannot prepare a second draft for the same receipt."
            : !maker ? refuse(["Admin", "Operations"], "prepare an accounting draft")
            : !cash.permissions.erp ? "Grant the Prepare accounting drafts and VAT schedules permission in Permissions and readiness first."
            : !canOperate ? SET_UP_FIRST
            : "Prepare the draft and check its invoice and fee evidence. A different Finance reviewer then approves it."}
        </p>
        {!cash.erpDrafts.length ? (
          <div className="rounded-xl border border-dashed p-8 text-center">
            <FileCheck2 className="mx-auto h-8 w-8 text-muted-foreground" />
            <h3 className="mt-3 font-medium">No accounting draft yet</h3>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              Select Prepare accounting draft to start. A different Finance
              reviewer then checks the business, invoice, tax code and amounts
              before export.
            </p>
          </div>
        ) : (
          cash.erpDrafts.map((r) => (
            <div key={r.id} className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-semibold">{r.name}</h3>
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <ConnectedStatus record="accounting-draft" status={r.status} />
                  Not posted to accounting software
                </p>
              </div>
              {r.status === "blocked" && r.draft.reasons.length > 0 && (
                <div className="rounded-xl border p-4 text-sm">
                  <p className="font-medium">Why it is blocked:</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                    {r.draft.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <Metric
                  title="Received before fees"
                  value={amount(r.draft.input.grossMinor)}
                  detail="Amount paid against the invoice"
                />
                <Metric
                  title="Fee (with evidence)"
                  value={amount(r.draft.input.feeMinor)}
                  detail="Recorded against a separate fee account"
                />
                <Metric
                  title="Received after fees"
                  value={amount(r.draft.input.netMinor)}
                  detail="The amount before fees, less the fee"
                />
              </div>
              {r.draft.residuals.map((residual) => (
                <div
                  key={residual.invoiceId}
                  className="rounded-xl border p-4 text-sm"
                >
                  <p className="font-semibold">{residual.invoiceId}</p>
                  <dl className="mt-3 grid gap-3 sm:grid-cols-4">
                    {(
                      [
                        ["Owed before", residual.beforeMinor],
                        ["This payment", residual.paymentMinor],
                        ["Credit note", residual.creditNoteMinor],
                        ["Still owed", residual.afterMinor],
                      ] as const
                    ).map(([name, value]) => (
                      <div key={name}>
                        <dt className="text-xs text-muted-foreground">
                          {name}
                        </dt>
                        <dd className="mt-1 font-medium">{amount(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Account mapping {r.draft.input.mapping.version} · company{" "}
                {r.draft.input.mapping.companyId} · tax code{" "}
                {r.draft.input.mapping.taxCode}
              </p>
              <p className="text-sm text-muted-foreground">
                Prepared by {r.draft.input.maker}.
                {r.status === "review_required"
                  ? " Permissions changed since this review. Refresh the accounting review, then get a new Finance approval."
                  : r.draft.review
                    ? ` Approved by ${r.draft.review.reviewer}.`
                    : " A different Finance reviewer must approve it."}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={
                    !canOperate || !maker || !cash.permissions.erp || pending
                  }
                  onClick={() =>
                    ask({
                      action: "cash.erp.refresh",
                      title: "Refresh accounting review?",
                      detail:
                        "This checks the current permissions, invoice balances, account mapping and closed periods again. The receipt and the earlier review are kept. A different Finance reviewer must then approve again.",
                      confirm: "Refresh accounting review",
                      busy: "Refreshing…",
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
                      title: "Approve accounting draft?",
                      detail:
                        "Check the business, the account mapping, the invoice payment, the fee and the credit note. Approving does not post anything to accounting software.",
                      confirm: "Approve draft",
                      busy: "Approving…",
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
                      title: "Prepare export file?",
                      detail:
                        "This checks the approved draft again and prepares its export file. Nothing will be posted to accounting software.",
                      confirm: "Prepare export file",
                      busy: "Preparing…",
                      recordId: r.id,
                    })
                  }
                >
                  <Download />
                  Prepare export file
                </Button>
                {!!r.manifest && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      saveJson("valo-sample-accounting-review.json", r.manifest)
                    }
                  >
                    <Download />
                    Download export file
                  </Button>
                )}
              </div>
              {!finance && (
                <p className="text-xs text-muted-foreground">
                  {refuse(["Finance"], "approve the draft or prepare its export file")}
                </p>
              )}
            </div>
          ))
        )}
      </Section>
    </div>
  );
}
