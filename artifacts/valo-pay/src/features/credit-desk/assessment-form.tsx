import { ConnectedPanel } from "@/components/connected-frame";
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
  amountErrors: Record<string, string>;
  canAssess: boolean;
  canWrite: boolean;
  pending: boolean;
  onAssess: () => Promise<void>;
};

export function AssessmentForm({
  applicants,
  customer,
  permissions,
  values,
  onChange,
  onCustomerChange,
  amountErrors,
  canAssess,
  canWrite,
  pending,
  onAssess,
}: Props) {
  const { scenario, principal, repayment, months, reason } = values;
  return (
    <ConnectedPanel
      title="Prepare an assessment"
      description="Choose a sample case and the lender’s proposed repayment schedule."
    >
      <form
        className="space-y-4"
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
            <p className="font-medium">Separate permissions</p>
            <p>
              Account reading: {permissions.accountRead ? "Active" : "Required"}
            </p>
            <p>
              Credit assessment:{" "}
              {permissions.creditAssessment ? "Active" : "Required"}
            </p>
            {(!permissions.accountRead || !permissions.creditAssessment) && (
              <Link
                href="/connections"
                className="font-medium underline underline-offset-4"
              >
                Set up sample permissions{" "}
                <ArrowRight size={13} className="inline" aria-hidden="true" />
              </Link>
            )}
            <p className="text-xs text-muted-foreground">
              Missing permissions produce a blocked assessment. They never
              authorise a payment.
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
            <label htmlFor="credit-principal">Requested principal (₦)</label>
            <input
              id="credit-principal"
              inputMode="decimal"
              aria-invalid={!!amountErrors["credit-principal"]}
              aria-describedby={
                amountErrors["credit-principal"]
                  ? "credit-principal-error"
                  : undefined
              }
              value={principal}
              onChange={(event) => onChange("principal", event.target.value)}
              required
            />
            {amountErrors["credit-principal"] && (
              <p
                id="credit-principal-error"
                className="mt-2 text-xs text-destructive"
                role="alert"
              >
                {amountErrors["credit-principal"]}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="credit-repayment">Repayment per month (₦)</label>
            <input
              id="credit-repayment"
              inputMode="decimal"
              aria-invalid={!!amountErrors["credit-repayment"]}
              aria-describedby={
                amountErrors["credit-repayment"]
                  ? "credit-repayment-error"
                  : undefined
              }
              value={repayment}
              onChange={(event) => onChange("repayment", event.target.value)}
              required
            />
            {amountErrors["credit-repayment"] && (
              <p
                id="credit-repayment-error"
                className="mt-2 text-xs text-destructive"
                role="alert"
              >
                {amountErrors["credit-repayment"]}
              </p>
            )}
          </div>
        </div>
        <div>
          <label htmlFor="credit-term">Number of monthly repayments</label>
          <select
            id="credit-term"
            value={months}
            onChange={(event) => onChange("months", event.target.value)}
          >
            {[1, 2, 3, 6, 9, 12, 18, 24].map((value) => (
              <option key={value} value={value}>
                {formatCount(value, "repayment")}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            Include all charges. One repayment falls due each calendar month, on
            today’s date or the month’s last day when it is shorter; the
            affordability check takes each month’s total.
          </p>
        </div>
        <div>
          <label htmlFor="credit-reason">Reason for this assessment</label>
          <textarea
            id="credit-reason"
            rows={2}
            minLength={8}
            maxLength={500}
            value={reason}
            onChange={(event) => onChange("reason", event.target.value)}
            placeholder="Describe the application or calculation you are reviewing"
            required
          />
        </div>
        <Button
          type="submit"
          busy={pending}
          busyLabel="Calculating…"
          disabled={!canAssess || !canWrite || !customer}
        >
          <FileCheck2 aria-hidden="true" /> Run sample assessment
        </Button>
        {!canAssess && (
          <p className="text-xs text-muted-foreground">
            Switch to Admin or Operations to prepare an assessment.
          </p>
        )}
      </form>
    </ConnectedPanel>
  );
}
