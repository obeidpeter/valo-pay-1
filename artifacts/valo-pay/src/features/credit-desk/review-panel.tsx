import { ConnectedPanel } from "@/components/connected-frame";
import { Button } from "@/components/ui/button";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import { useState } from "react";
import type { Assessment } from "./types";

export function ReviewPanel({
  assessment,
  canReview,
  pending,
  onReview,
}: {
  assessment: Assessment;
  canReview: boolean;
  pending: boolean;
  onReview: (data: Record<string, unknown>) => Promise<void>;
}) {
  const [outcome, setOutcome] = useState(""),
    [rationale, setRationale] = useState(""),
    [explanation, setExplanation] = useState(""),
    [override, setOverride] = useState(""),
    [error, setError] = useState("");
  // A review typed but not recorded is a draft: leaving asks first.
  useUnsavedChanges(
    !assessment.reviews.length &&
      Boolean(outcome || rationale || explanation || override),
  );
  const needsOverride =
    outcome === "approve" &&
    assessment.result.policy.recommendation === "policy_not_met";
  const usable = !!assessment.result.score && !assessment.permissionRestricted;
  return (
    <ConnectedPanel
      title="Record a separate reviewer outcome"
      description="Read the evidence and calculations first. The outcome is a sandbox exercise; it cannot issue a loan."
    >
      {assessment.reviews.length ? (
        <p className="text-sm text-muted-foreground">
          This version already has an immutable review. Open Review history to
          read it, or prepare a new assessment with updated terms or evidence.
        </p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            try {
              await onReview({
                expectedAssessmentVersion: assessment.result.version,
                outcome,
                rationale,
                applicantExplanation: explanation,
                reasonCodes: [
                  outcome === "request_information"
                    ? "evidence_review_required"
                    : "reviewer_evidence_assessment",
                ],
                ...(needsOverride ? { overrideRationale: override } : {}),
              });
              setOutcome("");
              setRationale("");
              setExplanation("");
              setOverride("");
            } catch (failure) {
              setError((failure as Error).message);
            }
          }}
        >
          {!canReview && (
            <p className="connected-note">
              A different reviewer must complete this step. Switch from the
              assessor to Finance, Compliance reviewer or a different permitted
              role using the workspace role selector. Authentication here is
              simulated.
            </p>
          )}
          {error && (
            <p className="connected-error" role="alert">
              {error}
            </p>
          )}
          <div>
            <label htmlFor="credit-review-outcome">Reviewer outcome</label>
            <select
              id="credit-review-outcome"
              value={outcome}
              onChange={(event) => setOutcome(event.target.value)}
              required
              disabled={!canReview}
            >
              <option value="">Choose after reviewing the evidence</option>
              <option value="request_information">
                Request more information
              </option>
              <option value="approve" disabled={!usable}>
                Record sample approval
              </option>
              <option value="decline" disabled={!usable}>
                Record sample decline
              </option>
            </select>
            <p className="mt-2 text-xs text-muted-foreground">
              To amend terms, prepare a new assessment with the changed
              schedule. Evidence gaps cannot be converted to a decline.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="credit-review-rationale">
                What did you review?
              </label>
              <textarea
                id="credit-review-rationale"
                value={rationale}
                onChange={(event) => setRationale(event.target.value)}
                minLength={20}
                maxLength={4000}
                rows={3}
                placeholder="Explain the evidence and why it supports your outcome"
                required
                disabled={!canReview}
              />
            </div>
            <div>
              <label htmlFor="credit-applicant-explanation">
                Explanation for the applicant
              </label>
              <textarea
                id="credit-applicant-explanation"
                value={explanation}
                onChange={(event) => setExplanation(event.target.value)}
                minLength={20}
                maxLength={4000}
                rows={3}
                placeholder="Use clear reasons that an applicant could understand and question"
                required
                disabled={!canReview}
              />
            </div>
          </div>
          {needsOverride && (
            <div>
              <label htmlFor="credit-override">
                Reason for overriding the policy
              </label>
              <textarea
                id="credit-override"
                value={override}
                onChange={(event) => setOverride(event.target.value)}
                minLength={30}
                maxLength={4000}
                rows={3}
                placeholder="Explain the additional evidence and why the policy recommendation is being overridden"
                required
                disabled={!canReview}
              />
            </div>
          )}
          <Button
            type="submit"
            variant="outline"
            disabled={!canReview || !outcome || assessment.permissionRestricted}
            busy={pending}
            busyLabel="Recording review…"
          >
            Record sample review
          </Button>
        </form>
      )}
    </ConnectedPanel>
  );
}
