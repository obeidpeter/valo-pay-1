/** Owner-run synthetic staging commissioning. Review by default; --apply commits typed projection only. */
import { readFile } from 'node:fs/promises';
import { financialProjectionSchema, FINANCIAL_PROJECTION_LIMIT, syncFinancialProjection } from '../../artifacts/api-server/src/lib/financial-projection';
import type { DomainState } from '../../artifacts/api-server/src/domain/types';
import { assertPublicOperatorSchema } from '../../artifacts/api-server/src/lib/product-identity';

const args = process.argv.slice(2);
const value = (flag: string) => { const i=args.indexOf(flag); return i<0 ? undefined : args[i+1]; };
const allowed = new Set(['--schema','--workspace','--lender','--initialise','--apply']);
for (let i=0;i<args.length;i++) {
  if (!allowed.has(args[i]!)) throw new Error('Use --schema NAME --workspace ID --lender ID [--apply], or --schema NAME --initialise.');
  if (['--schema','--workspace','--lender'].includes(args[i]!)) { if (!args[i+1] || args[i+1]!.startsWith('--')) throw new Error('Missing argument value.'); i++; }
}
const schema = financialProjectionSchema(value('--schema') || '');
if (process.env.VALO_PAY_1_FINANCIAL_PROJECTION !== 'staging') throw new Error('Set VALO_PAY_1_FINANCIAL_PROJECTION=staging for this synthetic-only operator command.');
if (args.includes('--initialise') && (args.includes('--apply') || value('--workspace') || value('--lender'))) throw new Error('Initialise the isolated schema separately from a lender backfill.');
const workspace = value('--workspace'), lender = value('--lender');
if (!args.includes('--initialise') && (!workspace || !lender)) throw new Error('Name the exact workspace and lender; bulk backfills are intentionally not supported.');
assertPublicOperatorSchema();
const { pool } = await import('../../lib/db/src/index');
const { verifyProductDatabaseBinding } = await import('../../artifacts/api-server/src/lib/valo-pay-1-store');
try { await verifyProductDatabaseBinding(); }
catch { await pool.end(); console.error('Financial staging refused: Valo Pay 1 resource identity is not verified. Review VALO_PAY_1_ENVIRONMENT and VALO_PAY_1_RESOURCE_BINDINGS. No database changes were made.'); process.exit(1); }
const client = await pool.connect();
try {
  if (args.includes('--initialise')) {
    // CREATE (without IF NOT EXISTS) refuses an existing schema. Migration is never automatic.
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}",pg_catalog,pg_temp`);
    await client.query("SELECT set_config('valopay.financial_migration','staging-only',false)");
    await client.query(await readFile(new URL('../../lib/db/migrations/010_financial_projection_staging.sql',import.meta.url),'utf8'));
    console.log(JSON.stringify({status:'initialised',schema,version:1,productionActivated:false}));
  } else {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    const merchant = (await client.query('SELECT info,settings FROM valopay_merchants WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[lender,workspace])).rows[0];
    if (!merchant) throw new Error('Lender was not found in the named workspace.');
    if (merchant.settings.environment !== 'sandbox') throw new Error('Only sandbox source data may enter this staging rehearsal.');
    const rows = (await client.query(`SELECT id,merchant_id,kind,name,status,reference,amount_kobo::text,customer_id,data,created_at,updated_at
      FROM valopay_records WHERE merchant_id=$1 AND kind IN ('customers','payments','due-items','allocations') ORDER BY id LIMIT $2`,[lender,FINANCIAL_PROJECTION_LIMIT*2+1])).rows;
    if (rows.length>FINANCIAL_PROJECTION_LIMIT*2) throw new Error('Source read exceeds the bounded rehearsal limit.');
    const state: DomainState = {merchant:merchant.info,settings:merchant.settings,records:rows.map(row=>({id:row.id,merchantId:row.merchant_id,kind:row.kind,name:row.name,status:row.status,reference:row.reference,amountKobo:Number(row.amount_kobo),customerId:row.customer_id,data:row.data,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()}))};
    const result = await syncFinancialProjection(client,schema,workspace!,state);
    await client.query(args.includes('--apply') ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({status:args.includes('--apply') ? 'staging_projection_committed' : 'review_passed_rolled_back',schema,receipts:result.receipts.length,obligations:result.obligations.length,allocations:result.allocations.length,sourceDigest:result.sourceDigest,sourceChanged:false,productionActivated:false}));
  }
} catch(error) {
  await client.query('ROLLBACK').catch(()=>{});
  // Database errors may contain source row values or connection details; log only controlled diagnostics.
  console.error('Financial staging command failed; no source records were changed. Review scope, source parity and the migration in an authorised operator session.');
  process.exitCode=1;
} finally { client.release(); await pool.end(); }
