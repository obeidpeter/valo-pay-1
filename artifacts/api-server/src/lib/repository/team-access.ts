/** Internal repository team-access. Import through valopay-store; external access is rejected by the boundary check. */
import { pool, type PoolClient } from "@workspace/db";
import {
  approvalRoles,
  grantNeedsApproval,
  invitationAcceptedSchema,
  sameJson,
} from "@workspace/valopay-schema";
import { randomBytes, randomUUID } from "node:crypto";
import type { StaffLenderAccessInput } from "@workspace/valopay-schema";
import { validateLenderAccessChange } from "../staff-lender-access";
import type { Request } from "express";
import { staffMode, verifyStaff } from "../staff-access";
import { getAuth, clerkClient } from "@clerk/express";
import type { VerifiedClerkSession } from "../pilot-access";
import {
  beginStatement,
  checkOut,
  databaseLimits,
  failedTransaction,
} from "../database-limits";
import {
  bindRuntimeIdentity,
  clearRuntimeInviteeGrants,
  runtimeIsolationEnabled,
} from "../runtime-isolation";
import { contractAnswer } from "../contract";
import { markRolledBack } from "../transaction-outcome";
import type { DomainState } from "../../domain/types";
import { requestFingerprint } from "../digests";
import { seedMerchant } from "../valopay-seed";
import type { StaffRow, StoreContext, Session, MerchantRow } from "./types";
type Dependencies = Pick<
  typeof import("./core"),
  | "sessionFor"
  | "roles"
  | "fail"
  | "listMerchants"
  | "digest"
  | "rowsAffected"
  | "lockWorkspace"
  | "SANDBOX_LENDER_LIMIT"
  | "loadState"
  | "appendAudit"
  | "saveState"
>;

/** A membership change that grants one of `approvalRoles`, waiting for a second administrator: its request in the access history. */
export type ChangeRequestRow = {
  id: string;
  actor: string;
  subject: string;
  detail: {
    before: { role: string; status: string };
    after: { role: string; status: string };
    reason: string;
    version: string;
  };
  created_at: Date;
  name: string;
  member_version: Date;
};

/** What an operator command did: its outcome, the workspace and administrator, and the expiry, in plain words too. */
export type OperatorProvisioning = {
  outcome: "provisioned" | "added" | "renewed" | "unchanged";
  workspaceId: string;
  userId: string;
  status: string;
  expiresAt: string;
  previousExpiresAt?: string;
  message: string;
};

export type OperatorMember = StaffRow & { current: boolean };

export function createTeamAccessRepository(dependencies: Dependencies) {
  const {
    sessionFor,
    roles,
    listMerchants,
    digest,
    rowsAffected,
    lockWorkspace,
    SANDBOX_LENDER_LIMIT,
    loadState,
    appendAudit,
    saveState,
  } = dependencies;
  const fail: (message: string, status?: number) => never = dependencies.fail;

  const staffProvision = (row: StaffRow, organizationId: string) => ({
    id: row.id,
    userId: row.user_id,
    organizationId,
    tenantId: row.workspace_id,
    role: row.role,
    status: row.status,
    validFrom: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  });
  const staffView = (row: StaffRow) => ({
    id: row.id,
    actor: `Clerk:${row.user_id}`,
    name: row.display_name,
    role: row.role,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
  async function caseAssignees(ctx: StoreContext) {
    const session = sessionFor(ctx);
    // A demo persona is named as its changes are recorded (the context's actor), so the lists and the history agree.
    if (ctx.accessMode !== "staff")
      return roles
        .filter((role) => role !== "Read-only")
        .map((role) => ({
          actor: `Sandbox ${role}`,
          name: `Sandbox ${role}`,
          role,
        }));
    if (!session.lockedMerchantId)
      fail("Select a lender before looking up available assignees.", 409);
    // The same three fields as a demo role: who, their name and their role; the membership's other details stay in the team directory.
    return (
      await session.client.query<StaffRow>(
        `SELECT member.* FROM valopay_staff_memberships member
    WHERE member.workspace_id=$1 AND member.status='active' AND member.expires_at>$2 AND member.role<>'Read-only'
      AND (member.role='Admin' OR EXISTS (SELECT 1 FROM valopay_staff_lender_access grant_row WHERE grant_row.membership_id=member.id AND grant_row.merchant_id=$3))
    ORDER BY member.display_name,member.id`,
        [session.workspace.id, ctx.now, session.lockedMerchantId],
      )
    ).rows.map((row) => {
      const { actor, name, role } = staffView(row);
      return { actor, name, role };
    });
  }
  const changeView = (row: ChangeRequestRow) => ({
    id: row.id,
    memberId: row.subject,
    name: row.name,
    from: row.detail.before,
    to: row.detail.after,
    reason: row.detail.reason,
    requestedBy: row.actor,
    requestedAt: row.created_at.toISOString(),
  });
  /** Change requests nobody has approved or declined, with the membership they change as it stands now, newest first. */
  const changeRequestsSql = `SELECT request.id,request.actor,request.subject,request.detail,request.created_at,member.display_name AS name,member.updated_at AS member_version
  FROM valopay_staff_events request JOIN valopay_staff_memberships member ON member.id=request.subject AND member.workspace_id=request.workspace_id
  WHERE request.workspace_id=$1 AND request.action='staff.change_requested' AND ($2::text IS NULL OR request.id=$2) AND ($3::text IS NULL OR request.subject=$3)
    AND NOT EXISTS (SELECT 1 FROM valopay_staff_events decision WHERE decision.workspace_id=request.workspace_id AND decision.action IN ('staff.change_approved','staff.change_declined') AND decision.detail->>'requestId'=request.id)
  ORDER BY request.created_at DESC,request.id DESC LIMIT 200`;
  /** A request is current while the membership is still the version it was made against; any later change leaves it out of date. */
  const currentRequest = (row: ChangeRequestRow) =>
    row.member_version.toISOString() === row.detail.version;
  /** The administrator who approved a pending invitation, never the one who sent it; undefined while it waits. */
  async function invitationApprover(
    client: PoolClient,
    workspaceId: string,
    invitation: { id: string; invited_by: string },
  ): Promise<string | undefined> {
    return (
      await client.query<{ actor: string }>(
        "SELECT actor FROM valopay_staff_events WHERE workspace_id=$1 AND subject=$2 AND action='staff.invitation_approved' AND actor<>$3 ORDER BY created_at,id LIMIT 1",
        [workspaceId, invitation.id, invitation.invited_by],
      )
    ).rows[0]?.actor;
  }
  const needsApproval = (role: string) =>
    (approvalRoles as readonly string[]).includes(role);
  /** What a person refused as their own approver is told: the rule, and how a pilot with one administrator gets a second. */
  const secondAdministrator = (what: string, who: string) =>
    `A different administrator must approve this ${what}: the administrator who ${who} cannot approve it. A pilot with one administrator asks the operator to add a second with the provisioning command's --add-administrator mode.`;
  async function staffDirectory(ctx: StoreContext) {
    const session = sessionFor(ctx);
    if (ctx.accessMode !== "staff")
      return {
        mode: "sandbox",
        actor: ctx.actor,
        members: [],
        lenders: [],
        invitations: [],
        changes: [],
        events: [],
        message:
          "Real staff access is not enabled on this host. Demo roles are for practice only.",
      };
    const memberRows = (
      await session.client.query<StaffRow>(
        "SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 ORDER BY display_name,id",
        [session.workspace.id],
      )
    ).rows;
    const grants = (
      await session.client.query<{
        membership_id: string;
        merchant_id: string;
      }>(
        `SELECT grant_row.membership_id,grant_row.merchant_id FROM valopay_staff_lender_access grant_row JOIN valopay_staff_memberships member ON member.id=grant_row.membership_id JOIN valopay_merchants lender ON lender.id=grant_row.merchant_id WHERE member.workspace_id=$1 AND lender.workspace_id=$1 ORDER BY grant_row.merchant_id`,
        [session.workspace.id],
      )
    ).rows;
    const lendersOf = (id: string) =>
      grants
        .filter((grant) => grant.membership_id === id)
        .map((grant) => grant.merchant_id);
    const admin = ctx.role === "Admin",
      own = memberRows.find((row) => row.user_id === session.userId),
      shared = new Set(own ? lendersOf(own.id) : []);
    // An administrator sees everyone. Anyone else sees the colleagues who can open one of their lenders (an administrator opens
    // every lender), only the lenders they share, and no one's expiry but their own.
    const colleague = (row: StaffRow) =>
      row.status === "active" &&
      row.expires_at.getTime() > Date.parse(ctx.now) &&
      (row.role === "Admin"
        ? shared.size > 0
        : lendersOf(row.id).some((id) => shared.has(id)));
    const members = memberRows
      .filter((row) => admin || row.id === own?.id || colleague(row))
      .map((row) => {
        const whole = admin || row.id === own?.id;
        return {
          ...staffView(row),
          expiresAt: whole ? row.expires_at.toISOString() : null,
          lenderIds:
            row.role === "Admin"
              ? []
              : lendersOf(row.id).filter((id) => whole || shared.has(id)),
          allLenders: row.role === "Admin",
        };
      });
    if (!admin)
      return {
        mode: "staff",
        actor: ctx.actor,
        members,
        lenders: [],
        invitations: [],
        changes: [],
        events: [],
        message:
          "Verified staff access. Membership, lender access and MFA are checked for every request. You see the colleagues who work on your lenders. Financial records remain synthetic.",
      };
    const lenders = await listMerchants(ctx);
    // Timestamps as the ISO text the answer carries, as every other view writes them.
    const invitations = (
      await session.client.query<{
        id: string;
        email: string;
        role: string;
        status: string;
        expiresAt: Date;
        invitedBy: string;
        approvedBy: string | null;
      }>(
        `SELECT invitation.id,invitation.email,invitation.role,invitation.status,invitation.expires_at AS "expiresAt",invitation.invited_by AS "invitedBy",
    (SELECT approval.actor FROM valopay_staff_events approval WHERE approval.workspace_id=invitation.workspace_id AND approval.subject=invitation.id AND approval.action='staff.invitation_approved' AND approval.actor<>invitation.invited_by ORDER BY approval.created_at,approval.id LIMIT 1) AS "approvedBy"
    FROM valopay_staff_invitations invitation WHERE invitation.workspace_id=$1 ORDER BY invitation.created_at DESC LIMIT 100`,
        [session.workspace.id],
      )
    ).rows.map((row) => ({
      ...row,
      expiresAt: row.expiresAt.toISOString(),
      approval: !needsApproval(row.role)
        ? "not_required"
        : row.approvedBy
          ? "approved"
          : "awaiting",
    }));
    const changes = (
      await session.client.query<ChangeRequestRow>(changeRequestsSql, [
        session.workspace.id,
        null,
        null,
      ])
    ).rows
      .filter(currentRequest)
      .slice(0, 100)
      .map(changeView);
    const events = (
      await session.client.query<{
        id: string;
        actor: string;
        action: string;
        subject: string;
        detail: unknown;
        createdAt: Date;
      }>(
        'SELECT id,actor,action,subject,detail,created_at AS "createdAt" FROM valopay_staff_events WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',
        [session.workspace.id],
      )
    ).rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    return {
      mode: "staff",
      actor: ctx.actor,
      members,
      lenders,
      invitations,
      changes,
      events,
      message:
        "Verified staff access. Membership, lender access and MFA are checked for every request. Financial records remain synthetic.",
    };
  }
  function viewerScope(ctx: StoreContext) {
    const session = sessionFor(ctx);
    return digest(
      `viewer:${session.workspace.id}:${session.owner || session.principal}`,
    );
  }
  function teamAdmin(ctx: StoreContext) {
    const session = sessionFor(ctx);
    if (
      ctx.accessMode !== "staff" ||
      ctx.role !== "Admin" ||
      session.access !== "team"
    )
      fail("A verified pilot administrator with recent MFA is required.", 403);
    return session;
  }
  async function staffEvent(
    client: PoolClient,
    workspaceId: string,
    actor: string,
    action: string,
    subject: string,
    detail: unknown,
  ): Promise<{ id: string; createdAt: Date }> {
    return (
      await client.query<{ id: string; createdAt: Date }>(
        'INSERT INTO valopay_staff_events(id,workspace_id,actor,action,subject,detail) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,created_at AS "createdAt"',
        [randomUUID(), workspaceId, actor, action, subject, detail],
      )
    ).rows[0]!;
  }
  async function inviteStaff(ctx: StoreContext, email: string, role: string) {
    const session = teamAdmin(ctx);
    const token = randomBytes(32).toString("hex"),
      id = randomUUID(),
      approval = needsApproval(role)
        ? ("awaiting" as const)
        : ("not_required" as const);
    await session.client.query(
      "UPDATE valopay_staff_invitations SET status='revoked' WHERE workspace_id=$1 AND email=$2 AND status='pending'",
      [session.workspace.id, email],
    );
    await session.client.query(
      `INSERT INTO valopay_staff_invitations(id,workspace_id,email,role,token_hash,invited_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        session.workspace.id,
        email,
        role,
        digest(token),
        ctx.actor,
        new Date(Date.parse(ctx.now) + 7 * 86400000),
      ],
    );
    await staffEvent(
      session.client,
      session.workspace.id,
      ctx.actor,
      "staff.invited",
      id,
      { email, role, ...(approval === "awaiting" ? { approval } : {}) },
    );
    if (approval === "not_required")
      return {
        id,
        token,
        approval,
        message:
          "Invitation created. Share the link directly with this person; no email has been sent. It expires in seven days.",
      };
    const administrators = Number(
      (
        await session.client.query<{ count: string }>(
          "SELECT count(*) FROM valopay_staff_memberships WHERE workspace_id=$1 AND role='Admin' AND status='active' AND expires_at>$2",
          [session.workspace.id, ctx.now],
        )
      ).rows[0]!.count,
    );
    return {
      id,
      token,
      approval,
      message: `Invitation created. It waits for a second administrator's approval before it can be accepted: an Admin, Finance or Compliance reviewer grant needs two administrators, and the one who sent it cannot approve it.${administrators < 2 ? " This pilot has one active administrator: ask the operator to add a second with the provisioning command's --add-administrator mode." : ""} Share the link directly; no email has been sent. It expires in seven days.`,
    };
  }
  /** A second administrator's approval of an invitation to Admin, Finance or Compliance reviewer, recorded in the access history; the invitee can accept it afterwards. */
  async function approveInvitation(ctx: StoreContext, id: string) {
    const session = teamAdmin(ctx);
    const invitation = (
      await session.client.query<{
        id: string;
        email: string;
        role: string;
        invited_by: string;
        status: string;
        expires_at: Date;
      }>(
        "SELECT id,email,role,invited_by,status,expires_at FROM valopay_staff_invitations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [session.workspace.id, id],
      )
    ).rows[0];
    if (!invitation) fail("Invitation not found.", 404);
    if (
      invitation.status !== "pending" ||
      invitation.expires_at.getTime() <= Date.parse(ctx.now)
    )
      fail("This invitation is no longer pending.", 409);
    if (!needsApproval(invitation.role))
      fail(
        "This invitation needs no approval: only Admin, Finance and Compliance reviewer invitations do.",
        409,
      );
    if (invitation.invited_by === ctx.actor)
      fail(secondAdministrator("invitation", "sent it"), 403);
    if (
      await invitationApprover(session.client, session.workspace.id, invitation)
    )
      fail("This invitation is already approved.", 409);
    await staffEvent(
      session.client,
      session.workspace.id,
      ctx.actor,
      "staff.invitation_approved",
      id,
      {
        email: invitation.email,
        role: invitation.role,
        invitedBy: invitation.invited_by,
      },
    );
    return {
      message: `Invitation approved: ${invitation.email} can now accept it as ${invitation.role}.`,
    };
  }
  /** Applies a membership change, clearing lender grants on a role change or revocation and pending invitations on a suspension or revocation, with its event. */
  async function applyStaffChange(
    session: Session,
    ctx: StoreContext,
    row: StaffRow,
    after: { role: string; status: string },
    action: string,
    detail: Record<string, unknown>,
  ) {
    const result = await session.client.query<StaffRow>(
      `UPDATE valopay_staff_memberships SET role=$3,status=$4,updated_at=greatest(now(),updated_at+interval '1 millisecond') WHERE workspace_id=$1 AND id=$2 RETURNING *`,
      [session.workspace.id, row.id, after.role, after.status],
    );
    if (after.status === "revoked" || after.role !== row.role)
      await session.client.query(
        "DELETE FROM valopay_staff_lender_access WHERE membership_id=$1",
        [row.id],
      );
    // Suspension and revocation withdraw the person's pending invitations: an
    // invitation sent earlier must not hand the access straight back.
    const invitationsRevoked =
      after.status === "active"
        ? 0
        : (
            await session.client.query(
              "UPDATE valopay_staff_invitations SET status='revoked' WHERE workspace_id=$1 AND lower(email)=lower($2) AND status='pending'",
              [session.workspace.id, row.display_name],
            )
          ).rowCount || 0;
    await staffEvent(
      session.client,
      session.workspace.id,
      ctx.actor,
      action,
      row.id,
      {
        before: { role: row.role, status: row.status },
        after,
        ...detail,
        ...(invitationsRevoked ? { invitationsRevoked } : {}),
      },
    );
    return result.rows[0]!;
  }
  async function updateStaff(
    ctx: StoreContext,
    id: string,
    input: {
      role: string;
      status: string;
      expectedUpdatedAt: string;
      reason: string;
    },
  ) {
    const session = teamAdmin(ctx);
    const row = (
      await session.client.query<StaffRow>(
        "SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [session.workspace.id, id],
      )
    ).rows[0];
    if (!row) fail("Staff membership not found.", 404);
    if (row.user_id === session.userId)
      fail("Ask another administrator to change your membership.", 403);
    if (row.updated_at.toISOString() !== input.expectedUpdatedAt)
      fail(
        "This membership changed. Refresh the team and review it again.",
        409,
      );
    if (row.status === "revoked" && input.status !== "revoked")
      fail(
        "A revoked person must accept a new invitation before access is restored.",
        409,
      );
    const after = { role: input.role, status: input.status };
    if (grantNeedsApproval(row, after)) {
      // The grant waits for a second administrator: the request is recorded, and the membership stays as it is until one approves it.
      const waiting = (
        await session.client.query<ChangeRequestRow>(changeRequestsSql, [
          session.workspace.id,
          null,
          id,
        ])
      ).rows.find(
        (request) =>
          currentRequest(request) && sameJson(request.detail.after, after),
      );
      const pending = waiting
        ? changeView(waiting)
        : await (async () => {
            const request = await staffEvent(
              session.client,
              session.workspace.id,
              ctx.actor,
              "staff.change_requested",
              id,
              {
                before: { role: row.role, status: row.status },
                after,
                reason: input.reason,
                version: row.updated_at.toISOString(),
              },
            );
            return changeView({
              id: request.id,
              actor: ctx.actor,
              subject: id,
              detail: {
                before: { role: row.role, status: row.status },
                after,
                reason: input.reason,
                version: row.updated_at.toISOString(),
              },
              created_at: request.createdAt,
              name: row.display_name,
              member_version: row.updated_at,
            });
          })();
      return {
        ...staffView(row),
        message: `This change waits for a second administrator: an Admin, Finance or Compliance reviewer grant takes effect only when a different administrator approves it in Team & access. ${row.display_name} keeps their current access until then.`,
        pendingChange: pending,
      };
    }
    const updated = await applyStaffChange(
      session,
      ctx,
      row,
      after,
      "staff.changed",
      { reason: input.reason },
    );
    return {
      ...staffView(updated),
      message:
        "Access change saved. Existing sessions must pass it on their next request.",
      pendingChange: null,
    };
  }
  /** The request a second administrator approves or declines: current, not decided, in this workspace. */
  async function changeRequest(
    session: Session,
    requestId: string,
  ): Promise<ChangeRequestRow> {
    const found = (
      await session.client.query<ChangeRequestRow>(
        `SELECT request.id,request.actor,request.subject,request.detail,request.created_at,member.display_name AS name,member.updated_at AS member_version
    FROM valopay_staff_events request JOIN valopay_staff_memberships member ON member.id=request.subject AND member.workspace_id=request.workspace_id
    WHERE request.workspace_id=$1 AND request.id=$2 AND request.action='staff.change_requested'`,
        [session.workspace.id, requestId],
      )
    ).rows[0];
    if (!found) fail("Change request not found.", 404);
    if (
      !(
        await session.client.query(changeRequestsSql, [
          session.workspace.id,
          requestId,
          null,
        ])
      ).rows.length
    )
      fail("This change was already approved or declined.", 409);
    return found;
  }
  /** A second administrator's approval of a waiting change: the exact change requested, applied now and recorded with who asked and who approved. */
  async function approveStaffChange(ctx: StoreContext, requestId: string) {
    const session = teamAdmin(ctx);
    const request = await changeRequest(session, requestId);
    const row = (
      await session.client.query<StaffRow>(
        "SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [session.workspace.id, request.subject],
      )
    ).rows[0];
    if (!row) fail("Staff membership not found.", 404);
    if (row.updated_at.toISOString() !== request.detail.version)
      fail(
        "This membership changed after the change was requested. Review the membership and ask for the change again.",
        409,
      );
    if (request.actor === ctx.actor)
      fail(secondAdministrator("change", "asked for it"), 403);
    if (row.user_id === session.userId)
      fail(
        "Ask another administrator to approve a change to your own membership.",
        403,
      );
    const updated = await applyStaffChange(
      session,
      ctx,
      row,
      request.detail.after,
      "staff.change_approved",
      { reason: request.detail.reason, requestId, requestedBy: request.actor },
    );
    return {
      ...staffView(updated),
      message: `Change approved: ${row.display_name} is now ${updated.role} (${updated.status}). Existing sessions must pass it on their next request.`,
      pendingChange: null,
    };
  }
  /** Declines a waiting change (or withdraws it, for the administrator who asked), recorded in the access history; the membership is unchanged. Like an approval, never by the person it changes. */
  async function declineStaffChange(ctx: StoreContext, requestId: string) {
    const session = teamAdmin(ctx);
    const request = await changeRequest(session, requestId);
    // Declining a change to one's own membership would keep the access it takes away.
    const subject = (
      await session.client.query<{ user_id: string }>(
        "SELECT user_id FROM valopay_staff_memberships WHERE workspace_id=$1 AND id=$2",
        [session.workspace.id, request.subject],
      )
    ).rows[0];
    if (subject?.user_id === session.userId)
      fail(
        "Ask another administrator to decline a change to your own membership.",
        403,
      );
    await staffEvent(
      session.client,
      session.workspace.id,
      ctx.actor,
      "staff.change_declined",
      request.subject,
      {
        requestId,
        before: request.detail.before,
        after: request.detail.after,
        requestedBy: request.actor,
      },
    );
    return {
      message:
        request.actor === ctx.actor
          ? "Change request withdrawn. The membership is unchanged."
          : "Change request declined. The membership is unchanged.",
    };
  }
  /** The workspace's exclusive team lock serialises grant changes with every
   * read/write transaction, so removing a grant blocks later requests using an
   * already-issued session token after current authorised work completes. */
  async function updateStaffLenders(
    ctx: StoreContext,
    id: string,
    input: StaffLenderAccessInput,
  ) {
    const session = teamAdmin(ctx);
    const member = (
      await session.client.query<StaffRow>(
        "SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [session.workspace.id, id],
      )
    ).rows[0];
    if (!member) fail("Staff membership not found.", 404);
    const available = await listMerchants(ctx);
    const checked = validateLenderAccessChange(
      input,
      {
        userId: member.user_id,
        role: member.role,
        status: member.status,
        updatedAt: member.updated_at.toISOString(),
        expiresAt: member.expires_at.toISOString(),
      },
      session.userId || "",
      available.map((lender) => lender.id),
      ctx.now,
    );
    const before = (
      await session.client.query<{ merchant_id: string }>(
        "SELECT merchant_id FROM valopay_staff_lender_access WHERE membership_id=$1 ORDER BY merchant_id",
        [id],
      )
    ).rows.map((row) => row.merchant_id);
    await session.client.query(
      "DELETE FROM valopay_staff_lender_access WHERE membership_id=$1",
      [id],
    );
    for (const merchantId of checked.lenderIds)
      await session.client.query(
        "INSERT INTO valopay_staff_lender_access(membership_id,merchant_id,granted_by,granted_at) VALUES($1,$2,$3,$4)",
        [id, merchantId, ctx.actor, ctx.now],
      );
    const updated = (
      await session.client.query<StaffRow>(
        `UPDATE valopay_staff_memberships SET updated_at=greatest(now(),updated_at+interval '1 millisecond') WHERE id=$1 AND workspace_id=$2 RETURNING *`,
        [id, session.workspace.id],
      )
    ).rows[0]!;
    await staffEvent(
      session.client,
      session.workspace.id,
      ctx.actor,
      "staff.lender_access_changed",
      id,
      { before, after: [...checked.lenderIds].sort(), reason: checked.reason },
    );
    return {
      ...staffView(updated),
      lenderIds: checked.lenderIds,
      allLenders: false,
      message:
        "Lender access saved. Existing sessions must pass these permissions on their next request.",
    };
  }
  async function revokeInvitation(ctx: StoreContext, id: string) {
    const session = teamAdmin(ctx);
    const result = await session.client.query(
      "UPDATE valopay_staff_invitations SET status='revoked' WHERE workspace_id=$1 AND id=$2 AND status='pending'",
      [session.workspace.id, id],
    );
    if (!rowsAffected(result))
      fail("This invitation is no longer pending.", 409);
    await staffEvent(
      session.client,
      session.workspace.id,
      ctx.actor,
      "staff.invitation_revoked",
      id,
      {},
    );
    return { message: "Invitation revoked." };
  }

  /** Acceptance has no existing membership. Clerk supplies the verified email;
   * the browser supplies only the invitation token, never an email or role. */
  async function acceptStaffInvitation(req: Request, token: string) {
    if (!staffMode()) fail("Staff access is not enabled on this host.", 403);
    const auth = getAuth(req) as unknown as VerifiedClerkSession;
    const now = new Date().toISOString();
    verifyStaff(
      auth,
      {
        id: "invitation-check",
        userId: auth.userId || "",
        organizationId: auth.orgId || "",
        tenantId: "invitation-check",
        role: "Read-only",
        status: "active",
        validFrom: "2020-01-01T00:00:00.000Z",
        expiresAt: "2100-01-01T00:00:00.000Z",
      },
      true,
      now,
    );
    const user = await clerkClient.users.getUser(auth.userId!);
    const emails = user.emailAddresses
      .filter((address) => address.verification?.status === "verified")
      .map((address) => address.emailAddress.toLowerCase());
    return acceptVerifiedInvitation(auth, token, emails);
  }
  async function acceptVerifiedInvitation(
    auth: VerifiedClerkSession,
    token: string,
    verifiedEmails: string[],
  ) {
    const guard = await checkOut(() => pool.connect()),
      client = guard.client;
    let committing = false;
    try {
      await client.query(beginStatement(databaseLimits().request));
      await bindRuntimeIdentity(
        client,
        { organizationId: auth.orgId || "", userId: auth.userId || "" },
        { token, verifiedEmails },
      );
      // A membership change, like a team change: the workspace lock exclusively (waiting only for work already running), then its row.
      const found = (
        await client.query<{ workspace_id: string }>(
          "SELECT t.workspace_id FROM valopay_teams t WHERE t.organization_id=$1",
          [auth.orgId],
        )
      ).rows[0];
      if (!found)
        fail("Select the organisation named in your invitation.", 403);
      await lockWorkspace(client, found.workspace_id, "exclusive", true);
      const team = (
        await client.query<{ workspace_id: string }>(
          `SELECT t.workspace_id FROM valopay_teams t JOIN valopay_workspaces w ON w.id=t.workspace_id WHERE t.organization_id=$1 AND w.id=$2 FOR UPDATE OF w`,
          [auth.orgId, found.workspace_id],
        )
      ).rows[0];
      if (!team) fail("Select the organisation named in your invitation.", 403);
      const checkedAt = (
        await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")
      ).rows[0]!.now.toISOString();
      verifyStaff(
        auth,
        {
          id: "invitation-check",
          userId: auth.userId || "",
          organizationId: auth.orgId || "",
          tenantId: "invitation-check",
          role: "Read-only",
          status: "active",
          validFrom: "2020-01-01T00:00:00.000Z",
          expiresAt: "2100-01-01T00:00:00.000Z",
        },
        true,
        checkedAt,
      );
      const invite = (
        await client.query<{
          id: string;
          email: string;
          role: string;
          invited_by: string;
          created_at: Date;
        }>(
          `SELECT id,email,role,invited_by,created_at FROM valopay_staff_invitations WHERE workspace_id=$1 AND token_hash=$2 AND status='pending' AND expires_at>clock_timestamp() FOR UPDATE`,
          [team.workspace_id, digest(token)],
        )
      ).rows[0];
      if (!invite || !verifiedEmails.includes(invite.email))
        fail(
          "This invitation is expired, used, revoked or belongs to another verified email address.",
          403,
        );
      const existing = (
        await client.query<StaffRow>(
          "SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE",
          [team.workspace_id, auth.userId],
        )
      ).rows[0];
      if (
        existing?.status === "active" &&
        existing.expires_at > new Date(checkedAt)
      )
        fail(
          "You already have an active membership. Ask an administrator to change its role.",
          409,
        );
      if (existing && existing.status !== "active") {
        // Only an invitation an administrator sent after the suspension or
        // revocation restores access; an older one, sent to any of the person's
        // verified addresses, is refused.
        const withdrawnAt =
          (
            await client.query<{ at: Date | null }>(
              `SELECT max(created_at) AS at FROM valopay_staff_events WHERE workspace_id=$1 AND subject=$2 AND action='staff.changed' AND detail->'after'->>'status' IN ('suspended','revoked')`,
              [team.workspace_id, existing.id],
            )
          ).rows[0]?.at ?? existing.updated_at;
        if (invite.created_at <= withdrawnAt)
          fail(
            "This invitation was sent before your access was suspended or revoked, so it cannot restore it. Ask an administrator for a new invitation.",
            403,
          );
      }
      // An Admin, Finance or Compliance reviewer grant takes effect only once a second administrator approved the invitation.
      const approvedBy = needsApproval(invite.role)
        ? await invitationApprover(client, team.workspace_id, invite)
        : undefined;
      if (needsApproval(invite.role) && !approvedBy)
        fail(
          "This invitation is waiting for a second administrator's approval. Ask the administrator who sent it to have another administrator approve it in Team & access, then accept it again.",
          403,
        );
      if (existing) {
        if (runtimeIsolationEnabled()) await clearRuntimeInviteeGrants(client);
        else
          await client.query(
            "DELETE FROM valopay_staff_lender_access WHERE membership_id=$1",
            [existing.id],
          );
      }
      await client.query(
        `INSERT INTO valopay_staff_memberships(id,workspace_id,user_id,display_name,role,status,expires_at) VALUES($1,$2,$3,$4,$5,'active',now()+interval '90 days')
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET display_name=EXCLUDED.display_name,role=EXCLUDED.role,status='active',expires_at=EXCLUDED.expires_at,updated_at=greatest(now(),valopay_staff_memberships.updated_at+interval '1 millisecond')`,
        [
          randomUUID(),
          team.workspace_id,
          auth.userId,
          invite.email,
          invite.role,
        ],
      );
      await client.query(
        "UPDATE valopay_staff_invitations SET status='accepted' WHERE id=$1 AND workspace_id=$2",
        [invite.id, team.workspace_id],
      );
      await staffEvent(
        client,
        team.workspace_id,
        `Clerk:${auth.userId}`,
        "staff.accepted",
        invite.id,
        { role: invite.role, ...(approvedBy ? { approvedBy } : {}) },
      );
      // Checked before COMMIT: an answer that does not match its contract saves nothing.
      const accepted = contractAnswer(invitationAcceptedSchema, {
        message: "Invitation accepted. Your pilot membership lasts 90 days.",
        role: invite.role,
      });
      committing = true;
      await client.query("COMMIT");
      return accepted;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* the transaction is already closed */
      }
      const failed = failedTransaction(error, {
        committing,
        lost: guard.lost(),
        write: true,
      });
      // Before COMMIT was sent nothing was saved, and the answer may say so (as inWorkspace's do).
      if (failed === error && !committing) markRolledBack(error);
      throw failed;
    } finally {
      guard.release();
    }
  }

  /**
   * Operator-only (scripts/provision-pilot.ts); never called by an HTTP route.
   * An organisation's staff workspace and its administrators: the first
   * administrator with the workspace, another administrator, and renewal of an
   * administrator's 90 days. Each change is one transaction with its staff
   * event; running a command again never fails on a duplicate row, it says
   * where things stand.
   */
  const OPERATOR_ACTOR = "System · operator provisioning";
  /** The checks every operator command makes before it opens a connection. */
  function operatorCheck(
    organizationId: string,
    userId: string,
    name?: { value: string; label: string },
  ) {
    if (runtimeIsolationEnabled())
      fail(
        "Provision isolated staff workspaces through the separate migration-owner connection before starting the restricted runtime.",
        503,
      );
    if (
      !staffMode() ||
      !/^org_[A-Za-z0-9]+$/.test(organizationId) ||
      !/^user_[A-Za-z0-9]+$/.test(userId) ||
      (name && (!name.value.trim() || name.value.length > 100))
    )
      fail(
        `Provide a staging organisation${name ? `, administrator user ID and ${name.label}` : " and administrator user ID"}.`,
      );
  }
  /** One operator change in its own bounded transaction: committed, or rolled back and thrown. */
  async function operatorTransaction<T>(
    change: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const guard = await checkOut(() => pool.connect()),
      client = guard.client;
    let committing = false;
    try {
      await client.query(beginStatement(databaseLimits().request));
      const result = await change(client);
      committing = true;
      const committed = await client.query("COMMIT");
      if (committed.command !== "COMMIT")
        throw markRolledBack(
          new Error("The provisioning transaction was rolled back."),
        );
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* the transaction is already closed */
      }
      // A row another run wrote at the same moment: named in plain words, never with the key the database quotes.
      if ((error as { code?: unknown }).code === "23505")
        fail(
          "Another provisioning run changed this organisation at the same moment, and nothing was saved. Run the command again to see where it stands.",
          409,
        );
      throw failedTransaction(error, {
        committing,
        lost: guard.lost(),
        write: true,
      });
    } finally {
      guard.release();
    }
  }
  const memberFor = async (
    client: PoolClient,
    workspaceId: string,
    userId: string,
  ) =>
    (
      await client.query<OperatorMember>(
        "SELECT *, expires_at > clock_timestamp() AS current FROM valopay_staff_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE",
        [workspaceId, userId],
      )
    ).rows[0];
  const operatorAnswer = (
    outcome: OperatorProvisioning["outcome"],
    workspaceId: string,
    member: StaffRow,
    message: string,
    previous?: StaffRow,
  ): OperatorProvisioning => ({
    outcome,
    workspaceId,
    userId: member.user_id,
    status: member.status,
    expiresAt: member.expires_at.toISOString(),
    ...(previous
      ? { previousExpiresAt: previous.expires_at.toISOString() }
      : {}),
    message,
  });
  /** The organisation's workspace, locked as a team change locks it (exclusively, waiting only for work already running), or a 404. */
  async function lockedTeam(
    client: PoolClient,
    organizationId: string,
  ): Promise<string> {
    const missing = () =>
      fail(
        "This organisation has not been provisioned yet. Provision it with its first administrator.",
        404,
      );
    const found =
      (
        await client.query<{ workspace_id: string }>(
          "SELECT workspace_id FROM valopay_teams WHERE organization_id=$1",
          [organizationId],
        )
      ).rows[0] ?? missing();
    await lockWorkspace(client, found.workspace_id, "exclusive", true);
    const team =
      (
        await client.query<{ workspace_id: string }>(
          "SELECT t.workspace_id FROM valopay_teams t JOIN valopay_workspaces w ON w.id=t.workspace_id WHERE t.organization_id=$1 AND w.id=$2 FOR UPDATE OF w",
          [organizationId, found.workspace_id],
        )
      ).rows[0] ?? missing();
    return team.workspace_id;
  }

  /** The organisation's workspace with its first administrator for 90 days; for an organisation already provisioned with this administrator, nothing changes and the answer says where it stands. */
  async function provisionStaffWorkspace(
    organizationId: string,
    userId: string,
    name: string,
  ): Promise<OperatorProvisioning> {
    operatorCheck(organizationId, userId, {
      value: name,
      label: "workspace name",
    });
    const principal = digest(`staff-org:${organizationId}`);
    return operatorTransaction(async (client) => {
      // The lock a first visit takes for its principal: two runs for one organisation run one after the other.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [principal],
      );
      const existing = (
        await client.query<{ workspace_id: string }>(
          "SELECT workspace_id FROM valopay_teams WHERE organization_id=$1",
          [organizationId],
        )
      ).rows[0];
      if (existing) {
        const member = await memberFor(client, existing.workspace_id, userId);
        if (member?.role !== "Admin")
          fail(
            "This organisation is already provisioned, with another first administrator. Add this person with --add-administrator, or renew an administrator with --renew.",
            409,
          );
        const state =
          member.status !== "active"
            ? `this administrator's membership is ${member.status}`
            : member.current
              ? `this person is an administrator until ${member.expires_at.toISOString()}`
              : `this administrator's access ended on ${member.expires_at.toISOString()}; renew it with --renew`;
        return operatorAnswer(
          "unchanged",
          existing.workspace_id,
          member,
          `Already provisioned, so nothing changed: ${state}.`,
        );
      }
      const workspaceId = randomUUID();
      await client.query(
        "INSERT INTO valopay_workspaces(id,principal_hash,role) VALUES($1,$2,'Read-only')",
        [workspaceId, principal],
      );
      await client.query(
        "INSERT INTO valopay_teams(workspace_id,organization_id,name) VALUES($1,$2,$3)",
        [workspaceId, organizationId, name],
      );
      const member = (
        await client.query<StaffRow>(
          "INSERT INTO valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES($1,$2,$3,$4,'Admin',now()+interval '90 days') RETURNING *",
          [randomUUID(), workspaceId, userId, "Pilot administrator"],
        )
      ).rows[0]!;
      await staffEvent(
        client,
        workspaceId,
        OPERATOR_ACTOR,
        "staff.provisioned",
        userId,
        { organizationId },
      );
      return operatorAnswer(
        "provisioned",
        workspaceId,
        member,
        `Provisioned: the first administrator's access lasts until ${member.expires_at.toISOString()}. Add a second administrator with --add-administrator, and renew with --renew before access ends.`,
      );
    });
  }

  /** Another administrator for a provisioned organisation, for 90 days; for a person who is already an active administrator, nothing changes. A suspended or revoked membership is never restored this way. */
  async function addStaffAdministrator(
    organizationId: string,
    userId: string,
    displayName: string,
  ): Promise<OperatorProvisioning> {
    operatorCheck(organizationId, userId, {
      value: displayName,
      label: "display name",
    });
    return operatorTransaction(async (client) => {
      const workspaceId = await lockedTeam(client, organizationId);
      const member = await memberFor(client, workspaceId, userId);
      if (
        member?.role === "Admin" &&
        member.status === "active" &&
        member.current
      )
        return operatorAnswer(
          "unchanged",
          workspaceId,
          member,
          `Already an administrator until ${member.expires_at.toISOString()}, so nothing changed. Renew with --renew before then.`,
        );
      if (member?.role === "Admin" && member.status === "active")
        fail(
          `This administrator's access ended on ${member.expires_at.toISOString()}. Renew it with --renew.`,
          409,
        );
      if (member)
        fail(
          member.status === "active"
            ? `This person is already a ${member.role} member. An administrator changes their role in Team & access.`
            : `This person's membership is ${member.status}, and adding an administrator never restores it: an administrator invites them again.`,
          409,
        );
      const added = (
        await client.query<StaffRow>(
          "INSERT INTO valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES($1,$2,$3,$4,'Admin',now()+interval '90 days') RETURNING *",
          [randomUUID(), workspaceId, userId, displayName.trim()],
        )
      ).rows[0]!;
      await staffEvent(
        client,
        workspaceId,
        OPERATOR_ACTOR,
        "staff.administrator_added",
        added.id,
        { userId, organizationId },
      );
      return operatorAnswer(
        "added",
        workspaceId,
        added,
        `Added: this administrator's access lasts until ${added.expires_at.toISOString()}.`,
      );
    });
  }

  /** An administrator's access, active or already ended, extended to 90 days from now, with a staff event; a suspended or revoked membership, or another role's, is refused. */
  async function renewStaffAdministrator(
    organizationId: string,
    userId: string,
  ): Promise<OperatorProvisioning> {
    operatorCheck(organizationId, userId);
    return operatorTransaction(async (client) => {
      const workspaceId = await lockedTeam(client, organizationId);
      const member = await memberFor(client, workspaceId, userId);
      if (!member)
        fail(
          "This person has no membership in the organisation's workspace. Add them with --add-administrator.",
          404,
        );
      if (member.role !== "Admin")
        fail(
          `Renewal is for administrators, and this membership is ${member.role}. An administrator renews anyone else with a new invitation.`,
          409,
        );
      if (member.status !== "active")
        fail(
          `This administrator's membership is ${member.status}, and renewal never restores it: an administrator invites them again, or add another administrator with --add-administrator.`,
          409,
        );
      const renewed = (
        await client.query<StaffRow>(
          "UPDATE valopay_staff_memberships SET expires_at=greatest(expires_at,now()+interval '90 days'),updated_at=greatest(now(),updated_at+interval '1 millisecond') WHERE id=$1 AND workspace_id=$2 RETURNING *",
          [member.id, workspaceId],
        )
      ).rows[0]!;
      await staffEvent(
        client,
        workspaceId,
        OPERATOR_ACTOR,
        "staff.renewed",
        member.id,
        {
          userId,
          previousExpiresAt: member.expires_at.toISOString(),
          expiresAt: renewed.expires_at.toISOString(),
          ended: !member.current,
        },
      );
      return operatorAnswer(
        "renewed",
        workspaceId,
        renewed,
        `Renewed: this administrator's access ${member.current ? "now lasts" : "is restored and lasts"} until ${renewed.expires_at.toISOString()}.`,
        member,
      );
    });
  }

  /** A new synthetic lender, or, for a repeat of the same request (repeated), the lender its key created earlier. */
  async function createPilotLender(
    ctx: StoreContext,
    input: { name: string; segment: string },
    key: string,
  ): Promise<{ lender: DomainState["merchant"]; repeated: boolean }> {
    const session = sessionFor(ctx);
    if (ctx.role !== "Admin" || session.access !== "team")
      fail("An administrator must set up a lender.", 403);
    // Workspace lock and deterministic ID make a repeated onboarding request safe.
    const id = digest(
        `onboarding:${session.workspace.id}:${session.owner}:${key}`,
      ),
      fingerprint = requestFingerprint(input);
    const found = (
      await session.client.query<MerchantRow>(
        "SELECT id,info,settings FROM valopay_merchants WHERE workspace_id=$1 AND id=$2",
        [session.workspace.id, id],
      )
    ).rows[0];
    if (found) {
      if (found.settings.onboardingFingerprint !== fingerprint)
        fail("This setup request was already used for different details.", 409);
      return { lender: found.info, repeated: true };
    }
    // The journal does not record lender creation, so a creation whose answer was lost and is sent again after a reload
    // has a new key: a name already in the workspace, ignoring case and surrounding or repeated spaces, is refused
    // naming that lender, in every mode, rather than making a second one.
    const same = (
      await session.client.query<{ name: string }>(
        `SELECT info->>'name' AS name FROM valopay_merchants WHERE workspace_id=$1
    AND lower(btrim(regexp_replace(info->>'name','\\s+',' ','g')))=lower(btrim(regexp_replace($2,'\\s+',' ','g'))) ORDER BY id LIMIT 1`,
        [session.workspace.id, input.name],
      )
    ).rows[0];
    if (same)
      fail(
        `A lender named "${same.name}" already exists in this workspace. Select it in the lender list, or choose another name.`,
        409,
      );
    // 'team' access holds the workspace lock exclusively (lockWorkspace), so two creations at once are counted one after the other.
    if (ctx.accessMode !== "staff") {
      const held = (
        await session.client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM valopay_merchants WHERE workspace_id=$1",
          [session.workspace.id],
        )
      ).rows[0]!.count;
      if (held >= SANDBOX_LENDER_LIMIT)
        fail(
          `This sandbox already holds ${SANDBOX_LENDER_LIMIT} lenders, the most a sandbox can have. Continue with an existing lender; a staff workspace can hold more.`,
          409,
        );
    }
    const state = seedMerchant(id, true);
    state.records = [];
    Object.assign(state.merchant, {
      name: input.name,
      shortName: input.name,
      segment: input.segment,
      provider: "Paystack",
      mode: "observation",
      status: "onboarding",
      monthlyVolume: 0,
      killSwitch: true,
      preDataReady: false,
      preLiveReady: false,
    });
    Object.assign(state.settings, {
      onboardingFingerprint: fingerprint,
      scheduledCloseEnabled: false,
      anonymousWorkspace: !ctx.authenticated,
      nextCloseAt: null,
    });
    await session.client.query(
      "INSERT INTO valopay_merchants(id,workspace_id,info,settings) VALUES($1,$2,$3,$4)",
      [id, session.workspace.id, state.merchant, state.settings],
    );
    await loadState(ctx, id, "update");
    appendAudit(
      state,
      ctx,
      "lender.created",
      id,
      "Created an empty synthetic lender for pilot rehearsal.",
    );
    await saveState(ctx, state);
    return { lender: state.merchant, repeated: false };
  }
  return {
    staffProvision,
    caseAssignees,
    staffDirectory,
    viewerScope,
    teamAdmin,
    staffEvent,
    inviteStaff,
    approveInvitation,
    updateStaff,
    approveStaffChange,
    declineStaffChange,
    updateStaffLenders,
    revokeInvitation,
    acceptStaffInvitation,
    operatorTransaction,
    provisionStaffWorkspace,
    addStaffAdministrator,
    renewStaffAdministrator,
    createPilotLender,
  };
}
