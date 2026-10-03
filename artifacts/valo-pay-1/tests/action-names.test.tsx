// Request history and the Audit log name a request in the service's words (workspaceActionRequest), and the console's
// button for the same action in its own. The standard says to use the same words for the same thing, so every action
// the record dialog offers reads as its button: the button's words, in order, are the start of the service's name
// or are in it with the object named ("Submit for review" is "Submit retry policy for review").
import { describe, expect, it } from 'vitest';
import { actionLabels } from '@/components/record-dialog';
import { workspaceActionRequest } from '../../api-server/src/lib/action-names';

const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);

describe('action names', () => {
  it.each(Object.entries(actionLabels))('names %s in the service with the button’s words', (code, button) => {
    const request = words(workspaceActionRequest(code));
    const pressed = words(button);
    expect(request[0], `${button} / ${workspaceActionRequest(code)}`).toBe(pressed[0]);
    let at = 0;
    for (const word of pressed) {
      at = request.indexOf(word, at);
      expect(at, `"${word}" of ${button} in ${workspaceActionRequest(code)}`).toBeGreaterThanOrEqual(0);
      at += 1;
    }
  });

  it('names the actions the review found apart in the words of their buttons', () => {
    expect(workspaceActionRequest('reject_template')).toBe('Request changes to message template');
    expect(workspaceActionRequest('simulate_failure')).toBe('Simulate failed collection attempt');
    expect(workspaceActionRequest('backtest_policy')).toBe('Test retry policy');
    expect(workspaceActionRequest('review_allocation')).toBe('Mark match correct or incorrect');
  });
});
