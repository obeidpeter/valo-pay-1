import type { PoolClient } from '@workspace/valo-pay-1-db';
import type { DomainState, ValopayRecord } from '../domain/types';
import { canonicalDigest as digest } from './digests';
import { canonicalJson as canonical } from '@workspace/valo-pay-1-schema';

/** Staging-only dual-write guard, not a second source of production financial truth. */
export const FINANCIAL_PROJECTION_LIMIT = 5_000;
export function financialProjectionSchema(value: string): string {
  if (!/^valopay_finance_staging_[a-z0-9_]{1,32}$/.test(value)) throw new Error('Financial projection requires an isolated valopay_finance_staging_* schema.');
  return value;
}
const money = (value: unknown, label: string): bigint => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be safe non-negative integer kobo.`);
  return BigInt(value);
};
const currency = (record: ValopayRecord): string => {
  const value = String(record.data.currency || 'NGN').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(value)) throw new Error('Financial currency must be a three-letter uppercase code.');
  return value;
};
type Parent = { id: string; customer_id: string; currency: string; amount_kobo: string; source_digest: string };
type Receipt = Parent & { returned_kobo: string };
type Allocation = Parent & { receipt_id: string; obligation_id: string };
export type FinancialProjection = { receipts: Receipt[]; obligations: Parent[]; allocations: Allocation[]; sourceDigest: string };

export function projectFinancialState(state: DomainState): FinancialProjection {
  if (state.settings.environment !== 'sandbox') throw new Error('Financial projection is available only for an explicit sandbox rehearsal.');
  const selected = state.records.filter(record => ['payments','due-items','allocations'].includes(record.kind));
  if (selected.length > FINANCIAL_PROJECTION_LIMIT) throw new Error(`Financial projection is bounded to ${FINANCIAL_PROJECTION_LIMIT} source records per lender; partition and review larger migrations.`);
  const customers = new Set(state.records.filter(record => record.kind === 'customers').map(record => record.id));
  const ids = new Set<string>();
  for (const record of selected) {
    if (record.merchantId !== state.merchant.id || ids.has(record.id)) throw new Error('Financial records require unique lender-local identities.');
    ids.add(record.id);
    if (record.customerId && !customers.has(record.customerId)) throw new Error('Financial customer must exist in the same lender.');
  }
  const parent = (record: ValopayRecord): Parent => ({ id: record.id, customer_id: record.customerId, currency: currency(record), amount_kobo: money(record.amountKobo,'Source amount').toString(), source_digest:digest(record) });
  const receipts: Receipt[] = selected.filter(record => record.kind === 'payments').map(record => ({ ...parent(record), returned_kobo: money(record.data.reversalStatus === 'reversed' ? record.amountKobo
    : ['refunded','recorded_externally'].includes(record.data.refundStatus) ? record.data.refundedKobo ?? record.amountKobo : 0,'Returned amount').toString() }));
  const obligations = selected.filter(record => record.kind === 'due-items').map(parent);
  const receiptMap = new Map(receipts.map(row => [row.id,row])), obligationMap = new Map(obligations.map(row => [row.id,row]));
  const receiptSums = new Map<string,bigint>(), obligationSums = new Map<string,bigint>();
  const allocations: Allocation[] = selected.filter(record => record.kind === 'allocations' && record.status === 'confirmed').map(record => {
    const receipt_id = String(record.data.paymentId || ''), obligation_id = String(record.data.dueItemId || '');
    const receipt = receiptMap.get(receipt_id), obligation = obligationMap.get(obligation_id);
    if (!receipt || !obligation || !record.customerId || record.customerId !== receipt.customer_id || record.customerId !== obligation.customer_id || receipt.currency !== obligation.currency
      || (record.data.currency !== undefined && currency(record) !== receipt.currency)) throw new Error('Confirmed allocation must match lender, identified payer and currency of both parents.');
    const row = { ...parent(record), currency:receipt.currency, receipt_id, obligation_id };
    receiptSums.set(receipt_id,(receiptSums.get(receipt_id) ?? 0n)+BigInt(row.amount_kobo));
    obligationSums.set(obligation_id,(obligationSums.get(obligation_id) ?? 0n)+BigInt(row.amount_kobo));
    return row;
  });
  const originals = new Map(selected.map(record => [record.id,record]));
  for (const receipt of receipts) {
    const applied = receiptSums.get(receipt.id) ?? 0n;
    if (applied+BigInt(receipt.returned_kobo)>BigInt(receipt.amount_kobo)) throw new Error('Allocations and returned money exceed receipt amount; review the source before backfill.');
    if (money(originals.get(receipt.id)!.data.allocatedKobo ?? 0,'Allocated counter') !== applied) throw new Error('Receipt allocation counter differs from confirmed allocations; source parity failed.');
  }
  for (const obligation of obligations) {
    if (!obligation.customer_id) throw new Error('Obligation needs an identified lender-local customer.');
    const outstanding = BigInt(obligation.amount_kobo)-(obligationSums.get(obligation.id) ?? 0n);
    if (outstanding<0n) throw new Error('Allocations exceed obligation amount.');
    if (money(originals.get(obligation.id)!.data.outstandingKobo ?? Number(obligation.amount_kobo),'Outstanding counter') !== outstanding) throw new Error('Obligation outstanding counter differs from confirmed allocations; source parity failed.');
  }
  const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  for (const rows of [receipts,obligations,allocations]) rows.sort(byId);
  return { receipts,obligations,allocations,sourceDigest:digest(selected.sort(byId)) };
}

// Independently recompute catalogue identity: missing/disabled constraints or triggers
// and changed functions fail closed. The owner-stamped signature is not a defence
// against an owner who deliberately alters both schema and stamp.
export const financialCatalogueSignatureSql = `SELECT md5(string_agg(definition,E'\\n' ORDER BY definition)) AS signature FROM (
 SELECT 'column:'||c.relname||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'') AS definition
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'constraint:'||c.relname||':'||k.conname||':'||k.convalidated||':'||pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1
 UNION ALL SELECT 'index:'||pg_get_indexdef(i.indexrelid)||':'||i.indisvalid||':'||i.indisready FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1
 UNION ALL SELECT 'trigger:'||pg_get_triggerdef(t.oid)||':'||t.tgenabled::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal
 UNION ALL SELECT 'function:'||pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1
) definitions`;

export async function verifyFinancialProjectionSchema(client: PoolClient, schema: string): Promise<void> {
  financialProjectionSchema(schema);
  // Deparser output depends on search_path. Always match the path used at installation.
  const oldPath = (await client.query('SHOW search_path')).rows[0].search_path as string;
  await client.query("SELECT set_config('search_path',$1,true)",[`${schema},pg_catalog,pg_temp`]);
  try {
    const installed = (await client.query(`SELECT signature FROM "${schema}".financial_projection_metadata WHERE version=1`)).rows;
    const actual = (await client.query(financialCatalogueSignatureSql,[schema])).rows[0]?.signature;
    if (installed.length!==1 || installed[0].signature==='pending' || installed[0].signature!==actual) throw new Error('Financial projection schema drift detected; review migration before writing.');
  } catch (error) {
    // A missing table aborts PostgreSQL's transaction; preserve that original error.
    await client.query("SELECT set_config('search_path',$1,true)",[oldPath]).catch(()=>{});
    throw error;
  }
  await client.query("SELECT set_config('search_path',$1,true)",[oldPath]);
}

/** Caller already owns the lender lock and transaction. All v1 and typed writes roll back together. */
export async function syncFinancialProjection(client: PoolClient, schema: string, workspaceId: string, state: DomainState): Promise<FinancialProjection> {
  financialProjectionSchema(schema);
  const projection = projectFinancialState(state), lenderId = state.merchant.id;
  await verifyFinancialProjectionSchema(client,schema);
  const q = (table: string) => `"${schema}".${table}`;
  await client.query(`INSERT INTO ${q('financial_scopes')}(workspace_id,lender_id,source_digest) VALUES($1,$2,$3)
    ON CONFLICT(workspace_id,lender_id) DO UPDATE SET source_digest=EXCLUDED.source_digest,projected_at=now(),lock_version=financial_scopes.lock_version+1`,[workspaceId,lenderId,projection.sourceDigest]);
  // Remove the old projection's claims before changing parent capacities, including reversals.
  for (const table of ['financial_allocations','financial_receipts','financial_obligations']) await client.query(`DELETE FROM ${q(table)} WHERE workspace_id=$1 AND lender_id=$2`,[workspaceId,lenderId]);
  for (const [table,rows,extra] of [
    ['financial_receipts',projection.receipts,'returned_kobo numeric'],
    ['financial_obligations',projection.obligations,''],
    ['financial_allocations',projection.allocations,'receipt_id text,obligation_id text'],
  ] as const) {
    if (!rows.length) continue;
    const fields = 'id,customer_id,currency,amount_kobo,source_digest'+(extra ? ','+extra.replace(/ (?:numeric|text)/g,'') : '');
    await client.query(`INSERT INTO ${q(table)}(workspace_id,lender_id,${fields}) SELECT $1,$2,${fields} FROM jsonb_to_recordset($3::jsonb)
      AS row(id text,customer_id text,currency text,amount_kobo numeric,source_digest text${extra ? ','+extra : ''})`,[workspaceId,lenderId,JSON.stringify(rows)]);
    const read = (await client.query(`SELECT ${fields} FROM ${q(table)} WHERE workspace_id=$1 AND lender_id=$2 ORDER BY id`,[workspaceId,lenderId])).rows;
    const order = (a: {id:string},b:{id:string}) => a.id<b.id ? -1 : a.id>b.id ? 1 : 0;
    const expected = [...rows].sort(order);read.sort(order);
    if (canonical(read)!==canonical(expected)) throw new Error(`Financial projection row parity failed for ${table}.`);
  }
  return projection;
}
