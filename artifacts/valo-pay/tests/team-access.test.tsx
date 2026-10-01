// Team & access on a staff host, with the directory the API answers each viewer: what a colleague's row counts, and
// what an applied change or a decision leaves on the page and where focus goes once its button has gone (console
// review of 24 September, items 3 to 5).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StaffDirectory } from "@workspace/valopay-schema";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

type Member = StaffDirectory["members"][number];
type Lender = StaffDirectory["lenders"][number];
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const member = (id: string, actor: string, name: string, role: Member["role"], lenderIds: string[], expiresAt: string | null = at(60)): Member =>
  ({ id, actor, name, role, status: "active", expiresAt, updatedAt: at(-1), lenderIds: role === "Admin" ? [] : lenderIds, allLenders: role === "Admin" });
const directory = (actor: string, members: Member[], rest: Partial<StaffDirectory> = {}): StaffDirectory =>
  ({ mode: "staff", actor, members, lenders: [], invitations: [], changes: [], events: [], message: "Verified staff access.", ...rest });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
/** A membership as a change answers it: no lender fields, and an expiry. */
const answered = ({ lenderIds: _lenders, allLenders: _all, ...rest }: Member) => ({ ...rest, expiresAt: rest.expiresAt ?? at(60) });

/**
 * Serves the fake API as a staff host signed in as `viewer`. `team` answers the team routes (undefined passes a
 * request on) and is given the workspace's lenders.
 */
function staffHost(viewer: { actor: string; role: string }, team: (path: string, method: string, body: any, lenders: Lender[]) => unknown) {
  const send = globalThis.fetch;
  let lenders: Lender[] = [];
  globalThis.fetch = async (input, options) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    const path = new URL(url, "http://localhost").pathname, method = options?.method ?? "GET";
    if (path.startsWith("/api/v1/team") && path !== "/api/v1/team/readiness") {
      const answer = team(path.slice("/api/v1".length), method, options?.body ? JSON.parse(String(options.body)) : undefined, lenders);
      if (answer !== undefined) return json(answer);
    }
    const response = await send(input, options);
    if (path !== "/api/v1/workspace") return response;
    const workspace = await response.json();
    lenders = workspace.merchants;
    return json({ ...workspace, accessMode: "staff", actor: viewer.actor, role: viewer.role, authenticated: true });
  };
}
const card = (name: string) => screen.getByRole("heading", { name }).closest("article")!;

it("counts on a colleague's row the lenders the viewer shares with them, not their permitted lenders", async () => {
  const [first, second] = api.merchantIds as [string, string];
  // To someone who is not an administrator the API sends only the lenders they share with each colleague.
  staffHost({ actor: "Clerk:user_ops", role: "Operations" }, (path) => path === "/team" ? directory("Clerk:user_ops", [
    member("m-ops", "Clerk:user_ops", "Ope Adéyẹmí", "Operations", [first, second]),
    member("m-fin", "Clerk:user_fin", "Funmi Ọbi", "Finance", [first], null),
    member("m-comp", "Clerk:user_comp", "Chika Ifẹ", "Compliance reviewer", [first, second], null),
    member("m-admin", "Clerk:user_admin", "Ada Admin", "Admin", [], null),
  ]) : undefined);
  renderApp("/team");
  await screen.findByRole("heading", { name: "Funmi Ọbi" });
  expect(card("Funmi Ọbi").textContent).toContain("1 lender you share");
  expect(card("Chika Ifẹ").textContent).toContain("2 lenders you share");
  // The viewer's own row and an administrator's say what they may open.
  expect(card("Ope Adéyẹmí").textContent).toContain("Can work on 2 lenders");
  expect(card("Ada Admin").textContent).toContain("All lenders in this workspace");
  expect(screen.queryByText(/^Can work on 1 lender$/)).toBeNull();
});

it("names each access history event and each status in words, never by its code", async () => {
  staffHost({ actor: "Clerk:user_admin", role: "Admin" }, (path) => path === "/team" ? directory("Clerk:user_admin", [
    member("m-admin", "Clerk:user_admin", "Ada Admin", "Admin", []),
  ], {
    invitations: [{ id: "i-1", email: "finance@example.test", role: "Finance", status: "pending", expiresAt: at(7), invitedBy: "Clerk:user_admin", approval: "awaiting", approvedBy: null }],
    events: [
      { id: "e-1", actor: "Clerk:user_admin", action: "staff.invitation_approved", subject: "i-1", detail: {}, createdAt: at(-1) },
      { id: "e-2", actor: "Clerk:user_admin", action: "staff.lender_access_changed", subject: "m-admin", detail: { reason: "Covers the second lender" }, createdAt: at(-1) },
    ],
  }) : undefined);
  renderApp("/team");
  const history = (await screen.findByRole("heading", { name: "Access history" })).closest("section")!;
  expect(within(history).getByText("Invitation approved")).toBeTruthy();
  expect(within(history).getByText("Lender access changed")).toBeTruthy();
  expect(history.textContent).not.toMatch(/staff\.|invitation_approved|lender_access_changed/);
  expect(screen.getByText(/^finance@example\.test · Finance/).parentElement!.textContent).toContain("Pending · waiting for a second Admin");
});

it("counts every permitted lender on each row for an administrator, whose directory is whole", async () => {
  const [first, second] = api.merchantIds as [string, string];
  staffHost({ actor: "Clerk:user_admin", role: "Admin" }, (path, _method, _body, lenders) => path === "/team" ? directory("Clerk:user_admin", [
    member("m-admin", "Clerk:user_admin", "Ada Admin", "Admin", []),
    member("m-fin", "Clerk:user_fin", "Funmi Ọbi", "Finance", [first, second]),
    member("m-ops", "Clerk:user_ops", "Ope Adéyẹmí", "Operations", [second]),
  ], { lenders }) : undefined);
  renderApp("/team");
  await screen.findByRole("heading", { name: "Funmi Ọbi" });
  expect(card("Funmi Ọbi").textContent).toContain("Can work on 2 lenders");
  expect(card("Ope Adéyẹmí").textContent).toContain("Can work on 1 lender");
  expect(screen.queryByText(/you share/)).toBeNull();
});

/** An administrator's directory whose members, invitations and waiting changes change as the API would change them: every change to a membership is a new version. */
function liveTeam() {
  const [first] = api.merchantIds as [string];
  const state: Pick<StaffDirectory, "members" | "invitations" | "changes"> = {
    members: [member("m-admin", "Clerk:user_admin", "Ada Admin", "Admin", []), member("m-ops", "Clerk:user_ops", "Chidi Ops", "Operations", [first], at(80)), member("m-fin", "Clerk:user_fin", "Funmi Ọbi", "Finance", [first], at(80))],
    invitations: [{ id: "i-1", email: "finance.new@example.test", role: "Finance", status: "pending", expiresAt: at(6), invitedBy: "Clerk:user_other", approval: "awaiting", approvedBy: null }],
    changes: [
      { id: "c-1", memberId: "m-ops", name: "Chidi Ops", from: { role: "Operations", status: "active" }, to: { role: "Finance", status: "active" }, reason: "Needs to review closes", requestedBy: "Clerk:user_other", requestedAt: at(-0.1) },
      { id: "c-2", memberId: "m-fin", name: "Funmi Ọbi", from: { role: "Finance", status: "active" }, to: { role: "Admin", status: "active" }, reason: "Covers administration in August", requestedBy: "Clerk:user_other", requestedAt: at(-0.2) },
    ],
  };
  const version = (id: string, change: Partial<Member>) => {
    state.members = state.members.map((item) => item.id === id ? { ...item, ...change, updatedAt: new Date(Date.parse(item.updatedAt) + 1000).toISOString() } : item);
    return state.members.find((item) => item.id === id)!;
  };
  staffHost({ actor: "Clerk:user_admin", role: "Admin" }, (path, method, body, lenders) => {
    if (path === "/team" && method === "GET") return directory("Clerk:user_admin", state.members, { lenders, invitations: state.invitations, changes: state.changes });
    const edited = /^\/team\/members\/([^/]+)$/.exec(path);
    if (edited && method === "PATCH") {
      const saved = version(edited[1]!, { role: body.role, status: body.status, ...(body.status === "revoked" ? { lenderIds: [] } : {}) });
      return { ...answered(saved), message: body.status === "revoked" ? `${saved.name}’s access is revoked. Their lender access and pending invitations are removed.` : `${saved.name} is now ${saved.role} (${saved.status}).`, pendingChange: null };
    }
    const granted = /^\/team\/members\/([^/]+)\/lenders$/.exec(path);
    if (granted && method === "PATCH") return { ...answered(version(granted[1]!, { lenderIds: body.lenderIds })), lenderIds: body.lenderIds, allLenders: false, message: "Lender access saved. Existing sessions must pass these permissions on their next request." };
    if (path === "/team/invitations/i-1/approve") {
      state.invitations = state.invitations.map((item) => ({ ...item, approval: "approved", approvedBy: "Clerk:user_admin" }));
      return { message: "Invitation approved: finance.new@example.test can now accept it as Finance." };
    }
    if (path === "/team/invitations" && method === "POST") {
      state.invitations = [...state.invitations, { id: "i-2", email: body.email, role: body.role, status: "pending", expiresAt: at(7), invitedBy: "Clerk:user_admin", approval: "not_required", approvedBy: null }];
      return { id: "i-2", token: "a".repeat(64), approval: "not_required", message: "Invitation created. No email has been sent, so share the link with this person yourself. It expires in 7 days." };
    }
    const decided = /^\/team\/changes\/([^/]+)\/(approve|decline)$/.exec(path);
    if (decided) {
      const request = state.changes.find((item) => item.id === decided[1])!;
      state.changes = state.changes.filter((item) => item !== request);
      if (decided[2] === "decline") return { message: "Change request declined. Their access has not changed." };
      return { ...answered(version(request.memberId, request.to)), message: `Change approved: ${request.name} is now ${request.to.role} (${request.to.status}).`, pendingChange: null };
    }
    return undefined;
  });
  return state;
}

it("keeps what an applied suspension or revocation did once the directory shows the membership's new version", async () => {
  const user = userEvent.setup();
  liveTeam();
  renderApp("/team");
  await screen.findByRole("heading", { name: "Chidi Ops" });
  await user.selectOptions(within(card("Funmi Ọbi")).getByLabelText("Access for Funmi Ọbi"), "suspended");
  await user.type(within(card("Funmi Ọbi")).getByLabelText("Reason for changing Funmi Ọbi’s access"), "On leave until the audit ends");
  await user.click(within(card("Funmi Ọbi")).getByRole("button", { name: "Save access change" }));
  // The new version renews the card's form, which shows the membership as it now stands; its button goes with the old
  // form, so focus goes to what the change did.
  await waitFor(() => expect(within(card("Funmi Ọbi")).getByText(/^Finance · Suspended/)).toBeTruthy());
  expect((within(card("Funmi Ọbi")).getByLabelText("Reason for changing Funmi Ọbi’s access") as HTMLInputElement).value).toBe("");
  const suspended = within(card("Funmi Ọbi")).getByRole("status");
  expect(suspended.textContent).toBe("Funmi Ọbi is now Finance (suspended).");
  await waitFor(() => expect(document.activeElement).toBe(suspended));

  await user.selectOptions(within(card("Chidi Ops")).getByLabelText("Access for Chidi Ops"), "revoked");
  await user.type(within(card("Chidi Ops")).getByLabelText("Reason for changing Chidi Ops’s access"), "Left the pilot team this week");
  await user.click(within(card("Chidi Ops")).getByRole("button", { name: "Save access change" }));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke access" }));
  await waitFor(() => expect(within(card("Chidi Ops")).getByText(/^Operations · Revoked/)).toBeTruthy());
  expect(within(card("Chidi Ops")).getByRole("status").textContent).toBe("Chidi Ops’s access is revoked. Their lender access and pending invitations are removed.");
});

it("returns focus to the kept confirmation once Revoke access is confirmed and answered", async () => {
  // Second review of the audit fixes, the older focus patterns: confirming Revoke access left focus on the page's main region.
  const user = userEvent.setup();
  liveTeam();
  renderApp("/team");
  await screen.findByRole("heading", { name: "Chidi Ops" });
  await user.selectOptions(within(card("Chidi Ops")).getByLabelText("Access for Chidi Ops"), "revoked");
  await user.type(within(card("Chidi Ops")).getByLabelText("Reason for changing Chidi Ops’s access"), "Left the pilot team this week");
  within(card("Chidi Ops")).getByRole("button", { name: "Save access change" }).focus();
  await user.keyboard("{Enter}");
  within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke access" }).focus();
  await user.keyboard("{Enter}");
  const said = await within(card("Chidi Ops")).findByText("Chidi Ops’s access is revoked. Their lender access and pending invitations are removed.");
  await waitFor(() => expect(within(card("Chidi Ops")).getByText(/^Operations · Revoked/)).toBeTruthy());
  await waitFor(() => expect(document.activeElement).toBe(said));
});

// Third review of the audit fixes, finding 7: a revocation the service refused, or whose answer was lost, left focus on the
// page's main region while its problem notice sat unfocused in the member's card.
for (const how of ["refused", "lost"] as const) it(`moves focus to the member's problem notice when Revoke access is ${how}`, async () => {
  const user = userEvent.setup();
  liveTeam();
  const send = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    if (new URL(url, "http://localhost").pathname !== "/api/v1/team/members/m-ops" || options?.method !== "PATCH") return send(input, options);
    if (how === "lost") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify({ error: "This membership changed after you opened it. Refresh Team & access and review it before changing it again.", requestId: "fix59-409" }), { status: 409, headers: { "Content-Type": "application/json" } });
  };
  renderApp("/team");
  await screen.findByRole("heading", { name: "Chidi Ops" });
  await user.selectOptions(within(card("Chidi Ops")).getByLabelText("Access for Chidi Ops"), "revoked");
  await user.type(within(card("Chidi Ops")).getByLabelText("Reason for changing Chidi Ops’s access"), "Left the pilot team this week");
  within(card("Chidi Ops")).getByRole("button", { name: "Save access change" }).focus();
  await user.keyboard("{Enter}");
  within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke access" }).focus();
  await user.keyboard("{Enter}");
  // The notice itself; a lost answer's holds the service's words in an alert of their own.
  const notice = (await within(card("Chidi Ops")).findAllByRole("alert"))[0]!;
  expect(notice.textContent).toContain(how === "refused" ? "This membership changed after you opened it." : "Request not confirmed");
  await waitFor(() => expect(document.activeElement).toBe(notice));
});

// Fourth review of the audit fixes, finding 3: a refused or lost Save lender access still left focus on the page body, as
// its fieldset waits disabled, while its notice sat unfocused in the member's card.
for (const how of ["refused", "lost"] as const) it(`moves focus to the member's lender access notice when Save lender access is ${how}`, async () => {
  const user = userEvent.setup();
  liveTeam();
  const send = globalThis.fetch;
  let answer = () => { /* replaced by the gate's resolver */ };
  const gate = new Promise<void>((resolve) => { answer = resolve; });
  globalThis.fetch = async (input, options) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    if (new URL(url, "http://localhost").pathname !== "/api/v1/team/members/m-ops/lenders" || options?.method !== "PATCH") return send(input, options);
    await gate;
    if (how === "lost") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify({ error: "This membership changed after you opened it. Refresh Team & access and review it before changing it again.", requestId: "fix60-409" }), { status: 409, headers: { "Content-Type": "application/json" } });
  };
  renderApp("/team");
  await screen.findByRole("heading", { name: "Chidi Ops" });
  const form = within(within(card("Chidi Ops")).getByRole("group", { name: "Lenders available to Chidi Ops" }));
  await user.click(form.getAllByRole("checkbox").find((box) => !(box as HTMLInputElement).checked)!);
  await user.type(form.getByLabelText("Reason for changing Chidi Ops’s lenders"), "Needs the second lender for cover");
  const save = form.getByRole("button", { name: "Save lender access" }) as HTMLButtonElement;
  save.focus();
  await user.keyboard("{Enter}");
  // The form waits disabled for the answer. A browser then moves the focus from the button to the page body, where jsdom
  // leaves it on the button (and will not blur a disabled one): move it there as the browser does.
  await waitFor(() => expect(save.disabled).toBe(true));
  const stand = document.body.appendChild(document.createElement("span"));
  stand.tabIndex = -1;
  stand.focus();
  stand.remove();
  expect(document.activeElement).toBe(document.body);
  answer();
  const notice = (await within(card("Chidi Ops")).findAllByRole("alert"))[0]!;
  expect(notice.textContent).toContain(how === "refused" ? "This membership changed after you opened it." : "Request not confirmed");
  await waitFor(() => expect(document.activeElement).toBe(notice));
});

/**
 * Holds the team route's `method` request to `path` until the returned function answers it: `refused` with a 409, `lost`
 * with no answer at all, `applied` as the service does.
 */
function hold(method: "PATCH" | "POST", path: string) {
  const send = globalThis.fetch;
  let release: (how: "refused" | "lost" | "applied") => void = () => { /* replaced by the gate's resolver */ };
  const gate = new Promise<"refused" | "lost" | "applied">((resolve) => { release = resolve; });
  globalThis.fetch = async (input, options) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    if (new URL(url, "http://localhost").pathname !== `/api/v1${path}` || options?.method !== method) return send(input, options);
    const how = await gate;
    if (how === "lost") throw new TypeError("Failed to fetch");
    if (how === "refused") return new Response(JSON.stringify({ error: "This membership changed after you opened it. Refresh Team & access and review it before changing it again.", requestId: "fix60-409" }), { status: 409, headers: { "Content-Type": "application/json" } });
    return send(input, options);
  };
  return (how: "refused" | "lost" | "applied") => release(how);
}
/** Moves the focus to the page body, as a browser does from a button its form disables while it waits (jsdom leaves it there, and will not blur a disabled one). */
function dropFocus() {
  const stand = document.body.appendChild(document.createElement("span"));
  stand.tabIndex = -1;
  stand.focus();
  stand.remove();
  expect(document.activeElement).toBe(document.body);
}

// Review of the fourth review's console fixes: a card watched what each of its two requests said until the focus reached
// it, so a request whose answer found the person on another field kept its watch. A Save lender access refused or lost
// then sent the focus of a later revocation on the card to its old notice, an access change refused or applied did the
// same to a later Save lender access, and either took the focus from a later invitation. Only the card's latest request
// is watched now, and only until the focus is found outside the card.
for (const how of ["refused", "lost"] as const) it(`moves a revocation's focus to what it did, not to a Save lender access ${how} while the person was on another field`, async () => {
  const user = userEvent.setup();
  liveTeam();
  const answerGrant = hold("PATCH", "/team/members/m-ops/lenders"), answerChange = hold("PATCH", "/team/members/m-ops");
  renderApp("/team");
  await screen.findByRole("heading", { name: "Chidi Ops" });
  const form = within(within(card("Chidi Ops")).getByRole("group", { name: "Lenders available to Chidi Ops" }));
  await user.click(form.getAllByRole("checkbox").find((box) => !(box as HTMLInputElement).checked)!);
  await user.type(form.getByLabelText("Reason for changing Chidi Ops’s lenders"), "Needs the second lender for cover");
  const save = form.getByRole("button", { name: "Save lender access" }) as HTMLButtonElement;
  save.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(save.disabled).toBe(true));
  // While it waits, the person moves on to the card's access form, where the answer finds them.
  const reason = within(card("Chidi Ops")).getByLabelText("Reason for changing Chidi Ops’s access");
  reason.focus();
  answerGrant(how);
  const old = (await within(card("Chidi Ops")).findAllByRole("alert"))[0]!;
  expect(document.activeElement).toBe(reason);
  await user.selectOptions(within(card("Chidi Ops")).getByLabelText("Access for Chidi Ops"), "revoked");
  await user.type(reason, "Left the pilot team this week");
  within(card("Chidi Ops")).getByRole("button", { name: "Save access change" }).focus();
  await user.keyboard("{Enter}");
  within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke access" }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  answerChange("applied");
  const said = await within(card("Chidi Ops")).findByText("Chidi Ops’s access is revoked. Their lender access and pending invitations are removed.");
  expect(old.isConnected).toBe(true);
  await waitFor(() => expect(document.activeElement).toBe(said));
});

for (const first of ["refused", "applied"] as const) it(`moves a Save lender access's focus to what it did, not to an access change ${first} while the person was on another card`, async () => {
  const user = userEvent.setup();
  liveTeam();
  const answerChange = hold("PATCH", "/team/members/m-ops"), answerGrant = hold("PATCH", "/team/members/m-ops/lenders");
  renderApp("/team");
  await screen.findByRole("heading", { name: "Chidi Ops" });
  await user.selectOptions(within(card("Chidi Ops")).getByLabelText("Role for Chidi Ops"), "Finance");
  await user.type(within(card("Chidi Ops")).getByLabelText("Reason for changing Chidi Ops’s access"), "Needs to review closes");
  await user.click(within(card("Chidi Ops")).getByRole("button", { name: "Save access change" }));
  // While it waits, the person moves on to another member's card, where the answer finds them.
  const elsewhere = within(card("Funmi Ọbi")).getByLabelText("Reason for changing Funmi Ọbi’s access");
  elsewhere.focus();
  answerChange(first);
  const old = first === "refused" ? (await within(card("Chidi Ops")).findAllByRole("alert"))[0]! : await within(card("Chidi Ops")).findByText("Chidi Ops is now Finance (active).");
  if (first === "applied") await waitFor(() => expect(within(card("Chidi Ops")).getByText(/^Finance · Active/)).toBeTruthy());
  expect(document.activeElement).toBe(elsewhere);
  const form = within(within(card("Chidi Ops")).getByRole("group", { name: "Lenders available to Chidi Ops" }));
  await user.click(form.getAllByRole("checkbox").find((box) => !(box as HTMLInputElement).checked)!);
  await user.type(form.getByLabelText("Reason for changing Chidi Ops’s lenders"), "Needs the second lender for cover");
  const save = form.getByRole("button", { name: "Save lender access" }) as HTMLButtonElement;
  save.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(save.disabled).toBe(true));
  dropFocus();
  answerGrant("applied");
  await waitFor(() => expect(card("Chidi Ops").textContent).toContain("Can work on 2 lenders"));
  const saved = within(card("Chidi Ops")).getByText("Lender access saved.");
  expect(old.isConnected).toBe(true);
  await waitFor(() => expect(document.activeElement).toBe(saved));
});

for (const first of ["Save lender access", "Save access change"] as const) it(`moves an invitation's focus to what it did, not to a member's ${first} refused while the person was in the invitation form`, async () => {
  const user = userEvent.setup();
  liveTeam();
  const answerCard = hold("PATCH", first === "Save lender access" ? "/team/members/m-ops/lenders" : "/team/members/m-ops"), answerInvitation = hold("POST", "/team/invitations");
  renderApp("/team");
  await screen.findByRole("heading", { name: "Chidi Ops" });
  if (first === "Save lender access") {
    const form = within(within(card("Chidi Ops")).getByRole("group", { name: "Lenders available to Chidi Ops" }));
    await user.click(form.getAllByRole("checkbox").find((box) => !(box as HTMLInputElement).checked)!);
    await user.type(form.getByLabelText("Reason for changing Chidi Ops’s lenders"), "Needs the second lender for cover");
  } else {
    await user.selectOptions(within(card("Chidi Ops")).getByLabelText("Role for Chidi Ops"), "Finance");
    await user.type(within(card("Chidi Ops")).getByLabelText("Reason for changing Chidi Ops’s access"), "Needs to review closes");
  }
  await user.click(within(card("Chidi Ops")).getByRole("button", { name: first }));
  // While it waits, the person moves on to the invitation form, where the refusal finds them.
  const email = screen.getByLabelText("Verified email");
  email.focus();
  answerCard("refused");
  const old = (await within(card("Chidi Ops")).findAllByRole("alert"))[0]!;
  expect(document.activeElement).toBe(email);
  await user.type(email, "new.colleague@example.test");
  const create = screen.getByRole("button", { name: "Create invitation" }) as HTMLButtonElement;
  create.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(create.disabled).toBe(true));
  dropFocus();
  answerInvitation("applied");
  const said = await screen.findByText(/^Invitation created\. No email has been sent, so share the link with this person yourself\./);
  expect(old.isConnected).toBe(true);
  await waitFor(() => expect(document.activeElement).toBe(said));
});

it("keeps the confirmation of saved lender access, which gives the membership a new version", async () => {
  const user = userEvent.setup();
  liveTeam();
  renderApp("/team");
  await screen.findByRole("heading", { name: "Chidi Ops" });
  expect(card("Chidi Ops").textContent).toContain("Can work on 1 lender");
  const form = within(within(card("Chidi Ops")).getByRole("group", { name: "Lenders available to Chidi Ops" }));
  await user.click(form.getAllByRole("checkbox").find((box) => !(box as HTMLInputElement).checked)!);
  await user.type(form.getByLabelText("Reason for changing Chidi Ops’s lenders"), "Also works on the second lender's collections");
  await user.click(form.getByRole("button", { name: "Save lender access" }));
  await waitFor(() => expect(card("Chidi Ops").textContent).toContain("Can work on 2 lenders"));
  const saved = within(card("Chidi Ops")).getByText("Lender access saved.");
  await waitFor(() => expect(document.activeElement).toBe(saved));
});

it("moves focus to the decision's message when Approve invitation, Approve change or Reject change removes its item", async () => {
  const user = userEvent.setup();
  liveTeam();
  renderApp("/team");
  const panel = (await screen.findByRole("heading", { name: "Waiting for a second Admin" })).closest("section")!;
  for (const [button, said] of [
    ["Approve invitation", "Invitation approved: finance.new@example.test can now accept it as Finance."],
    ["Approve change", "Change approved: Chidi Ops is now Finance (active)."],
    ["Reject change", "Change request declined. Their access has not changed."],
  ] as const) {
    const pressed = within(panel).getAllByRole("button", { name: button })[0]!;
    await user.click(pressed);
    await waitFor(() => expect(pressed.isConnected).toBe(false));
    const message = within(panel).getByText(said);
    await waitFor(() => expect(document.activeElement).toBe(message));
  }
  expect(within(panel).getByText("Nothing is waiting for approval.")).toBeTruthy();
});

it("says a privileged role waits for a second Admin, shows a one-Admin pilot whom to ask, and keeps the set-up command in closed Technical setup", async () => {
  liveTeam();
  renderApp("/team");
  const panel = (await screen.findByRole("heading", { name: "Waiting for a second Admin" })).closest("section")!;
  expect(within(panel).getByText("Giving someone the Admin, Finance or Compliance reviewer role takes effect only when a second Admin, not the one who asked, approves it.")).toBeTruthy();
  // The way forward for a lender's Admin is on the page; only the Valo Pay team's command is in Technical setup.
  expect(within(panel).getByText("If your pilot has only one Admin, ask the Valo Pay team to add a second.").closest("details")).toBeNull();
  const setup = within(panel).getByText("The Valo Pay team adds one with the staff set-up command, using its option for adding an Admin.").closest("details")!;
  expect(setup.open).toBe(false);
  expect(screen.getByText(/invitation can be accepted only after a second Admin approves it\./)).toBeTruthy();
});

// Backlog decision UX-B02-X1: team and access changes stay out of the operations journal, so while one's outcome is
// unconfirmed the page asks before it is left or reloaded, which would lose the only way to check it.
const leaving = () => { const unload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload); return unload.defaultPrevented; };
for (const lost of ["an access change", "an invitation"] as const) it(`asks before leaving Team & access while ${lost}'s outcome is unconfirmed`, async () => {
  const user = userEvent.setup();
  liveTeam();
  const send = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    const path = new URL(url, "http://localhost").pathname;
    if ((path === "/api/v1/team/members/m-ops" && options?.method === "PATCH") || (path === "/api/v1/team/invitations" && options?.method === "POST")) throw new TypeError("Failed to fetch");
    return send(input, options);
  };
  renderApp("/team");
  await screen.findByRole("heading", { name: "Chidi Ops" });
  expect(leaving()).toBe(false);
  if (lost === "an access change") {
    await user.selectOptions(within(card("Chidi Ops")).getByLabelText("Access for Chidi Ops"), "suspended");
    await user.type(within(card("Chidi Ops")).getByLabelText("Reason for changing Chidi Ops’s access"), "On leave for two weeks");
    await user.click(within(card("Chidi Ops")).getByRole("button", { name: "Save access change" }));
  } else {
    await user.type(screen.getByLabelText("Verified email"), "new.colleague@example.test");
    await user.click(screen.getByRole("button", { name: "Create invitation" }));
  }
  await screen.findByText("Request not confirmed");
  expect(leaving()).toBe(true);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await user.click(screen.getAllByRole("link", { name: "Overview" })[0]!);
  expect(confirm).toHaveBeenCalled();
  expect(window.location.pathname).toBe("/team");
  confirm.mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Discard original request" }));
  await waitFor(() => expect(screen.queryByText("Request not confirmed")).toBeNull());
  expect(leaving()).toBe(false);
});
