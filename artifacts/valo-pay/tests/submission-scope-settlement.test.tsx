import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '@workspace/api-client-react';
import { useConnected } from '@/lib/connected';
import { useSafePerformAction } from '@/lib/safe-mutations';
import { ScopedSubmissionRecoveryProvider } from '@/lib/submission-recovery';
import * as workspaceContext from '@/lib/workspace-context';
import { installFakeApi, type FakeApi } from './fake-api';

type Adapter = 'standard' | 'connected';
type HeldRequest = { key: string; finish: (response: Response) => void };
const requests: HeldRequest[] = [];
let api: FakeApi;
let workspace: Workspace;
let merchantId: string;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});
const receipt = (adapter: Adapter) => adapter === 'standard'
  ? { message: 'Saved.', data: {} }
  : { message: 'Already initialised.', record: { message: 'Already initialised.', data: { synthetic: true } }, mode: 'synthetic', externalInstructionPerformed: false };
const scope = () => JSON.stringify([workspace.viewerScope, workspace.actor, workspace.role, merchantId]);
const stored = (identity: string): Array<{ key: string }> => JSON.parse(sessionStorage.getItem(`valopay-submission:v1:${identity}`) || '[]');

beforeEach(async () => {
  window.history.replaceState({}, '', '/cash-desk');
  sessionStorage.clear();
  requests.length = 0;
  api = installFakeApi();
  workspace = await (await fetch('/api/v1/workspace')).json() as Workspace;
  merchantId = api.merchantIds[0]!;
  vi.spyOn(workspaceContext, 'useWorkspace').mockImplementation(() => ({
    merchantId, workspace, setMerchantId: vi.fn(), isLoading: false, refreshFailure: null,
  }));
  const send = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(String(input), 'http://localhost');
    if (options?.method !== 'POST' || !['/api/v1/actions', '/api/v1/connected/actions'].includes(url.pathname)) {
      return send(input, options);
    }
    return new Promise<Response>(finish => {
      requests.push({ key: new Headers(options.headers).get('Idempotency-Key')!, finish });
    });
  };
});

afterEach(() => { cleanup(); sessionStorage.clear(); api.uninstall(); });

function useStandardAction() {
  const mutation = useSafePerformAction(undefined, merchantId);
  return {
    ready: true,
    held: mutation.hasUnconfirmedOutcome,
    submit: () => mutation.mutateAsync({ params: { merchantId }, data: { action: 'allocate_payment', reason: 'Synthetic scope recovery check' } }),
  };
}
function useConnectedAction() {
  const mutation = useConnected();
  return {
    ready: Boolean(mutation.data),
    held: mutation.hasUnconfirmedOutcome,
    submit: () => mutation.run('cash.initialize', {}, undefined, 'Synthetic scope recovery check'),
  };
}
function mount(adapter: Adapter) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Router><QueryClientProvider client={client}>
      <ScopedSubmissionRecoveryProvider scope={scope()} merchantId={merchantId}>{children}</ScopedSubmissionRecoveryProvider>
    </QueryClientProvider></Router>
  );
  const useAction = adapter === 'standard' ? useStandardAction : useConnectedAction;
  return renderHook(() => useAction(), { wrapper });
}

describe.each<Adapter>(['standard', 'connected'])('%s submission settlement across role changes', adapter => {
  it.each(['success', 'cancelled'] as const)('keeps the new request intact when the old scope receives %s', async outcome => {
    const hook = mount(adapter);
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    const originalScope = scope();
    let first!: Promise<unknown>;
    act(() => { first = hook.result.current.submit().catch(error => error); });
    await waitFor(() => expect(requests).toHaveLength(1));
    const firstRequest = requests[0]!;

    workspace = { ...workspace, role: workspace.role === 'Finance' ? 'Admin' : 'Finance' };
    hook.rerender();
    const newScope = scope();
    let second!: Promise<unknown>;
    act(() => { second = hook.result.current.submit().catch(error => error); });
    await waitFor(() => expect(requests).toHaveLength(2));
    const secondRequest = requests[1]!;
    expect(secondRequest.key).not.toBe(firstRequest.key);

    await act(async () => {
      firstRequest.finish(outcome === 'success'
        ? json(receipt(adapter))
        : json({ error: 'This request was cancelled.', operation: 'cancelled' }, 409));
      await first;
    });
    expect(stored(newScope)).toEqual([expect.objectContaining({ key: secondRequest.key })]);
    // Connected failures detached by a scope change remain available for recovery in their original context.
    expect(stored(originalScope)).toEqual(adapter === 'connected' && outcome === 'cancelled'
      ? [expect.objectContaining({ key: firstRequest.key })]
      : []);

    await act(async () => { await expect(hook.result.current.submit()).rejects.toThrow('still in progress'); });
    expect(requests).toHaveLength(2);
    await act(async () => {
      secondRequest.finish(json({ error: 'The outcome is unavailable.' }, 503));
      await second;
    });
    // The deliberate third submission moved React Query's observer; inspect the older attempt on the next render.
    hook.rerender();
    await waitFor(() => expect(hook.result.current.held).toBe(true));
    expect(stored(newScope)).toEqual([expect.objectContaining({ key: secondRequest.key })]);
  });
});

it('refuses a connected write before sending when its recovery marker cannot be stored', async () => {
  const hook = mount('connected');
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  const denied = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage disabled', 'SecurityError'); });
  await act(async () => { await expect(hook.result.current.submit()).rejects.toThrow('Nothing was submitted'); });
  expect(requests).toHaveLength(0);
  denied.mockRestore();

  let sent!: Promise<unknown>;
  act(() => { sent = hook.result.current.submit(); });
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => { requests[0]!.finish(json(receipt('connected'))); await sent; });
  expect(stored(scope())).toEqual([]);
});
