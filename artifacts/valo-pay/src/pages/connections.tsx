import { useEffect, useRef, useState } from "react";
import { ShieldCheck, LockKeyhole, Link2 } from "lucide-react";
import {
  ConnectedFrame,
  ConnectedPanel,
  ConnectedStatus,
  ConnectedRecovery,
  ConnectedState,
} from "@/components/connected-frame";
import { Button } from "@/components/ui/button";
import { EvidenceDisclosure } from "@/components/evidence-disclosure";
import { Loading } from "@/components/loading";
import { LoadProblem } from "@/components/load-problem";
import { useConnected } from "@/lib/connected";
import { formatDate, formatNumber } from "@/lib/formatters";
import { useFormDraft } from "@/lib/unsaved-changes";
import { useWorkspace } from "@/lib/workspace-context";
const TITLE = "Permissions & readiness",
  DESCRIPTION =
    "Know what each connection may do, who authorised it, and when that permission ends.";
export default function ConnectionsPage() {
  const api = useConnected(),
    { merchantId } = useWorkspace();
  return <ConnectionsContent key={merchantId} api={api} />;
}
function ConnectionsContent({ api }: { api: ReturnType<typeof useConnected> }) {
  const [purpose, setPurpose] = useState("account_read"),
    [subject, setSubject] = useState(""),
    [days, setDays] = useState("30"),
    [reason, setReason] = useState(""),
    [failure, setFailure] = useState(""),
    [success, setSuccess] = useState(""),
    [revoke, setRevoke] = useState("");
  const revokeTrigger = useRef<HTMLButtonElement | null>(null);
  // A grant or revocation typed but not saved is a draft: leaving asks first.
  const draft = useFormDraft({ purpose, subject, days, reason });
  useEffect(() => {
    if (revoke) document.getElementById("permission-reason")?.focus();
  }, [revoke]);
  const sme = [
    "merchant_account_read",
    "erp_draft",
    "payroll_prepare",
  ].includes(purpose);
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
          ? "Sample permission recorded."
          : "Permission revoked. New dependent work is blocked; historical evidence is retained.",
      );
      setRevoke("");
      setReason("");
      draft.saved();
    } catch (e) {
      setFailure((e as Error).message);
    }
  };
  if (api.isLoading) return <Loading what="permissions" heading />;
  if (!api.data)
    return (
      <ConnectedState title={TITLE} description={DESCRIPTION}>
        <LoadProblem
          what="permissions"
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
      ? "Sample SME · separate legal entity"
      : data.customers.find((c) => c.id === id)?.name || "Unknown subject";
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
          <span>Authority model</span>
          <strong className="!text-xl">Purpose by purpose</strong>
        </div>
        <div className="connected-metric">
          <span>Live bank connections</span>
          <strong>0</strong>
        </div>
      </div>
      <p className="connected-note">
        <ShieldCheck size={16} className="inline mr-2" aria-hidden="true" />
        This is a permission simulator. A permission here cannot connect a real
        account or authorise a live payment. Account reading, credit assessment,
        accounting and payroll each need separate authority.
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
          title={revoke ? "Revoke permission" : "Create a sample permission"}
          description={
            revoke
              ? "Revocation stops new dependent work. In-flight receipts can still be reconciled."
              : "Choose one purpose and one subject. No bank credentials are collected."
          }
        >
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
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
                aria-label="Permission to revoke"
              >
                <p className="font-semibold text-foreground">
                  {selectedPermission.name}
                </p>
                <p>{subjectName(selectedPermission.data.subjectId)}</p>
                <p>Expires {formatDate(selectedPermission.data.expiresAt ?? '')}</p>
                <p className="mt-2">
                  Only this permission will end. Other purposes stay unchanged.
                  New work depending on it will stop; existing evidence will
                  remain.
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
                  <label htmlFor="permission-subject">Subject</label>
                  <select
                    id="permission-subject"
                    value={sme ? "sme" : subject}
                    onChange={(e) => setSubject(e.target.value)}
                    required
                  >
                    {!sme && <option value="">Choose an applicant</option>}
                    {sme ? (
                      <option value="sme">
                        Sample SME · separate legal entity
                      </option>
                    ) : (
                      data.customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))
                    )}
                  </select>
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
                Reason for {revoke ? "revoking" : "granting"} permission
              </label>
              <textarea
                id="permission-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={8}
                maxLength={500}
                required
                rows={3}
                placeholder="Describe the sample workflow you are reviewing"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={
                  api.pending ||
                  (revoke ? !canRevoke || !selectedPermission : !canGrant)
                }
                type="submit"
              >
                {api.pending
                  ? "Saving…"
                  : revoke
                    ? "Revoke permission"
                    : "Grant sample permission"}
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
                    revokeTrigger.current?.focus();
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Your role: {data.role}. Admin or Operations can grant permissions.
              Admin, Operations or Compliance reviewer can revoke them.
            </p>
          </form>
        </ConnectedPanel>
        <ConnectedPanel
          title="Permission register"
          description="Expiry and revocation are enforced on the server, even when this page stays open."
        >
          {data.consents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No permissions yet. Grant a sample permission to explore the
              connected workflows.
            </p>
          ) : (
            data.consents
              .slice()
              .reverse()
              .map((c) => (
                <article className="connected-record" key={c.id}>
                  <div className="flex justify-between gap-3">
                    <h3>{c.name}</h3>
                    <ConnectedStatus status={c.effectiveStatus || c.status} />
                  </div>
                  <p className="mt-2">
                    {c.data.subjectId === "sme"
                      ? "Sample SME"
                      : data.customers.find((x) => x.id === c.data.subjectId)
                          ?.name || "Payment customer"}{" "}
                    ·{" "}
                    {c.data.authority === "simulated"
                      ? "Simulated authority"
                      : "Sample permission"}
                  </p>
                  <p>Expires {formatDate(c.data.expiresAt ?? '')}</p>
                  <p>Granted by {c.data.grantedBy}</p>
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
                      }}
                    >
                      Review revocation
                    </Button>
                  )}
                </article>
              ))
          )}
        </ConnectedPanel>
      </div>
      <ConnectedPanel
        title="Connection roadmap"
        description="These capabilities require verification outside the sandbox. A checklist or sample permission does not enable them."
      >
        <div className="connected-subgrid">
          <div className="connected-record">
            <h3>
              <Link2 size={16} className="inline mr-2" aria-hidden="true" />
              Paystack
            </h3>
            <p>
              Preferred first payment provider. Test credentials and route
              verification are still needed. Bank payment initiation and
              corporate payouts are separate capabilities.
            </p>
          </div>
          <div className="connected-record">
            <h3>Xero Accounting</h3>
            <p>
              First accounting target. Cash Desk prepares sample drafts and
              review files. No accounting connection or write is enabled.
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
              <div className="mt-3"><EvidenceDisclosure title={`Required evidence for ${g.name}`}>
                <p>{g.requires}</p>
              </EvidenceDisclosure></div>
            </div>
          ))}
        </div>
      </ConnectedPanel>
    </ConnectedFrame>
  );
}
