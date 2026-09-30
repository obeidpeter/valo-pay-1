import {
  ConnectedPanel,
  FieldHint,
  describedBy,
  tooShort,
} from "@/components/connected-frame";
import { FieldError } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import { useState } from "react";
import type { Assessment } from "./types";

export function ReviewPanel({
  assessment,
  canReview,
  staff = false,
  pending,
  onReview,
}: {
  assessment: Assessment;
  canReview: boolean;
  /** A signed-in workspace, where roles are not switched in Settings. */
  staff?: boolean;
  pending: boolean;
  onReview: (data: Record<string, unknown>) => Promise<void>;
}) {
  const [outcome, setOutcome] = useState(""),
    [rationale, setRationale] = useState(""),
    [explanation, setExplanation] = useState(""),
    [override, setOverride] = useState(""),
    [error, setError] = useState(""),
    [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // A review typed but not recorded is a draft: leaving asks first.
  useUnsavedChanges(
    !assessment.reviews.length &&
      Boolean(outcome || rationale || explanation || override),
  );
  const needsOverride =
    outcome === "approve" &&
    assessment.result.policy.recommendation === "policy_not_met";
  const usable = !!assessment.result.score && !assessment.permissionRestricted;
  const corrected = (id: string) =>
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  return (
    <ConnectedPanel
      title="Record your review"
      description="Read the evidence and calculations first. The outcome is a sandbox exercise; it cannot issue a loan."
    >
      {assessment.reviews.length ? (
        <p className="text-sm text-muted-foreground">
          This version already has a review, and it cannot be changed. Select
          Review history to read it. To review again, run a new assessment.
        </p>
      ) : (
        <form
          className="space-y-4"
          noValidate
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            const errors: Record<string, string> = {};
            const add = (id: string, problem: string) => {
              if (problem) errors[id] = problem;
            };
            add("credit-review-rationale", tooShort(rationale, "what you reviewed", 20));
            add("credit-applicant-explanation", tooShort(explanation, "an explanation for the applicant", 20));
            if (needsOverride)
              add("credit-override", tooShort(override, "a reason for overriding the policy", 30));
            setFieldErrors(errors);
            const first = Object.keys(errors)[0];
            if (first) {
              document.getElementById(first)?.focus();
              return;
            }
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
              A different person must review this assessment.{" "}
              {staff
                ? "Only Admin, Finance or Compliance reviewer can review it, and not the person who ran it."
                : "To try this step, change your demo role in Settings to Finance or Compliance reviewer. Switching demo roles is not a second person."}{" "}
              Reviewer sign-in is simulated here.
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
              aria-describedby="credit-review-outcome-help"
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
            <p
              id="credit-review-outcome-help"
              className="mt-2 text-xs text-muted-foreground"
            >
              {assessment.permissionRestricted
                ? "A permission has changed, so this version cannot be reviewed. Run a new assessment. "
                : !assessment.result.score
                  ? "Approving or declining needs a score, so only Request more information is available. "
                  : ""}
              To change the terms, run a new assessment with the new schedule.
              Missing evidence is not a reason to decline.
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
                onChange={(event) => {
                  setRationale(event.target.value);
                  corrected("credit-review-rationale");
                }}
                maxLength={4000}
                rows={3}
                placeholder="Explain the evidence and why it supports your outcome"
                aria-invalid={fieldErrors["credit-review-rationale"] ? true : undefined}
                aria-describedby={describedBy("credit-review-rationale", fieldErrors["credit-review-rationale"])}
                required
                disabled={!canReview}
              />
              <FieldHint id="credit-review-rationale-help" minLength={20} note="Shown in Review history." />
              <FieldError id="credit-review-rationale" message={fieldErrors["credit-review-rationale"]} />
            </div>
            <div>
              <label htmlFor="credit-applicant-explanation">
                Explanation for the applicant
              </label>
              <textarea
                id="credit-applicant-explanation"
                value={explanation}
                onChange={(event) => {
                  setExplanation(event.target.value);
                  corrected("credit-applicant-explanation");
                }}
                maxLength={4000}
                rows={3}
                placeholder="Use clear reasons that an applicant could understand and question"
                aria-invalid={fieldErrors["credit-applicant-explanation"] ? true : undefined}
                aria-describedby={describedBy("credit-applicant-explanation", fieldErrors["credit-applicant-explanation"])}
                required
                disabled={!canReview}
              />
              <FieldHint id="credit-applicant-explanation-help" minLength={20} note="Shown in Review history." />
              <FieldError id="credit-applicant-explanation" message={fieldErrors["credit-applicant-explanation"]} />
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
                onChange={(event) => {
                  setOverride(event.target.value);
                  corrected("credit-override");
                }}
                maxLength={4000}
                rows={3}
                placeholder="Explain the extra evidence and why you are overriding the policy"
                aria-invalid={fieldErrors["credit-override"] ? true : undefined}
                aria-describedby={describedBy("credit-override", fieldErrors["credit-override"])}
                required
                disabled={!canReview}
              />
              <FieldHint id="credit-override-help" minLength={30} note="Shown in Review history." />
              <FieldError id="credit-override" message={fieldErrors["credit-override"]} />
            </div>
          )}
          <Button
            type="submit"
            variant="outline"
            disabled={!canReview || !outcome || assessment.permissionRestricted}
            busy={pending}
            busyLabel="Recording review…"
          >
            Record review
          </Button>
        </form>
      )}
    </ConnectedPanel>
  );
}
