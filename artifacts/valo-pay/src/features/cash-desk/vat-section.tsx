import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/formatters";
import { Download, FileCheck2 } from "lucide-react";
import { amount, label, Metric, saveJson, Section } from "./shared";
import type { CashView, ReviewAction } from "./types";

type Props = {
  cash: CashView;
  canOperate: boolean;
  finance: boolean;
  pending: boolean;
  ask: ReviewAction;
};

export function CashVatSection({
  cash,
  canOperate,
  finance,
  pending,
  ask,
}: Props) {
  return (
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
                    <tr className="border-b last:border-0" key={line.invoiceId}>
                      <td className="py-4">
                        <span className="font-medium">{line.invoiceId}</span>
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
                Loan proceeds and own-account transfers are not treated as sales
                invoices.
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
                Period {cash.vat.period} · {label(cash.vat.status)} · not filed
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
            Restore business-account permission to review the evidence schedule.
          </p>
        )}
        <>
          {cash.vatExports?.map((exported) => (
            <div
              key={exported.id}
              className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3"
            >
              <p className="text-xs text-muted-foreground">
                Saved by {exported.reviewer} · {formatDate(exported.createdAt)}
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
                  Its figures are withheld: the permission it was saved under,
                  or its evidence, has changed or cannot be confirmed. Save the
                  schedule again under the current permission.
                </p>
              )}
            </div>
          ))}
        </>
      </Section>
    </div>
  );
}
