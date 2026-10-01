import {
  ConnectedFrame,
  ConnectedRecovery,
  ConnectedState,
  roleRefusal,
  tooShort,
} from "@/components/connected-frame";
import { LoadProblem } from "@/components/load-problem";
import { Loading } from "@/components/loading";
import { AssessmentForm } from "@/features/credit-desk/assessment-form";
import { AssessmentWorkspace } from "@/features/credit-desk/assessment-workspace";
import { ModelGovernance } from "@/features/credit-desk/model-governance";
import { ReviewPanel } from "@/features/credit-desk/review-panel";
import { useConnected } from "@/lib/connected";
import { formatNumber } from "@/lib/formatters";
import { nairaToKobo } from "@/lib/money-input";
import { useFormDraft } from "@/lib/unsaved-changes";
import { useWorkspace } from "@/lib/workspace-context";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";

const TITLE = "Credit Desk",
  DESCRIPTION =
    "Applicants are your customers. A different person reviews each assessment. A credit result is not a lending decision.";
export default function CreditDeskPage() {
  const api = useConnected(),
    { merchantId } = useWorkspace();
  return <CreditDeskContent key={merchantId} api={api} />;
}
function CreditDeskContent({ api }: { api: ReturnType<typeof useConnected> }) {
  const { workspace } = useWorkspace();
  const [customerId, setCustomerId] = useState(""),
    [scenario, setScenario] = useState("ready"),
    [selectedId, setSelectedId] = useState("");
  const [principal, setPrincipal] = useState("240000"),
    [repayment, setRepayment] = useState("90000"),
    [months, setMonths] = useState("3");
  const [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  const [tab, setTab] = useState<"assessment" | "evidence" | "history">(
    "assessment",
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // An assessment typed but not run is a draft: leaving asks first.
  const draft = useFormDraft({
    customerId,
    scenario,
    principal,
    repayment,
    months,
    reason,
  });
  if (api.isLoading) return <Loading what="Credit Desk" heading />;
  if (!api.data)
    return (
      <ConnectedState title={TITLE} description={DESCRIPTION}>
        <LoadProblem
          what="Credit Desk"
          error={api.error}
          retry={() => void api.refetch()}
        />
        <ConnectedRecovery recovery={api} />
      </ConnectedState>
    );
  const data = api.data.credit;
  // The applicants are the workspace's customers, listed once for every connected page.
  const applicants = api.data.customers;
  const customer =
    applicants.find((item) => item.id === customerId) ?? applicants[0];
  const permissions = data.permissions.find(
    (item) => item.customerId === customer?.id,
  ) ?? { accountRead: false, creditAssessment: false };
  const selected =
    data.assessments.find((item) => item.id === selectedId) ??
    data.assessments[0];
  const completeCount = data.assessments.filter(
    (item) => item.result.score && !item.reviews.length,
  ).length;
  const assess = async () => {
    setError("");
    setSuccess("");
    const errors: Record<string, string> = {};
    const parse = (id: string, value: string) => {
      try {
        const kobo = nairaToKobo(value);
        if (kobo < 100 || kobo > 100_000_000_000)
          throw new Error("Enter an amount from ₦1.00 to ₦1,000,000,000.00.");
        return kobo;
      } catch (failure) {
        errors[id] = (failure as Error).message;
        return 0;
      }
    };
    const principalKobo = parse("credit-principal", principal),
      repaymentKobo = parse("credit-repayment", repayment);
    const short = tooShort(reason, "a reason", 8);
    if (short) errors["credit-reason"] = short;
    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      document.getElementById(Object.keys(errors)[0])?.focus();
      return;
    }
    if (!customer) {
      setError("Choose an applicant before running an assessment.");
      return;
    }
    draft.sending({
      customerId,
      scenario,
      principal,
      repayment,
      months,
      reason: "",
    });
    try {
      await api.run(
        "credit.assess",
        {
          customerId: customer.id,
          scenario,
          principalKobo,
          repaymentKobo,
          termMonths: Number(months),
        },
        undefined,
        reason,
      );
      setSelectedId("");
      setTab("assessment");
      setSuccess(
        "Sample assessment saved as a new version. It cannot be changed. Check its evidence and explanations below.",
      );
      setReason("");
      draft.saved();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  return (
    <ConnectedFrame
      title={TITLE}
      description={DESCRIPTION}
      recovery={api}
      onReleased={() => setError("")}
      onRecovered={() => {
        setError("");
        setReason("");
        setSelectedId("");
        setTab("assessment");
        draft.saved();
      }}
    >
      <div className="connected-metrics">
        <div className="connected-metric">
          <span>Sample assessments</span>
          <strong>{formatNumber(data.assessments.length)}</strong>
        </div>
        <div className="connected-metric">
          <span>Waiting for review</span>
          <strong>{formatNumber(completeCount)}</strong>
        </div>
        <div className="connected-metric">
          <span>Reviewed by</span>
          <strong className="!text-xl">A different person</strong>
        </div>
      </div>
      <p className="connected-note">
        <ShieldCheck className="inline mr-2" size={16} aria-hidden="true" />
        Try the sample rule score and affordability check with sample bank
        data. The rules have not been validated for real lending. No real
        applicant is assessed, no loan is made and no money moves.
      </p>
      {error && !api.hasUnconfirmedOutcome && (
        <p className="connected-error" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="connected-note" role="status">
          {success}
        </p>
      )}
      <div className="connected-grid">
        <AssessmentForm
          applicants={applicants}
          customer={customer}
          permissions={permissions}
          values={{ scenario, principal, repayment, months, reason }}
          onChange={(field, value) => {
            ({
              scenario: setScenario,
              principal: setPrincipal,
              repayment: setRepayment,
              months: setMonths,
              reason: setReason,
            })[field](value);
            if (field === "reason")
              setFieldErrors((current) => {
                const next = { ...current };
                delete next["credit-reason"];
                return next;
              });
          }}
          onCustomerChange={setCustomerId}
          fieldErrors={fieldErrors}
          refusal={
            data.canAssess
              ? ""
              : roleRefusal(["Admin", "Operations"], "run an assessment")
          }
          canAssess={data.canAssess}
          canWrite={api.canWrite}
          pending={api.pending}
          onAssess={assess}
        />
        <AssessmentWorkspace
          assessments={data.assessments}
          selected={selected}
          modelVersion={data.model.version}
          tab={tab}
          onSelect={setSelectedId}
          onTabChange={setTab}
        />
      </div>
      {selected && (
        <ReviewPanel
          key={selected.id}
          assessment={selected}
          canReview={
            data.canReview && api.canWrite && selected.createdBy !== data.actor
          }
          staff={workspace?.accessMode === "staff"}
          pending={api.pending}
          onReview={async (reviewData) => {
            draft.sending(null);
            await api.run(
              "credit.review",
              reviewData,
              selected.id,
              "Record a sample credit review",
            );
            setTab("history");
            setSuccess(
              "Sample review recorded. The assessment and its score have not changed.",
            );
          }}
        />
      )}
      <ModelGovernance model={data.model} gate={data.gate} />
    </ConnectedFrame>
  );
}
