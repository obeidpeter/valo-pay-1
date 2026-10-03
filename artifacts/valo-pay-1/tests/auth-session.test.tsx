// Clerk loads as a chunk of its own, beside the pages (audit of 23 September,
// item 12): its arrival reports the session without remounting a page, and
// Clerk's own components render under its provider, in their place on the page.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { Router } from "wouter";
import { AuthShow, ClerkLoader, ClerkSlot, ClerkSignIn, useSessionUser, useSignOut } from "@/lib/auth";

vi.unmock("@/lib/auth");
const clerk = vi.hoisted(() => ({ signOut: () => {}, signedOut: 0, provider: null as Record<string, unknown> | null }));
vi.mock("@clerk/react", async () => {
  const React = await import("react");
  const Provided = React.createContext(false);
  return {
    ClerkProvider: ({ children, ...props }: { children: React.ReactNode }) => {
      clerk.provider = props;
      return <Provided.Provider value>{children}</Provided.Provider>;
    },
    useAuth: () => {
      if (!React.useContext(Provided)) throw new Error("useAuth outside ClerkProvider");
      return { userId: "user_sample", orgId: "org_sample", isLoaded: true };
    },
    useClerk: () => ({ signOut: async () => { clerk.signedOut += 1; } }),
    SignIn: () => <section aria-label={React.useContext(Provided) ? "Sign-in under Clerk's provider" : "Sign-in outside Clerk's provider"} />,
  };
});
vi.mock("@/lib/auth-config", () => ({ browserAuth: { enabled: false, publicKey: "pk_test_sample" } }));

function Session() {
  const { userId, isLoaded } = useSessionUser();
  const signOut = useSignOut();
  return <><p>{isLoaded ? `Signed in as ${userId}` : "Waiting for Clerk"}</p><button onClick={signOut}>Sign out</button></>;
}
/** State a remount would lose. */
function Draft() {
  const [value, setValue] = useState("");
  return <input aria-label="Draft" value={value} onChange={(event) => setValue(event.target.value)} />;
}

it("reports Clerk's session when its chunk arrives, keeps the page mounted and places Clerk's form in the page", async () => {
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  const pending = arrived.then(() => import("@/lib/clerk-session"));
  const load = () => pending;
  render(
    <Router>
      <ClerkLoader load={load}>
        <Session />
        <Draft />
        <AuthShow when="signed-in"><p>Only when signed in</p></AuthShow>
        <div data-testid="place"><ClerkSlot><ClerkSignIn path="/sign-in" signUpUrl="/sign-up" fallbackRedirectUrl="/overview" /></ClerkSlot></div>
      </ClerkLoader>
    </Router>,
  );
  expect(screen.getByText("Waiting for Clerk")).toBeTruthy();
  expect(screen.queryByText("Only when signed in")).toBeNull();
  expect(screen.queryByRole("region")).toBeNull();
  const draft = screen.getByLabelText("Draft") as HTMLInputElement;
  act(() => { draft.focus(); });
  fireEvent.change(draft, { target: { value: "typed before Clerk arrived" } });

  await act(async () => { arrive(); await pending; });
  await screen.findByText("Signed in as user_sample");
  expect(screen.getByText("Only when signed in")).toBeTruthy();
  // The same input, with its value and focus: Clerk's arrival did not remount the page.
  expect(screen.getByLabelText("Draft")).toBe(draft);
  expect(draft.value).toBe("typed before Clerk arrived");
  expect(document.activeElement).toBe(draft);
  // Clerk's form renders under Clerk's provider, where the page placed it.
  expect(within(screen.getByTestId("place")).getByRole("region", { name: "Sign-in under Clerk's provider" })).toBeTruthy();
  screen.getByRole("button", { name: "Sign out" }).click();
  await waitFor(() => expect(clerk.signedOut).toBe(1));
});

it("keeps sign-in unavailable, and shows neither signed-in nor signed-out content, without Clerk", () => {
  render(<><AuthShow when="signed-out"><p>Signed out</p></AuthShow><AuthShow when="signed-in"><p>Signed in</p></AuthShow><Session /></>);
  expect(screen.queryByText("Signed out")).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(screen.getByText("Signed in as null")).toBeTruthy();
});

it("explains a failed auth load and retries it without losing a draft or treating failure as signed out", async () => {
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  const pending = arrived.then(() => import("@/lib/clerk-session"));
  const load = vi.fn<() => typeof pending>()
    .mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module"))
    .mockImplementationOnce(() => pending);
  render(<Router><ClerkLoader load={load}>
    <Session /><Draft />
    <AuthShow when="signed-out"><p>Signed out content</p></AuthShow>
    <AuthShow when="signed-in"><p>Signed in content</p></AuthShow>
    <ClerkSlot><ClerkSignIn path="/sign-in" signUpUrl="/sign-up" fallbackRedirectUrl="/overview" /></ClerkSlot>
  </ClerkLoader></Router>);
  const draft = screen.getByLabelText("Draft") as HTMLInputElement;
  fireEvent.change(draft, { target: { value: "Keep my unsaved work" } });
  const failure = await screen.findByRole("alert");
  expect(failure.textContent).toContain("We could not load sign-in.");
  expect(screen.queryByText("Signed out content")).toBeNull();
  expect(screen.queryByText("Signed in content")).toBeNull();
  expect(screen.getByText("Waiting for Clerk")).toBeTruthy();
  fireEvent.click(within(failure).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("status").textContent).toBe("Loading sign-in…");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("Signed out content")).toBeNull();
  await act(async () => { arrive(); await pending; });
  await screen.findByText("Signed in as user_sample");
  expect(screen.getByLabelText("Draft")).toBe(draft);
  expect(draft.value).toBe("Keep my unsaved work");
  expect(screen.getByText("Signed in content")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Sign-in under Clerk's provider" })).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});

it("gives Clerk's own screens British English and the pages' own names", async () => {
  const pending = import("@/lib/clerk-session");
  render(<Router><ClerkLoader load={() => pending}>
    <ClerkSlot><ClerkSignIn path="/sign-in" signUpUrl="/sign-up" fallbackRedirectUrl="/overview" /></ClerkSlot>
  </ClerkLoader></Router>);
  await screen.findByRole("region", { name: "Sign-in under Clerk's provider" });
  const localization = clerk.provider?.localization as Record<string, unknown>;
  expect(localization).toMatchObject({
    locale: "en-GB",
    signIn: { start: { title: "Sign in", actionLink: "Create an account" }, totpMfa: { title: "Two-step verification" } },
    signUp: { start: { title: "Create an account", actionLink: "Sign in" } },
    organizationSwitcher: { notSelected: "No organisation selected", action__createOrganization: "Create organisation" },
    taskChooseOrganization: { chooseOrganization: { title: "Choose an organisation" } },
  });
  // Every word given to Clerk spells organisation the British way and calls a second factor two-step verification.
  const words: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") words.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(localization);
  expect(words.length).toBeGreaterThan(20);
  expect(words.filter((word) => /organization|two-step authentication|two-factor|\bMFA\b/i.test(word))).toEqual([]);
});
