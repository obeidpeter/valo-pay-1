import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { readableLabel, StatusBadge } from '../src/components/record-label';

describe('readable record labels', () => {
  it('explains known statuses and failure codes in ordinary words', () => {
    expect(readableLabel('pending_activation')).toBe('Awaiting activation');
    expect(readableLabel('INSUFFICIENT_FUNDS')).toBe('Insufficient funds');
  });

  it('keeps unfamiliar values readable, in sentence case, without confusing them with inherited properties', () => {
    expect(readableLabel('awaitingProviderReview')).toBe('Awaiting provider review');
    expect(readableLabel('AWAITING_PROVIDER_REVIEW')).toBe('Awaiting provider review');
    expect(readableLabel('next_provider-stage')).toBe('Next provider stage');
    expect(readableLabel('constructor')).toBe('Constructor');
    expect(readableLabel(undefined)).toBe('Unknown');
  });

  it('shows a status in its words, and a missing one as Not recorded, never as a code', () => {
    const { container, rerender } = render(<StatusBadge status="pending_activation" />);
    expect(container.textContent).toBe('Awaiting activation');
    rerender(<StatusBadge status={null} />);
    expect(container.textContent).toBe('Not recorded');
    expect(container.querySelector('span')?.getAttribute('title')).toBe('Not recorded');
  });
});
