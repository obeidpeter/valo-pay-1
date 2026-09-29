import React, { type ComponentType, ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useWorkspace } from '@/lib/workspace-context';
import { AuthShow, useSignOut } from '@/lib/auth';
import { type LucideIcon, LayoutDashboard, Inbox, AlertTriangle, Scale, ArrowRightLeft, Upload, ClipboardCheck, Users, FileSignature, ScrollText, Landmark, ShieldCheck, Building2, KeyRound, FileBarChart, Download, History, BadgeCheck, Route, Database, Activity, UserCog, Archive, Settings, Presentation, Lock, LogOut, Menu, Sun, Moon, ChevronRight, Layers } from 'lucide-react';
import { Button } from './ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from './ui/sheet';
import { BrandLockup } from './brand';
import { ErrorBoundary, ErrorNotice } from './error-boundary';
import { focusMain, useConsoleViewportReset, useDialogActivationTracking } from '@/lib/focus';
import { formatDate } from '@/lib/formatters';
import { useTheme } from '@/lib/theme';
import { SandboxGuide } from './sandbox-guide';
import { PresentationGuide, usePresentation } from './presentation-guide';
import { useQueuePosition } from '@/lib/queue-position';
import { WorkspaceRefreshProblem } from './workspace-unavailable';
import { SubmissionRecoveryNotice } from './submission-recovery-notice';
import { getCountPendingOperationsQueryKey, useCountPendingOperations } from '@workspace/api-client-react';
import { ContextualHelp } from './contextual-help';
import type { HelpTopicId } from '@/lib/help-content';

const pageDescriptions: Record<string, string> = {
  '/overview': 'See what needs attention and where to start.',
  '/work': 'Find your assigned issues and handovers.',
  '/exceptions': 'Issues that need investigation and a recorded resolution.',
  '/reconciliation': 'Match payments to bills or repayments.',
  '/collections': 'Track repayments and collection attempts.',
  '/imports': 'Review a file, save a batch and commit valid records.',
  '/close-review': 'Prepare a close for a separate reviewer.',
  '/customers': 'Find a customer and their payment history.',
  '/mandates': 'Permissions for recurring bank debits.',
  '/policies': 'Review collection rules and message templates.',
  '/pay-by-bank': 'Create and track a request to pay an instalment.',
  '/credit-desk': 'Prepare and review an applicant’s assessment.',
  '/cash-desk': 'Understand business cash and prepare accounting or payroll work.',
  '/connections': 'Review specific permissions and capability readiness.',
  '/reports': 'Review results, billing and daily close evidence.',
  '/exports': 'Retrieve generated files and check their saved status.',
  '/audit': 'Inspect the history of recorded changes.',
  '/evidence': 'Review commercial terms and go-live requirements.',
  '/pilot': 'Follow saved progress or set up a lender.',
  '/sources': 'Describe incoming files and provider evidence.',
  '/operations': 'Check unconfirmed requests before sending them again.',
  '/team': 'Review invitations and staff access.',
  '/lifecycle': 'Administrator controls for data retention.',
  '/settings': 'Review workspace settings and keyboard shortcuts.',
  '/presentation': 'Explore a guided sample presentation.',
};
const helpTopics: Record<string, HelpTopicId> = {
  '/overview': 'start', '/work': 'cases', '/exceptions': 'cases', '/reconciliation': 'matching',
  '/collections': 'matching', '/imports': 'imports', '/close-review': 'close', '/customers': 'exports',
  '/mandates': 'mandates', '/policies': 'policies', '/pay-by-bank': 'payment-status',
  '/credit-desk': 'credit-review', '/cash-desk': 'cash', '/connections': 'permissions',
  '/reports': 'close', '/exports': 'exports', '/audit': 'recovery', '/evidence': 'start',
  '/pilot': 'start', '/sources': 'imports', '/operations': 'recovery', '/team': 'access',
  '/lifecycle': 'exports', '/settings': 'start', '/presentation': 'start',
};

type NavItem = { href: string; label: string; icon: LucideIcon };
/**
 * The console's pages in named groups, daily work first, each with its own
 * label and icon: the sidebar, the phone drawer and the page title all read
 * this one list, so a page is found in the same place on every screen.
 */
const navGroups: Array<{ id: string; label: string; items: NavItem[] }> = [
  { id: 'daily', label: 'Daily work', items: [
    { href: '/overview', label: 'Overview', icon: LayoutDashboard },
    { href: '/work', label: 'My work', icon: Inbox },
    { href: '/exceptions', label: 'Exceptions', icon: AlertTriangle },
    { href: '/reconciliation', label: 'Reconciliation', icon: Scale },
    { href: '/collections', label: 'Collections', icon: ArrowRightLeft },
    { href: '/imports', label: 'Import batches', icon: Upload },
    { href: '/close-review', label: 'Close review', icon: ClipboardCheck },
  ] },
  { id: 'customers', label: 'Customers and policies', items: [
    { href: '/customers', label: 'Customers', icon: Users },
    { href: '/mandates', label: 'Mandates', icon: FileSignature },
    { href: '/policies', label: 'Policies & templates', icon: ScrollText },
  ] },
  { id: 'connected', label: 'Connected banking', items: [
    { href: '/pay-by-bank', label: 'Pay-by-bank', icon: Landmark },
    { href: '/credit-desk', label: 'Credit Desk', icon: ShieldCheck },
    { href: '/cash-desk', label: 'Cash Desk', icon: Building2 },
    { href: '/connections', label: 'Permissions & readiness', icon: KeyRound },
  ] },
  { id: 'oversight', label: 'Oversight', items: [
    { href: '/reports', label: 'Reports', icon: FileBarChart },
    { href: '/exports', label: 'Saved exports', icon: Download },
    { href: '/audit', label: 'Audit log', icon: History },
    { href: '/evidence', label: 'Go-live evidence', icon: BadgeCheck },
  ] },
  { id: 'setup', label: 'Setup and administration', items: [
    { href: '/pilot', label: 'Pilot journey', icon: Route },
    { href: '/sources', label: 'Data sources', icon: Database },
    { href: '/operations', label: 'Operations', icon: Activity },
    { href: '/team', label: 'Team & access', icon: UserCog },
    { href: '/lifecycle', label: 'Data retention', icon: Archive },
    { href: '/settings', label: 'Settings', icon: Settings },
    { href: '/presentation', label: 'Presentation', icon: Presentation },
  ] },
];
const navItems = navGroups.flatMap(group => group.items);

/**
 * Scrolls a list of pages so the current page's link is in view, moving the
 * list alone and never the page. A link out of view is brought to the
 * middle, so the pages around it show too.
 */
export function revealCurrentPage(list: HTMLElement | null): void {
  const current = list?.querySelector<HTMLElement>('[aria-current="page"]');
  if (!list || !current) return;
  const frame = list.getBoundingClientRect(), link = current.getBoundingClientRect();
  if (link.top >= frame.top && link.bottom <= frame.bottom) return;
  list.scrollTop += link.top - frame.top - (frame.height - link.height) / 2;
}

/**
 * One list of links for the sidebar and the phone drawer, so the console is
 * learnt once and looks the same on every screen. The drawer's rows are taller
 * because they are pressed with a thumb, not a pointer.
 */
function NavLinks({ location, spacious = false, onNavigate, pending = 0 }: { location: string; spacious?: boolean; onNavigate?: () => void; pending?: number }) {
  // The sidebar and the drawer each render the list, so their group names need ids of their own.
  const id = useId();
  const { workspace } = useWorkspace();
  const [filter, setFilter] = useState('');
  const searchBox = useRef<HTMLInputElement>(null);
  const normalise = (value: string) => value.toLocaleLowerCase().replace(/[-&]/g, ' ').replace(/\s+/g, ' ').trim();
  const query = normalise(filter);
  const groups = navGroups.map(group => ({ ...group, items: group.items.filter(item =>
    (item.href !== '/lifecycle' || workspace?.role === 'Admin') &&
    (!query || query.split(' ').every(word => normalise(`${item.label} ${pageDescriptions[item.href]}`).includes(word)))
  ) })).filter(group => group.items.length);
  const pageCount = groups.reduce((count, group) => count + group.items.length, 0);
  return (
    <>
      <div className="mb-3">
        <label htmlFor={`${id}-find-page`} className="mb-1 block px-1 text-xs font-medium">Find a page</label>
        <input ref={searchBox} id={`${id}-find-page`} type="search" value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && filter) { event.stopPropagation(); setFilter(''); } }} placeholder="Try payments or payroll" className="min-h-10 w-full rounded-lg border bg-background px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" />
        {/* Kept on the page while empty, since a screen reader announces a live region's changes, not its arrival: polite
            and whole like a status, without a second status role beside the page's own. Empty, its margin adds no space. */}
        <p aria-live="polite" aria-atomic="true" className="mt-1 px-1 text-xs text-muted-foreground">{query && `${pageCount} ${pageCount === 1 ? 'page' : 'pages'} found. This searches page names, not records.`}</p>
        {/* Clearing removes this button, so focus goes back to the search rather than falling to the page or the drawer. */}
        {query && <button type="button" onClick={() => { setFilter(''); searchBox.current?.focus(); }} className="mt-1 min-h-9 px-1 text-xs font-medium underline">Clear page search</button>}
      </div>
      {groups.map((group, index) => (
        <div key={group.id} role="group" aria-labelledby={`${id}-${group.id}`} className="space-y-0.5">
          <p id={`${id}-${group.id}`} className={`nav-group-label ${index > 0 ? 'mt-2' : 'mt-0'}`}>{group.label}</p>
          {group.items.map(item => {
            const active = location === item.href || location.startsWith(`${item.href}/`);
            return (
              <Link key={item.href} href={item.href} aria-label={item.href === '/operations' && pending > 0 ? `${item.label}, ${pending} unconfirmed ${pending === 1 ? 'request' : 'requests'}` : item.label} aria-describedby={`${id}-${item.href.slice(1)}-purpose`} aria-current={active ? 'page' : undefined} onClick={() => { setFilter(''); onNavigate?.(); }} className={`console-nav-link flex items-center gap-3 px-3 rounded-lg text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${spacious ? 'py-3' : 'py-1.5'} ${active ? 'is-active' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}>
                <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0">{item.label}<span id={`${id}-${item.href.slice(1)}-purpose`} className={query || spacious || ['/overview', '/collections', '/pay-by-bank', '/credit-desk', '/cash-desk'].includes(item.href) ? 'mt-0.5 block text-[11px] font-normal leading-snug' : 'sr-only'}>{pageDescriptions[item.href]}</span></span>
                {item.href === '/operations' && pending > 0 && <><span aria-hidden="true" className="ml-auto rounded-full bg-warning px-2 text-[11px] font-semibold text-warning-foreground">{pending}</span><span className="sr-only">, {pending} unconfirmed {pending === 1 ? 'request' : 'requests'}</span></>}
              </Link>
            );
          })}
        </div>
      ))}
      {!groups.length && <p className="p-2 text-sm text-muted-foreground">No pages match. Try a task such as payments, imports or reports.</p>}
    </>
  );
}

/**
 * The warning above every page for a staff administrator whose access, or the last administrator's, ends soon. Its
 * code reads the team through the shared schemas, so only a staff administrator loads it, after the shell: the
 * landing page and the sandbox never fetch it (design rationale, Performance). A chunk that cannot be fetched leaves
 * the page as it is, since the warning is advice and Team & access shows every expiry.
 */
function AdministratorExpiryWarning() {
  const [Warning, setWarning] = useState<ComponentType | null>(null);
  useEffect(() => {
    let current = true;
    import('./administrator-expiry').then((module) => { if (current) setWarning(() => module.AdministratorExpiry); }, () => undefined);
    return () => { current = false; };
  }, []);
  return Warning ? <Warning /> : null;
}

/**
 * How many of the viewer's requests in the selected lender wait for confirmation. A person who lost a form's answer
 * and reloaded sees the count on the Operations link, where the request can be checked (backlog decision UX-B02). Read
 * through the generated client, as the workspace is, so the shell carries no schemas; a count that is not a number
 * shows nothing.
 */
function usePendingOperations(merchantId: string | null, ready: boolean): number {
  const params = { merchantId: merchantId || '' };
  const pending = useCountPendingOperations(params, { query: { queryKey: getCountPendingOperationsQueryKey(params), enabled: ready && !!merchantId } }).data?.pending;
  return typeof pending === 'number' && Number.isSafeInteger(pending) && pending > 0 ? pending : 0;
}

/** Sign in or sign out, the same block at the foot of the sidebar and of the drawer. */
function AuthBlock({ role, signOut }: { role: string | undefined; signOut: () => void }) {
  return (
    <>
      <AuthShow when="signed-in">
        <div className="flex items-center justify-between mb-4">
          <Button variant="ghost" size="sm" onClick={() => signOut()} className="gap-2 text-muted-foreground">
            <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out
          </Button>
          <div className="text-xs font-mono text-muted-foreground bg-secondary px-2 py-1 rounded">
            {role || 'User'}
          </div>
        </div>
      </AuthShow>
      <AuthShow when="signed-out">
        <Link href="/sign-in" className="flex items-center justify-center gap-2 w-full bg-primary text-primary-foreground py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors mb-2">
          <Lock className="h-4 w-4" aria-hidden="true" /> Sign in
        </Link>
        <p className="text-xs text-center text-muted-foreground">Keep a workspace linked to your account</p>
      </AuthShow>
    </>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const presentation = usePresentation();
  useConsoleViewportReset();
  useDialogActivationTracking();
  const search = useSearch();
  const embedded = new URLSearchParams(search).get('embedded') === '1';
  const { workspace, merchantId, setMerchantId, isLoading, refreshFailure } = useWorkspace();
  const pending = usePendingOperations(merchantId, !!workspace);
  const [location] = useLocation();
  const signOut = useSignOut();
  const { theme, setChoice } = useTheme();
  const mainRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  useQueuePosition(mainRef, `${location}?${search}`, `${merchantId}:${workspace?.actor}:${workspace?.role}`);

  // The title names the page, or says the page stopped working while the boundary below shows its notice.
  const [pageError,setPageError]=useState<Error|null>(null);
  useEffect(()=>{document.title=`${pageError?"Page error":navItems.find(n=>n.href===location)?.label||(location.startsWith("/cases/")?"Case handling":"Customer timeline")} · Valo Pay`;},[location,pageError]);

  // The phone drawer. It opens with focus on the first page, closes when a page is chosen in it or the
  // address changes (the browser's back), and then focus goes to the page content as it does after the
  // sidebar; closed any other way (Escape, the close button, a tap outside) focus returns to the Menu
  // button. It also closes if the window grows past the sidebar breakpoint, where its button is no longer shown.
  const [menuOpen, setMenuOpen] = useState(false);
  const openedAt = useRef(location);
  const currentLocation = useRef(location);
  currentLocation.current = location;
  const drawerPages = useRef<HTMLElement>(null);
  // A long list may put the current page below the fold of a short window: keep its link in view, also when the
  // list's height changes, as it does when the lender selector arrives with the workspace or the window is resized.
  const sidebarPages = useRef<HTMLElement>(null);
  useEffect(() => {
    const list = sidebarPages.current;
    revealCurrentPage(list);
    if (!list) return;
    const resized = new ResizeObserver(() => revealCurrentPage(list));
    resized.observe(list);
    return () => resized.disconnect();
  }, [location]);
  useEffect(() => { if (location !== openedAt.current) setMenuOpen(false); }, [location]);
  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    // CSS uses the shell's available width in rem, so enlarged root text also switches to the drawer.
    // Observe its actual visibility instead of duplicating a viewport-only breakpoint in JavaScript.
    const observer = new ResizeObserver(() => { if (sidebar.getClientRects().length && getComputedStyle(sidebar).display !== 'none') setMenuOpen(false); });
    observer.observe(sidebar);
    return () => observer.disconnect();
  }, []);
  // Paper carries what the screen's chrome carried: the lender, the sandbox notice, and when it was printed.
  // The time is taken again as the print dialog opens, since a page can sit open for a day before it is printed.
  const lender = workspace?.merchants.find(m => m.id === merchantId);
  // Only a staff pilot's administrator can be warned that administrator access ends: never the sandbox, whatever its role.
  const staffAdministrator = workspace?.accessMode === 'staff' && workspace.role === 'Admin';
  const lenderName = lender?.name;
  const pageTitle = navItems.find(n => n.href === location)?.label || (location.startsWith('/cases/') ? 'Case handling' : 'Customer timeline');
  const baseRoute = location.startsWith('/cases/') ? '/exceptions' : location.startsWith('/customers/') ? '/customers' : location;
  const cashView = new URLSearchParams(search).get('view');
  // A Cash Desk section has a guide of its own, and its help returns to that section rather than to the first.
  const cashSection = baseRoute === '/cash-desk' && ['accounting', 'vat', 'payroll'].includes(cashView || '') ? cashView as HelpTopicId : null;
  const helpTopic: HelpTopicId = cashSection || helpTopics[baseRoute] || 'start';
  const helpReturn = cashSection ? `${baseRoute}?view=${cashSection}` : baseRoute;
  const [printedAt, setPrintedAt] = useState(() => formatDate(new Date().toISOString()));
  useEffect(() => {
    const stamp = () => setPrintedAt(formatDate(new Date().toISOString()));
    window.addEventListener('beforeprint', stamp);
    return () => window.removeEventListener('beforeprint', stamp);
  }, []);
  const lenderSelect = (id: string, className: string) => (
    <select id={id} className={className} value={merchantId || ''} onChange={(e) => setMerchantId(e.target.value)}>
      {workspace?.merchants.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select>
  );

  return (
    <div className="console-shell h-dvh min-h-0 flex flex-col bg-background print:block print:h-auto print:min-h-0">
      {/* The first tab stop skips the banner, the lender selector and eleven links (universal design: low physical effort). */}
      <a href="#main" onClick={focusMain} className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground">Skip to page content</a>
      {/* The banner and the phone bar are the page's header landmark, so no content sits outside a landmark. */}
      <header>
      {/* Sandbox banner: on a phone it keeps the sentence that matters and drops the restatement, so it stays one line. */}
      <div className="environment-strip px-4 py-2 text-[11px] font-medium flex items-center justify-center gap-2 border-b z-50 print:hidden">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>Sandbox · Sample data. We never hold money.<span className="hidden sm:inline"> Live instructions are disabled.</span></span>
        {workspace?.environment && <span className="ml-2 hidden sm:inline-block text-[10px] uppercase tracking-wider rounded border px-2 py-0.5">Environment: {workspace.environment}</span>}
      </div>

      {/* Phone bar: the brand, the lender being worked on, and the drawer with the same pages as the sidebar. */}
      <div className="console-phone-bar sticky top-0 z-40 flex flex-wrap items-center gap-2 border-b bg-card px-3 py-2 print:hidden">
        <BrandLockup descriptor={false} compact className="shrink-0" />
        <label htmlFor="lender-phone" className="sr-only">Active lender</label>
        {lenderSelect('lender-phone', 'min-w-0 flex-1 rounded-md border bg-secondary p-2 text-sm text-secondary-foreground')}
        <Sheet open={menuOpen} onOpenChange={(open) => { if (open) openedAt.current = location; setMenuOpen(open); }}>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm" className="shrink-0 gap-2">
              <Menu className="h-4 w-4" aria-hidden="true" /> Menu
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="flex w-72 max-w-[90vw] flex-col p-0" aria-describedby={undefined}
            onEscapeKeyDown={(event) => { if (event.target instanceof HTMLInputElement && event.target.type === 'search' && event.target.value) event.preventDefault(); }}
            onOpenAutoFocus={(event) => { event.preventDefault(); (drawerPages.current?.querySelector<HTMLElement>('a[aria-current="page"]') ?? drawerPages.current?.querySelector('a'))?.focus(); }}
            onCloseAutoFocus={(event) => { if (currentLocation.current !== openedAt.current || (sidebarRef.current?.getClientRects().length && getComputedStyle(sidebarRef.current).display !== 'none')) { event.preventDefault(); focusMain(); } }}>
            <SheetHeader className="border-b p-4 pr-12 text-left">
              <SheetTitle className="text-base">Menu</SheetTitle>
            </SheetHeader>
            <nav ref={drawerPages} aria-label="Pages" className="flex-1 overflow-y-auto p-3 space-y-1">
              <NavLinks location={location} spacious onNavigate={() => setMenuOpen(false)} pending={pending} />
            </nav>
            <div className="border-t p-4">
              <Link href="/help" onClick={() => setMenuOpen(false)} className="mb-3 flex min-h-11 items-center text-sm font-semibold underline">Help & glossary</Link>
              <AuthBlock role={workspace?.role} signOut={signOut} />
            </div>
          </SheetContent>
        </Sheet>
      </div>
      </header>
      <div className="flex flex-1 overflow-hidden print:block print:overflow-visible">
        {/* Sidebar */}
        <aside ref={sidebarRef} aria-label="Console sidebar" className="console-sidebar w-60 border-r bg-card flex-col shrink-0 print:hidden">
          <div className="px-5 py-3 flex items-center justify-between">
            <BrandLockup descriptor={false} />
            <span className="text-[9px] tracking-widest uppercase text-muted-foreground border rounded px-1.5 py-1">Console</span>
          </div>

          {/* Lender selector */}
          {workspace && workspace.merchants.length > 0 && (
            <div className="mx-3 mb-1 rounded-xl border bg-background px-3 py-2.5">
              <label htmlFor="lender-sidebar" className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase mb-1 block">Active lender</label>
              {lenderSelect('lender-sidebar', 'w-full bg-transparent text-foreground rounded text-xs font-semibold py-1 border-none focus-visible:outline-2 focus-visible:outline-ring')}
            </div>
          )}

          <nav ref={sidebarPages} aria-label="Pages" className="flex-1 overflow-y-auto px-3 py-2 space-y-0.5">
            <NavLinks location={location} pending={pending} />
          </nav>

          <div className="p-3 border-t mt-auto">
            <Link href="/help" className="mb-2 flex min-h-10 items-center px-2 text-sm font-semibold underline-offset-4 hover:underline">Help & glossary</Link>
            {/* The sidebar has to fit a 720 px window with every page in view (measured in the design rationale), so this row stays one line high. */}
            <div className="flex items-center gap-3 [&:not(:last-child)]:mb-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary"><Layers className="h-4 w-4 text-muted-foreground" aria-hidden="true" /></span>
              <div className="min-w-0 flex-1"><p className="text-xs font-semibold">Sandbox workspace</p><p className="text-[10px] text-muted-foreground mt-0.5">Sample data only</p></div>
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setChoice(theme === 'dark' ? 'light' : 'dark')}>
                {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
              </Button>
            </div>
            <AuthBlock role={workspace?.role} signOut={signOut} />
          </div>
        </aside>

        {/* Main Content */}
        <main ref={mainRef} id="main" tabIndex={-1} className="min-w-0 flex-1 overflow-auto bg-background focus:outline-none print:overflow-visible">
          <div className="workspace-bar flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 md:px-8 print:hidden">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs"><span className="text-muted-foreground">Workspace</span><ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" /><span className="font-medium">{pageTitle}</span></div>
            <p aria-live="polite" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"><span>{workspace?.accessMode === 'staff' ? 'Role' : 'Demo role'}: <strong className="font-semibold">{workspace?.role || 'Loading…'}</strong></span>{lender?.mode && <span>Mode: <strong className="font-semibold">{lender.mode}</strong></span>}<span className="text-muted-foreground">Times in WAT</span></p>
          </div>
          <div className="console-content p-4 sm:p-6 md:p-8 max-w-[1440px] mx-auto print:max-w-none print:p-0" aria-busy={isLoading && !workspace}>
            {!embedded && <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b pb-3 text-xs print:hidden"><p className="text-muted-foreground">{pageDescriptions[baseRoute]}</p><ContextualHelp topic={helpTopic} returnTo={helpReturn} /></div>}
            {/* Print only: the provenance the screen's banner and sidebar carried. */}
            <div className="hidden print:block mb-6 border-b pb-3">
              <div className="flex items-baseline justify-between gap-4 text-sm">
                <span className="font-bold">Valo Pay · Sample data sandbox</span>
                {lenderName && <span>{lenderName}</span>}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Sample data only. We never hold money. This is not a live payment record or a statement of account.</p>
            </div>
            {/* A refresh that failed keeps the pages, their forms and dialogs, and says so above them. */}
            {refreshFailure && <WorkspaceRefreshProblem failure={refreshFailure} staff={workspace?.accessMode === 'staff'} />}
            <SubmissionRecoveryNotice />
            {/* Until the workspace arrives the pages have no lender to show, so the page area says what is happening instead,
                as its heading. A page that stops working keeps the sidebar and the lender selector as the way out. */}
            {isLoading && !workspace
              ? <h1 className="text-sm font-normal text-muted-foreground"><span role="status">Loading your workspace…</span></h1>
              : <>{/* The presentation toolbar sits above the page's boundary, so a page that stops working keeps it and its End presentation. */}{!embedded && <PresentationGuide />}{!embedded && staffAdministrator && <AdministratorExpiryWarning />}<ErrorBoundary resetKey={location} FallbackComponent={ErrorNotice} onErrorChange={setPageError}>{!embedded && !presentation.state.active && !location.startsWith('/cases/') && !['/presentation','/pilot','/imports','/operations','/team','/pay-by-bank','/credit-desk','/cash-desk','/connections'].includes(location) && <SandboxGuide />}{/* The page's own content, apart from the guides above it: where focus moves on within the page (discard-original-request). */}<div data-page-content="" className="contents">{children}</div></ErrorBoundary></>}
            <p className="hidden print:block mt-8 border-t pt-3 text-xs text-muted-foreground">Printed {printedAt} from the Valo Pay sandbox · {pageTitle}{lenderName ? ` · ${lenderName}` : ''}.</p>
          </div>
        </main>
      </div>
    </div>
  );
}
