import { useListQueue, getListQueueQueryKey, useListRecords, getListRecordsQueryKey } from '@workspace/api-client-react';
import { PLATFORM_OWNER, handBackFallbackOwner, type HandBackOwner } from '@workspace/valopay-schema';
import { readableLabel } from './record-label';
import { formatCount } from '@/lib/formatters';

const ownerPhrases: Record<HandBackOwner, string> = {
  lms: 'the loan management system', merchant_manual: 'the lender team', provider_auto: 'the provider’s automatic collection',
};

/** The owner collection returns to, in a sentence: "the loan management system". */
export function handBackOwnerPhrase(owner: unknown): string {
  return ownerPhrases[handBackFallbackOwner(owner)];
}

/** The words that announce a confirmed return of collection: the service's message, then its counts and the stop it switched on. */
export function handBackResult(response: { message?: unknown; data?: Record<string, unknown> } | undefined): string {
  const data = response?.data ?? {};
  return [
    String(response?.message || 'Collection was returned.'),
    `${formatCount(Number(data.reverted ?? 0), 'instalment')} returned to ${handBackOwnerPhrase(data.fallbackOwner)}, and ${formatCount(Number(data.cancelled ?? 0), 'scheduled attempt')} cancelled.`,
    'The emergency stop is now on for this lender. Turn it off in Emergency controls when collection can start again.',
  ].join(' ');
}

/**
 * DEB-12: what returning collection ownership will do, shown before it is
 * confirmed, with the numbers the console can read now: the instalments the
 * platform collects, the scheduled attempts, and the fallback owner the
 * cutover contract names, chosen as the service chooses it. Read afresh on
 * every opening; the result's own counts are announced once it is done.
 */
export function HandBackContext({ merchantId }: { merchantId: string }) {
  const fresh = { staleTime: 0, refetchOnMount: 'always' as const };
  const ownedParams = { merchantId, view: 'all', owner: PLATFORM_OWNER, limit: 1 };
  const owned = useListQueue('collections', ownedParams, { query: { ...fresh, queryKey: getListQueueQueryKey('collections', ownedParams) } });
  const scheduledParams = { merchantId, status: 'scheduled', limit: 1 };
  const scheduled = useListRecords('attempts', scheduledParams, { query: { ...fresh, queryKey: getListRecordsQueryKey('attempts', scheduledParams) } });
  const contractParams = { merchantId };
  const contracts = useListRecords('cutovers', contractParams, { query: { ...fresh, queryKey: getListRecordsQueryKey('cutovers', contractParams) } });
  // The newest cutover that is not itself a hand-back, as the service picks it.
  const contract = contracts.data?.items.find(item => item.status !== 'handed_back');
  const owner = contracts.data ? contract?.data?.fallbackOwner ?? null : undefined;
  const count = (query: { data?: { total: number }; isError: boolean }, noun: string) =>
    query.data ? formatCount(query.data.total, noun) : query.isError ? 'Could not be counted' : 'Counting…';
  const unread = owned.isError || scheduled.isError || contracts.isError;
  return <section aria-label="Summary of returning collection" className="space-y-3 rounded-lg border bg-secondary/20 p-4 text-sm">
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
      <dt className="text-muted-foreground">Instalments Valo Pay collects now</dt><dd className="font-medium tabular-nums">{count(owned, 'instalment')}</dd>
      <dt className="text-muted-foreground">Scheduled attempts to cancel</dt><dd className="font-medium tabular-nums">{count(scheduled, 'attempt')}</dd>
      <dt className="text-muted-foreground">Collection returns to</dt><dd className="font-medium">{owner !== undefined ? readableLabel(handBackFallbackOwner(owner)) : contracts.isError ? 'Could not be read' : 'Loading…'}</dd>
      <dt className="text-muted-foreground">Emergency stop</dt><dd className="font-medium">Turns on for this lender</dd>
    </dl>
    <p className="border-t pt-3">Every instalment Valo Pay collects goes back to {owner !== undefined ? handBackOwnerPhrase(owner) : 'the previous collection owner'}. Every scheduled attempt is cancelled, and the reason is saved. Attempts already sent to a provider keep their outcomes. A checklist of this return is saved with your reason.</p>
    <p className="font-medium">The emergency stop turns on and stays on after the return. Turn it off separately, in Emergency controls, when collection can start again.</p>
    <p className="text-muted-foreground">There is no undo: returned instalments stay with their new owner and cancelled attempts stay cancelled.</p>
    {unread && <p role="status" className="text-muted-foreground">Some figures could not be read. Confirming still returns every instalment Valo Pay collects, and the result gives the counts.</p>}
    <p className="text-xs font-medium">This updates the sandbox record only. No bank instruction is sent and no customer is messaged.</p>
  </section>;
}
