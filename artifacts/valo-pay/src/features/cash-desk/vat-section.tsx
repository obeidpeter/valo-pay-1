import { ConnectedStatus } from "@/components/connected-frame";
import { Button } from "@/components/ui/button";
import { ScrollFrame } from "@/components/scroll-frame";
import { formatDate } from "@/lib/formatters";
import { valueLabel } from "@workspace/valopay-schema";
import { Download, FileCheck2 } from "lucide-react";
import { amount, Metric, saveJson, Section, SET_UP_FIRST } from "./shared";
import type { CashView, ReviewAction, RoleRefusal } from "./types";

type Props = {
  cash: CashView;
  canOperate: boolean;
  finance: boolean;
  pending: boolean;
  refuse: RoleRefusal;
  ask: ReviewAction;
};

const monthFormat = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
/** A VAT period ("2026-09") as its month in words ("September 2026"); anything else as it is. */
const vatMonth = (period: string) =>
  /^\d{4}-\d{2}$/.test(period) ? monthFormat.format(new Date(`${period}-01T00:00:00Z`)) : period;

export function CashVatSection({
  cash,
  canOperate,
  finance,
  pending,
  refuse,
  ask,
}: Props) {
  return (
    <div className="space-y-5">
      <Section
        title="VAT evidence"
        detail="Invoice amounts, bank payments and the VAT account in your ledger are checked separately. Money arriving in the bank does not by itself create VAT, or prove that you can reclaim VAT."
        action={
          <Button
            variant="outline"
            aria-describedby="vat-review-help"
            disabled={
              !canOperate || !finance || !cash.permissions.erp || pending
            }
            onClick={() =>
              ask({
                action: "cash.vat.export",
                title: "Save VAT schedule?",
                detail:
                  "This saves the schedule that links invoices, bank payments and the ledger, with any gaps. It does not file a VAT return or pay tax.",
                confirm: "Save VAT schedule",
                busy: "Saving…",
              })
            }
          >
            <FileCheck2 />
            Save VAT schedule
          </Button>
        }
      >
        <p id="vat-review-help" className="mb-4 text-xs leading-relaxed text-muted-foreground">
          {!finance ? refuse(["Finance"], "save a VAT schedule")
            : !cash.permissions.erp ? "Grant the Prepare accounting drafts and VAT schedules permission in Permissions and readiness first."
            : !canOperate ? SET_UP_FIRST
            : "The saved schedule keeps any evidence gaps for your accountant to resolve. It does not file a VAT return."}
        </p>
        {cash.vat ? (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric
                title="Output VAT (on sales)"
                value={amount(cash.vat.outputVatMinor)}
                detail="VAT on approved sales invoices"
              />
              <Metric
                title="Input VAT you can reclaim"
                value={amount(cash.vat.eligibleInputVatMinor)}
                detail="Needs an approved decision before you reclaim it"
              />
              <Metric
                title="Input VAT needing review"
                value={amount(cash.vat.blockedInputVatMinor)}
                detail="Left out until its evidence is approved"
              />
              <Metric
                title="Difference from your ledger"
                value={amount(cash.vat.varianceMinor)}
                detail="VAT account in your ledger minus the expected balance"
              />
            </div>
            <ScrollFrame label={`VAT invoice evidence for ${vatMonth(cash.vat.period)}`}>
              <table className="w-full text-sm">
                <caption className="sr-only">
                  VAT invoice evidence for {vatMonth(cash.vat.period)}
                </caption>
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-3">Invoice</th>
                    <th className="py-3 text-right">Value before VAT</th>
                    <th className="py-3 text-right">VAT</th>
                    <th className="py-3 text-right">Paid through bank</th>
                  </tr>
                </thead>
                <tbody>
                  {cash.vat.lines.map((line) => (
                    <tr className="border-b last:border-0" key={line.invoiceId}>
                      <td className="py-4">
                        <span className="font-medium">{line.invoiceId}</span>
                        <span className="block text-xs text-muted-foreground">
                          {valueLabel(line.kind)}
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
            </ScrollFrame>
            <div className="rounded-xl border bg-secondary/30 p-4">
              <p className="text-sm font-medium">
                {amount(cash.vat.excludedBankCreditsMinor)} received in the
                bank is left out of the VAT calculation
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Loan money and transfers between the business’s own accounts
                are not treated as sales.
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
              <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>{vatMonth(cash.vat.period)}</span>
                <ConnectedStatus record="vat-schedule" status={cash.vat.status} />
                <span>No VAT return filed</span>
              </p>
              <Button
                variant="outline"
                onClick={() =>
                  saveJson("valo-sample-vat-evidence.json", cash.vat)
                }
              >
                <Download />
                Download current VAT schedule
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Grant the Read business accounts permission and the Prepare
            accounting drafts and VAT schedules permission to see this
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
                  Download saved VAT schedule
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  This schedule’s figures are hidden. Its permission or
                  evidence has changed, or cannot be checked. Save the
                  schedule again to see current figures.
                </p>
              )}
            </div>
          ))}
        </>
      </Section>
    </div>
  );
}
