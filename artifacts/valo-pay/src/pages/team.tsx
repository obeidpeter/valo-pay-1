import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useWorkspace } from "@/lib/workspace-context";
import { useTypedPilotMutation, usePilotQuery } from "@/lib/pilot";
import { invitationCreatedSchema, messageSchema, staffChangeResultSchema, staffLenderAccessSchema, staffDirectorySchema, type StaffDirectory } from "@workspace/valopay-schema";
import {
  PilotError,
  PilotHeading,
  PilotPanel,
  RecoveryNotice,
  pilotField,
} from "@/components/pilot-ui";
import { StaffSession } from "@/components/staff-session";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { focusLost, focusMain, useDialogFocusReturn, useFocusWhenLost } from "@/lib/focus";
import { formatCount, formatDate } from "@/lib/formatters";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import { AccessReadiness } from '@/components/access-readiness';

type DirectoryMember = StaffDirectory['members'][number];
type DirectoryLenders = StaffDirectory['lenders'];
type ChangeMutation = ReturnType<typeof useTypedPilotMutation<typeof staffChangeResultSchema>>;
type GrantMutation = ReturnType<typeof useTypedPilotMutation<typeof staffLenderAccessSchema>>;
type MessageMutation = ReturnType<typeof useTypedPilotMutation<typeof messageSchema>>;

const roles = [
  "Admin",
  "Operations",
  "Finance",
  "Compliance reviewer",
  "Read-only",
];
export default function TeamPage() {
  const { workspace } = useWorkspace(),
    query = usePilotQuery("/team", staffDirectorySchema, false);
  const [email, setEmail] = useState(""),
    [role, setRole] = useState("Operations"),
    [link, setLink] = useState(""),
    [message, setMessage] = useState("");
  const invite = useTypedPilotMutation(invitationCreatedSchema, (result) => {
    setLink(
      `${window.location.origin}${import.meta.env.BASE_URL}team-invite#${result.token}`,
    );
    setMessage(result.message);
    setEmail("");
  });
  const revoke = useTypedPilotMutation(messageSchema, (result) => setMessage(result.message));
  const [decision, setDecision] = useState("");
  const decide = useTypedPilotMutation(messageSchema, (result) => setDecision(result.message));
  // A decision clears the last one's message as it starts, so the next takes focus even when worded the same.
  const choose = (path: string) => { setDecision(""); decide.mutate({ path, lender: false }); };
  // Operations does not record team changes: while one is unanswered, leaving or reloading would lose the only check.
  useUnsavedChanges([invite, revoke, decide].some((mutation) => mutation.isPending || mutation.hasUnconfirmedOutcome));
  // Revoking an invitation removes its button, and creating one holds its button disabled until the answer, so focus
  // then goes to what happened rather than to the page.
  const said = useRef<HTMLParagraphElement>(null);
  useFocusWhenLost(said, message);
  // The directory as the shared schema read it: every list present, lenders included.
  const directory = query.data;
  const admin = directory?.mode === "staff" && workspace?.role === "Admin";
  return (
    <div className="space-y-6">
      <PilotHeading title="Team & access">
        Give each person an accountable role. Staff invitations, role changes
        and revocations are recorded separately from financial approvals.
      </PilotHeading>
      <PilotError
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
      <PilotPanel title="Access status">
        <p className="text-sm">
          {directory?.message || "Checking this environment…"}
        </p>
        {directory?.mode === "staff" ? (
          <StaffSession />
        ) : (
          <p className="text-sm text-muted-foreground">
            This environment uses demo personas. Pilot staff mode requires a
            configured organisation, an administrator provisioned by the
            operator, and MFA. Sample records remain synthetic in either mode.
          </p>
        )}
      </PilotPanel>
      {directory?.mode === "staff" && (
        <>
          {workspace?.role !== "Admin" && !workspace?.merchants.length && <PilotPanel title="Waiting for lender access"><p className="text-sm text-muted-foreground">Your staff account is active. An administrator must assign the lenders you may work on before their records appear here.</p></PilotPanel>}
          <PilotPanel title="Staff members">
            <p className="text-sm text-muted-foreground">Administrators manage every lender in this workspace. Other roles need explicit lender access. New invitations and role changes start with no lender grants.</p>
            <div className="space-y-3">
              {directory.members.map((member) => (
                <Member
                  key={member.id}
                  member={member}
                  editable={admin && member.actor !== workspace?.actor}
                  shared={!admin && member.actor !== workspace?.actor}
                  lenders={directory.lenders}
                />
              ))}
            </div>
          </PilotPanel>
          {admin && (
            <Approvals directory={directory} actor={workspace?.actor} decide={decide} choose={choose} message={decision} />
          )}
          {admin && (
            <PilotPanel title="Invite a team member">
              <p className="text-sm text-muted-foreground">
                First add the person to this organisation in your identity
                service. Their Valo Pay invitation requires the same verified
                email and both authentication factors. Invitations last seven
                days; accepted pilot membership lasts 90 days.
                After acceptance, assign the lenders a non-administrator may access.
                An Admin, Finance or Compliance reviewer invitation can be accepted
                only after another administrator approves it.
              </p>
              <form
                className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]"
                onSubmit={(e) => {
                  e.preventDefault();
                  setLink("");
                  setMessage("");
                  invite.mutate({
                    path: "/team/invitations",
                    lender: false,
                    data: { email, role },
                  });
                }}
              >
                <label className="space-y-1 text-sm font-medium">
                  Verified email
                  <input
                    className={pilotField}
                    type="email"
                    required
                    maxLength={254}
                    disabled={invite.isPending || invite.hasUnconfirmedOutcome}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label className="space-y-1 text-sm font-medium">
                  Role
                  <select
                    className={pilotField}
                    disabled={invite.isPending || invite.hasUnconfirmedOutcome}
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  >
                    {roles.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <Button
                  type="submit"
                  disabled={invite.hasUnconfirmedOutcome}
                  busy={invite.isPending}
                >
                  Create invitation
                </Button>
              </form>
              <RecoveryNotice mutation={invite} persistent={false} />
              {link && (
                <label className="block space-y-2 text-sm">
                  Share this invitation directly
                  <input
                    readOnly
                    className={pilotField}
                    value={link}
                    onFocus={(e) => e.target.select()}
                  />
                </label>
              )}
              <p ref={said} role="status" className="text-sm">
                {message}
              </p>
              <div className="space-y-3">
                {directory.invitations.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"
                  >
                    <span>
                      {item.email} · {item.role}
                      <small className="mt-1 block text-muted-foreground">
                        {item.status}{item.status === "pending" && item.approval === "awaiting" ? " · waiting for a second administrator" : item.approval === "approved" ? ` · approved by ${item.approvedBy}` : ""} · expires {formatDate(item.expiresAt)}
                      </small>
                    </span>
                    {item.status === "pending" && (
                      <Button
                        variant="outline"
                        disabled={revoke.hasUnconfirmedOutcome}
                        busy={revoke.isPending}
                        onClick={() => {
                          setMessage("");
                          revoke.mutate({
                            path: `/team/invitations/${item.id}/revoke`,
                            lender: false,
                          });
                        }}
                      >
                        Revoke invitation
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              <RecoveryNotice mutation={revoke} persistent={false} />
            </PilotPanel>
          )}
          {admin && (
            <PilotPanel title="Access history">
              <ol className="space-y-3 text-sm">
                {directory.events.map((event) => (
                  <li key={event.id} className="border-b pb-3">
                    <strong>{event.action.replaceAll(".", " ")}</strong>
                    <p className="text-xs text-muted-foreground">
                      {event.actor} · {formatDate(event.createdAt)}
                    </p>
                    {typeof event.detail.reason === "string" && event.detail.reason && (
                      <p className="mt-1">{event.detail.reason}</p>
                    )}
                  </li>
                ))}
              </ol>
            </PilotPanel>
          )}
        </>
      )}
      <AccessReadiness />
      <Link
        href="/pilot"
        className="inline-block text-sm text-primary underline"
      >
        Return to the pilot journey
      </Link>
    </div>
  );
}
/**
 * A member's card lasts as long as the membership, and its forms start again from each version of it (updatedAt),
 * so after any change they show the membership as it now stands. What a change made here did, or a change whose
 * outcome is unconfirmed, stays on the card rather than going with the form the new version replaced.
 */
function Member({ member, editable, shared, lenders }: { member: DirectoryMember; editable: boolean; shared: boolean; lenders: DirectoryLenders }) {
  const change = useTypedPilotMutation(staffChangeResultSchema), grant = useTypedPilotMutation(staffLenderAccessSchema);
  useUnsavedChanges([change, grant].some((mutation) => mutation.isPending || mutation.hasUnconfirmedOutcome));
  // The button that made a change goes with that form, so focus then goes to what the change did; and a change the
  // service refused, or whose answer was lost, sends it to the problem notice that says so, as does lender access,
  // whose form waits disabled for the answer.
  const changed = useRef<HTMLParagraphElement>(null), granted = useRef<HTMLParagraphElement>(null), problem = useRef<HTMLDivElement>(null), grantProblem = useRef<HTMLDivElement>(null);
  // A watch lasts until the focus reaches its message, which it does not when the answer finds the person on another
  // control. So only the card's latest request is watched, until the focus is found outside the card: what one request
  // said never takes the focus from a later one, on this card or elsewhere on the page.
  const card = useRef<HTMLElement>(null), granting = grant.submittedAt > change.submittedAt;
  useFocusWhenLost(changed, granting ? undefined : change.data, card);
  useFocusWhenLost(problem, granting ? undefined : change.error, card);
  useFocusWhenLost(granted, granting ? grant.data : undefined, card);
  useFocusWhenLost(grantProblem, granting ? grant.error : undefined, card);
  const count = member.lenderIds?.length || 0;
  return (
    <article ref={card} className="space-y-3 rounded-lg border p-4">
      <div>
        <h3 className="text-sm font-semibold">{member.name}</h3>
        <p className="text-xs text-muted-foreground">
          {member.role} · {member.status}
          {member.expiresAt ? ` · expires ${formatDate(member.expiresAt)}` : ""}
        </p>
      </div>
      {/* Someone who is not an administrator is sent only the lenders they share with a colleague, so that is what a colleague's row counts. */}
      <p className="text-sm text-muted-foreground">{member.role === "Admin" ? "All lenders in this workspace" : shared ? formatCount(count, "lender you share", "lenders you share") : formatCount(count, "permitted lender")}</p>
      {editable && <AccessForm key={`access:${member.updatedAt}`} member={member} mutation={change} answer={() => changed.current ?? problem.current} />}
      <RecoveryNotice mutation={change} persistent={false} noticeRef={problem} />
      {change.data?.message && <p ref={changed} role="status" className="text-sm">{change.data.message}</p>}
      {editable && member.role !== "Admin" && member.status === "active" && <LenderGrants key={`lenders:${member.updatedAt}`} member={member} lenders={lenders} mutation={grant} />}
      <RecoveryNotice mutation={grant} persistent={false} noticeRef={grantProblem} />
      {grant.isSuccess && <p ref={granted} role="status" className="text-sm">Lender access saved.</p>}
    </article>
  );
}

/**
 * A membership's role and access as one version of it stands, and the change sent against that version. `answer` is
 * where the member's card says what a change did or why it did not happen.
 */
function AccessForm({ member, mutation, answer }: { member: DirectoryMember; mutation: ChangeMutation; answer: () => HTMLElement | null }) {
  const [role, setRole] = useState<string>(member.role),
    [status, setStatus] = useState<string>(member.status),
    [reason, setReason] = useState(""),
    // Revoking cannot be undone here, so it takes one more step after its reason; other changes save at once.
    [confirming, setConfirming] = useState(false);
  const restoreFocus = useDialogFocusReturn(confirming), revoking = useRef(false);
  const save = () =>
    mutation.mutate({
      path: `/team/members/${member.id}`,
      method: "PATCH",
      lender: false,
      data: {
        role,
        status,
        reason,
        expectedUpdatedAt: member.updatedAt,
      },
    });
  return (
    <>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (status === "revoked" && member.status !== "revoked") setConfirming(true);
          else save();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            Role for {member.name}
            <select
              className={pilotField}
              disabled={mutation.isPending || mutation.hasUnconfirmedOutcome}
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              {roles.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            Access for {member.name}
            <select
              className={pilotField}
              disabled={mutation.isPending || mutation.hasUnconfirmedOutcome}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {["active", "suspended", "revoked"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="block space-y-1 text-sm">
          Reason for changing {member.name}
          <input
            className={pilotField}
            required
            minLength={3}
            maxLength={500}
            disabled={mutation.isPending || mutation.hasUnconfirmedOutcome}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <Button
          variant={status === "revoked" ? "destructive" : "outline"}
          type="submit"
          disabled={mutation.hasUnconfirmedOutcome}
          busy={mutation.isPending}
        >
          Save access change
        </Button>
      </form>
      <Dialog open={confirming} onOpenChange={(open) => { if (!open) setConfirming(false); }}>
        {/* Revoke access sends the change, whose new version replaces this form and its button: focus goes to what the card
            says of it if that is already there, and otherwise waits on the page's main region for it, which then takes it. */}
        <DialogContent onCloseAutoFocus={(event) => {
          if (!revoking.current) return restoreFocus(event);
          revoking.current = false; event.preventDefault();
          if (!focusLost()) return;
          const said = answer();
          if (!said?.isConnected) return focusMain();
          if (!said.hasAttribute("tabindex")) said.tabIndex = -1;
          said.focus();
        }}>
          <DialogHeader>
            <DialogTitle>Revoke {member.name}’s access?</DialogTitle>
            <DialogDescription>
              {member.name} loses access to this workspace and to every lender in it at their next request. Their lender access and any invitation still waiting for them are removed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>A revoked person regains access only by accepting a new invitation.</p>
            <p>Reason recorded in the access history: {reason}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>Keep access</Button>
            <Button variant="destructive" onClick={() => { revoking.current = true; setConfirming(false); save(); }}>Revoke access</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * What waits for a second administrator: Admin, Finance and Compliance reviewer invitations and role changes. The
 * administrator who asked cannot approve (the service refuses it too), but may withdraw a change; the person a change
 * is for neither approves nor declines it (refused too).
 */
function Approvals({ directory, actor, decide, choose, message }: { directory: StaffDirectory; actor?: string; decide: MessageMutation; choose: (path: string) => void; message: string }) {
  const invitations = directory.invitations.filter((item) => item.status === "pending" && item.approval === "awaiting");
  const busy = decide.isPending || decide.hasUnconfirmedOutcome;
  // A decision removes its item, and its button with it, so focus then goes to what the decision did.
  const decided = useRef<HTMLParagraphElement>(null);
  useFocusWhenLost(decided, message);
  return (
    <PilotPanel title="Waiting for a second administrator">
      <p className="text-sm text-muted-foreground">
        An invitation or role change that grants Admin, Finance or Compliance reviewer takes effect only when an
        administrator other than the one who asked approves it. A pilot with one administrator asks the operator to
        add a second with the provisioning command.
      </p>
      {!invitations.length && !directory.changes.length ? <p className="text-sm">Nothing is waiting for approval.</p> : (
        <ul className="space-y-3">
          {invitations.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
              <span>Invitation: {item.email} as {item.role}<small className="mt-1 block text-muted-foreground">Sent by {item.invitedBy} · expires {formatDate(item.expiresAt)}</small></span>
              {item.invitedBy === actor ? <span className="text-xs text-muted-foreground">You sent it: another administrator approves it.</span> : (
                <Button variant="outline" disabled={busy} onClick={() => choose(`/team/invitations/${item.id}/approve`)}>Approve invitation</Button>
              )}
            </li>
          ))}
          {directory.changes.map((change) => (
            <li key={change.id} className="space-y-2 rounded-lg border p-3 text-sm">
              <p>{change.name}: {change.from.role} ({change.from.status}) to {change.to.role} ({change.to.status})</p>
              <p className="text-xs text-muted-foreground">Asked by {change.requestedBy} · {formatDate(change.requestedAt)} · {change.reason}</p>
              <div className="flex flex-wrap gap-2">
                {directory.members.some((member) => member.id === change.memberId && member.actor === actor) ? <span className="self-center text-xs text-muted-foreground">A change to your own membership: another administrator approves or declines it.</span> : <>
                  {change.requestedBy === actor ? <span className="self-center text-xs text-muted-foreground">You asked for it: another administrator approves it.</span> : (
                    <Button variant="outline" disabled={busy} onClick={() => choose(`/team/changes/${change.id}/approve`)}>Approve change</Button>
                  )}
                  <Button variant="ghost" disabled={busy} onClick={() => choose(`/team/changes/${change.id}/decline`)}>{change.requestedBy === actor ? "Withdraw request" : "Decline change"}</Button>
                </>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <RecoveryNotice mutation={decide} persistent={false} />
      {message && <p ref={decided} role="status" className="text-sm">{message}</p>}
    </PilotPanel>
  );
}

/** A member's lenders as one version of the membership stands; what a save did stays on the member's card. */
function LenderGrants({ member, lenders, mutation }: { member: DirectoryMember; lenders: DirectoryLenders; mutation: GrantMutation }) {
  const [selected, setSelected] = useState<string[]>(member.lenderIds || []), [reason, setReason] = useState("");
  const busy = mutation.isPending || mutation.hasUnconfirmedOutcome;
  // A saved change's reason is spent, even before the new version renews this form.
  useEffect(() => { if (mutation.data) setReason(""); }, [mutation.data]);
  return <form className="space-y-3 border-t pt-4" onSubmit={event => { event.preventDefault(); mutation.mutate({ path: `/team/members/${member.id}/lenders`, lender: false, method: "PATCH", data: { expectedUpdatedAt: member.updatedAt, lenderIds: selected, reason } }); }}>
    <fieldset disabled={busy} className="space-y-2"><legend className="mb-2 text-sm font-semibold">Lenders available to {member.name}</legend>{lenders.length ? lenders.map(lender => <label key={lender.id} className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={selected.includes(lender.id)} onChange={event => setSelected(current => event.target.checked ? [...current, lender.id] : current.filter(id => id !== lender.id))} />{lender.name}</label>) : <p className="text-sm text-muted-foreground">Create a lender from the pilot journey before assigning access.</p>}
      <label className="block space-y-1 text-sm">Reason for lender access change for {member.name}<textarea className={pilotField} required minLength={10} maxLength={1000} rows={2} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <p className="text-xs text-muted-foreground">Clearing every selection removes lender access. Saved sessions are checked again on the next request.</p>
      <Button type="submit" variant="outline" busy={mutation.isPending}>Save lender access</Button>
    </fieldset>
  </form>;
}
