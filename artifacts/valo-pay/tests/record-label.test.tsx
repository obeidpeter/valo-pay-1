import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { readableLabel, StatusBadge, statusTone } from '../src/components/record-label';

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
    expect(readableLabel(undefined)).toBe('Not recorded');
    expect(readableLabel('')).toBe('Not recorded');
  });

  it('shows a status in its words, and a missing one as Not recorded, never as a code', () => {
    const { container, rerender } = render(<StatusBadge status="pending_activation" />);
    expect(container.textContent).toBe('Awaiting activation');
    rerender(<StatusBadge status={null} />);
    expect(container.textContent).toBe('Not recorded');
    expect(container.querySelector('span')?.getAttribute('title')).toBe('Not recorded');
  });

  it('shows a status that warns in the warning colour and a completed one in the success colour', () => {
    // The connected pages' record-keyed codes, which other pages show in other words.
    for (const status of ['checkout.unknown', 'payroll-item.unknown', 'permission.revoked', 'assessment.blocked', 'accounting-draft.blocked']) expect([status, statusTone(status)]).toEqual([status, 'warning']);
    for (const status of ['payroll-item.succeeded', 'payroll-run.completed']) expect([status, statusTone(status)]).toEqual([status, 'success']);
    // Any status that reads Outcome unknown, Blocked, Withdrawn or Some outcomes unknown, whatever its code.
    for (const status of ['unknown_outcome', 'TIMEOUT_UNKNOWN', 'blocked', 'withdrawn', 'needs_reconciliation']) expect([status, statusTone(status)]).toEqual([status, 'warning']);
    // Others keep their colour.
    expect(statusTone('confirmed')).toBe('success');
    expect(statusTone('failed')).toBe('danger');
    expect(statusTone('checkout.created')).toBe('neutral');
    const { container } = render(<StatusBadge status="checkout.unknown" />);
    expect(container.textContent).toBe('Outcome unknown');
    expect(container.querySelector('span')?.className).toContain('bg-warning');
  });
});
