import { Link, useLocation } from "wouter";
import {
  Building2,
  KeyRound,
  Landmark,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DiscardOriginalRequest } from "@/components/discard-original-request";
import { RefreshProblem, type RefreshableQuery } from "@/components/load-problem";
import { requestClosed, savedAnswerWithheld } from "@/lib/safe-mutations";
import { errorWords } from "@/lib/notify";
import "@/connected.css";
/** The connected workspace's held request and, for a failed refresh, its query. */
type Recovery = {
  scope: string;
  pending: boolean;
  hasUnconfirmedOutcome: boolean;
  retryUnconfirmed: () => Promise<void>;
  abandonUnconfirmed: () => void;
} & Partial<RefreshableQuery>;
export function ConnectedFrame({
  title,
  description,
  children,
  recovery,
  onRecovered,
  onReleased,
}: {
  title: string;
  description: string;
  children: ReactNode;
  recovery?: Recovery;
  onRecovered?: () => void;
  /** The held request was let go without a result: discarded, refused as cancelled, or saved earlier with its answer withheld. */
  onReleased?: () => void;
}) {
  return (
    <div className="connected-page space-y-6">
      <ConnectedHeader title={title} description={description} />
      <RefreshProblem what={title} shown="records" query={recovery} />
      <ConnectedRecovery
        recovery={recovery}
        onRecovered={onRecovered}
        onReleased={onReleased}
      />
      <fieldset
        disabled={recovery?.pending || recovery?.hasUnconfirmedOutcome}
        className="space-y-6 min-w-0"
        aria-label="Connected workspace actions and records"
      >
        {children}
      </fieldset>
    </div>
  );
}
/**
 * A connected page's heading and the tabs between the four modules. The page
 * shows them while its workspace loads and when it cannot be loaded too, so
 * every state has its h1 and a way to the other modules.
 */
export function ConnectedHeader({ title, description }: { title: string; description: string }) {
  const [location] = useLocation();
  return (
    <>
      <header className="connected-heading">
        <div>
          <p className="connected-eyebrow">
            <Sparkles size={14} aria-hidden="true" /> Connected workspace
          </p>
          <h1>{title}</h1>
          <p className="text-sm text-muted-foreground max-w-2xl mt-2">
            {description}
          </p>
        </div>
        <span className="connected-mode">
          Sample journeys · no live instructions
        </span>
      </header>
      <nav className="connected-tabs" aria-label="Connected modules">
        {[
          { href: "/pay-by-bank", label: "Pay-by-bank", icon: Landmark },
          { href: "/credit-desk", label: "Credit Desk", icon: ShieldCheck },
          { href: "/cash-desk", label: "Cash Desk", icon: Building2 },
          {
            href: "/connections",
            label: "Permissions & readiness",
            icon: KeyRound,
          },
        ].map((i) => (
          <Link
            key={i.href}
            href={i.href}
            aria-current={location === i.href ? "page" : undefined}
          >
            <i.icon size={16} aria-hidden="true" />
            {i.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
/** A connected page that waits for its workspace, or could not load it: its heading and tabs, then the state. */
export function ConnectedState({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="connected-page space-y-6">
      <ConnectedHeader title={title} description={description} />
      {children}
    </div>
  );
}
export function ConnectedRecovery({
  recovery,
  onRecovered,
  onReleased,
}: {
  recovery?: Recovery;
  onRecovered?: () => void;
  onReleased?: () => void;
}) {
  const [recoveryError, setRecoveryError] = useState("");
  const [recovered, setRecovered] = useState(false);
  const scope = useRef(recovery?.scope);
  scope.current = recovery?.scope;
  useEffect(() => {
    setRecovered(false);
    setRecoveryError("");
  }, [recovery?.scope]);
  useEffect(() => {
    if (recovery?.hasUnconfirmedOutcome) {
      setRecovered(false);
      setRecoveryError("");
    }
  }, [recovery?.hasUnconfirmedOutcome]);
  return (
    <>
      {recovery?.hasUnconfirmedOutcome && (
        <div className="connected-note" role="alert">
          <h2 className="font-semibold text-foreground">
            Previous action outcome unconfirmed
          </h2>
          <p className="mt-2">
            The response was lost or unavailable. Your action may already have
            been saved. Retry the original request to recover its result. If it
            cannot be recovered, check Operations before you start a new action.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              busy={recovery.pending}
              busyLabel="Recovering result…"
              onClick={async () => {
                const submittedScope = recovery.scope;
                setRecoveryError("");
                try {
                  await recovery.retryUnconfirmed();
                  if (scope.current === submittedScope) {
                    onRecovered?.();
                    setRecovered(true);
                  }
                } catch (error) {
                  if (scope.current !== submittedScope) return;
                  // The service cancelled the request's key: nothing sent with it was saved, and the page is free again.
                  if (requestClosed(error)) {
                    onReleased?.();
                    setRecoveryError(
                      `The original request was not saved. ${errorWords(error, "")}`,
                    );
                  } else if (savedAnswerWithheld(error)) {
                    // Saved earlier, with its answer withheld now: the service says why, and the page is free again.
                    onReleased?.();
                    setRecoveryError(
                      errorWords(error, "The original request was saved earlier, but its result is no longer available."),
                    );
                  } else setRecoveryError(errorWords(error, "The service did not confirm the result."));
                }
              }}
            >
              Retry original sample request
            </Button>
            <Link
              href="/operations"
              className="inline-flex min-h-10 items-center text-primary underline"
            >
              Open Operations
            </Link>
            <DiscardOriginalRequest
              disabled={recovery.pending}
              onDiscard={() => {
                recovery.abandonUnconfirmed();
                setRecoveryError("");
                onReleased?.();
              }}
            />
          </div>
          {recoveryError && <p className="mt-2">{recoveryError}</p>}
        </div>
      )}
      {!recovery?.hasUnconfirmedOutcome && recoveryError && (
        <p role="alert" className="connected-error">
          {recoveryError}
        </p>
      )}
      {recovered && (
        <p className="connected-note" role="status">
          Original sample request confirmed. Review the refreshed records below.
          No live financial instruction was sent.
        </p>
      )}
    </>
  );
}
export function ConnectedPanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="connected-panel">
      <div className="connected-panel-head">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      <div className="p-5 space-y-4">{children}</div>
    </section>
  );
}
export function ConnectedStatus({ status }: { status: string }) {
  return (
    <span
      className={`connected-status ${["confirmed", "active", "approved", "complete"].includes(status) ? "good" : ["unknown", "expired", "revoked", "failed", "blocked", "refused"].includes(status) ? "attention" : ""}`}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}
