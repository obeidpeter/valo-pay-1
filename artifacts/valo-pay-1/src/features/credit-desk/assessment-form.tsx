import { ConnectedPanel, FieldHint } from "@/components/connected-frame";
import { Button } from "@/components/ui/button";
import { formatCount } from "@/lib/formatters";
import { ArrowRight, FileCheck2 } from "lucide-react";
import { Link } from "wouter";
import { scenarios } from "./labels";
import type { Applicant, AssessmentInputs } from "./types";

type Props = {
  applicants: Applicant[];
  customer: Applicant | undefined;
  permissions: { accountRead: boolean; creditAssessment: boolean };
  values: AssessmentInputs;
  onChange: (field: keyof AssessmentInputs, value: string) => void;
  onCustomerChange: (id: string) => void;
  /** Messages under the fields, by the field's id. */
  fieldErrors: Record<string, string>;
  /** Why this role cannot run an assessment, when it cannot. */
  refusal: string;
  canAssess: boolean;
  canWrite: boolean;
  pending: boolean;
  onAssess: () => Promise<void>;
};

/** A field's description: its help when it has some, and its message when there is one. */
const describedBy = (id: string, error: string | undefined, help = false) =>
  [help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(" ") ||
  undefined;

export function AssessmentForm({
  applicants,
  customer,
  permissions,
  values,
  onChange,
  onCustomerChange,
  fieldErrors,
  refusal,
  canAssess,
  canWrite,
  pending,
  onAssess,
}: Props) {
  const { scenario, principal, repayment, months, reason } = values;
  return (
    <ConnectedPanel
      title="Run an assessment"
      description="Choose a sample case and the lender’s proposed repayment schedule."
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void onAssess();
        }}
      >
        <div>
          <label htmlFor="credit-customer">Applicant</label>
          <select
            id="credit-customer"
            value={customer?.id ?? ""}
            onChange={(event) => onCustomerChange(event.target.value)}
            required
          >
            {applicants.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name} · {item.reference}
              </option>
            ))}
          </select>
        </div>
        {customer && (
          <div className="rounded-lg border p-3 text-sm space-y-2">
            <p className="font-medium">Permissions needed</p>
            <p>
              Read applicant accounts:{" "}
              {permissions.accountRead ? "Active" : "Not active"}
            </p>
            <p>
              Assess an application:{" "}
              {permissions.creditAssessment ? "Active" : "Not active"}
            </p>
            {(!permissions.accountRead || !permissions.creditAssessment) && (
              <Link
                href="/connections"
                className="font-medium underline underline-offset-4"
              >
                Open Permissions and readiness{" "}
                <ArrowRight size={13} className="inline" aria-hidden="true" />
              </Link>
            )}
            <p className="text-xs text-muted-foreground">
              Without both permissions, the assessment is blocked. Permission to
              read an account is not permission to take money from it.
            </p>
          </div>
        )}
        <div>
          <label htmlFor="credit-scenario">Evidence scenario</label>
          <select
            id="credit-scenario"
            value={scenario}
            onChange={(event) => onChange("scenario", event.target.value)}
          >
            {scenarios.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            {scenarios.find(([value]) => value === scenario)?.[2]}
          </p>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="credit-principal">Loan amount (₦)</label>
            <input
              id="credit-principal"
              inputMode="decimal"
              aria-invalid={!!fieldErrors["credit-principal"]}
              aria-describedby={describedBy(
                "credit-principal",
                fieldErrors["credit-principal"],
              )}
              value={principal}
              onChange={(event) => onChange("principal", event.target.value)}
              required
            />
            {fieldErrors["credit-principal"] && (
              <p
                id="credit-principal-error"
                className="mt-2 text-xs text-destructive"
                role="alert"
              >
                {fieldErrors["credit-principal"]}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="credit-repayment">Repayment per month (₦)</label>
            <input
              id="credit-repayment"
              inputMode="decimal"
              aria-invalid={!!fieldErrors["credit-repayment"]}
              aria-describedby={describedBy(
                "credit-repayment",
                fieldErrors["credit-repayment"],
                true,
              )}
              value={repayment}
              onChange={(event) => onChange("repayment", event.target.value)}
              required
            />
            <p
              id="credit-repayment-help"
              className="mt-1 text-xs text-muted-foreground"
            >
              Include interest and all charges.
            </p>
            {fieldErrors["credit-repayment"] && (
              <p
                id="credit-repayment-error"
                className="mt-2 text-xs text-destructive"
                role="alert"
              >
                {fieldErrors["credit-repayment"]}
              </p>
            )}
          </div>
        </div>
        <div>
          <label htmlFor="credit-term">Number of monthly repayments</label>
          <select
            id="credit-term"
            value={months}
            aria-describedby="credit-term-help"
            onChange={(event) => onChange("months", event.target.value)}
          >
            {[1, 2, 3, 6, 9, 12, 18, 24].map((value) => (
              <option key={value} value={value}>
                {formatCount(value, "repayment")}
              </option>
            ))}
          </select>
          <p id="credit-term-help" className="mt-1 text-xs text-muted-foreground">
            One repayment is due each month on today’s date. In a shorter
            month, it is due on the last day. The affordability check uses
            each month’s total.
          </p>
        </div>
        <div>
          <label htmlFor="credit-reason">Reason for this assessment</label>
          <textarea
            id="credit-reason"
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(event) => onChange("reason", event.target.value)}
            placeholder="Describe the application or calculation you are reviewing"
            aria-invalid={!!fieldErrors["credit-reason"]}
            aria-describedby={describedBy(
              "credit-reason",
              fieldErrors["credit-reason"],
              true,
            )}
            required
          />
          <FieldHint id="credit-reason-help" minLength={8} />
          {fieldErrors["credit-reason"] && (
            <p
              id="credit-reason-error"
              className="mt-2 text-xs text-destructive"
              role="alert"
            >
              {fieldErrors["credit-reason"]}
            </p>
          )}
        </div>
        <Button
          type="submit"
          busy={pending}
          busyLabel="Running…"
          disabled={!canAssess || !canWrite || !customer}
        >
          <FileCheck2 aria-hidden="true" /> Run assessment
        </Button>
        {refusal && (
          <p className="text-xs text-muted-foreground">{refusal}</p>
        )}
      </form>
    </ConnectedPanel>
  );
}
