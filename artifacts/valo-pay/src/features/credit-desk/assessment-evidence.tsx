import { TabsContent } from "@/components/ui/tabs";
import { EvidenceDisclosure } from "@/components/evidence-disclosure";
import { formatCount, formatDate, formatNumber } from "@/lib/formatters";
import { Amount } from "./amount";
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
          <dt>Source accounts</dt>
          <dd>{formatNumber(result.evidence.sourceCount)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Complete history</dt>
          <dd>{formatCount(result.evidence.coverageDays, "day")}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Oldest source update</dt>
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
              label="Sustainable income per 30 days"
              value={result.features.sustainableMonthlyIncomeKobo}
            />
            <Amount
              label="Reviewed essential costs"
              value={result.features.essentialMonthlyKobo}
            />
            <Amount
              label="Verified existing repayments"
              value={result.features.verifiedCommitmentsMonthlyKobo}
            />
            <Amount
              label="Declared existing repayments"
              value={result.features.declaredCommitmentsMonthlyKobo}
            />
            <Amount
              label="Median observed liquidity"
              value={result.features.liquidityBufferKobo}
            />
          </dl>
          <p className="text-sm">
            {formatCount(
              result.features.includedTransactionRefs.length,
              "included observation",
            )}{" "}
            · {formatNumber(result.features.excludedTransactions.length)}{" "}
            excluded ·{" "}
            {formatCount(
              result.features.duplicatesIgnored,
              "duplicate observation",
            )}{" "}
            ignored.
          </p>
          <p className="text-xs text-muted-foreground">
            Matched own-account transfers, loan proceeds, refunds and asset
            sales do not count as recurring income. Unclear classifications need
            review.
          </p>
          {result.features.excludedTransactions.length > 0 && (
            <EvidenceDisclosure title="Excluded observations">
              <ul className="mt-3 space-y-2 text-xs">
                {result.features.excludedTransactions.map((item) => (
                  <li key={item.reference} className="break-all">
                    {item.reference} — {item.reason.replaceAll("_", " ")}
                  </li>
                ))}
              </ul>
            </EvidenceDisclosure>
          )}
        </>
      )}
      <EvidenceDisclosure title="Immutable evidence fingerprint">
        <p className="break-all text-xs text-muted-foreground mt-2 font-mono">
          {result.snapshotHash}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Rulecard {result.score?.rulecardVersion ?? modelVersion} · Policy
          version {result.policy.version}
        </p>
      </EvidenceDisclosure>
    </TabsContent>
  );
}
