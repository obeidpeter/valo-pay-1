import { TabsContent } from "@/components/ui/tabs";
import { formatDate } from "@/lib/formatters";
import { CheckCircle2 } from "lucide-react";
import { outcomeLabels } from "./labels";
import type { Assessment } from "./types";

export function AssessmentHistory({ assessment }: { assessment: Assessment }) {
  return (
    <TabsContent value="history" className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Prepared by {assessment.createdBy}.{" "}
        {assessment.result.previousResultId
          ? `This version supersedes an earlier immutable assessment.`
          : "This is the first assessment version."}
      </p>
      {assessment.reviews.length === 0 ? (
        <p className="text-sm">
          No reviewer outcome has been recorded for this version.
        </p>
      ) : (
        assessment.reviews.map((review) => (
          <article className="connected-record" key={review.id}>
            <h3>
              <CheckCircle2
                size={16}
                className="inline mr-2"
                aria-hidden="true"
              />
              {outcomeLabels[review.outcome]}
            </h3>
            <p className="mt-2">
              {review.reviewer} · {formatDate(review.reviewedAt)}
            </p>
            <p className="mt-3">{review.rationale}</p>
            <p className="mt-3">
              <strong>Applicant explanation:</strong>{" "}
              {review.applicantExplanation}
            </p>
            {review.override && (
              <p className="mt-3">
                <strong>Policy override:</strong> {review.overrideRationale}
              </p>
            )}
            <p className="mt-3 text-xs">
              Simulated reviewer authentication. This is not an actual lending
              decision.
            </p>
          </article>
        ))
      )}
    </TabsContent>
  );
}
