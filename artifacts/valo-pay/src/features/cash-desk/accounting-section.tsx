import { Button } from "@/components/ui/button";
import { Check, Download, FileCheck2, RefreshCw } from "lucide-react";
import { amount, Gate, label, Metric, saveJson, Section } from "./shared";
import type { CashView, ReviewAction } from "./types";

type Props = {
  cash: CashView;
  canOperate: boolean;
  maker: boolean;
  finance: boolean;
  pending: boolean;
  ask: ReviewAction;
};

export function CashAccountingSection({
  cash,
  canOperate,
  maker,
  finance,
  pending,
  ask,
}: Props) {
  return (
    <div className="space-y-5">
      {!cash.permissions.erp && (
        <Gate text="Accounting-draft permission is needed to prepare and export a receipt." />
      )}
      <Section
        title="Receipts ready for Finance"
        detail="Match the bank receipt, invoice residual, fee and credit note before exporting an accounting draft. Xero is the first planned integration; live posting is gated."
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
        <p id="accounting-prepare-help" className="mb-4 text-xs leading-relaxed text-muted-foreground">
          {cash.erpDrafts.length > 0 ? "A sample draft already exists. Continue its review below; preparing another draft for the same receipt is unavailable."
            : !maker ? "An Admin or Operations user prepares the draft; a different Finance reviewer checks it."
            : !cash.permissions.erp ? "Grant accounting-draft permission in Permissions & readiness before preparing a draft."
            : !canOperate ? "Set up the sample Cash Desk with active business-account read permission first."
            : "Prepare the draft, review its invoice and fee evidence, then hand it to a different Finance reviewer."}
        </p>
        {!cash.erpDrafts.length ? (
          <div className="rounded-xl border border-dashed p-8 text-center">
            <FileCheck2 className="mx-auto h-8 w-8 text-muted-foreground" />
            <h3 className="mt-3 font-medium">
              A clear path from receipt to accounting
            </h3>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              Operations prepares the draft. A different Finance reviewer checks
              the exact company, invoice, tax code and amounts before export.
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
                    {(
                      [
                        ["Original residual", residual.beforeMinor],
                        ["Payment allocation", residual.paymentMinor],
                        ["Credit note", residual.creditNoteMinor],
                        ["Remaining due", residual.afterMinor],
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
                    !canOperate || !maker || !cash.permissions.erp || pending
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
                  Switch to a different Finance reviewer to approve or prepare
                  the export.
                </p>
              )}
            </div>
          ))
        )}
      </Section>
    </div>
  );
}
