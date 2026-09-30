import { WorkflowProgress, type WorkflowStep } from "@/components/workflow-progress";

/** A presentation of persisted checkout state only; the service still decides every permitted action. */
export function paymentProgress(status: string, { expired = false, held = false, refundRequested = false } = {}) {
  const steps: WorkflowStep[] = [
    { label: "Checkout details", state: "complete" },
    { label: "Bank authorisation", state: "waiting" },
    { label: "Payment confirmed", state: "waiting" },
  ];
  let title = "Checkout saved", detail = "Read its timeline before you take another step.";
  if (status === "created") {
    steps[1].state = expired || held ? "attention" : "current";
    title = held ? "Finish the reversal review first" : expired ? "Checkout expired" : "Check the details before authorisation";
    detail = held ? "Finance must finish a reversal review on this instalment before this checkout can be authorised."
      : expired ? "Cancel this checkout, then create a new one. An expired checkout does not mean that a payment failed."
      : "Check the customer, instalment, recipient and exact amount. No payment is confirmed at this stage.";
  } else if (["authorised", "pending", "unknown"].includes(status)) {
    steps[1].state = "complete";
    steps[2].state = status === "unknown" ? "attention" : "current";
    title = status === "unknown" ? "Resolve the unknown outcome" : "Wait for the payment to be confirmed";
    detail = status === "unknown" ? "Check the outcome with the provider again. Do not start another payment for this instalment while the outcome is unknown."
      : "Authorisation and a return from the bank do not prove payment. Only the provider’s outcome says whether the customer paid.";
  } else if (["confirmed", "refunded", "reversed"].includes(status)) {
    steps[1].state = "complete";
    steps[2].state = "complete";
    title = status === "refunded" ? "Refund recorded" : status === "reversed" ? "Reversal recorded"
      : refundRequested ? "Refund waiting for a Finance reviewer" : "Payment confirmed";
    detail = status === "refunded" ? "The original payment stays in the timeline. Check the instalment, which is open for collection again. No money moved."
      : status === "reversed" ? "The original payment stays in the timeline. Check the customer dispute and Reconciliation before you collect again."
      : refundRequested ? "A different Finance reviewer must record the refund. Requesting a refund does not send money back."
      : "Check the payment and the instalment it paid in Reconciliation. This sample payment is not a real payment or settlement.";
  } else if (status === "failed") {
    steps[1].state = "complete";
    steps[2].state = "attention";
    title = "Payment failed";
    detail = "No money was received for this checkout. Check the instalment before you create a new checkout.";
  } else if (status === "cancelled") {
    steps[1].state = "attention";
    title = "Checkout cancelled before authorisation";
    detail = "No money moved. Check the instalment before you create a new checkout.";
  }
  return { steps, title, detail };
}

export function PaymentProgress({ status, expired, held, refundRequested }: {
  status: string; expired: boolean; held: boolean; refundRequested: boolean;
}) {
  const progress = paymentProgress(status, { expired, held, refundRequested });
  return <section aria-label="Checkout progress" className="space-y-3">
    <WorkflowProgress label="Checkout steps" steps={progress.steps} />
    <div className="rounded-lg border-l-2 border-primary bg-secondary/30 p-4">
      <h3 className="text-sm font-semibold">{progress.title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{progress.detail}</p>
    </div>
  </section>;
}
