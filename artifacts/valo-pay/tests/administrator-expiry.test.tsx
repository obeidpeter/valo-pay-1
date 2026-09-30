// A staff administrator is warned, above every console page, when their own
// administrator access or the last administrator's ends within 14 days:
// memberships last 90 days and only the operator renews an administrator, so
// a pilot whose administrators all lapse has nobody left to invite or renew
// staff. Nobody else is warned, and the sandbox never asks for the team.
import { afterEach, beforeEach, expect, it } from "vitest";
import type { StaffDirectory } from "@workspace/valopay-schema";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen } from "./harness";
import { ADMINISTRATOR_EXPIRY_WARNING_DAYS, administratorExpiryWarnings } from "@/components/administrator-expiry";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-09-23T09:00:00.000Z");
const inDays = (days: number) => new Date(now + days * DAY).toISOString();
const member = (actor: string, role: string, expiresAt: string, status = "active") => ({ id: `member-${actor}`, actor, name: actor, role, status, expiresAt, updatedAt: inDays(-1), lenderIds: [], allLenders: role === "Admin" }) as StaffDirectory["members"][number];
const directory = (members: StaffDirectory["members"], actor = "Clerk:user_me"): StaffDirectory => ({ mode: "staff", actor, members, lenders: [], invitations: [], changes: [], events: [], message: "Verified staff access." });

it("names the viewer's own ending access and the last administrator's, only within 14 days", () => {
  expect(ADMINISTRATOR_EXPIRY_WARNING_DAYS).toBe(14);
  // Far off: nothing to say.
  expect(administratorExpiryWarnings(directory([member("Clerk:user_me", "Admin", inDays(60)), member("Clerk:user_other", "Admin", inDays(80))]), now)).toEqual([]);
  // Mine soon, another administrator's later: only mine.
  const own = administratorExpiryWarnings(directory([member("Clerk:user_me", "Admin", inDays(10)), member("Clerk:user_other", "Admin", inDays(80))]), now);
  expect(own).toHaveLength(1);
  expect(own[0]).toMatch(/^Your administrator access ends on .* Ask the operator to renew it before then; it cannot be renewed from the console\.$/);
  // Mine the last to end, and soon: one message that says nobody is left after it.
  const last = administratorExpiryWarnings(directory([member("Clerk:user_me", "Admin", inDays(13)), member("Clerk:user_other", "Admin", inDays(3)), member("Clerk:user_gone", "Admin", inDays(-2))]), now);
  expect(last).toEqual([expect.stringMatching(/^Your administrator access ends on .*, and no other administrator's lasts longer: after that nobody can invite, change or renew staff\./)]);
  // Another administrator lasts longer, but also ends soon: both.
  const both = administratorExpiryWarnings(directory([member("Clerk:user_me", "Admin", inDays(2)), member("Clerk:user_other", "Admin", inDays(12))]), now);
  expect(both).toHaveLength(2);
  expect(both[1]).toMatch(/^Every administrator's access ends by .*: after that nobody can invite, change or renew staff\. Ask the operator to renew an administrator, or to add another, before then\.$/);
  // A suspended administrator does not count as staying; a Finance member or a sandbox is never warned.
  expect(administratorExpiryWarnings(directory([member("Clerk:user_me", "Admin", inDays(40)), member("Clerk:user_other", "Admin", inDays(80), "suspended")]), now)).toEqual([]);
  expect(administratorExpiryWarnings(directory([member("Clerk:user_me", "Finance", inDays(2)), member("Clerk:user_other", "Admin", inDays(3))]), now)).toEqual([]);
  expect(administratorExpiryWarnings({ ...directory([]), mode: "sandbox" }, now)).toEqual([]);
});

/** Serves the fake API as a staff workspace for this role, with this team directory, and counts the team reads. */
function staffHost(role: string, members: StaffDirectory["members"]) {
  const send = globalThis.fetch;
  const reads = { team: 0 };
  globalThis.fetch = async (input, options) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    const path = new URL(url, "http://localhost").pathname;
    if (path === "/api/v1/team") {
      reads.team += 1;
      return new Response(JSON.stringify(directory(members)), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const response = await send(input, options);
    if (path !== "/api/v1/workspace") return response;
    const workspace = await response.json();
    return new Response(JSON.stringify({ ...workspace, accessMode: "staff", actor: "Clerk:user_me", role, authenticated: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return reads;
}

it("warns a staff administrator above the page when every administrator's access ends within 14 days", async () => {
  const soon = new Date(Date.now() + 5 * DAY).toISOString();
  staffHost("Admin", [member("Clerk:user_me", "Admin", soon)]);
  renderApp("/overview");
  const notice = await screen.findByRole("status", { name: "Administrator access" });
  expect(notice.textContent).toMatch(/Administrator access is ending/);
  expect(notice.textContent).toMatch(/Your administrator access ends on .* and no other administrator's lasts longer/);
});

it("says nothing to a staff administrator whose access lasts", async () => {
  const reads = staffHost("Admin", [member("Clerk:user_me", "Admin", new Date(Date.now() + 60 * DAY).toISOString())]);
  // Team & access shows the same read of the team, so once its member is on screen the warning has had its data.
  renderApp("/team");
  await screen.findByText(/^Admin · Active · expires /);
  expect(screen.queryByRole("status", { name: "Administrator access" })).toBeNull();
  expect(reads.team).toBe(1);
});

it("never reads the team for this outside a staff administrator's console", async () => {
  const reads = staffHost("Finance", [member("Clerk:user_me", "Finance", new Date(Date.now() + 2 * DAY).toISOString())]);
  renderApp("/overview");
  await screen.findByRole("heading", { name: "Operations overview" });
  expect(screen.queryByRole("status", { name: "Administrator access" })).toBeNull();
  expect(reads.team).toBe(0);
});

it("never reads the team for this in the sandbox", async () => {
  const send = globalThis.fetch;
  let team = 0;
  globalThis.fetch = async (input, options) => {
    if (String(input instanceof Request ? input.url : input).includes("/api/v1/team")) team += 1;
    return send(input, options);
  };
  renderApp("/overview");
  await screen.findByRole("heading", { name: "Operations overview" });
  expect(screen.queryByRole("status", { name: "Administrator access" })).toBeNull();
  expect(team).toBe(0);
});
