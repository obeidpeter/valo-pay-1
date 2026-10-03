import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireLoopback } from './throwaway-database';
import { seedMerchant } from '../src/lib/valo-pay-1-seed';
import { syncFinancialProjection, verifyFinancialProjectionSchema } from '../src/lib/financial-projection';
if(process.env.VALO_PAY_1_RUN_INTEGRATION!=='1'){console.log('Financial projection rehearsal requires disposable local PostgreSQL.');process.exit(0);}
requireLoopback('Financial projection rehearsal',new URL(process.env.DATABASE_URL || ''));
const {pool}=await import('@workspace/valo-pay-1-db');
const schema=`valopay_finance_staging_${randomBytes(6).toString('hex')}`,workspace=randomUUID(),lender=randomUUID();
const client=await pool.connect(),state=seedMerchant(lender),q=(table:string)=>`"${schema}".${table}`;
let checks=0;
const refused=async(sql:string,values:unknown[]=[],code='23514')=>{await assert.rejects(pool.query(sql,values),(error:any)=>error.code===code);checks++;};
const scope=[workspace,lender];
const insertAllocation=(id:string,receipt:string,obligation:string,amount:string,customer:string,currency='NGN',tenant:string=workspace,merchant:string=lender)=>pool.query(`INSERT INTO ${q('financial_allocations')}(workspace_id,lender_id,id,customer_id,currency,amount_kobo,source_digest,receipt_id,obligation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[tenant,merchant,id,customer,currency,amount,'a'.repeat(64),receipt,obligation]);
try {
 await client.query(`CREATE SCHEMA "${schema}"`);
 await client.query(`SET search_path TO "${schema}",pg_catalog`);
 const migration=await readFile(new URL('../../../lib/db/migrations/010_financial_projection_staging.sql',import.meta.url),'utf8');
 await assert.rejects(client.query(migration),/staging-only/);await client.query('ROLLBACK');checks++;
 await client.query("SELECT set_config('valopay.financial_migration','staging-only',false)");await client.query(migration);checks++;
 await client.query('RESET search_path');
 await pool.query('INSERT INTO valopay_workspaces(id,principal_hash) VALUES($1,$2)',[workspace,`financial-${workspace}`]);
 await pool.query('INSERT INTO valopay_merchants(id,workspace_id,info,settings) VALUES($1,$2,$3,$4)',[lender,workspace,state.merchant,state.settings]);
 await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
   SELECT id,$1,kind,name,status,reference,"amountKobo","customerId",data,"createdAt","updatedAt" FROM jsonb_to_recordset($2::jsonb)
   AS v(id text,kind text,name text,status text,reference text,"amountKobo" bigint,"customerId" text,data jsonb,"createdAt" timestamptz,"updatedAt" timestamptz)`,[lender,JSON.stringify(state.records)]);
 const sync=async(value=state)=>{await client.query('BEGIN');try{const result=await syncFinancialProjection(client,schema,workspace,value);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}};
 await sync();checks++;
 const rows=async()=>JSON.stringify((await pool.query(`SELECT * FROM ${q('financial_receipts')} ORDER BY id`)).rows);
 const baseline=await rows();await sync();assert.equal(await rows(),baseline);checks++;
 const command=spawnSync(process.execPath,[fileURLToPath(new URL('../../../scripts/node_modules/tsx/dist/cli.mjs',import.meta.url)),fileURLToPath(new URL('../../../scripts/src/financial-projection.ts',import.meta.url)),'--schema',schema,'--workspace',workspace,'--lender',lender],{encoding:'utf8',env:{...process.env,VALO_PAY_1_FINANCIAL_PROJECTION:'staging'},timeout:30_000});
 assert.equal(command.status,0,command.stderr);const report=JSON.parse(command.stdout.trim());assert.equal(report.status,'review_passed_rolled_back');assert.deepEqual([report.receipts,report.obligations,report.allocations],[4,8,2]);assert.equal(await rows(),baseline);checks+=2;
 const receipt=state.records.find(r=>r.kind==='payments'&&r.data.allocatedKobo>0)!,allocation=state.records.find(r=>r.kind==='allocations'&&r.data.paymentId===receipt.id)!,obligation=state.records.find(r=>r.id===allocation.data.dueItemId)!;
 await assert.rejects(insertAllocation('over-receipt',receipt.id,obligation.id,'1',receipt.customerId),(error:any)=>error.code==='23514');checks++;
 // An unprivileged writer with CREATE TEMP cannot substitute trigger relations.
 // Empty fake parent tables would make a vulnerable conservation query see no violations.
 for(const table of ['financial_receipts','financial_obligations','financial_allocations']) await client.query(`CREATE TEMP TABLE ${table} (LIKE ${q(table)} INCLUDING ALL)`);
 await client.query('CREATE TEMP TABLE financial_scopes(workspace_id text,lender_id text,lock_version bigint)');
 await client.query('INSERT INTO pg_temp.financial_scopes VALUES($1,$2,0)',scope);
 await assert.rejects(client.query(`INSERT INTO ${q('financial_allocations')}(workspace_id,lender_id,id,customer_id,currency,amount_kobo,source_digest,receipt_id,obligation_id) VALUES($1,$2,'temp-shadow',$3,'NGN',1,$4,$5,$6)`,[...scope,receipt.customerId,'f'.repeat(64),receipt.id,obligation.id]),(error:any)=>error.code==='23514');
 assert.equal((await client.query('SELECT lock_version::text FROM pg_temp.financial_scopes')).rows[0].lock_version,'0');checks+=2;
 for(const table of ['financial_allocations','financial_receipts','financial_obligations','financial_scopes']) await client.query(`DROP TABLE pg_temp.${table}`);
 await assert.rejects(insertAllocation(allocation.id,receipt.id,obligation.id,'0',receipt.customerId),(error:any)=>error.code==='23505');checks++;
 await assert.rejects(insertAllocation('wrong-payer',receipt.id,obligation.id,'0','other'),(error:any)=>error.code==='23503');checks++;
 await assert.rejects(insertAllocation('wrong-currency',receipt.id,obligation.id,'0',receipt.customerId,'USD'),(error:any)=>error.code==='23503');checks++;
 await assert.rejects(insertAllocation('wrong-tenant',receipt.id,obligation.id,'0',receipt.customerId,'NGN','other'),(error:any)=>error.code==='23503');checks++;
 await pool.query(`INSERT INTO ${q('financial_scopes')}(workspace_id,lender_id,source_digest) VALUES('other','other',$1)`,['c'.repeat(64)]);
 await assert.rejects(insertAllocation('existing-foreign-scope',receipt.id,obligation.id,'0',receipt.customerId,'NGN','other','other'),(error:any)=>error.code==='23503');checks++;
 await refused(`UPDATE ${q('financial_receipts')} SET amount_kobo=0 WHERE workspace_id=$1 AND lender_id=$2 AND id=$3`,[...scope,receipt.id]);
 await refused(`UPDATE ${q('financial_receipts')} SET returned_kobo=1 WHERE workspace_id=$1 AND lender_id=$2 AND id=$3`,[...scope,receipt.id]);
 await refused(`UPDATE ${q('financial_obligations')} SET amount_kobo=0 WHERE workspace_id=$1 AND lender_id=$2 AND id=$3`,[...scope,obligation.id]);
 await refused(`UPDATE ${q('financial_allocations')} SET id='changed' WHERE workspace_id=$1 AND lender_id=$2 AND id=$3`,[...scope,allocation.id]);
 await refused(`UPDATE ${q('financial_allocations')} SET amount_kobo=0.5 WHERE workspace_id=$1 AND lender_id=$2 AND id=$3`,[...scope,allocation.id]);
 await refused(`UPDATE ${q('financial_receipts')} SET amount_kobo=9007199254740992 WHERE workspace_id=$1 AND lender_id=$2 AND id=$3`,[...scope,receipt.id]);
 assert.equal(await rows(),baseline);checks++;
 // A verified projection and an ordinary v1 change are in the same transaction: both roll back.
 const altered=structuredClone(state);altered.records.find(r=>r.kind==='payments'&&r.data.allocatedKobo===0)!.name='Rehearsal changed source';
 await client.query('BEGIN');await client.query("UPDATE valopay_merchants SET settings=settings||'{\"rollbackMarker\":true}'::jsonb WHERE id=$1",[lender]);
 await syncFinancialProjection(client,schema,workspace,altered);assert.notEqual((await client.query(`SELECT source_digest FROM ${q('financial_receipts')} WHERE id=$1`,[altered.records.find(r=>r.kind==='payments'&&r.data.allocatedKobo===0)!.id])).rows[0]?.source_digest,undefined);
 await client.query('ROLLBACK');assert.equal(await rows(),baseline);assert.equal((await pool.query('SELECT settings FROM valopay_merchants WHERE id=$1',[lender])).rows[0].settings.rollbackMarker,undefined);checks+=2;
 // Full reversal: retire confirmed claim, reopen obligation, then project returned receipt.
 const reversed=structuredClone(state),rp=reversed.records.find(r=>r.id===receipt.id)!,ra=reversed.records.find(r=>r.id===allocation.id)!,rd=reversed.records.find(r=>r.id===obligation.id)!;
 rp.data.reversalStatus='reversed';rp.data.allocatedKobo=0;ra.status='superseded';rd.data.outstandingKobo=rd.amountKobo;
 await sync(reversed);assert.equal((await pool.query(`SELECT returned_kobo FROM ${q('financial_receipts')} WHERE id=$1`,[receipt.id])).rows[0].returned_kobo,String(receipt.amountKobo));
 assert.equal((await pool.query(`SELECT count(*) FROM ${q('financial_allocations')} WHERE id=$1`,[allocation.id])).rows[0].count,'0');checks+=2;
 await sync();assert.equal(await rows(),baseline);checks++;
 // Guard drift is caught before any dual write. Restore the trigger, then verify again.
 await pool.query(`ALTER TABLE ${q('financial_allocations')} DISABLE TRIGGER financial_allocations_conservation`);
 await assert.rejects(sync(),/schema drift/);assert.equal(await rows(),baseline);checks++;
 await pool.query(`ALTER TABLE ${q('financial_allocations')} ENABLE TRIGGER financial_allocations_conservation`);
 await client.query('BEGIN');await verifyFinancialProjectionSchema(client,schema);await client.query('ROLLBACK');checks++;
 // The production repository's explicit staging hook, through its normal scoped system transaction.
 const oldMode=process.env.VALO_PAY_1_FINANCIAL_PROJECTION,oldSchema=process.env.VALO_PAY_1_FINANCIAL_PROJECTION_SCHEMA;
 process.env.VALO_PAY_1_FINANCIAL_PROJECTION='staging';process.env.VALO_PAY_1_FINANCIAL_PROJECTION_SCHEMA=schema;
 try {
   const store=await import('../src/lib/valo-pay-1-store');
   await store.inMerchantAsSystem(lender,`${store.SYSTEM_ACTOR_PREFIX}financial rehearsal`,async context=>{const current=await store.loadState(context,lender);current.settings.projectionHookVerified=true;await store.saveState(context,current);});
   assert.equal((await pool.query('SELECT settings FROM valopay_merchants WHERE id=$1',[lender])).rows[0].settings.projectionHookVerified,true);assert.equal(await rows(),baseline);checks++;
   await assert.rejects(store.inMerchantAsSystem(lender,`${store.SYSTEM_ACTOR_PREFIX}financial rehearsal`,async context=>{const current=await store.loadState(context,lender);current.settings.mustNotCommit=true;current.records.find(r=>r.id===receipt.id)!.data.allocatedKobo=0;await store.saveState(context,current);}),/counter differs/);
   assert.equal((await pool.query('SELECT settings FROM valopay_merchants WHERE id=$1',[lender])).rows[0].settings.mustNotCommit,undefined);assert.equal(await rows(),baseline);checks++;
 } finally {if(oldMode===undefined)delete process.env.VALO_PAY_1_FINANCIAL_PROJECTION;else process.env.VALO_PAY_1_FINANCIAL_PROJECTION=oldMode;if(oldSchema===undefined)delete process.env.VALO_PAY_1_FINANCIAL_PROJECTION_SCHEMA;else process.env.VALO_PAY_1_FINANCIAL_PROJECTION_SCHEMA=oldSchema;}
 // 100 direct SQL contenders share a one-kobo receipt: database enforcement, no application lock.
 await pool.query(`INSERT INTO ${q('financial_receipts')} VALUES($1,$2,'contended-receipt','contended-customer','NGN',1,0,$3)`,[...scope,'b'.repeat(64)]);
 await pool.query(`INSERT INTO ${q('financial_obligations')} VALUES($1,$2,'contended-obligation','contended-customer','NGN',100,$3)`,[...scope,'b'.repeat(64)]);
 const outcomes=await Promise.allSettled(Array.from({length:100},(_,i)=>insertAllocation(`contender-${i}`,'contended-receipt','contended-obligation','1','contended-customer')));
 assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
 assert.ok(outcomes.filter(result=>result.status==='rejected').every(result=>(result as PromiseRejectedResult).reason.code==='23514'));
 assert.equal((await pool.query(`SELECT sum(amount_kobo)::text AS amount FROM ${q('financial_allocations')} WHERE receipt_id='contended-receipt'`)).rows[0].amount,'1');checks+=3;
 // A payment can be split legitimately. The cap spans rows, not one allocation ID.
 await pool.query(`DELETE FROM ${q('financial_allocations')} WHERE receipt_id='contended-receipt'`);
 await pool.query(`UPDATE ${q('financial_receipts')} SET amount_kobo=2 WHERE id='contended-receipt'`);
 await insertAllocation('split-a','contended-receipt','contended-obligation','1','contended-customer');await insertAllocation('split-b','contended-receipt','contended-obligation','1','contended-customer');
 await assert.rejects(insertAllocation('split-c','contended-receipt','contended-obligation','1','contended-customer'),(error:any)=>error.code==='23514');checks++;
 // Repeatable-read readers that saw the same free capacity cannot both claim it.
 await pool.query(`DELETE FROM ${q('financial_allocations')} WHERE receipt_id='contended-receipt'`);
 await pool.query(`UPDATE ${q('financial_receipts')} SET amount_kobo=1 WHERE id='contended-receipt'`);
 const left=await pool.connect(),right=await pool.connect();
 try {
   for(const connection of [left,right]){await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await connection.query(`SELECT * FROM ${q('financial_receipts')} WHERE id='contended-receipt'`);}
   const claimSql=`INSERT INTO ${q('financial_allocations')}(workspace_id,lender_id,id,customer_id,currency,amount_kobo,source_digest,receipt_id,obligation_id) VALUES($1,$2,$3,'contended-customer','NGN',1,$4,'contended-receipt','contended-obligation')`;
   await left.query(claimSql,[...scope,'repeatable-a','d'.repeat(64)]);await left.query('COMMIT');
   await assert.rejects(right.query(claimSql,[...scope,'repeatable-b','d'.repeat(64)]),(error:any)=>error.code==='40001');await right.query('ROLLBACK');checks++;
 } finally {await left.query('ROLLBACK');await right.query('ROLLBACK');left.release();right.release();}
 // Exact upper bound round-trips through PostgreSQL numeric without IEEE-754 summation.
 await pool.query(`INSERT INTO ${q('financial_receipts')} VALUES($1,$2,'max-receipt','max-customer','NGN',9007199254740991,0,$3)`,[...scope,'e'.repeat(64)]);
 await pool.query(`INSERT INTO ${q('financial_obligations')} VALUES($1,$2,'max-obligation','max-customer','NGN',9007199254740991,$3)`,[...scope,'e'.repeat(64)]);
 await insertAllocation('max-allocation','max-receipt','max-obligation','9007199254740991','max-customer');
 assert.equal((await pool.query(`SELECT sum(amount_kobo)::text AS amount FROM ${q('financial_allocations')} WHERE receipt_id='max-receipt'`)).rows[0].amount,'9007199254740991');checks++;
 console.log(`Financial projection PostgreSQL rehearsal passed ${checks} checks, including 100 concurrent direct SQL claims, exact integer limits, scope/payer/currency identity, returns, drift, parity and paired rollback.`);
} finally {
 await client.query('ROLLBACK').catch(()=>{});await client.query('RESET search_path');
 await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
 await pool.query('DELETE FROM valopay_records WHERE merchant_id=$1',[lender]);await pool.query('DELETE FROM valopay_merchants WHERE id=$1',[lender]);await pool.query('DELETE FROM valopay_workspaces WHERE id=$1',[workspace]);
 client.release();await pool.end();
}
