import { WorkflowProgress, type WorkflowStep } from "@/components/workflow-progress";

/** A presentation of persisted checkout state only; the service still decides every permitted action. */
export function paymentProgress(status: string, { expired = false, held = false, refundRequested = false } = {}) {
  const steps: WorkflowStep[] = [
    { label: "Checkout details", state: "complete" },
    { label: "Bank authorisation", state: "waiting" },
    { label: "Verified receipt", state: "waiting" },
  ];
  let title = "Review the saved checkout", detail = "Check the current record and its journey history before taking another action.";
  if (status === "created") {
    steps[1].state = expired || held ? "attention" : "current";
    title = held ? "Resolve the review hold" : expired ? "Authorisation window ended" : "Review before authorising";
    detail = held ? "This instalment is held for reversal review. Resolve that review before authorising a new collection."
      : expired ? "Cancel this unauthorised checkout before preparing a new one. Expiry is not evidence that an in-flight payment failed."
      : "Check the customer, instalment, recipient and exact amount. No receipt is confirmed at this stage.";
  } else if (["authorised", "pending", "unknown"].includes(status)) {
    steps[1].state = "complete";
    steps[2].state = status === "unknown" ? "attention" : "current";
    title = status === "unknown" ? "Resolve the existing payment" : "Await a verified receipt";
    detail = status === "unknown" ? "Query the existing outcome. Do not create or retry a competing payment while the result is unknown."
      : "Authorisation and a browser return are not proof of payment. Record the provider outcome for this checkout.";
  } else if (["confirmed", "refunded", "reversed"].includes(status)) {
    steps[1].state = "complete";
    steps[2].state = "complete";
    title = status === "refunded" ? "Refund evidence recorded" : status === "reversed" ? "Reversal evidence recorded"
      : refundRequested ? "Independent refund review needed" : "Receipt recorded for reconciliation";
    detail = status === "refunded" ? "The original receipt remains in history. Review the reopened instalment; this sample evidence did not send a refund."
      : status === "reversed" ? "The original receipt remains in history. Review the customer dispute and reconciliation before further collection."
      : refundRequested ? "A different Finance reviewer must check the refund evidence. The request alone does not establish a refund."
      : "Review the canonical payment and allocation. This sample receipt does not establish a live payment or settlement.";
  } else if (status === "failed") {
    steps[1].state = "complete";
    steps[2].state = "attention";
    title = "Provider failure recorded";
    detail = "No successful receipt was recorded for this checkout. Review the failure and current instalment before preparing any new collection.";
  } else if (status === "cancelled") {
    steps[1].state = "attention";
    title = "Checkout cancelled before authorisation";
    detail = "No receipt was recorded. Review the current instalment before preparing a new checkout.";
  }
  return { steps, title, detail };
}

export function PaymentProgress({ status, expired, held, refundRequested }: {
  status: string; expired: boolean; held: boolean; refundRequested: boolean;
}) {
  const progress = paymentProgress(status, { expired, held, refundRequested });
  return <section aria-label="Checkout progress" className="space-y-3">
    <WorkflowProgress label="Payment steps" steps={progress.steps} />
    <div className="rounded-lg border-l-2 border-primary bg-secondary/30 p-4">
      <h3 className="text-sm font-semibold">{progress.title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{progress.detail}</p>
    </div>
  </section>;
}
