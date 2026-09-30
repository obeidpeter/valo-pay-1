import { TabsContent } from "@/components/ui/tabs";
import { formatPercent } from "@/lib/formatters";
import { valueLabel } from "@workspace/valopay-schema";
import { Amount } from "./amount";
import { recommendationLabels } from "./labels";
import type { Assessment } from "./types";

export function AssessmentSummary({ assessment }: { assessment: Assessment }) {
  const result = assessment.result;
  // The income cut is the assessment's own; the safety margin and the 40% limit are not in its data, so they are named as the sample policy sets them.
  const incomeCut = result.affordability
    ? formatPercent(result.affordability.incomeStressBps / 10_000)
    : "";
  return (
    <TabsContent value="assessment">
      {result.score ? (
        <div className="flex items-center gap-5 mb-5 rounded-xl bg-muted/50 p-5">
          <div className="text-5xl tracking-tight font-semibold tabular-nums">
            {result.score.value}
            <span className="text-base text-muted-foreground"> /100</span>
          </div>
          <div>
            <p className="font-semibold">Sample rule score (not validated)</p>
            <p className="text-xs text-muted-foreground mt-1">
              Not a prediction of whether the applicant will repay.
              <br />
              Not a lending decision.
            </p>
          </div>
        </div>
      ) : (
        <div className="connected-note mb-4">
          <h3 className="font-semibold">Score unavailable</h3>
          <p className="mt-2 text-sm">
            {assessment.permissionRestricted
              ? "A permission has changed or ended. Grant it again, then run a new assessment."
              : "Fix the evidence issues below. Missing data, or a refused permission, does not mean a score of zero."}
          </p>
        </div>
      )}
      <div className="mb-5">
        <h3 className="font-semibold">
          {recommendationLabels[result.policy.recommendation] ??
            valueLabel(result.policy.recommendation)}
        </h3>
        {result.policy.reasons.map((message) => (
          <p key={message} className="text-sm text-muted-foreground mt-2">
            {message}
          </p>
        ))}
      </div>
      {result.evidence.issues.length > 0 && (
        <div className="space-y-2 mb-5">
          {result.evidence.issues.map((issue, index) => (
            <p
              key={`${issue.code}-${index}`}
              className={`rounded-md border p-3 text-sm ${issue.severity === "blocking" ? "border-amber-300/60 bg-amber-50/40 dark:bg-amber-950/20" : "bg-muted/30"}`}
            >
              {issue.message}
            </p>
          ))}
        </div>
      )}
      {result.affordability && (
        <>
          <h3 className="font-semibold mb-3">Affordability check</h3>
          <dl className="space-y-3 text-sm mb-5">
            <Amount
              label={`Regular income after a ${incomeCut} cut`}
              value={result.affordability.stressedMonthlyIncomeKobo}
            />
            <Amount
              label="Largest new monthly repayment the applicant can afford"
              value={result.affordability.monthlyCapacityKobo}
              strong
            />
            <Amount
              label="Highest scheduled monthly payment"
              value={result.affordability.peakScheduledMonthlyKobo}
            />
            <Amount
              label="Loan amount this schedule supports"
              value={result.affordability.indicativePrincipalCapacityKobo}
            />
            <Amount
              label="Total repayment, including charges"
              value={result.affordability.scheduledTotalKobo}
            />
          </dl>
          <p className="text-xs text-muted-foreground mb-5">
            This sample policy cuts income by {incomeCut} to allow for a bad
            month. It then takes away essential costs, existing repayments and
            a ₦50,000.00 safety margin. All repayments together may not be more
            than 40% of the reduced income. The loan amount above is scaled
            from this schedule. It is not a loan offer.
          </p>
        </>
      )}
      {result.score && (
        <div className="space-y-4">
          <h3 className="font-semibold">Why the score looks this way</h3>
          {result.score.factors.map((factor) => (
            <div key={factor.code}>
              <div className="flex justify-between gap-3 text-sm mb-2">
                <span>{factor.label}</span>
                <strong className="tabular-nums">
                  {factor.points}/{factor.maximum}
                </strong>
              </div>
              <div
                className="h-1.5 rounded-full bg-muted overflow-hidden"
                aria-hidden="true"
              >
                <div
                  className="h-full bg-primary rounded-full"
                  style={{
                    width: `${(100 * factor.points) / factor.maximum}%`,
                  }}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {factor.reason}
              </p>
            </div>
          ))}
        </div>
      )}
    </TabsContent>
  );
}
