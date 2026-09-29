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
import { fieldMessageId } from "@/components/form-field";
import { StatusBadge } from "@/components/record-label";
import { requestClosed, savedAnswerWithheld } from "@/lib/safe-mutations";
import { errorWords } from "@/lib/notify";
import { valueLabel, valueLabels } from "@workspace/valopay-schema";
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
        aria-label="Connected banking actions and records"
      >
        {children}
      </fieldset>
    </div>
  );
}
/**
 * A connected page's heading and the tabs between the four Connected banking
 * pages. The page shows them while its data loads and when it cannot be
 * loaded too, so every state has its h1 and a way to the other pages.
 */
export function ConnectedHeader({ title, description }: { title: string; description: string }) {
  const [location] = useLocation();
  return (
    <>
      <header className="connected-heading">
        <div>
          <p className="connected-eyebrow">
            <Sparkles size={14} aria-hidden="true" /> Connected banking
          </p>
          <h1>{title}</h1>
          <p className="text-sm text-muted-foreground max-w-2xl mt-2">
            {description}
          </p>
        </div>
        <span className="connected-mode">
          Sample data only · No live payments
        </span>
      </header>
      <nav className="connected-tabs" aria-label="Connected banking">
        {[
          { href: "/pay-by-bank", label: "Pay by Bank", icon: Landmark },
          { href: "/credit-desk", label: "Credit Desk", icon: ShieldCheck },
          { href: "/cash-desk", label: "Cash Desk", icon: Building2 },
          {
            href: "/connections",
            label: "Permissions and readiness",
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
            Request not confirmed
          </h2>
          <p className="mt-2">
            We do not know yet whether Valo Pay saved this. Check the original
            request before you change anything.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              busy={recovery.pending}
              busyLabel="Checking original request…"
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
                  } else setRecoveryError(errorWords(error, "Valo Pay did not confirm the result. Check the original request again."));
                }
              }}
            >
              Check original request
            </Button>
            <Link
              href="/operations"
              className="inline-flex min-h-10 items-center text-primary underline"
            >
              Open Request history
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
          Original request confirmed. Check the updated records below. Nothing
          was sent to a bank.
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
/**
 * The help under a written field such as a reason: its minimum length and,
 * for a reason the action records, where it is kept.
 */
export function FieldHint({ id, minLength, audited = true }: { id: string; minLength: number; audited?: boolean }) {
  return (
    <p id={id} className="mt-1 text-xs text-muted-foreground">
      At least {minLength} characters.{audited ? " Saved in the audit log." : ""}
    </p>
  );
}
/**
 * The page's own words for a written field that is too short ("Enter a
 * reason (at least 8 characters)."), or nothing when it is long enough. The
 * service trims what it is sent, so the page does too.
 */
export function tooShort(value: string, what: string, minLength: number): string {
  return value.trim().length < minLength ? `Enter ${what} (at least ${minLength} characters).` : "";
}
/** A written field's description: its help, and its message when there is one. */
export function describedBy(id: string, error?: string): string {
  return error ? `${id}-help ${fieldMessageId(id)}` : `${id}-help`;
}
/**
 * Why a role cannot take an action, in one shape on every connected page:
 * "Only Admin or Operations can grant a permission. Your role is Finance." In
 * the sandbox the demo role is the way to try it.
 */
export function roleRefusal(roles: readonly string[], action: string, role: string, accessMode?: string): string {
  const who = roles.length < 2 ? roles[0] : `${roles.slice(0, -1).join(", ")} or ${roles.at(-1)}`;
  return `Only ${who} can ${action}. Your role is ${role}.${accessMode === "staff" ? "" : " Change your demo role in Settings."}`;
}
/** The records whose statuses these pages show. */
export type ConnectedStatusRecord =
  | "checkout"
  | "permission"
  | "assessment"
  | "accounting-draft"
  | "vat-schedule"
  | "payroll-run"
  | "payroll-item"
  | "payroll-funding";
/**
 * A connected status's key in the shared labels: its record's own entry
 * ("checkout.created"), for a code other pages show in other words, else the
 * code itself. The stored code never changes.
 */
export function connectedStatusKey(record: ConnectedStatusRecord, status: string): string {
  const key = `${record}.${status}`;
  return Object.hasOwn(valueLabels, key) ? key : status;
}
/** A connected status in the shared words, where it is read as text rather than as a badge. */
export function connectedStatusLabel(record: ConnectedStatusRecord, status: string): string {
  return valueLabel(connectedStatusKey(record, status));
}
/** A connected status as the shared badge shows every status. */
export function ConnectedStatus({ record, status }: { record: ConnectedStatusRecord; status: string }) {
  return <StatusBadge status={connectedStatusKey(record, status)} />;
}
