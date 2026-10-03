import { inMerchantAsSystem, merchantInWorkspace, loadState, saveState, appendAudit, systemWorkspaceMatches, fail } from './valo-pay-1-store';
import { paystackConnections, paystackTestSecretKey } from '../providers/paystack-ingress-config';
import type { PaystackConnectionTransaction, PaystackIngress } from '../routes/sources';
import type { DomainState } from '../domain/types';
import { createWindowCounter } from './request-limits';

/** What a connection needs from the repository: the lender lock, and a read without it for when the lock is not taken. */
export type PaystackConnectionStore = { inMerchantAsSystem: typeof inMerchantAsSystem; merchantInWorkspace: typeof merchantInWorkspace };

/** Signed deliveries one connection may make a minute, whichever addresses they come from; app.ts also allows 120 a minute per client network. */
export const PAYSTACK_CONNECTION_LIMIT = 60;
/** A receipt's delivery count is written at most this often; repeats in between are tallied in this process and added at its next write. */
export const REPEAT_COUNT_INTERVAL_MS = 60_000;

/**
 * What a delivery writes. A new receipt is saved with its audit entry. A
 * repeat of a saved receipt (Paystack signatures carry no time, so a captured
 * delivery can be replayed at will) is acknowledged without an audit entry,
 * and its count is written at most once a REPEAT_COUNT_INTERVAL_MS per
 * receipt: repeats that arrive sooner are tallied here and added to the count
 * at its next write. A burst of replays thus makes at most one write a minute
 * per receipt, and none to the audit chain. A tally not yet written when the
 * process stops is lost, so the count is a floor.
 */
export function createDeliveryRecorder(intervalMs = REPEAT_COUNT_INTERVAL_MS, maxTallies = 10_000) {
  const unwritten = new Map<string, number>();
  const counts = (state: DomainState) => new Map(state.records.filter((record) => record.kind === 'provider-events').map((record) => [record.id, { count: Number(record.data.deliveryCount) || 0, at: record.data.lastReceivedAt as string | undefined }]));
  return {
    /** Before the delivery is applied: each receipt's count and last write. */
    before(state: DomainState) { return { records: state.records.length, counts: counts(state) }; },
    /** After it: `receipt` (save it with its audit entry), `count` (save the repeat's count alone) or `none` (write nothing). */
    after(state: DomainState, seen: { records: number; counts: ReturnType<typeof counts> }, lender: string, now: string): 'receipt' | 'count' | 'none' {
      if (state.records.length !== seen.records) return 'receipt';
      const repeat = state.records.find((record) => record.kind === 'provider-events' && (Number(record.data.deliveryCount) || 0) > (seen.counts.get(record.id)?.count ?? 0));
      if (!repeat) return 'none';
      const key = `${lender}\u0000${repeat.id}`, last = seen.counts.get(repeat.id)!, tally = unwritten.get(key) ?? 0;
      if (Date.parse(now) - Date.parse(last.at ?? '') < intervalMs) {
        if (!unwritten.delete(key) && unwritten.size >= maxTallies) unwritten.delete(unwritten.keys().next().value!);
        unwritten.set(key, tally + 1);
        return 'none';
      }
      unwritten.delete(key);
      repeat.data.deliveryCount = Number(repeat.data.deliveryCount) + tally;
      return 'count';
    },
  };
}

/** Operators map an opaque endpoint to an existing synthetic lender. Browser
 * state, customer IDs and webhook fields can never choose the receiving tenant. */
export function createPaystackConnectionTransaction(store: PaystackConnectionStore): PaystackConnectionTransaction {
  const deliveries = createWindowCounter({ limit: PAYSTACK_CONNECTION_LIMIT, windowMs: 60_000, maxKeys: 1_000 }), recorder = createDeliveryRecorder();
  return async (connectionId, apply) => {
    // The route has already checked the switch and key; direct callers are held to them too.
    paystackTestSecretKey();
    const mapping=paystackConnections();
    const connection=Object.hasOwn(mapping,connectionId)?mapping[connectionId]:undefined;
    if(!connection)fail('Paystack test connection not found.',404);
    // Counted per mapped connection only, so the counter holds no more keys than the mapping.
    if(!deliveries.take(connectionId))throw Object.assign(new Error('Too many deliveries to this test connection. Paystack delivers the event again.'),{status:429,retryAfterSeconds:60});
    const result=await store.inMerchantAsSystem(connection.merchantId,'System · Paystack test evidence',async context=>{
      if(!systemWorkspaceMatches(context,connection.workspaceId))fail('Paystack test connection is unavailable.',403);
      const state=await loadState(context,connection.merchantId,'update');
      if(!['sandbox','observation'].includes(state.merchant.mode) || !state.merchant.killSwitch)fail('This test connection requires a disabled synthetic lender.',403);
      const seen=recorder.before(state);
      const receipt=await apply({state,context});
      const write=recorder.after(state,seen,connection.merchantId,context.now);
      if(write==='receipt')appendAudit(state,context,'paystack.test_event','provider-inbox','Signed Paystack test event received. No money moved.');
      if(write!=='none')await saveState(context,state);
      return receipt;
    });
    if(result!==undefined)return result;
    // No row was locked: the lender is busy, or the mapping names a lender that is not in its workspace, which no retry mends.
    if(!await store.merchantInWorkspace(connection.merchantId,connection.workspaceId))fail('The lender mapped to this Paystack test connection was not found. Correct the connection mapping.',404);
    fail('The test lender is busy. Retry this delivery.',503);
  };
}

export const paystackConnectionTransaction = createPaystackConnectionTransaction({ inMerchantAsSystem, merchantInWorkspace });

/** The ingress app.ts mounts: the key comes from the environment alone, so a delivery is verified before any lender is opened. */
export const paystackIngress: PaystackIngress = { secretKey: paystackTestSecretKey, transact: paystackConnectionTransaction };
