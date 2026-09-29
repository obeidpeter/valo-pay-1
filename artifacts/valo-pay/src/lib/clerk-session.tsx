import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'wouter';
import { ClerkProvider, useAuth, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
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
