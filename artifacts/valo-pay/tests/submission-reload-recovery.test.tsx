import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState, type ReactNode } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { ScopedSubmissionRecoveryProvider } from '@/lib/submission-recovery';
import { SubmissionRecoveryNotice } from '@/components/submission-recovery-notice';
import { useSafePerformAction } from '@/lib/safe-mutations';
import { RecordDialog } from '@/components/record-dialog';
import * as workspaceContext from '@/lib/workspace-context';

const identity = { merchantId: 'lender-one', viewerScope: 'viewer-one', actor: 'staff-one', role: 'Finance' };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const requests: Array<{ path: string; key: string | null; body: unknown }> = [];
let status: 'pending' | 'completed' | 'cancelled' | null;
let lookupStatus: number;
let loseAnswer: boolean;
let cancelLost: boolean;
function operation() {
  return status && { id: 'original-operation', label: 'Allocate a payment', actor: identity.actor, role: identity.role, status,
    createdAt: '2026-09-27T10:00:00Z', updatedAt: '2026-09-27T10:00:00Z', message: status === 'completed' ? 'Valo Pay saved this request.' : status === 'cancelled' ? 'The request was cancelled and saved nothing.' : 'Completion is not confirmed.', recordId: null, recordKind: null, summary: null };
}
function Form() {
  // Real page callers often scope the form to its lender, leaving recovery to distinguish actors and roles.
  const mutation = useSafePerformAction(undefined, identity.merchantId);
  return <><button type="button" onClick={() => mutation.mutate({ params: { merchantId: identity.merchantId }, data: { action: 'allocate_payment', recordId: 'private-record', reason: 'Private customer evidence never belongs in storage', data: { note: 'confidential CSV contents' } } })}>Submit new change</button><p>{mutation.hasUnconfirmedOutcome ? 'Original request held' : 'Ready to submit'}</p>{mutation.error && <p role="alert">{mutation.error.message}</p>}<SubmissionRecoveryNotice /></>;
}
function DialogForm() {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)}>Add customer</button><SubmissionRecoveryNotice /><RecordDialog kind="customers" isOpen={open} onOpenChange={setOpen} title="Add customer" fields={[{ name: 'name', label: 'Full name', type: 'text', required: true }]} /></>;
}
const recoveryScope = () => JSON.stringify([identity.viewerScope, identity.actor, identity.role, identity.merchantId]);
function mount(children: ReactNode = <Form />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const frame = () => <Router><QueryClientProvider client={client}><ScopedSubmissionRecoveryProvider scope={recoveryScope()} merchantId={identity.merchantId}>{children}</ScopedSubmissionRecoveryProvider></QueryClientProvider></Router>;
  const mounted = render(frame());
  return { ...mounted, refreshIdentity: () => mounted.rerender(frame()) };
}
function stored() {
  const key = Object.keys(sessionStorage).find(key => key.startsWith('valopay-submission:v1:'));
  return key ? JSON.parse(sessionStorage.getItem(key)!) as Array<Record<string, unknown>> : [];
}
beforeEach(() => {
  window.history.replaceState({}, '', '/reconciliation');
  sessionStorage.clear(); requests.length = 0; status = 'pending'; lookupStatus = 200; loseAnswer = true; cancelLost = false;
  Object.assign(identity, { merchantId: 'lender-one', viewerScope: 'viewer-one', actor: 'staff-one', role: 'Finance' });
  vi.stubGlobal('fetch', vi.fn(async (input: string, options?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const body = JSON.parse(String(options?.body || '{}'));
    requests.push({ path, key: new Headers(options?.headers).get('Idempotency-Key'), body });
    if (path === '/api/v1/actions' || path === '/api/v1/records/customers') {
      if (loseAnswer) throw new TypeError('The connection was interrupted.');
      return json({ message: 'Saved new change.', data: {} });
    }
    if (path === '/api/v1/operations/lookup') return lookupStatus === 200 ? json({ operation: operation() || null }) : json({ error: 'Access must be checked again.' }, lookupStatus);
    if (path === '/api/v1/operations/original-operation/retry') { status = 'completed'; return json({ message: 'Original result recovered.', data: {} }); }
    if (path === '/api/v1/operations/cancel-unreceived') { if (cancelLost) throw new TypeError('Cancellation answer lost.'); status = 'cancelled'; return json({ message: 'The original key is now cancelled.' }); }
    throw new Error(`Unexpected ${path}`);
  }));
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

describe('interrupted submissions after reloading', () => {
  it('does not send a write when its recovery identity cannot be persisted', async () => {
    const user = userEvent.setup();
    const denied = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage disabled', 'SecurityError'); });
    mount();
    await user.click(screen.getByRole('button', { name: 'Submit new change' }));
    await screen.findByText(/Allow session storage or use another browser/);
    expect(requests).toHaveLength(0);
    denied.mockRestore(); loseAnswer = false;
    await user.click(screen.getByRole('button', { name: 'Submit new change' }));
    await waitFor(() => expect(requests.filter(request => request.path === '/api/v1/actions')).toHaveLength(1));
  });
  it('remembers only the identity, blocks a new write after reload, and recovers using the server original before releasing the page', async () => {
    const user = userEvent.setup(), first = mount();
    await user.click(screen.getByRole('button', { name: 'Submit new change' }));
    await screen.findByText('The connection was interrupted.');
    const originalKey = requests[0]!.key;
    expect(stored()).toEqual([{ key: originalKey, method: 'POST', path: '/v1/actions', page: '/reconciliation' }]);
    expect(JSON.stringify(sessionStorage)).not.toMatch(/Private customer|confidential|private-record|fingerprint|reason/);
    first.unmount(); mount();
    await screen.findByText('Completion is not confirmed.');
    await user.click(screen.getByRole('button', { name: 'Submit new change' }));
    await screen.findByText(/earlier request on this page still needs checking/);
    expect(requests.filter(request => request.path === '/api/v1/actions')).toHaveLength(1);
    expect(requests.find(request => request.path.endsWith('/lookup'))?.body).toEqual({ key: originalKey, method: 'POST', path: '/v1/actions' });
    await user.click(screen.getByRole('button', { name: 'Check original request' }));
    await screen.findByText('Valo Pay saved this request.');
    expect(requests.find(request => request.path.endsWith('/retry'))).toMatchObject({ key: null, body: {} });
    // Recovery does not invent another key or reconstitute private form fields in the browser.
    expect(stored()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'I have reviewed the outcome' }));
    await waitFor(() => expect(stored()).toHaveLength(0));
    loseAnswer = false;
    await user.click(screen.getByRole('button', { name: 'Submit new change' }));
    await waitFor(() => expect(requests.filter(request => request.path === '/api/v1/actions')).toHaveLength(2));
    expect(requests.filter(request => request.path === '/api/v1/actions')[1]!.key).not.toBe(originalKey);
  });

  it('does not treat no received request as proof of failure, and only releases a server-fenced cancellation', async () => {
    const user = userEvent.setup(), first = mount();
    await user.click(screen.getByRole('button', { name: 'Submit new change' }));
    await screen.findByText('The connection was interrupted.');
    const originalKey = requests[0]!.key;
    first.unmount(); status = null; mount();
    await screen.findByText(/It may still arrive/);
    await user.click(screen.getByRole('button', { name: 'Submit new change' }));
    expect(requests.filter(request => request.path === '/api/v1/actions')).toHaveLength(1);
    cancelLost = true;
    await user.click(screen.getByRole('button', { name: 'Cancel if unfinished' }));
    await screen.findByText('Cancellation answer lost.');
    expect(stored()).toHaveLength(1);
    cancelLost = false;
    await user.click(screen.getByRole('button', { name: 'Cancel if unfinished' }));
    await screen.findByText('The request was cancelled and saved nothing.');
    expect(requests.filter(request => request.path.endsWith('/cancel-unreceived')).every(request => (request.body as { key: string }).key === originalKey)).toBe(true);
    await user.click(screen.getByRole('button', { name: 'I have reviewed the outcome' }));
    await waitFor(() => expect(stored()).toHaveLength(0));
  });

  it.each([403, 500])('keeps the request when a lookup is refused or unavailable (%s)', async code => {
    const user = userEvent.setup(), first = mount();
    await user.click(screen.getByRole('button', { name: 'Submit new change' }));
    await screen.findByText('The connection was interrupted.');
    first.unmount(); lookupStatus = code; mount();
    await screen.findByText('Access must be checked again.');
    expect(stored()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'I have reviewed the outcome' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Submit new change' }));
    expect(requests.filter(request => request.path === '/api/v1/actions')).toHaveLength(1);
  });

  it.each(['merchantId', 'viewerScope', 'actor', 'role'] as const)('does not reveal or recover another %s scope', async field => {
    const user = userEvent.setup(), first = mount();
    await user.click(screen.getByRole('button', { name: 'Submit new change' }));
    await screen.findByText('The connection was interrupted.');
    first.unmount(); const original = identity[field]; identity[field] = 'another-scope';
    const other = mount();
    expect(screen.queryByRole('region', { name: 'Interrupted requests' })).toBeNull();
    expect(requests.filter(request => request.path.endsWith('/lookup'))).toHaveLength(0);
    other.unmount(); identity[field] = original; mount();
    await screen.findByText('Completion is not confirmed.');
  });

  it.each(['actor', 'role'] as const)('keeps an unresolved key in its original %s scope when the same form remains mounted', async field => {
    const user = userEvent.setup(), page = mount();
    const submit = screen.getByRole('button', { name: 'Submit new change' });
    await user.click(submit);
    await screen.findByText('Original request held');
    const firstScope = recoveryScope(), originalKey = requests[0]!.key, original = identity[field];

    identity[field] = field === 'role' ? 'Admin' : 'staff-two';
    page.refreshIdentity();
    await screen.findByText('Ready to submit');
    expect(screen.getByRole('button', { name: 'Submit new change' })).toBe(submit);
    expect(screen.queryByRole('region', { name: 'Interrupted requests' })).toBeNull();
    expect(requests.filter(request => request.path.endsWith('/lookup'))).toHaveLength(0);
    expect(sessionStorage.getItem('valopay-submission:v1:' + recoveryScope())).toBeNull();

    await user.click(submit);
    await screen.findByText('Original request held');
    const writes = requests.filter(request => request.path === '/api/v1/actions');
    expect(writes).toHaveLength(2);
    expect(writes[1]!.key).not.toBe(originalKey);
    expect(JSON.parse(sessionStorage.getItem('valopay-submission:v1:' + firstScope)!)).toEqual([expect.objectContaining({ key: originalKey })]);
    expect(JSON.parse(sessionStorage.getItem('valopay-submission:v1:' + recoveryScope())!)).toEqual([expect.objectContaining({ key: writes[1]!.key })]);

    identity[field] = original;
    page.refreshIdentity();
    await screen.findByText('Completion is not confirmed.');
    expect(requests.find(request => request.path.endsWith('/lookup'))?.body).toMatchObject({ key: originalKey });
    await user.click(submit);
    await screen.findByText(/earlier request on this page still needs checking/);
    expect(requests.filter(request => request.path === '/api/v1/actions')).toHaveLength(2);
  });

  it('blocks a fresh submission after closing and reopening the same mounted record dialog', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(workspaceContext, 'useWorkspace').mockReturnValue({ merchantId: identity.merchantId, workspace: { actor: identity.actor, role: 'Finance' } as ReturnType<typeof workspaceContext.useWorkspace>['workspace'], setMerchantId: vi.fn(), isLoading: false, refreshFailure: null });
    mount(<DialogForm />);
    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add customer' });
    await user.type(within(dialog).getByLabelText(/^Full name/), 'Interrupted customer');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await within(dialog).findByText('Outcome not confirmed');
    const originalKey = requests.find(request => request.path === '/api/v1/records/customers')!.key;
    await user.click(within(dialog).getAllByRole('button', { name: 'Close' }).find(button => button.textContent === 'Close')!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await screen.findByText('Completion is not confirmed.');
    expect(stored()).toEqual([{ key: originalKey, method: 'POST', path: '/v1/records/customers', page: '/reconciliation' }]);

    await user.click(screen.getByRole('button', { name: 'Add customer' }));
    const reopened = await screen.findByRole('dialog', { name: 'Add customer' });
    await user.type(within(reopened).getByLabelText(/^Full name/), 'Interrupted customer');
    await user.click(within(reopened).getByRole('button', { name: 'Save' }));
    await within(reopened).findByText(/earlier request on this page still needs checking/);
    expect(requests.filter(request => request.path === '/api/v1/records/customers')).toHaveLength(1);
    expect(stored()[0]!.key).toBe(originalKey);
  });

  it('keeps unrelated pages usable and shows the interruption when returning to its original page', async () => {
    const user = userEvent.setup(), first = mount();
    await user.click(screen.getByRole('button', { name: 'Submit new change' }));
    await screen.findByText('The connection was interrupted.'); first.unmount();
    window.history.replaceState({}, '', '/customers'); const other = mount();
    expect(screen.queryByRole('region', { name: 'Interrupted requests' })).toBeNull();
    other.unmount(); window.history.replaceState({}, '', '/reconciliation'); mount();
    await screen.findByText('Completion is not confirmed.');
  });
});
