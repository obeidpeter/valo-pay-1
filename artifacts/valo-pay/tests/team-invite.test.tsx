import { beforeEach, expect, it, vi } from "vitest";
import { focusMain } from "@/lib/focus";
import { renderApp, screen, userEvent, waitFor } from "./harness";

const session = vi.hoisted(() => ({ userId: "user_invitee" as string | null }));
vi.mock("@/lib/auth", () => ({
  authEnabled: true,
  useSessionUser: () => ({ userId: session.userId, isLoaded: true }),
  useSignOut: () => () => {},
  AuthShow: ({ children }: { children: unknown }) => session.userId ? children : null,
  AuthProvider: ({ children }: { children: unknown }) => children,
  ClerkSlot: ({ children }: { children: unknown }) => children,
  ClerkSignIn: () => null,
  ClerkSignUp: () => null,
  VerifiedSession: () => <p>Verify your organisation and account.</p>,
}));

beforeEach(() => { session.userId = "user_invitee"; });

for (const [name, fragment] of [
  ["missing", ""],
  ["malformed", "#incomplete-invitation"],
  ["truncated", `#${"a".repeat(63)}`],
] as const) it(`explains recovery for a ${name} invitation without sending or displaying its token`, async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  const user = userEvent.setup();
  renderApp(`/team-invite${fragment}`);
  const problem = await screen.findByRole("alert");
  expect(problem.textContent).toContain("This invitation link is incomplete or invalid.");
  expect(problem.textContent).toContain("Open the full link again, exactly as the Admin sent it.");
  expect(problem.textContent).toContain("ask them for a new invitation");
  const accept = screen.getByRole("button", { name: "Accept invitation" }) as HTMLButtonElement;
  expect(accept.disabled).toBe(true);
  expect(accept.getAttribute("aria-describedby")).toBe(problem.id);
  await user.click(accept);
  expect(fetch).not.toHaveBeenCalled();
  if (fragment) expect(screen.getByRole("main").innerHTML).not.toContain(fragment.slice(1));
});

it("keeps a complete invitation's sign-in recovery without passing its token to the sign-in link", async () => {
  session.userId = null;
  const token = "b".repeat(64);
  const fetch = vi.spyOn(globalThis, "fetch");
  renderApp(`/team-invite#${token}`);
  const signIn = await screen.findByRole("link", { name: "Sign in" });
  expect(signIn.getAttribute("href")).toBe("/sign-in");
  expect(screen.getByText(/Sign in first, then open your invitation link again/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect((screen.getByRole("button", { name: "Accept invitation" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("main").innerHTML).not.toContain(token);
  expect(fetch).not.toHaveBeenCalled();
});

it("accepts a complete invitation once and removes the token from the address after confirmation", async () => {
  const token = "c".repeat(64);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    message: "You have joined the pilot workspace.", role: "Operations",
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  const user = userEvent.setup();
  renderApp(`/team-invite#${token}`);
  const accept = await screen.findByRole("button", { name: "Accept invitation" }) as HTMLButtonElement;
  expect(accept.disabled).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("main").innerHTML).not.toContain(token);
  await user.click(accept);
  expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("You have joined the pilot workspace."));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith("/api/v1/team/accept", expect.objectContaining({
    method: "POST", body: JSON.stringify({ token }), credentials: "same-origin",
  }));
  expect(window.location.hash).toBe("");
  expect(screen.getByRole("link", { name: "Open Pilot journey" }).getAttribute("href")).toBe("/pilot");
  await waitFor(() => expect(accept.disabled).toBe(true));
  await user.click(accept);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("gives the shared route focus helper a focusable invitation main region", async () => {
  renderApp("/team-invite");
  await screen.findByRole("heading", { level: 1, name: "Accept your invitation" });
  const main = screen.getByRole("main");
  screen.getByRole("link", { name: "Valo Pay" }).focus();
  focusMain();
  expect(document.activeElement).toBe(main);
  expect(main.tabIndex).toBe(-1);
});
