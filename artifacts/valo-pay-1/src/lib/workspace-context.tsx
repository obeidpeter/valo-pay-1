import { browserStorageKey } from '@/lib/browser-identity';
import { createContext, useContext, ReactNode, useState, useEffect, useRef } from 'react';
import { useGetWorkspace, Workspace } from '@workspace/valo-pay-1-api-client-react';
import { useSessionUser } from '@/lib/auth';
import { useQueryClient } from '@tanstack/react-query';
import { WorkspaceUnavailable } from '@/components/workspace-unavailable';
import { confirmUnsavedChanges } from './unsaved-changes';
import { workspaceRefreshInterval, workspaceRefreshOnFocus, workspaceWaitUntil } from './query-retry';

/** A background refresh of the workspace on the screen that failed: what failed, what is shown, and the way to try again. */
export type WorkspaceRefreshFailure = {
  error: unknown;
  /** When the workspace on the screen was loaded. */
  updatedAt: number;
  /** When the service asked for a wait, the time before which it is not asked again automatically. */
  waitUntil?: number;
  busy: boolean;
  retry: () => void;
};

type WorkspaceContextType = {
  merchantId: string | null;
  setMerchantId: (id: string) => void;
  workspace: Workspace | undefined;
  isLoading: boolean;
  refreshFailure: WorkspaceRefreshFailure | null;
};

const WorkspaceContext = createContext<WorkspaceContextType | null>(null);
const rememberedLender = (scope: string) => { try { return sessionStorage.getItem(browserStorageKey(`lender:${scope}`)); } catch { return null; } };

/**
 * Loads the caller's workspace and provides it to the console. Only a workspace
 * that could not be loaded at all replaces the console with the failure notice;
 * a refresh that fails keeps every page, form and dialog where it is, and the
 * layout says the workspace could not be refreshed (refreshFailure).
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const {userId,orgId,isLoaded:authLoaded}=useSessionUser();
  const identity = `${userId || 'sandbox'}:${orgId || 'personal'}`;
  // Never hold the anonymous sandbox hostage to a slow or unreachable sign-in service.
  const [authTimedOut,setAuthTimedOut]=useState(false);
  useEffect(()=>{if(authLoaded)return;const timer=setTimeout(()=>setAuthTimedOut(true),5000);return()=>clearTimeout(timer);},[authLoaded]);
  const isLoaded=authLoaded||authTimedOut;
  const queryClient=useQueryClient();
  const previousUser=useRef<string|null|undefined>(undefined);
  // Every thirty seconds, or once the wait a refusal asked for (Retry-After) has passed when that is later.
  const { data: workspace, isLoading,isFetching,error,refetch,status,dataUpdatedAt,errorUpdatedAt } = useGetWorkspace({query:{queryKey:["workspace",identity],enabled:isLoaded,refetchInterval:workspaceRefreshInterval,refetchOnWindowFocus:workspaceRefreshOnFocus}});
  const [selectedMerchant, setMerchantId] = useState<string | null>(null);
  const preferenceScope = workspace?.viewerScope || identity;
  const merchantId=[selectedMerchant, rememberedLender(preferenceScope)].find(id => workspace?.merchants.some(m=>m.id===id)) || workspace?.merchants[0]?.id || null;

  useEffect(() => {
    if(!isLoaded)return;
    if(previousUser.current!==undefined&&previousUser.current!==identity){queryClient.clear();setMerchantId(null);window.history.replaceState(null, '', window.location.pathname);}
    previousUser.current=identity;
  },[identity,isLoaded,queryClient]);

  const retry = () => { void refetch(); };
  const refreshFailure: WorkspaceRefreshFailure | null = error && workspace
    ? { error, updatedAt: dataUpdatedAt, waitUntil: workspaceWaitUntil({ state: { status, error, errorUpdatedAt } }), busy: isFetching, retry }
    : null;

  return (
    <WorkspaceContext.Provider value={{ merchantId, setMerchantId: id => { if (id === merchantId || confirmUnsavedChanges()) { setMerchantId(id); try { sessionStorage.setItem(browserStorageKey(`lender:${preferenceScope}`),id); } catch { /* Selection still works when browser storage is unavailable. */ } } }, workspace, isLoading:isLoading||!isLoaded, refreshFailure }}>
      {error && !workspace ? <WorkspaceUnavailable error={error} retry={retry} busy={isFetching}/> : children}
    </WorkspaceContext.Provider>
  );
}

/** The loaded workspace, the selected lender and the way to change it; only valid inside WorkspaceProvider. */
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
}
