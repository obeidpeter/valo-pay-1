import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'wouter';
import { ClerkProvider, useAuth, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import type { LocalizationResource } from '@clerk/react/types';
import { ErrorBoundary, type ErrorFallbackProps } from '@/components/error-boundary';
import type { ClerkSlots, Session } from './auth';
export { ClerkSignIn, ClerkSignUp } from '@/components/clerk-forms';
export { VerifiedSession } from '@/components/staff-verification';

/*
 * Clerk's provider and the session it reports, in a chunk of their own that
 * lib/auth.tsx loads only where sign-in is wanted, so the page shell carries
 * no Clerk code and the anonymous sandbox on a local host never fetches it.
 * Forms and verification share this entry so a successful retry uses this
 * provider's Clerk context, never the original failed entry URL.
 */

const configuredKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

/**
 * Clerk's own words, in British English, where the sign-in, sign-up and
 * invitation pages show them (docs/design/writing.md): the first step's title
 * is the page's name (Sign in, Create an account), an organisation is spelt
 * so, and a second factor is two-step verification, as Clerk's account screens
 * already call it. Only these keys are set; every other word is Clerk's own.
 * Not exported: the chunk's exports are its provider, forms and verification.
 */
const localization: LocalizationResource = {
  locale: 'en-GB',
  signIn: {
    start: {
      title: 'Sign in',
      titleCombined: 'Sign in',
      subtitle: 'Welcome back. Continue to your workspace.',
      subtitleCombined: 'Welcome back. Continue to your workspace.',
      actionText: 'Don’t have an account?',
      actionLink: 'Create an account',
    },
    totpMfa: { title: 'Two-step verification' },
    backupCodeMfa: { subtitle: 'Use one of the backup codes you saved when you set up two-step verification.' },
  },
  signUp: {
    start: {
      title: 'Create an account',
      titleCombined: 'Create an account',
      subtitle: 'Fill in your details to get your own workspace.',
      subtitleCombined: 'Fill in your details to get your own workspace.',
      actionText: 'Already have an account?',
      actionLink: 'Sign in',
    },
  },
  reverification: {
    backupCodeMfa: { subtitle: 'Enter one of the backup codes you saved when you set up two-step verification.' },
  },
  organizationSwitcher: {
    action__createOrganization: 'Create organisation',
    action__openOrganizationSwitcher: 'Open organisation switcher',
    action__closeOrganizationSwitcher: 'Close organisation switcher',
    notSelected: 'No organisation selected',
  },
  taskChooseOrganization: {
    chooseOrganization: {
      title: 'Choose an organisation',
      subtitle: 'Join an existing organisation or create a new one.',
      subtitle__createOrganizationDisabled: 'Join an existing organisation.',
      action__createOrganization: 'Create new organisation',
    },
    createOrganization: {
      title: 'Set up your organisation',
      subtitle: 'Enter your organisation’s details to continue.',
      formFieldInputPlaceholder__name: 'My organisation',
      formFieldInputPlaceholder__slug: 'my-organisation',
    },
    organizationCreationDisabled: {
      title: 'You must belong to an organisation',
      subtitle: 'Ask the person who invited you to add you to an organisation.',
    },
  },
  unstable__errors: {
    organization_not_found_or_unauthorized: 'You are no longer a member of this organisation. Choose or create another one.',
    organization_not_found_or_unauthorized_with_create_organization_disabled: 'You are no longer a member of this organisation. Choose another one.',
  },
};

export type ClerkSessionProps = { onSession: (session: Session) => void; slots: ClerkSlots };

/** A Clerk component that stopped working says so where it stood, without taking the page with it. */
function ClerkProblem({ resetError }: ErrorFallbackProps) {
  return (
    <p role="alert" className="text-sm text-muted-foreground">
      We could not show sign-in. <button type="button" className="font-medium text-primary underline" onClick={resetError}>Try again</button>
    </p>
  );
}

/** Tells the pages who is signed in, and how to sign out, whenever Clerk's answer changes (and only then). */
function SessionReporter({ onSession }: { onSession: (session: Session) => void }) {
  const { userId, orgId, isLoaded } = useAuth();
  const instance = useClerk();
  // The latest instance signs out; a new object for the same session is not a new answer.
  const clerk = useRef(instance);
  clerk.current = instance;
  useEffect(() => {
    onSession({ userId: userId ?? null, orgId, isLoaded, signOut: () => { void clerk.current.signOut(); } });
  }, [userId, orgId, isLoaded, onSession]);
  return null;
}

/**
 * Clerk's provider, rendered beside the pages: it reports the session to
 * them, and renders each ClerkSlot's content under itself, into the slot's
 * place in the page.
 */
export function ClerkSession({ onSession, slots }: ClerkSessionProps) {
  const [, setLocation] = useLocation();
  const placed = useSyncExternalStore(slots.subscribe, slots.snapshot);
  return (
    <ClerkProvider
      publishableKey={publishableKeyFromHost(window.location.hostname, configuredKey)}
      proxyUrl={clerkProxyUrl}
      localization={localization}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <SessionReporter onSession={onSession} />
      {placed.map(([id, slot]) => createPortal(<ErrorBoundary FallbackComponent={ClerkProblem}>{slot.content}</ErrorBoundary>, slot.node, id))}
    </ClerkProvider>
  );
}
