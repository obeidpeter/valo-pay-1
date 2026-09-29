import { useRef, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, CheckCircle2, Landmark, ShieldCheck } from "lucide-react";
import {
  ConnectedFrame,
  ConnectedPanel,
  ConnectedStatus,
  ConnectedRecovery,
  ConnectedState,
  FieldHint,
  connectedStatusLabel,
  describedBy,
  roleRefusal,
  tooShort,
} from "@/components/connected-frame";
import { FieldError } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loading } from "@/components/loading";
import { LoadProblem } from "@/components/load-problem";
import { useConnected, type ConnectedRecord } from "@/lib/connected";
import { formatKobo, formatDate, formatNumber } from "@/lib/formatters";
import { nairaToKobo, koboToNaira } from "@/lib/money-input";
import { useFormDraft } from "@/lib/unsaved-changes";
import { useWorkspace } from "@/lib/workspace-context";
import { useDialogFocusReturn, useFocusWhenLost } from "@/lib/focus";
import { reversalReviewRefusals } from "@/lib/permissions";
import { PaymentProgress } from "@/features/pay-by-bank/payment-progress";
const TITLE = "Pay by Bank",
  DESCRIPTION =
    "The customer approves each payment at their bank. A payment counts only when the bank or provider confirms it.";
/**
 * The steps taken in a dialog: its question, what will happen, and the button
 * that does it. The button that opens the dialog says the same.
 */
const reviewedSteps: Record<
  string,
  { title: string; detail: string; confirm: string; busy: string; keep?: string }
> = {
  "payment.authorise": {
    title: "Simulate the customer’s authorisation?",
    detail:
      "This stands in for the customer approving the payment at their bank. Sample data only. No money will move.",
    confirm: "Simulate authorisation",
    busy: "Simulating…",
  },
  "payment.cancel": {
    title: "Cancel this checkout?",
    detail:
      "The customer can no longer authorise it. Sample data only. No money will move.",
    confirm: "Cancel checkout",
    busy: "Cancelling…",
    keep: "Keep checkout",
  },
  "payment.refund_request": {
    title: "Request a refund?",
    detail:
      "A different Finance reviewer must then record the refund. Sample data only. No money will move.",
    confirm: "Request refund",
    busy: "Requesting…",
  },
  "payment.refund_confirm": {
    title: "Record this refund?",
    detail:
      "The instalment this payment covered opens again for collection. Sample data only. No money will move.",
    confirm: "Record refund",
    busy: "Recording…",
  },
  "payment.reverse": {
    title: "Record a reversal?",
    detail:
      "The instalment this payment covered goes into dispute. Sample data only. No money will move.",
    confirm: "Record reversal",
    busy: "Recording…",
  },
};
export default function PayByBank() {
  const api = useConnected(),
    { merchantId } = useWorkspace();
  return <PaymentContent key={merchantId} api={api} />;
}
function PaymentContent({ api }: { api: ReturnType<typeof useConnected> }) {
  const { merchantId, workspace } = useWorkspace();
  const [dueId, setDueId] = useState(""),
    [amount, setAmount] = useState<string | null>(null),
    [amountError, setAmountError] = useState(""),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  const [review, setReview] = useState<{
      action: string;
      record: ConnectedRecord;
      data?: Record<string, unknown>;
    } | null>(null),
    [reason, setReason] = useState(""),
    [reasonError, setReasonError] = useState("");
  // A confirmed step usually removes the button that opened its review, so focus then goes to the result.
  const result = useRef<HTMLParagraphElement>(null),
    problem = useRef<HTMLParagraphElement>(null);
  const restoreFocus = useDialogFocusReturn(!!review, () => result.current);
  // A step taken without a review (Simulate return from bank, the outcomes) also removes or disables its own
  // button: when focus has fallen to the page, it goes to what the step did, or to why it was refused.
  useFocusWhenLost(result, success);
  useFocusWhenLost(problem, error);
  // A checkout, or a review's reason, typed but not sent is a draft: leaving asks first.
  const draft = useFormDraft({ dueId, amount, reason: review ? reason : "" });
  const act = async (
    action: string,
    data: Record<string, unknown> = {},
    recordId?: string,
    why = "Sample Pay by Bank step",
  ) => {
    setError("");
    setSuccess("");
    draft.sending(
      action === "payment.create" ? { dueId, amount, reason: "" } : null,
    );
    try {
      await api.run(action, data, recordId, why);
      draft.saved();
      const messages: Record<string, string> = {
        "payment.create":
          "Sample checkout created. Check the customer, instalment, recipient and amount before you simulate authorisation.",
        "payment.authorise":
          "Sample bank authorisation recorded. The payment is not confirmed yet.",
        "payment.return":
          "Return from the bank recorded. The sample payment is pending until the provider reports the outcome.",
        "payment.cancel":
          "Sample checkout cancelled before authorisation. No money moved.",
        "payment.refund_request":
          "Sample refund requested. A different Finance reviewer must now record it. No money moved.",
        "payment.refund_confirm":
          "Sample refund recorded. The instalment this payment covered is open for collection again. It is not in dispute. No money moved.",
        "payment.reverse":
          "Sample reversal recorded. The instalment this payment covered is now in dispute. A new dispute exception is open for Operations. No money moved.",
      };
      setSuccess(
        action === "payment.outcome"
          ? data.outcome === "confirmed"
            ? "Sample payment confirmed. It is not a real payment."
            : data.outcome === "unknown"
              ? "Outcome still unknown. You cannot collect this instalment again until it is known. Check again instead of starting a new payment."
              : "Sample failed payment recorded. No money moved."
          : (messages[action] ?? "Sample record saved. No money moved."),
      );
      setReview(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  if (api.isLoading) return <Loading what={TITLE} heading />;
  if (!api.data)
    return (
      <ConnectedState title={TITLE} description={DESCRIPTION}>
        <LoadProblem
          what={TITLE}
          error={api.error}
          retry={() => void api.refetch()}
        />
        <ConnectedRecovery recovery={api} />
      </ConnectedState>
    );
  const { payments, role } = api.data,
    due = payments.dues.find((d) => d.id === dueId) || payments.dues[0],
    intent =
      payments.intents.find((i) => i.id === selected) || payments.intents[0];
  const canPay =
      api.canWrite && ["Admin", "Operations", "Finance"].includes(role),
    canRequestRefund = api.canWrite && ["Admin", "Operations"].includes(role),
    canRecord = role === "Finance",
    staff = workspace?.accessMode === "staff",
    checkoutExpired =
      !!intent &&
      Date.parse(intent.data.expiresAt ?? '') <= Date.parse(api.data.asOf);
  // Instalments reconciliation holds for a renewed reversal review: the service refuses their checkouts.
  const heldForReview = new Set(payments.heldForReversalReview),
    dueHeld = !!due && heldForReview.has(due.id),
    intentHeld = !!intent && heldForReview.has(String(intent.data.dueItemId));
  // When the outcome became unknown: after 24 hours the daily close raises an exception for Finance, which the checkout names.
  const unknownSince = intent?.data.events?.find(
      (e) => e.status === "unknown",
    )?.at,
    outcomeExceptionId = intent?.data.outcomeExceptionId;
  // Why a confirmed payment's refund or reversal is not this role's to take, before a refund is requested.
  const adjustmentRefusal =
    !canRequestRefund && !canRecord
      ? `Only Admin or Operations can request a refund, and only Finance can record a reversal. Your role is ${role}.${staff ? "" : " Change your demo role in Settings."}`
      : !canRequestRefund
        ? roleRefusal(["Admin", "Operations"], "request a refund", role, workspace?.accessMode)
        : !canRecord
          ? roleRefusal(["Finance"], "record a reversal", role, workspace?.accessMode)
          : "";
  const step = review ? reviewedSteps[review.action] : undefined;
  const openReview = (action: string, record: ConnectedRecord) => {
    setReason("");
    setReasonError("");
    setError("");
    setReview({ action, record });
  };
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!due) return;
    setAmountError("");
    let value: number;
    try {
      value = nairaToKobo(amount ?? koboToNaira(due.outstandingKobo));
      if (value <= 0 || value > due.outstandingKobo)
        throw new Error(
          `Enter an amount from ₦0.01 to ${formatKobo(due.outstandingKobo)}.`,
        );
    } catch (e) {
      setAmountError((e as Error).message);
      document.getElementById("checkout-amount")?.focus();
      return;
    }
    try {
      if (
        await act(
          "payment.create",
          { dueItemId: due.id, amountKobo: value },
          undefined,
          "Create a sample checkout for this instalment",
        )
      )
        setSelected("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <ConnectedFrame
      title={TITLE}
      description={DESCRIPTION}
      recovery={api}
      onRecovered={() => {
        setError("");
        setReview(null);
        setReason("");
        draft.saved();
      }}
      onReleased={() => setError("")}
    >
      <div className="connected-metrics">
        <div className="connected-metric">
          <span>Confirmed sample payments</span>
          <strong>
            {formatNumber(
              payments.intents.filter((i) => i.status === "confirmed").length,
            )}
          </strong>
        </div>
        <div className="connected-metric">
          <span>Waiting for an outcome</span>
          <strong>
            {formatNumber(
              payments.intents.filter((i) =>
                ["authorised", "pending", "unknown"].includes(i.status),
              ).length,
            )}
          </strong>
        </div>
        <div className="connected-metric">
          <span>Each instalment</span>
          <strong className="!text-xl">One payment at a time</strong>
        </div>
      </div>
      <p className="connected-note">
        <ShieldCheck size={16} className="inline mr-2" aria-hidden="true" />
        A checkout asks a customer to pay one instalment from their bank. It is
        separate from bank transfers and direct debits. This page simulates each
        bank step.
      </p>
      {error && !api.hasUnconfirmedOutcome && (
        <p role="alert" className="connected-error" ref={problem}>
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="connected-note" ref={result}>
          {success}
        </p>
      )}
      <div className="connected-grid">
        <div className="space-y-5">
          <ConnectedPanel
            title="Create a checkout"
            description="The amount, recipient and instalment are fixed when the checkout is created."
          >
            {payments.dues.length ? (
              <form className="space-y-4" onSubmit={(e) => void create(e)}>
                <div>
                  <label htmlFor="checkout-due">Customer and instalment</label>
                  <select
                    id="checkout-due"
                    value={due?.id}
                    onChange={(e) => {
                      setDueId(e.target.value);
                      setAmount(null);
                      setAmountError("");
                    }}
                  >
                    {payments.dues.map((d) => (
                      <option value={d.id} key={d.id}>
                        {d.customerName} · {d.reference}
                        {d.blocked ? " · another payment in progress" : ""}
                        {heldForReview.has(d.id) ? " · held for reversal review" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="checkout-amount">Amount (₦)</label>
                  <input
                    id="checkout-amount"
                    inputMode="decimal"
                    value={amount ?? koboToNaira(due!.outstandingKobo)}
                    onChange={(e) => setAmount(e.target.value)}
                    aria-invalid={!!amountError}
                    aria-describedby={`checkout-amount-help${amountError ? " checkout-amount-error" : ""}`}
                    required
                  />
                  <p
                    id="checkout-amount-help"
                    className="text-xs text-muted-foreground mt-2"
                  >
                    Outstanding: {formatKobo(due!.outstandingKobo)}. You can ask
                    for less than this.
                  </p>
                  {amountError && (
                    <p
                      id="checkout-amount-error"
                      role="alert"
                      className="text-xs text-destructive mt-2"
                    >
                      {amountError}
                    </p>
                  )}
                </div>
                <Button
                  type="submit"
                  disabled={api.pending || !canPay || due?.blocked || dueHeld}
                >
                  Create checkout <ArrowRight size={16} />
                </Button>
                {!canPay && (
                  <p className="text-xs text-muted-foreground">
                    {roleRefusal(
                      ["Admin", "Operations", "Finance"],
                      "create or change a checkout",
                      role,
                      workspace?.accessMode,
                    )}
                  </p>
                )}
                {due?.blocked && (
                  <p className="text-xs text-muted-foreground">
                    Another payment for this instalment is in progress or has an
                    unknown outcome. Resolve it first, in Checkout history or in
                    Collections.
                  </p>
                )}
                {dueHeld && (
                  <p className="text-xs text-muted-foreground">
                    {reversalReviewRefusals.checkout}
                  </p>
                )}
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">
                No open instalments to collect. Collections lists every
                instalment and its status.
              </p>
            )}
          </ConnectedPanel>
          <ConnectedPanel
            title="Checkout history"
            description="Select a checkout to continue it or to check its payment."
          >
            {payments.intents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No checkouts yet. Select Create checkout to make the first one.
              </p>
            ) : (
              <div className="space-y-2">
                {payments.intents.map((i) => (
                  <button
                    key={i.id}
                    onClick={() => setSelected(i.id)}
                    aria-pressed={intent?.id === i.id}
                    className={`text-left w-full connected-record focus-visible:ring-2 focus-visible:ring-ring ${intent?.id === i.id ? "bg-secondary" : ""}`}
                  >
                    <div className="flex justify-between gap-2">
                      <span className="text-sm font-semibold">
                        {formatKobo(i.amountKobo)}
                      </span>
                      <ConnectedStatus record="checkout" status={i.status} />
                    </div>
                    <p className="mt-2">
                      {
                        api.data!.customers.find((c) => c.id === i.customerId)
                          ?.name
                      }
                    </p>
                    <p>{formatDate(i.createdAt)}</p>
                  </button>
                ))}
              </div>
            )}
          </ConnectedPanel>
        </div>
        <ConnectedPanel
          title={intent ? "Checkout details" : "No checkout yet"}
          description={
            intent
              ? "A sample payment in naira. Nothing is sent to a bank."
              : "Select Create checkout to try each step, from authorisation to a confirmed payment."
          }
        >
          {intent ? (
            <>
              <div className="rounded-xl border p-5 bg-background">
                <div className="flex items-center gap-3 mb-5">
                  <span className="p-3 bg-secondary rounded-lg">
                    <Landmark size={22} aria-hidden="true" />
                  </span>
                  <div>
                    <p className="text-xs text-muted-foreground">Pay to</p>
                    <h3 className="font-semibold">{intent.data.beneficiary}</h3>
                  </div>
                  <div className="ml-auto">
                    <ConnectedStatus record="checkout" status={intent.status} />
                  </div>
                </div>
                <p className="text-4xl font-semibold tracking-tight">
                  {formatKobo(intent.amountKobo)}
                </p>
                <p className="text-xs text-muted-foreground mt-3">
                  {
                    api.data.customers.find((c) => c.id === intent.customerId)
                      ?.name
                  }{" "}
                  · One-off sample payment
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {intent.data.expiresAt
                    ? `The customer must authorise before ${formatDate(intent.data.expiresAt)}.`
                    : "No expiry recorded."}
                </p>
                <p className="text-xs text-muted-foreground mt-3">
                  This simulator does not calculate or charge payment fees. It does not quote the cost of a live payment.
                </p>
              </div>
              <PaymentProgress status={intent.status} expired={checkoutExpired} held={intentHeld} refundRequested={!!intent.data.refundRequest} />
              <div className="flex flex-wrap gap-2">
                {intent.status === "created" && (
                  <>
                    <Button
                      disabled={
                        api.pending || !canPay || checkoutExpired || intentHeld
                      }
                      onClick={() => openReview("payment.authorise", intent)}
                    >
                      Simulate authorisation
                    </Button>
                    <Button
                      variant="outline"
                      disabled={api.pending || !canPay}
                      onClick={() => openReview("payment.cancel", intent)}
                    >
                      Cancel checkout
                    </Button>
                    {checkoutExpired && (
                      <p className="text-sm text-muted-foreground">
                        This checkout has expired. Cancel it, then create a new
                        one.
                      </p>
                    )}
                    {intentHeld && (
                      <p className="text-sm text-muted-foreground">
                        {reversalReviewRefusals.authorise}
                      </p>
                    )}
                  </>
                )}
                {intent.status === "authorised" && (
                  <Button
                    disabled={api.pending || !canPay}
                    onClick={() =>
                      void act(
                        "payment.return",
                        {},
                        intent.id,
                        "Simulate the return from the bank",
                      )
                    }
                  >
                    Simulate return from bank
                  </Button>
                )}
                {["authorised", "pending", "unknown"].includes(
                  intent.status,
                ) && (
                  <>
                    <Button
                      disabled={api.pending || !canPay}
                      onClick={() =>
                        void act(
                          "payment.outcome",
                          { outcome: "confirmed" },
                          intent.id,
                          intent.status === "unknown"
                            ? "Check again and simulate a confirmed payment"
                            : "Simulate a confirmed payment",
                        )
                      }
                    >
                      {intent.status === "unknown"
                        ? "Check again: confirmed"
                        : "Simulate confirmed payment"}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={api.pending || !canPay}
                      onClick={() =>
                        void act(
                          "payment.outcome",
                          { outcome: "unknown" },
                          intent.id,
                          "Simulate an unknown outcome",
                        )
                      }
                    >
                      Simulate unknown outcome
                    </Button>
                    <Button
                      variant="outline"
                      disabled={api.pending || !canPay}
                      onClick={() =>
                        void act(
                          "payment.outcome",
                          { outcome: "failed" },
                          intent.id,
                          "Simulate a failed payment",
                        )
                      }
                    >
                      Simulate failed payment
                    </Button>
                  </>
                )}
                {intent.status === "confirmed" && (
                  <>
                    <Link
                      className="text-sm font-medium underline underline-offset-4 py-2"
                      href="/reconciliation"
                    >
                      Open Reconciliation
                    </Link>
                    {!intent.data.refundRequest && (
                      <Button
                        variant="outline"
                        disabled={api.pending || !canRequestRefund}
                        onClick={() =>
                          openReview("payment.refund_request", intent)
                        }
                      >
                        Request refund
                      </Button>
                    )}
                    {intent.data.refundRequest && (
                      <Button
                        variant="outline"
                        disabled={api.pending || !canRecord}
                        onClick={() =>
                          openReview("payment.refund_confirm", intent)
                        }
                      >
                        Record refund
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      disabled={api.pending || !canRecord}
                      onClick={() => openReview("payment.reverse", intent)}
                    >
                      Record reversal
                    </Button>
                    {!intent.data.refundRequest && adjustmentRefusal && (
                      <p className="w-full text-xs text-muted-foreground">
                        {adjustmentRefusal}
                      </p>
                    )}
                  </>
                )}
              </div>
              {intent.status === "unknown" && (
                <p className="connected-note">
                  The outcome has been unknown
                  {unknownSince ? ` since ${formatDate(unknownSince)}` : ""}.
                  You cannot collect this instalment again until the outcome is
                  known. Check again with the provider. If it is still unknown
                  after 24 hours, the daily close creates an exception for
                  Finance. Finance then records the payment as confirmed, with
                  evidence, or as failed. Either way, this instalment is no
                  longer held.{" "}
                  {outcomeExceptionId && (
                    <Link
                      className="font-medium underline underline-offset-4"
                      href={`/exceptions?${new URLSearchParams({ record: outcomeExceptionId, lender: merchantId || "" })}`}
                    >
                      Open the exception for this checkout
                    </Link>
                  )}
                </p>
              )}
              {intent.status === "confirmed" && (
                <p className="connected-note">
                  <CheckCircle2
                    size={16}
                    className="inline mr-2"
                    aria-hidden="true"
                  />
                  You can see this sample payment, and the instalment it paid,
                  in the customer’s history and in Reconciliation. It is not a
                  real bank payment.
                </p>
              )}
              {intent.data.refundRequest && (
                <p className="connected-note">
                  Refund requested by {intent.data.refundRequest.maker}. A
                  different Finance reviewer must record it.{" "}
                  {!staff && (
                    <>
                      To try that step, change your demo role to Finance in{" "}
                      <Link href="/settings" className="underline">
                        Settings
                      </Link>
                      . Switching demo roles is not a second person.{" "}
                    </>
                  )}
                  Recording a refund never sends money.
                </p>
              )}
              <h3 className="font-semibold text-sm pt-3">Checkout timeline</h3>
              <ol className="connected-timeline">
                {intent.data.events?.map(
                  (
                    e: { at: string; status: string; detail: string },
                    i: number,
                  ) => (
                    <li key={i}>
                      <span className="font-medium">
                        {connectedStatusLabel("checkout", e.status)}
                      </span>
                      <p className="text-muted-foreground mt-1">{e.detail}</p>
                      <time>{formatDate(e.at)}</time>
                    </li>
                  ),
                )}
              </ol>
            </>
          ) : (
            <div className="py-12 text-center text-muted-foreground">
              <Landmark size={34} className="mx-auto mb-4" aria-hidden="true" />
              <p className="text-sm">
                The customer will see who they are paying,
                <br />
                the exact amount and what happens next.
              </p>
            </div>
          )}
        </ConnectedPanel>
      </div>
      {review && step && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !api.pending && !api.hasUnconfirmedOutcome)
              setReview(null);
          }}
        >
          <DialogContent onCloseAutoFocus={restoreFocus}>
            <DialogHeader>
              <DialogTitle>{step.title}</DialogTitle>
              <DialogDescription>{step.detail}</DialogDescription>
            </DialogHeader>
            <ConnectedRecovery
              recovery={api}
              onReleased={() => setError("")}
              onRecovered={() => {
                setError("");
                setReview(null);
                setReason("");
                setSuccess(
                  "Original request confirmed. Check the updated checkout below. Nothing was sent to a bank.",
                );
              }}
            />
            <form
              className="space-y-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                const short = tooShort(reason, "a reason", 8);
                setReasonError(short);
                if (short) {
                  document.getElementById("payment-reason")?.focus();
                  return;
                }
                void act(
                  review.action,
                  review.data || {},
                  review.record.id,
                  reason,
                );
              }}
            >
              <div className="rounded-lg border p-4">
                <p className="font-semibold">
                  {formatKobo(review.record.amountKobo)}
                </p>
                <p className="text-sm">{review.record.data.beneficiary}</p>
                {review.action === 'payment.authorise' && <p className="mt-2 text-xs text-muted-foreground">This simulator does not calculate or charge payment fees. It does not quote the cost of a live payment.</p>}
              </div>
              <div>
                <label
                  htmlFor="payment-reason"
                  className="block text-sm font-medium mb-2"
                >
                  Reason
                </label>
                <textarea
                  id="payment-reason"
                  disabled={api.pending || api.hasUnconfirmedOutcome}
                  className="w-full border rounded-md p-3 bg-background"
                  required
                  maxLength={500}
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setReasonError("");
                  }}
                  aria-invalid={reasonError ? true : undefined}
                  aria-describedby={describedBy("payment-reason", reasonError)}
                  rows={3}
                />
                <FieldHint id="payment-reason-help" minLength={8} />
                <FieldError id="payment-reason" message={reasonError} />
              </div>
              {error && !api.hasUnconfirmedOutcome && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={api.pending || api.hasUnconfirmedOutcome}
                  onClick={() => setReview(null)}
                >
                  {step.keep ?? "Cancel"}
                </Button>
                <Button
                  type="submit"
                  busy={api.pending}
                  busyLabel={step.busy}
                  disabled={api.hasUnconfirmedOutcome}
                >
                  {step.confirm}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </ConnectedFrame>
  );
}
