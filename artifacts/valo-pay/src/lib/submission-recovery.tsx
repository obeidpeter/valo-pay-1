import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { useWorkspace } from './workspace-context';

/** Only identities belong in browser storage. The request body and its fingerprint stay in memory or on the server. */
export type SubmissionIdentity = { method: 'POST' | 'PATCH'; path: string; merchantId: string };
export type RememberedSubmission = Omit<SubmissionIdentity, 'merchantId'> & { key: string; page: string; recovered: boolean };
const prefix = 'valopay-submission:v1:';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function read(scope: string): RememberedSubmission[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(prefix + scope) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is RememberedSubmission => Boolean(item && typeof item === 'object' && uuid.test(item.key) && ['POST', 'PATCH'].includes(item.method) && typeof item.path === 'string' && /^\/v1\/[^?#\\\s]+$/.test(item.path) && item.path.length <= 1000 && typeof item.page === 'string' && /^\/[^?#\\\s]*$/.test(item.page) && item.page.length <= 1000)).slice(0, 100).map(item => ({ key: item.key, method: item.method, path: item.path, page: item.page, recovered: true }));
  } catch { return []; }
}
type Recovery = {
  scope: string;
  merchantId: string;
  entries: RememberedSubmission[];
  durable: boolean;
  assertAvailable: (key?: string) => void;
  remember: (key: string, identity: SubmissionIdentity) => void;
  forget: (key: string) => void;
  keep: (key: string) => void;
};
const Context = createContext<Recovery | null>(null);

/** Optional for isolated forms/tests; the real console always provides it. */
export const useSubmissionRecovery = () => useContext(Context);

export function SubmissionRecoveryProvider({ children }: { children: ReactNode }) {
  const { merchantId, workspace } = useWorkspace();
  // viewerScope changes with the authenticated account/organisation or anonymous workspace, not its displayed name.
  const scope = workspace && merchantId ? JSON.stringify([workspace.viewerScope, workspace.actor, workspace.role, merchantId]) : null;
  return <ScopedSubmissionRecoveryProvider scope={scope || ''} merchantId={merchantId || ''}>{children}</ScopedSubmissionRecoveryProvider>;
}

/** The recovery store can change identity without remounting the page or losing an in-flight role-switch response. */
export function ScopedSubmissionRecoveryProvider({ scope, merchantId, children }: { scope: string; merchantId: string; children: ReactNode }) {
  const [page] = useLocation();
  const [, redraw] = useState(0);
  const current = useRef({ scope, entries: read(scope) });
  if (current.current.scope !== scope) current.current = { scope, entries: read(scope) };
  const entries = current.current.entries;
  const [durable, setDurable] = useState(true);
  const save = (next: RememberedSubmission[], required = false) => {
    try {
      if (next.length) sessionStorage.setItem(prefix + scope, JSON.stringify(next.map(({ key, method, path, page }) => ({ key, method, path, page }))));
      else sessionStorage.removeItem(prefix + scope);
    } catch {
      setDurable(false);
      if (required) throw new Error('This browser is blocking the storage Valo Pay uses to stop a request being sent twice. Allow site data for Valo Pay, or use another browser, then try again. Nothing was sent.');
    }
    if (current.current.scope === scope) { current.current.entries = next; redraw(version => version + 1); }
  };
  // An old request finishing after a lender/account change may settle only the marker in its original scope.
  const own = () => current.current.scope === scope ? current.current.entries : read(scope);
  return <Context.Provider value={scope ? { scope, merchantId, entries: entries.filter(entry => entry.page === page && entry.recovered), durable,
    assertAvailable: key => {
      if (own().some(entry => entry.recovered && entry.page === page && entry.key !== key)) throw new Error('An earlier request on this page is not confirmed. Check it in the notice at the top of this page before you send another change.');
    },
    remember: (key, identity) => {
      if (identity.merchantId !== merchantId) throw new Error('The lender changed. Open the form again for the lender you chose.');
      if (own().some(entry => entry.key === key)) return;
      if (own().length >= 100) throw new Error('Too many of your requests are not confirmed. Check them in Request history before you send more changes.');
      save([...own(), { key, method: identity.method, path: identity.path, page, recovered: false }], true);
    },
    forget: key => save(own().filter(entry => entry.key !== key)),
    // Leaving a form or discarding its in-memory draft cannot discard the server-side operation.
    keep: key => save(own().map(entry => entry.key === key ? { ...entry, recovered: true } : entry)),
  } : null}>{children}</Context.Provider>;
}
