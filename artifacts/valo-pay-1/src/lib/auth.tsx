import { browserAuth } from './auth-config';
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useState, type ComponentProps, type ReactNode } from 'react';
import clerkSessionUrl from 'virtual:clerk-session-url';

type ClerkModule = typeof import('./clerk-session');

// Authentication belongs to an explicitly reviewed instance; arbitrary hostnames cannot select one.
export const authEnabled = browserAuth.enabled;

/**
 * Clerk's code is not in the page shell: it is fetched as its
 * own chunk, only where sign-in is wanted, starting as the app loads so it
 * arrives while the first page renders (lib/clerk-session.tsx).
 */
let loadAttempt = 0;
const loadClerkSession = () => {
  const url = new URL(clerkSessionUrl, window.location.href);
  if (loadAttempt++) url.searchParams.set('sign-in-retry', String(loadAttempt));
  return import(/* @vite-ignore */ url.href) as Promise<ClerkModule>;
};

export type SessionUser = { userId: string | null; orgId?: string | null; isLoaded: boolean };
/** The signed-in person as Clerk reports them, and the way to sign out. */
export type Session = SessionUser & { signOut: () => void };
type Provided = Session & { available: boolean };
const anonymous: Provided = { available: false, userId: null, isLoaded: true, signOut: () => {} };
const waiting: Provided = { available: true, userId: null, isLoaded: false, signOut: () => {} };
const SessionContext = createContext<Provided>(anonymous);

/** The signed-in user, or the anonymous sandbox where sign-in is unavailable; `isLoaded` is false until Clerk has answered. */
export function useSessionUser(): SessionUser {
  return useContext(SessionContext);
}

/** A sign-out function, or a no-op when sign-in is unavailable. */
export function useSignOut(): () => void {
  return useContext(SessionContext).signOut;
}

/** Renders its children for the given session state once Clerk has answered; renders nothing when sign-in is unavailable. */
export function AuthShow({ when, children }: { when: 'signed-in' | 'signed-out'; children: ReactNode }) {
  const { available, userId, isLoaded } = useContext(SessionContext);
  if (!available || !isLoaded || (when === 'signed-in') !== Boolean(userId)) return null;
  return <>{children}</>;
}

type Placed = { node: HTMLElement; content: ReactNode };
/** Where Clerk's own components are placed in the page: each renders under Clerk's provider, into its slot's place. */
export class ClerkSlots {
  private slots = new Map<string, Placed>();
  private listeners = new Set<() => void>();
  private current: Array<[string, Placed]> = [];
  set(id: string, node: HTMLElement, content: ReactNode): void { this.slots.set(id, { node, content }); this.changed(); }
  delete(id: string): void { if (this.slots.delete(id)) this.changed(); }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = (): Array<[string, Placed]> => this.current;
  private changed(): void { this.current = [...this.slots]; this.listeners.forEach((listener) => listener()); }
}
const SlotContext = createContext<ClerkSlots | null>(null);
type ClerkLoadState = { state: 'loading' | 'ready' | 'failed'; retry: () => void; components: ClerkModule | null };
const ClerkLoadContext = createContext<ClerkLoadState | null>(null);

// All Clerk components come from the successful entry, including after a retry.
// Importing them separately would refer back to the browser's failed module URL
// or create a second Clerk context outside the recovered provider.
export function ClerkSignIn(props: ComponentProps<ClerkModule['ClerkSignIn']>) {
  const Component = useContext(ClerkLoadContext)?.components?.ClerkSignIn;
  return Component ? <Component {...props} /> : null;
}
export function ClerkSignUp(props: ComponentProps<ClerkModule['ClerkSignUp']>) {
  const Component = useContext(ClerkLoadContext)?.components?.ClerkSignUp;
  return Component ? <Component {...props} /> : null;
}
export function VerifiedSession() {
  const Component = useContext(ClerkLoadContext)?.components?.VerifiedSession;
  return Component ? <Component /> : null;
}

/**
 * Clerk's own components (its sign-in form, the organisation switcher and
 * re-verification) need Clerk's provider around them. That provider renders
 * beside the pages rather than around them, so its arrival never remounts a
 * page: what is placed here is rendered under it, into this place in the
 * page, once Clerk has loaded. Until then the slot explains the loading state
 * and offers a fresh fetch if the chunk cannot be loaded.
 */
export function ClerkSlot({ children }: { children: ReactNode }) {
  const slots = useContext(SlotContext);
  const loading = useContext(ClerkLoadContext);
  const id = useId();
  const [node, setNode] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { if (slots && node) slots.set(id, node, children); }, [slots, node, id, children]);
  useLayoutEffect(() => () => { slots?.delete(id); }, [slots, id]);
  return <>
    <div ref={setNode} className="contents" />
    {loading?.state === 'loading' && <p role="status" className="p-4 text-sm text-muted-foreground">Loading sign-in…</p>}
    {loading?.state === 'failed' && <div role="alert" className="space-y-3 rounded-lg border bg-card p-4 text-sm">
      <p className="font-medium">We could not load sign-in.</p>
      <p>Check your connection and try again. Nothing has changed.</p>
      <button type="button" className="min-h-10 rounded-md border border-input px-3 py-2 font-medium text-primary" onClick={loading.retry}>Try again</button>
    </div>}
  </>;
}

/**
 * The session for the pages below: the anonymous sandbox where sign-in is
 * unavailable, otherwise Clerk's, reported by Clerk's provider once its chunk
 * has loaded. Until then the session is not loaded, as it is until Clerk
 * itself has answered. A failed fetch offers retry in each Clerk slot without
 * changing identity or remounting the pages and their open drafts.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  if (!authEnabled) return <>{children}</>;
  return <ClerkLoader load={loadClerkSession}>{children}</ClerkLoader>;
}

/** The session from Clerk's chunk once `load` brings it, rendering Clerk's provider beside `children`; AuthProvider's, where sign-in is wanted. */
export function ClerkLoader({ load, children }: { load: () => Promise<ClerkModule>; children: ReactNode }) {
  const [session, setSession] = useState<Provided>(waiting);
  const report = useCallback((next: Session) => setSession({ ...next, available: true }), []);
  const [slots] = useState(() => new ClerkSlots());
  const [components, setComponents] = useState<ClerkModule | null>(null);
  const Clerk = components?.ClerkSession;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ClerkLoadState['state']>('loading');
  const retry = useCallback(() => { setState('loading'); setAttempt(value => value + 1); }, []);
  useEffect(() => {
    let current = true;
    // Invoke the loader anew on retry; reusing the first rejected promise would never recover.
    // Failure is not an anonymous or signed-out identity: Clerk has not answered yet.
    void Promise.resolve().then(load).then((module) => {
      if (current) { setComponents(module); setState('ready'); }
    }, () => { if (current) setState('failed'); });
    return () => { current = false; };
  }, [load, attempt]);
  return (
    <SessionContext.Provider value={session}>
      <SlotContext.Provider value={slots}>
        <ClerkLoadContext.Provider value={{ state, retry, components }}>
          {children}
          {Clerk && <Clerk onSession={report} slots={slots} />}
        </ClerkLoadContext.Provider>
      </SlotContext.Provider>
    </SessionContext.Provider>
  );
}
