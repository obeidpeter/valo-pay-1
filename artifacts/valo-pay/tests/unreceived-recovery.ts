import type { FakeApi } from './fake-api';
import { screen, waitFor, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

/** Recovery responses for tests whose intercepted original never reached the fake API. Real fences are covered in PostgreSQL. */
export function unreceivedRecovery(api: FakeApi) {
  const send = globalThis.fetch, cancelled = new Set<string>();
  globalThis.fetch = async (input, options) => {
    const path = new URL(String(input instanceof Request ? input.url : input), 'http://localhost').pathname;
    if (path === '/api/v1/operations/lookup' || path === '/api/v1/operations/cancel-unreceived') {
      const body = JSON.parse(String(options?.body || '{}'));
      if (path.endsWith('/cancel-unreceived')) { cancelled.add(body.key); return Response.json({ message: 'The original key cannot run.' }); }
      return Response.json({ operation: cancelled.has(body.key) ? { id: body.key, label: 'Cancelled interrupted submission', actor: `Sandbox ${api.role}`, role: api.role, status: 'cancelled', createdAt: api.now, updatedAt: api.now, message: 'The server cancelled the original key.', recordId: null, recordKind: null, summary: null } : null });
    }
    return send(input, options);
  };
}

/** The user must obtain the server's cancellation and review its outcome; discarding a form alone is not cancellation. */
export async function cancelInterrupted(user: ReturnType<typeof userEvent.setup>) {
  const region = await screen.findByRole('region', { name: 'Interrupted requests' });
  for (const card of [...region.querySelectorAll('article')]) {
    const cancel = await within(card).findByRole('button', { name: 'Cancel if unfinished' });
    await user.click(cancel);
    await user.click(await within(card).findByRole('button', { name: 'I have reviewed the outcome' }));
  }
  await waitFor(() => { if (screen.queryByRole('region', { name: 'Interrupted requests' })) throw new Error('Cancellation not yet confirmed'); });
}
