import { useEffect, useRef, useState } from "react";
import { ShieldCheck, LockKeyhole, Link2 } from "lucide-react";
import {
  ConnectedFrame,
  ConnectedPanel,
  ConnectedStatus,
  ConnectedRecovery,
  ConnectedState,
  FieldHint,
  describedBy,
  tooShort,
} from "@/components/connected-frame";
import { FieldError, fieldMessageId } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { EvidenceDisclosure } from "@/components/evidence-disclosure";
import { Loading } from "@/components/loading";
import { LoadProblem } from "@/components/load-problem";
import { useConnected } from "@/lib/connected";
import { formatDate, formatNumber } from "@/lib/formatters";
import { useFormDraft } from "@/lib/unsaved-changes";
import { useWorkspace } from "@/lib/workspace-context";
const TITLE = "Permissions and readiness",
  DESCRIPTION =
    "A permission covers one customer, or the sample business, until it expires or is withdrawn.";
/** Cash Desk's made-up business, which the business permissions cover. */
const SAMPLE_BUSINESS = "Sample business (separate from the lender)";
export default function ConnectionsPage() {
  const api = useConnected(),
    { merchantId } = useWorkspace();
  return <ConnectionsContent key={merchantId} api={api} />;
}
function ConnectionsContent({ api }: { api: ReturnType<typeof useConnected> }) {
  const { workspace } = useWorkspace();
  const [purpose, setPurpose] = useState("account_read"),
    [subject, setSubject] = useState(""),
    [days, setDays] = useState("30"),
    [reason, setReason] = useState(""),
    [failure, setFailure] = useState(""),
    [success, setSuccess] = useState(""),
    [revoke, setRevoke] = useState(""),
    [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const revokeTrigger = useRef<HTMLButtonElement | null>(null);
  // A grant or withdrawal typed but not saved is a draft: leaving asks first.
  const draft = useFormDraft({ purpose, subject, days, reason });
  useEffect(() => {
    if (revoke) document.getElementById("permission-reason")?.focus();
  }, [revoke]);
  const sme = [
    "merchant_account_read",
    "erp_draft",
    "payroll_prepare",
  ].includes(purpose);
  const corrected = (id: string) =>
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  const execute = async (
    action: string,
    data: Record<string, unknown>,
    id?: string,
  ) => {
    setFailure("");
    setSuccess("");
    draft.sending(
      action === "consent.grant" ? { purpose, subject, days, reason: "" } : null,
    );
    try {
      await api.run(action, data, id, reason);
      setSuccess(
        action === "consent.grant"
          ? "Sample permission granted. The pages that need it can use it now."
          : "Permission withdrawn. New work that needs it is now blocked. Records made earlier are kept.",
      );
      setRevoke("");
      setReason("");
      draft.saved();
    } catch (e) {
      setFailure((e as Error).message);
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
  const data = api.data;
  const canGrant = api.canWrite && ["Admin", "Operations"].includes(data.role);
  const canRevoke =
    api.canWrite &&
    ["Admin", "Operations", "Compliance reviewer"].includes(data.role);
  const selectedPermission = data.consents.find((c) => c.id === revoke);
  const subjectName = (id: string | undefined) =>
    id === "sme"
      ? SAMPLE_BUSINESS
      : data.customers.find((c) => c.id === id)?.name || "Unknown customer";
  const expiry = (expiresAt: string | undefined) =>
    expiresAt ? `Expires ${formatDate(expiresAt)}` : "No expiry recorded.";
  return (
    <ConnectedFrame
      title={TITLE}
      description={DESCRIPTION}
      recovery={api}
      onRecovered={() => {
        setFailure("");
        setRevoke("");
        setReason("");
        draft.saved();
      }}
      onReleased={() => setFailure("")}
    >
      <div className="connected-metrics">
        <div className="connected-metric">
          <span>Active sample permissions</span>
          <strong>
            {formatNumber(
              data.consents.filter((c) => c.effectiveStatus === "active").length,
            )}
          </strong>
        </div>
        <div className="connected-metric">
          <span>Each permission covers</span>
          <strong className="!text-xl">One purpose</strong>
        </div>
        <div className="connected-metric">
          <span>Live bank connections</span>
          <strong>0</strong>
        </div>
      </div>
      <p className="connected-note">
        <ShieldCheck size={16} className="inline mr-2" aria-hidden="true" />
        This page simulates permissions. A permission here cannot connect a
        real account or take a payment. Permission to read an account is not
        permission to take money from it.
      </p>
      {failure && !api.hasUnconfirmedOutcome && (
        <p role="alert" className="connected-error">
          {failure}
        </p>
      )}
      {success && (
        <p role="status" className="connected-note">
          {success}
        </p>
      )}
      <div className="connected-grid">
        <ConnectedPanel
          title={revoke ? "Withdraw a permission" : "Grant a permission"}
          description={
            revoke
              ? "Withdrawing stops new work that needs this permission. Payments already in progress can still be recorded."
              : "Choose what the permission is for and who it covers. No bank passwords or other credentials are collected."
          }
        >
          <form
            className="space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const errors: Record<string, string> = {};
              if (!revoke && !sme && !subject)
                errors["permission-subject"] = "Choose who the permission covers.";
              const short = tooShort(reason, "a reason", 8);
              if (short) errors["permission-reason"] = short;
              setFieldErrors(errors);
              const first = Object.keys(errors)[0];
              if (first) {
                document.getElementById(first)?.focus();
                return;
              }
              void execute(
                revoke ? "consent.revoke" : "consent.grant",
                revoke
                  ? {}
                  : {
                      purpose,
                      subjectId: sme ? "sme" : subject,
                      days: Number(days),
                    },
                revoke || undefined,
              );
            }}
          >
            {selectedPermission && (
              <div
                className="connected-note"
                role="region"
                aria-label="Permission to withdraw"
              >
                <p className="font-semibold text-foreground">
                  {selectedPermission.name}
                </p>
                <p>{subjectName(selectedPermission.data.subjectId)}</p>
                <p>{expiry(selectedPermission.data.expiresAt)}</p>
                <p className="mt-2">
                  Only this permission ends. Other purposes stay unchanged. New
                  work that needs it stops, and earlier records are kept.
                </p>
              </div>
            )}
            {!revoke && (
              <>
                <div>
                  <label htmlFor="permission-purpose">Purpose</label>
                  <select
                    id="permission-purpose"
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                  >
                    {data.purposes.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="permission-subject">Who it covers</label>
                  <select
                    id="permission-subject"
                    value={sme ? "sme" : subject}
                    onChange={(e) => {
                      setSubject(e.target.value);
                      corrected("permission-subject");
                    }}
                    aria-invalid={fieldErrors["permission-subject"] ? true : undefined}
                    aria-describedby={
                      fieldErrors["permission-subject"]
                        ? fieldMessageId("permission-subject")
                        : undefined
                    }
                    required
                  >
                    {!sme && <option value="">Choose a customer</option>}
                    {sme ? (
                      <option value="sme">{SAMPLE_BUSINESS}</option>
                    ) : (
                      data.customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))
                    )}
                  </select>
                  <FieldError
                    id="permission-subject"
                    message={fieldErrors["permission-subject"]}
                  />
                </div>
                <div>
                  <label htmlFor="permission-days">Valid for</label>
                  <select
                    id="permission-days"
                    value={days}
                    onChange={(e) => setDays(e.target.value)}
                  >
                    <option value="7">7 days</option>
                    <option value="30">30 days</option>
                    <option value="90">90 days</option>
                  </select>
                </div>
              </>
            )}
            <div>
              <label htmlFor="permission-reason">
                Reason for {revoke ? "withdrawing" : "granting"} permission
              </label>
              <textarea
                id="permission-reason"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  corrected("permission-reason");
                }}
                maxLength={500}
                required
                rows={3}
                placeholder={
                  revoke
                    ? "Why is this permission being withdrawn?"
                    : "Why is this permission needed?"
                }
                aria-invalid={fieldErrors["permission-reason"] ? true : undefined}
                aria-describedby={describedBy(
                  "permission-reason",
                  fieldErrors["permission-reason"],
                )}
              />
              <FieldHint id="permission-reason-help" minLength={8} />
              <FieldError
                id="permission-reason"
                message={fieldErrors["permission-reason"]}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={revoke ? !canRevoke || !selectedPermission : !canGrant}
                busy={api.pending}
                busyLabel={revoke ? "Withdrawing…" : "Granting…"}
                type="submit"
              >
                {revoke ? "Withdraw permission" : "Grant permission"}
              </Button>
              {revoke && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={api.pending}
                  onClick={() => {
                    setRevoke("");
                    setReason("");
                    setFailure("");
                    setFieldErrors({});
                    revokeTrigger.current?.focus();
                  }}
                >
                  Keep permission
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Admin or Operations can grant a permission. Admin, Operations or
              Compliance reviewer can withdraw one. Your role is {data.role}.
              {(!canGrant || !canRevoke) && workspace?.accessMode !== "staff"
                ? " Change your demo role in Settings."
                : ""}
            </p>
          </form>
        </ConnectedPanel>
        <ConnectedPanel
          title="All permissions"
          description="A permission stops working when it expires or is withdrawn, even if this page is still open."
        >
          {data.consents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No permissions yet. Select Grant permission to add the first one.
            </p>
          ) : (
            data.consents
              .slice()
              .reverse()
              .map((c) => (
                <article className="connected-record" key={c.id}>
                  <div className="flex justify-between gap-3">
                    <h3>{c.name}</h3>
                    <ConnectedStatus record="permission" status={c.effectiveStatus || c.status} />
                  </div>
                  <p className="mt-2">
                    {c.data.subjectId === "sme"
                      ? "Sample business"
                      : data.customers.find((x) => x.id === c.data.subjectId)
                          ?.name || "Unknown customer"}{" "}
                    ·{" "}
                    {c.data.authority === "simulated"
                      ? "Simulated permission"
                      : "Sample permission"}
                  </p>
                  <p>{expiry(c.data.expiresAt)}</p>
                  <p>
                    {c.data.grantedBy
                      ? `Granted by ${c.data.grantedBy}`
                      : "Granted by: Not recorded"}
                  </p>
                  {c.effectiveStatus === "active" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-3"
                      disabled={api.pending || !canRevoke}
                      onClick={(event) => {
                        revokeTrigger.current = event.currentTarget;
                        setRevoke(c.id);
                        setReason("");
                        setFailure("");
                        setSuccess("");
                        setFieldErrors({});
                      }}
                    >
                      Withdraw
                    </Button>
                  )}
                </article>
              ))
          )}
        </ConnectedPanel>
      </div>
      <ConnectedPanel
        title="Readiness for live use"
        description="Each of these needs checks outside the sandbox before it can be switched on. A sample permission does not switch it on."
      >
        <div className="connected-subgrid">
          <div className="connected-record">
            <h3>
              <Link2 size={16} className="inline mr-2" aria-hidden="true" />
              Paystack
            </h3>
            <p>
              Valo Pay’s planned first payment provider. It is not connected
              yet: a test key and a successful connection check are still needed.
              Starting bank payments and paying out to businesses would each
              need separate approval.
            </p>
          </div>
          <div className="connected-record">
            <h3>Xero</h3>
            <p>
              The first accounting software Valo Pay plans to connect. Cash Desk
              prepares sample drafts and export files only. Nothing is sent to
              Xero.
            </p>
          </div>
        </div>
        <div className="connected-subgrid">
          {data.gates.map((g) => (
            <div key={g.id} className="connected-record">
              <h3>
                <LockKeyhole
                  size={14}
                  className="inline mr-2"
                  aria-hidden="true"
                />
                {g.name}
              </h3>
              <p className="mt-2 font-medium">Not enabled for live use</p>
              <div className="mt-3"><EvidenceDisclosure title={`Needed before ${g.name} can go live`}>
                <p>{g.requires}</p>
              </EvidenceDisclosure></div>
            </div>
          ))}
        </div>
      </ConnectedPanel>
    </ConnectedFrame>
  );
}
