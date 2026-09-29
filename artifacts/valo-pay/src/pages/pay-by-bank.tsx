import { useRef, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, CheckCircle2, Landmark, ShieldCheck } from "lucide-react";
import {
  ConnectedFrame,
  ConnectedPanel,
  ConnectedStatus,
  ConnectedRecovery,
  ConnectedState,
  connectedStatusLabel,
} from "@/components/connected-frame";
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
const TITLE = "Pay-by-bank",
  DESCRIPTION =
    "A clear journey from bank authorisation to a verified receipt, tied to the instalment it pays.";
export default function PayByBank() {
  const api = useConnected(),
    { merchantId } = useWorkspace();
  return <PaymentContent key={merchantId} api={api} />;
}
function PaymentContent({ api }: { api: ReturnType<typeof useConnected> }) {
  const { merchantId } = useWorkspace();
  const [dueId, setDueId] = useState(""),
    [amount, setAmount] = useState<string | null>(null),
    [amountError, setAmountError] = useState(""),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  const [review, setReview] = useState<{
      action: string;
      title: string;
      record: ConnectedRecord;
      data?: Record<string, unknown>;
    } | null>(null),
    [reason, setReason] = useState("");
  // A confirmed step usually removes the button that opened its review, so focus then goes to the result.
  const result = useRef<HTMLParagraphElement>(null),
    problem = useRef<HTMLParagraphElement>(null);
  const restoreFocus = useDialogFocusReturn(!!review, () => result.current);
  // A step taken without a review (Simulate browser return, the outcomes) also removes or disables its own
  // button: when focus has fallen to the page, it goes to what the step did, or to why it was refused.
  useFocusWhenLost(result, success);
  useFocusWhenLost(problem, error);
  // A checkout, or a review's reason, typed but not sent is a draft: leaving asks first.
  const draft = useFormDraft({ dueId, amount, reason: review ? reason : "" });
  const act = async (
    action: string,
    data: Record<string, unknown> = {},
    recordId?: string,
    why = "Explore the synthetic payment journey",
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
          "Sample checkout created. Review the customer, instalment, recipient and amount before authorising it.",
        "payment.authorise":
          "Sample bank authorisation recorded. A verified receipt is still needed; no payment is confirmed yet.",
        "payment.return":
          "Browser return recorded. The sample payment is pending until a provider outcome is recorded.",
        "payment.cancel":
          "Unauthorised sample checkout cancelled. No money moved.",
        "payment.refund_request":
          "Sample refund request recorded. A different Finance reviewer must confirm the evidence; no refund was sent.",
        "payment.refund_confirm":
          "Sample refund evidence recorded. An instalment the receipt paid owes that amount again and is open for collection, not in dispute. No funds were sent.",
        "payment.reverse":
          "Sample reversal evidence recorded. An instalment the receipt paid owes that amount again and is in dispute, with a customer dispute exception for Operations. No money moved.",
      };
      setSuccess(
        action === "payment.outcome"
          ? data.outcome === "confirmed"
            ? "Sample receipt confirmed. Review the payment and allocation in reconciliation; this is not evidence of a live payment."
            : data.outcome === "unknown"
              ? "Outcome remains unknown. Another collection is blocked. Query this outcome instead of starting a new payment."
              : "Sample provider failure recorded. No successful receipt was recorded for this checkout."
          : (messages[action] ?? "Sample record saved. No money moved."),
      );
      setReview(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  if (api.isLoading) return <Loading what="pay-by-bank" heading />;
  if (!api.data)
    return (
      <ConnectedState title={TITLE} description={DESCRIPTION}>
        <LoadProblem
          what="pay-by-bank"
          error={api.error}
          retry={() => void api.refetch()}
        />
        <ConnectedRecovery recovery={api} />
      </ConnectedState>
    );
  const { payments } = api.data,
    due = payments.dues.find((d) => d.id === dueId) || payments.dues[0],
    intent =
      payments.intents.find((i) => i.id === selected) || payments.intents[0];
  const canPay =
      api.canWrite &&
      ["Admin", "Operations", "Finance"].includes(api.data.role),
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
  const openReview = (
    action: string,
    title: string,
    record: ConnectedRecord,
  ) => {
    setReason("");
    setError("");
    setReview({ action, title, record });
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
          `Enter an amount above ₦0.00 and no higher than ${formatKobo(due.outstandingKobo)}.`,
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
          <span>Confirmed sample receipts</span>
          <strong>
            {formatNumber(
              payments.intents.filter((i) => i.status === "confirmed").length,
            )}
          </strong>
        </div>
        <div className="connected-metric">
          <span>Awaiting a verified outcome</span>
          <strong>
            {formatNumber(
              payments.intents.filter((i) =>
                ["authorised", "pending", "unknown"].includes(i.status),
              ).length,
            )}
          </strong>
        </div>
        <div className="connected-metric">
          <span>One instalment, one collection</span>
          <strong className="!text-xl">Duplicate protection</strong>
        </div>
      </div>
      <p className="connected-note">
        <ShieldCheck size={16} className="inline mr-2" aria-hidden="true" />
        This simulator uses a one-time, bank-authorised payment journey. It is
        separate from manual transfer and direct debit. A browser return never
        counts as proof of payment.
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
                        {d.blocked ? " · pending instruction" : ""}
                        {heldForReview.has(d.id) ? " · held for review" : ""}
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
                    Outstanding: {formatKobo(due!.outstandingKobo)}. Partial
                    payment is supported.
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
                  Create sample checkout <ArrowRight size={16} />
                </Button>
                {!canPay && (
                  <p className="text-xs text-muted-foreground">
                    Your role, {api.data.role}, can view this journey. Admin,
                    Operations or Finance is required to create or update a
                    sample checkout.
                  </p>
                )}
                {due?.blocked && (
                  <p className="text-xs text-muted-foreground">
                    An instruction is pending. Resolve its outcome before
                    collecting again.
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
                There are no open instalments to collect.
              </p>
            )}
          </ConnectedPanel>
          <ConnectedPanel
            title="Checkout history"
            description="Select a checkout to continue its journey or review its receipt."
          >
            {payments.intents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Your first checkout will appear here.
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
          title={intent ? "Checkout detail" : "Ready when you are"}
          description={
            intent
              ? "Sample bank journey · NGN · no live payment instruction"
              : "Create a checkout to explore authorisation, pending outcomes and reconciliation."
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
                  · One-time sample payment
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Authorise before {formatDate(intent.data.expiresAt ?? '')}
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
                      onClick={() =>
                        openReview(
                          "payment.authorise",
                          "Review sample bank authorisation",
                          intent,
                        )
                      }
                    >
                      Review & authorise
                    </Button>
                    <Button
                      variant="outline"
                      disabled={api.pending || !canPay}
                      onClick={() =>
                        openReview(
                          "payment.cancel",
                          "Cancel this checkout",
                          intent,
                        )
                      }
                    >
                      Cancel checkout
                    </Button>
                    {checkoutExpired && (
                      <p className="text-sm text-muted-foreground">
                        This checkout expired. Cancel it and create a new
                        checkout to obtain fresh authorisation.
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
                    onClick={() => void act("payment.return", {}, intent.id)}
                  >
                    Simulate browser return
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
                          "Query sample provider and confirm its receipt",
                        )
                      }
                    >
                      {intent.status === "unknown"
                        ? "Query again: confirmed"
                        : "Simulate confirmed receipt"}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={api.pending || !canPay}
                      onClick={() =>
                        void act(
                          "payment.outcome",
                          { outcome: "unknown" },
                          intent.id,
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
                        )
                      }
                    >
                      Simulate failure
                    </Button>
                  </>
                )}
                {intent.status === "confirmed" && (
                  <>
                    <Link
                      className="text-sm font-medium underline underline-offset-4 py-2"
                      href="/reconciliation"
                    >
                      View reconciliation
                    </Link>
                    {!intent.data.refundRequest && (
                      <Button
                        variant="outline"
                        disabled={
                          api.pending ||
                          !api.canWrite ||
                          !["Admin", "Operations"].includes(api.data.role)
                        }
                        onClick={() =>
                          openReview(
                            "payment.refund_request",
                            "Request a sample refund",
                            intent,
                          )
                        }
                      >
                        Request refund
                      </Button>
                    )}
                    {intent.data.refundRequest && (
                      <Button
                        variant="outline"
                        disabled={api.pending || api.data.role !== "Finance"}
                        onClick={() =>
                          openReview(
                            "payment.refund_confirm",
                            "Confirm sample refund evidence",
                            intent,
                          )
                        }
                      >
                        Finance: confirm refund
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      disabled={api.pending || api.data.role !== "Finance"}
                      onClick={() =>
                        openReview(
                          "payment.reverse",
                          "Record sample reversal evidence",
                          intent,
                        )
                      }
                    >
                      Finance: record reversal
                    </Button>
                  </>
                )}
              </div>
              {intent.status === "unknown" && (
                <p className="connected-note">
                  The result has been unknown
                  {unknownSince ? ` since ${formatDate(unknownSince)}` : ""}. A
                  new collection is blocked until the outcome is known. Query
                  the provider again; once the outcome has been unknown for 24
                  hours, the daily close raises an unknown-outcome exception
                  for Finance, who confirms the payment with its evidence or
                  marks it failed. Either one releases the instalment.{" "}
                  {outcomeExceptionId && (
                    <Link
                      className="font-medium underline underline-offset-4"
                      href={`/exceptions?${new URLSearchParams({ record: outcomeExceptionId, lender: merchantId || "" })}`}
                    >
                      Open the unknown-outcome exception
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
                  Sample server receipt recorded. The payment and allocation are
                  available in the customer timeline and reconciliation. This is
                  not evidence of a live bank payment.
                </p>
              )}
              {intent.data.refundRequest && (
                <p className="connected-note">
                  Refund requested by {intent.data.refundRequest.maker}. Switch
                  to the Finance demo role in{" "}
                  <Link href="/settings" className="underline">
                    Settings
                  </Link>{" "}
                  to explore the reviewer step. A demo role switch does not
                  establish independent human approval. Sample refund evidence
                  never sends funds.
                </p>
              )}
              <h3 className="font-semibold text-sm pt-3">Journey history</h3>
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
                The customer sees who they are paying,
                <br />
                the exact amount, and what happens next.
              </p>
            </div>
          )}
        </ConnectedPanel>
      </div>
      {review && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !api.pending && !api.hasUnconfirmedOutcome)
              setReview(null);
          }}
        >
          <DialogContent onCloseAutoFocus={restoreFocus}>
            <DialogHeader>
              <DialogTitle>{review.title}</DialogTitle>
              <DialogDescription>
                Sample data only. No funds will move. Review the amount and
                recipient before continuing.
              </DialogDescription>
            </DialogHeader>
            <ConnectedRecovery
              recovery={api}
              onReleased={() => setError("")}
              onRecovered={() => {
                setError("");
                setReview(null);
                setReason("");
                setSuccess(
                  "Original sample request confirmed. Review the refreshed checkout below.",
                );
              }}
            />
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
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
                  minLength={8}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                />
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
                  Go back
                </Button>
                <Button
                  type="submit"
                  disabled={api.pending || api.hasUnconfirmedOutcome}
                >
                  {api.pending ? "Saving…" : "Confirm sample action"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </ConnectedFrame>
  );
}
