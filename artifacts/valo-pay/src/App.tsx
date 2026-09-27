import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Loading } from '@/components/loading';
import { focusMain } from '@/lib/focus';
import { installUnsavedNavigationGuard } from '@/lib/unsaved-changes';
import { QueryClient, QueryClientProvider, type DefaultOptions } from '@tanstack/react-query';
import { retryQuery } from '@/lib/query-retry';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import NotFoundPage from '@/pages/not-found';
import {
  Route,
  Switch,
  matchRoute,
  useLocation,
  useRouter,
  Router as WouterRouter
} from 'wouter';
import { AuthProvider } from '@/lib/auth';

import { WorkspaceProvider } from '@/lib/workspace-context';
import { SubmissionRecoveryProvider } from '@/lib/submission-recovery';
import { Layout } from '@/components/layout';
import { PresentationProvider } from '@/components/presentation-guide';

// Public pages: no workspace, no sandbox. The landing page ships with the shell, since it is the
// first thing a visitor sees; the sign-in pages bring Clerk's form and load only when someone goes there.
import LandingPage from '@/pages/landing';
const SignInPage: PageLoader = () => import('@/pages/sign-in').then((m) => ({ default: m.SignInPage }));
const SignUpPage: PageLoader = () => import('@/pages/sign-in').then((m) => ({ default: m.SignUpPage }));

// When the app loads, before the router first subscribes to the browser's location, so the
// unsaved-changes guard hears Back and Forward before the router changes the page.
installUnsavedNavigationGuard();

// Console pages load on first visit, each in its own chunk, so the landing page does not carry the
// console and the console does not carry every page at once (design rationale, Performance).
const OverviewPage: PageLoader = () => import('@/pages/overview');
const CustomersPage: PageLoader = () => import('@/pages/customers/index');
const CustomerTimelinePage: PageLoader = () => import('@/pages/customers/[id]');
const ReconciliationPage: PageLoader = () => import('@/pages/reconciliation');
const ExceptionsPage: PageLoader = () => import('@/pages/exceptions');
const PoliciesPage: PageLoader = () => import('@/pages/policies');
const MandatesPage: PageLoader = () => import('@/pages/mandates');
const CollectionsPage: PageLoader = () => import('@/pages/collections');
const ReportsPage: PageLoader = () => import('@/pages/reports');
const EvidencePage: PageLoader = () => import('@/pages/evidence');
const AuditPage: PageLoader = () => import('@/pages/audit');
const SettingsPage: PageLoader = () => import('@/pages/settings');
const PayByBankPage: PageLoader = () => import('@/pages/pay-by-bank');
const CreditDeskPage: PageLoader = () => import('@/pages/credit-desk');
const CashDeskPage: PageLoader = () => import('@/pages/cash-desk');
const ConnectionsPage: PageLoader = () => import('@/pages/connections');
const PilotPage: PageLoader = () => import('@/pages/pilot');
const ImportsPage: PageLoader = () => import('@/pages/imports');
const OperationsPage: PageLoader = () => import('@/pages/operations');
const CasePage: PageLoader = () => import('@/pages/case');
const TeamPage: PageLoader = () => import('@/pages/team');
const TeamInvitePage: PageLoader = () => import('@/pages/team-invite');
const CloseReviewPage: PageLoader = () => import('@/pages/close-review');
const SourcesPage: PageLoader = () => import('@/pages/sources');
const WorkPage: PageLoader = () => import('@/pages/work');
const LifecyclePage: PageLoader = () => import('@/pages/lifecycle');
const ExportsPage: PageLoader = () => import('@/pages/exports');
const PresentationPage: PageLoader = () => import('@/pages/presentation');

type PageLoader = () => Promise<{ default: ComponentType<any> }>;
const loadedPages = new Map<PageLoader, ComponentType<any>>();
/** Loads a page's code once; the loader is the key, so a page fetched ahead of time renders at once when visited. */
export function loadPage(load: PageLoader): Promise<ComponentType<any>> {
  const loaded = loadedPages.get(load);
  if (loaded) return Promise.resolve(loaded);
  return load().then((module) => { loadedPages.set(load, module.default); return module.default; });
}

/**
 * A page whose code arrives on its first visit. Plain state rather than Suspense: a committed
 * Suspense fallback is held for 300 ms before the content may replace it, which on a fast connection
 * is most of the wait (design rationale, Performance). Until the code is here the page area says so;
 * a chunk that cannot be fetched is thrown to the error boundary, which shows the page-error notice.
 */
export function LazyPage({ load, ...props }: { load: PageLoader; [prop: string]: unknown }) {
  const [Component, setComponent] = useState<ComponentType<any> | null>(() => loadedPages.get(load) ?? null);
  const [failure, setFailure] = useState<Error | null>(null);
  useEffect(() => {
    let current = true;
    loadPage(load).then((component) => { if (current) setComponent(() => component); }, (error: Error) => { if (current) setFailure(error); });
    return () => { current = false; };
  }, [load]);
  if (failure) throw failure;
  if (!Component) return <Loading what="the page" heading />;
  return <Component {...props} />;
}

/**
 * Fetches pages' code while the browser is idle, in the order given, so a first visit to a page
 * usually finds its code already here. Nothing is requested from the API by this.
 */
function Prefetch({ pages }: { pages: PageLoader[] }) {
  useEffect(() => {
    // Someone who has asked their browser to save data, or is on a 2G connection, gets pages on demand only.
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (connection?.saveData || /2g/.test(connection?.effectiveType || '')) return;
    const run = () => { pages.reduce((previous, load) => previous.then(() => loadPage(load)).catch(() => undefined), Promise.resolve<unknown>(undefined)); };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(run);
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(run, 1500);
    return () => window.clearTimeout(timer);
  }, [pages]);
  return null;
}

/**
 * Shared by the app and reset between console tests. Data fetched in the last
 * thirty seconds is shown at once when a page is returned to, instead of a
 * loading line and a repeated request; an action's invalidation still refetches
 * what it changed, and a tab that comes back after longer refetches on focus.
 * A failed read is repeated, at most twice, only when no answer arrived or the
 * service failed (retryQuery): a refusal such as a 403 or 404 shows at once.
 */
export const QUERY_STALE_MS = 30_000;
export const queryDefaults = { queries: { staleTime: QUERY_STALE_MS, retry: retryQuery } } satisfies DefaultOptions;
export const queryClient = new QueryClient({ defaultOptions: queryDefaults });

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Every address the console has a page for. Anything else is not found, and gets no workspace. */
const consoleRoutes: Array<{ path: string; load: PageLoader }> = [
  { path: '/overview', load: OverviewPage },
  { path: '/customers', load: CustomersPage },
  { path: '/customers/:id', load: CustomerTimelinePage },
  { path: '/reconciliation', load: ReconciliationPage },
  { path: '/exceptions', load: ExceptionsPage },
  { path: '/policies', load: PoliciesPage },
  { path: '/mandates', load: MandatesPage },
  { path: '/collections', load: CollectionsPage },
  { path: '/reports', load: ReportsPage },
  { path: '/evidence', load: EvidencePage },
  { path: '/audit', load: AuditPage },
  { path: '/settings', load: SettingsPage },
  { path: '/pay-by-bank', load: PayByBankPage },
  { path: '/credit-desk', load: CreditDeskPage },
  { path: '/cash-desk', load: CashDeskPage },
  { path: '/connections', load: ConnectionsPage },
  { path: '/pilot', load: PilotPage },
  { path: '/imports', load: ImportsPage },
  { path: '/operations', load: OperationsPage },
  { path: '/cases/:id', load: CasePage },
  { path: '/team', load: TeamPage },
  { path: '/close-review', load: CloseReviewPage },
  { path: '/sources', load: SourcesPage },
  { path: '/work', load: WorkPage },
  { path: '/lifecycle', load: LifecyclePage },
  { path: '/exports', load: ExportsPage },
  { path: '/presentation', load: PresentationPage },
];
const consolePages = consoleRoutes.map((route) => route.load);
const overviewOnly = [OverviewPage];

/**
 * The console mounts once for every address it has a page for, so the
 * workspace and the chosen lender survive navigation. Any other address gets
 * the not-found page outside the workspace provider: a mistyped address or a
 * stray crawler creates no sandbox (frontend contract, Pages).
 */
function Console() {
  const [location] = useLocation();
  const { parser } = useRouter();
  const known = consoleRoutes.some((route) => matchRoute(parser, route.path, location)[0]);
  if (!known) return <NotFoundPage />;
  return (
    <WorkspaceProvider>
      <SubmissionRecoveryProvider>
      <PresentationProvider>
      <Layout>
        {/* A page's code arrives on its first visit; the sidebar and the lender stay meanwhile, and the
            other pages are fetched while the browser is idle. */}
        <Switch>
          {consoleRoutes.map((route) => <Route key={route.path} path={route.path}>{(params) => <LazyPage load={route.load} params={params} />}</Route>)}
        </Switch>
        <Prefetch pages={consolePages} />
      </Layout>
      </PresentationProvider>
      </SubmissionRecoveryProvider>
    </WorkspaceProvider>
  );
}

/**
 * After in-app navigation, focus moves to the page's main region, as it would
 * on a page load, so keyboard and screen-reader users start at the top of what
 * changed instead of on a link that may no longer exist.
 */
function RouteFocus() {
  const [location] = useLocation();
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (previous.current !== null && previous.current !== location) focusMain();
    previous.current = location;
  }, [location]);
  return null;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  // Sign-in, where it is wanted, loads beside the routes and never remounts them (lib/auth.tsx).
  return (
    <WouterRouter base={basePath}>
      <AuthProvider>
        <QueryClientProvider client={queryClient}>
          <RoutedErrorBoundary>
            <Switch>
              {/* The public pages sit outside the workspace provider: reading about the product or
                  signing in never creates a sandbox. The workspace request happens only once someone
                  opens the console. The landing page fetches the overview's code while idle, since
                  "Open the sandbox" leads there. */}
              <Route path="/">{() => <><LandingPage /><Prefetch pages={overviewOnly} /></>}</Route>
              <Route path="/sign-in/*?">{(params) => <LazyPage load={SignInPage} params={params} />}</Route>
              <Route path="/sign-up/*?">{(params) => <LazyPage load={SignUpPage} params={params} />}</Route>
              <Route path="/team-invite">{() => <LazyPage load={TeamInvitePage} />}</Route>
              <Route component={Console} />
            </Switch>
          </RoutedErrorBoundary>
          <RouteFocus />
          <Toaster />
        </QueryClientProvider>
      </AuthProvider>
    </WouterRouter>
  );
}

export default App;
