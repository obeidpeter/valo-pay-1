import { TabsContent } from "@/components/ui/tabs";
import { EvidenceDisclosure } from "@/components/evidence-disclosure";
import { formatCount, formatDate, formatNumber } from "@/lib/formatters";
import { valueLabel } from "@workspace/valo-pay-1-schema";
import { Amount } from "./amount";
import { exclusionLabels } from "./labels";
import type { Assessment } from "./types";

export function AssessmentEvidence({
  result,
  modelVersion,
}: {
  result: Assessment["result"];
  modelVersion: string;
}) {
  return (
    <TabsContent value="evidence" className="space-y-5">
      <dl className="text-sm space-y-3">
        <div className="flex justify-between gap-3">
          <dt>Bank accounts</dt>
          <dd>{formatNumber(result.evidence.sourceCount)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Complete history</dt>
          <dd>{formatCount(result.evidence.coverageDays, "day")}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Oldest bank update</dt>
          <dd>
            {result.evidence.earliestSourceAsOf
              ? formatDate(result.evidence.earliestSourceAsOf)
              : "Unavailable"}
          </dd>
        </div>
      </dl>
      {result.features && (
        <>
          <dl className="text-sm space-y-3">
            <Amount
              label="Regular income per 30 days"
              value={result.features.sustainableMonthlyIncomeKobo}
            />
            <Amount
              label="Reviewed essential costs"
              value={result.features.essentialMonthlyKobo}
            />
            <Amount
              label="Existing repayments checked independently"
              value={result.features.verifiedCommitmentsMonthlyKobo}
            />
            <Amount
              label="Existing repayments stated by the applicant"
              value={result.features.declaredCommitmentsMonthlyKobo}
            />
            <Amount
              label="Typical account balance"
              value={result.features.liquidityBufferKobo}
            />
          </dl>
          <p className="text-sm">
            {formatCount(
              result.features.includedTransactionRefs.length,
              "transaction",
            )}{" "}
            included · {formatNumber(result.features.excludedTransactions.length)}{" "}
            left out ·{" "}
            {formatCount(result.features.duplicatesIgnored, "duplicate")}{" "}
            ignored.
          </p>
          <p className="text-xs text-muted-foreground">
            Transfers between the applicant’s own accounts, loan money, refunds
            and sales of assets do not count as regular income. Transactions
            that cannot be sorted need review.
          </p>
          {result.features.excludedTransactions.length > 0 && (
            <EvidenceDisclosure title="Transactions left out">
              <ul className="mt-3 space-y-2 text-xs">
                {result.features.excludedTransactions.map((item) => (
                  <li key={item.reference} className="break-all">
                    {item.reference}:{" "}
                    {exclusionLabels[item.reason] ?? valueLabel(item.reason)}
                  </li>
                ))}
              </ul>
            </EvidenceDisclosure>
          )}
        </>
      )}
      <EvidenceDisclosure title="Technical details">
        <p className="mt-2 text-xs text-muted-foreground">
          This reference identifies the exact evidence this assessment used. It
          cannot be changed.
        </p>
        <p className="break-all text-xs text-muted-foreground mt-2 font-mono">
          {result.snapshotHash}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Scoring rules {result.score?.rulecardVersion ?? modelVersion} · Policy
          version {result.policy.version}
        </p>
      </EvidenceDisclosure>
    </TabsContent>
  );
}
