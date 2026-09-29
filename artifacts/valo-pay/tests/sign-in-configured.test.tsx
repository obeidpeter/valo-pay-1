import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { SignInPage, SignUpPage } from "@/pages/sign-in";
import { setThemeChoice } from "@/lib/theme";

const clerk = vi.hoisted(() => ({
  signIn: null as Record<string, unknown> | null,
  signUp: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/auth", async () => ({
  ...await import("@/components/clerk-forms"),
  authEnabled: true,
  useSessionUser: () => ({ userId: null, isLoaded: true }),
  useSignOut: () => () => {},
  AuthShow: () => null,
  AuthProvider: ({ children }: { children: unknown }) => children,
  // Clerk's components render in place, as they do once Clerk's provider has loaded.
  ClerkSlot: ({ children }: { children: unknown }) => children,
}));

// Exercise the hand-off to Clerk without contacting an identity provider or
// reimplementing its fields, validation and authentication behaviour.
vi.mock("@clerk/react", () => ({
  SignIn: (props: Record<string, unknown>) => {
    clerk.signIn = props;
    return <section aria-label="Account sign-in" />;
  },
  SignUp: (props: Record<string, unknown>) => {
    clerk.signUp = props;
    return <section aria-label="Account registration" />;
  },
}));

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi();
  clerk.signIn = null;
  clerk.signUp = null;
});
afterEach(() => api.uninstall());

describe("configured account pages", () => {
  it("keeps Clerk path routing, registration and the console fallback intact", async () => {
    render(<SignInPage />);
    // Clerk's form is its own chunk, loaded only where sign-in is available.
    expect(
      await screen.findByRole("region", { name: "Account sign-in" }),
    ).toBeTruthy();
    expect(screen.queryByText("Sign-in is unavailable here")).toBeNull();
    expect(clerk.signIn).toMatchObject({
      routing: "path",
      path: "/sign-in",
      signUpUrl: "/sign-up",
      fallbackRedirectUrl: "/overview",
    });
    expect(
      screen
        .getByRole("link", { name: /Open the sandbox/ })
        .getAttribute("href"),
    ).toBe("/overview");
    expect(
      screen.getByText(
        /Work you do in the sandbox is not copied to your workspace/,
      ),
    ).toBeTruthy();
    expect(api.calls).toEqual([]);
  });

  it("keeps registration routed back to sign-in and respects a dark appearance", async () => {
    act(() => setThemeChoice("dark"));
    render(<SignUpPage />);
    expect(
      await screen.findByRole("region", { name: "Account registration" }),
    ).toBeTruthy();
    expect(clerk.signUp).toMatchObject({
      routing: "path",
      path: "/sign-up",
      signInUrl: "/sign-in",
      fallbackRedirectUrl: "/overview",
      appearance: { baseTheme: expect.any(Object) },
    });
    expect(
      screen.getByText(
        /Live payments and bank connections are switched off, even when you sign in/,
      ),
    ).toBeTruthy();
    expect(api.calls).toEqual([]);
  });
});
