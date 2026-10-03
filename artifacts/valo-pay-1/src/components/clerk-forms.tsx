import { SignIn, SignUp } from "@clerk/react";
import { dark } from "@clerk/themes";
import { useTheme } from "@/lib/theme";

/*
 * Clerk's sign-in and sign-up forms in the console's theme. The sign-in pages
 * load this module only where sign-in is available, so a host without Clerk
 * never fetches Clerk's code for them.
 */

/** Clerk's form in the console's colours, type and radius. */
const appearance = {
  variables: {
    colorPrimary: "hsl(var(--primary))",
    colorText: "hsl(var(--foreground))",
    colorTextSecondary: "hsl(var(--muted-foreground))",
    colorBackground: "hsl(var(--card))",
    colorInputBackground: "hsl(var(--background))",
    colorInputText: "hsl(var(--foreground))",
    colorTextOnPrimaryBackground: "hsl(var(--primary-foreground))",
    colorDanger: "hsl(var(--destructive))",
    borderRadius: "0.75rem",
    fontFamily: "'Plus Jakarta Sans', sans-serif",
  },
  elements: {
    rootBox: "auth-clerk-root",
    cardBox: "auth-clerk-box",
    card: "auth-clerk-card",
    headerTitle: "auth-clerk-title",
    headerSubtitle: "auth-clerk-subtitle",
    formFieldInput: "auth-clerk-input",
    formButtonPrimary: "auth-clerk-submit",
    socialButtonsBlockButton: "auth-clerk-social",
    footer: "auth-clerk-footer",
    footerActionLink: "auth-clerk-link",
  },
} as const;

/** The same form on a dark console: Clerk's dark base theme with the console's dark tokens, so the door matches the room. */
const darkAppearance = {
  ...appearance,
  baseTheme: dark,
  variables: {
    ...appearance.variables,
    colorTextOnPrimaryBackground: "hsl(var(--primary-foreground))",
  },
};

function useClerkAppearance() {
  const { theme } = useTheme();
  return theme === "dark" ? darkAppearance : appearance;
}

/** Clerk's sign-in form, by path, in the console's theme. */
export function ClerkSignIn({ path, signUpUrl, fallbackRedirectUrl }: { path: string; signUpUrl: string; fallbackRedirectUrl: string }) {
  return <SignIn routing="path" path={path} signUpUrl={signUpUrl} fallbackRedirectUrl={fallbackRedirectUrl} appearance={useClerkAppearance()} />;
}

/** Clerk's sign-up form, by path, in the console's theme. */
export function ClerkSignUp({ path, signInUrl, fallbackRedirectUrl }: { path: string; signInUrl: string; fallbackRedirectUrl: string }) {
  return <SignUp routing="path" path={path} signInUrl={signInUrl} fallbackRedirectUrl={fallbackRedirectUrl} appearance={useClerkAppearance()} />;
}
