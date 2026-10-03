import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen, userEvent, waitFor } from './harness';
import { DiscardOriginalRequest } from '@/components/discard-original-request';

// Third review of the audit fixes, finding 6: with no control named, Discard original request fell back to the nearest
// control before its notice anywhere in the main region, which on a pilot page was the tips (then the Sandbox guide) above the page.
it('moves focus within the page\'s own content when the page names no control, never to the chrome above it', async () => {
  function Page() {
    const [lost, setLost] = useState(true);
    return <main id="main" tabIndex={-1}>
      <button type="button">Tips</button>
      <div data-page-content="" className="contents">
        <h1>Data retention</h1>
        {lost && <div role="alert"><p>Request not confirmed</p><DiscardOriginalRequest onDiscard={() => setLost(false)} /></div>}
        <p>The run stopped because its last request was not confirmed.</p>
        <button type="button">Refresh retention</button>
      </div>
    </main>;
  }
  const user = userEvent.setup();
  render(<Page />);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  screen.getByRole('button', { name: 'Discard original request' }).focus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Discard original request' })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Refresh retention' })));
});
