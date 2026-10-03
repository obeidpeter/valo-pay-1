import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from '@workspace/valo-pay-1-db';
import { SyntheticInstructionRecovery, type InstructionScope, type SyntheticInstruction } from '@workspace/valo-pay-1-db/synthetic-instruction-recovery';
import { requireLoopback } from './throwaway-database';

if (process.env.VALO_PAY_1_RUN_INTEGRATION !== '1') {
  if (process.env.CI) throw Error('Instruction recovery requires explicit synthetic database opt-in');
  console.log('Set VALO_PAY_1_RUN_INTEGRATION=1 for the isolated synthetic instruction recovery rehearsal.'); process.exit(0);
}
const base = new URL(process.env.DATABASE_URL!);
requireLoopback('Instruction recovery',base);
const suffix = randomBytes(6).toString('hex');
const schema = `valopay_dispatch_staging_${suffix}`, table = `"${schema}"`;
const appName = `valopay_instruction_app_${suffix}`, journalName = `valopay_instruction_journal_${suffix}`;
const dbUrl = (name:string) => { const url = new URL(base); url.pathname=`/${name}`; return url.toString(); };
const admin = new Pool({ connectionString:base.toString() });
const app = new Pool({ connectionString:dbUrl(appName) });
const journal = new Pool({ connectionString:dbUrl(journalName) });
const appMigration = await readFile(new URL('../../../lib/db/migrations/011_synthetic_instruction_recovery.sql',import.meta.url),'utf8');
const journalMigration = await readFile(new URL('../../../lib/db/migrations/012_synthetic_independent_journal.sql',import.meta.url),'utf8');
let recovery: SyntheticInstructionRecovery | undefined, checks=0;
const s: InstructionScope = {workspace:'SYN-workspace',lender:'SYN-lender',purpose:'synthetic-payment'};
const input=(key:string): SyntheticInstruction => ({...s,economicKey:`SYN-due-${key}`,requestKey:`SYN-request-${key}`,amountKobo:'500000',currency:'NGN',sourceDigest:'a'.repeat(64),authorityVersion:'1',environment:'synthetic'});
async function install(pool: InstanceType<typeof Pool>, sql:string) {
  const c=await pool.connect();
  try { await c.query('BEGIN'); await c.query(`CREATE SCHEMA ${table}; SET LOCAL search_path=${table},pg_catalog; SET LOCAL valopay.instruction_migration='synthetic-only'`); await c.query(sql); await c.query('COMMIT'); }
  catch(e){await c.query('ROLLBACK');throw e;} finally{c.release();}
}
const check=async(fn:()=>Promise<unknown>|unknown)=>{await fn(); checks++;};
try {
  await admin.query(`CREATE DATABASE "${appName}"`); await admin.query(`CREATE DATABASE "${journalName}"`);
  await check(async()=>{await assert.rejects(app.query(appMigration),/isolated synthetic/); await assert.rejects(journal.query(journalMigration),/isolated synthetic/);});
  await install(app,appMigration); await install(journal,journalMigration);
  await check(()=>assert.throws(()=>new SyntheticInstructionRecovery('postgres://localhost/production',dbUrl(journalName),schema),/Disposable/));
  await check(()=>assert.throws(()=>new SyntheticInstructionRecovery(dbUrl(appName),dbUrl(appName),schema),/Separate/));
  recovery=new SyntheticInstructionRecovery(dbUrl(appName),dbUrl(journalName),schema);
  await recovery.appoint(s);
  await check(()=>assert.rejects(recovery!.enqueue({...input('invalid'),environment:'live' as any}),/Invalid/));
  const one=await recovery.enqueue(input('one'));
  await check(async()=>assert.equal((await recovery!.enqueue(input('one'))).id,one.id));
  await check(()=>assert.rejects(recovery!.enqueue({...input('one'),amountKobo:'500001'}),/another instruction/));
  await check(()=>assert.rejects(recovery!.enqueue({...input('one'),requestKey:'SYN-new-key'}),/one_obligation_owner/));
  const claims=await Promise.all(Array.from({length:100},()=>recovery!.claim(s,one.id)));
  const claim=claims.find(Boolean)!;
  await check(()=>assert.equal(claims.filter(Boolean).length,1));
  await check(async()=>assert.equal(await recovery!.read({...s,lender:'SYN-another'},one.id),undefined));
  await check(async()=>assert.equal(await recovery!.claim({...s,lender:'SYN-another'},one.id),undefined));
  await check(()=>assert.rejects(recovery!.dispatch({...claim,body:{...claim.body,amountKobo:'1'}}),/Frozen/));
  await check(()=>assert.rejects(recovery!.dispatch({...claim,workspace:'SYN-another'}),/Frozen/));
  const mutable=structuredClone(claim), pending=recovery.dispatch(mutable,{fault:'after-provider'});
  mutable.id='00000000-0000-0000-0000-000000000000'; mutable.body.amountKobo='1';
  await check(async()=>assert.deepEqual(await pending,{state:'unknown',dispatched:true}));
  await check(async()=>assert.equal((await recovery!.read(s,one.id))!.state,'unknown'));
  await check(async()=>assert.equal(await recovery!.claim(s,one.id),undefined));
  await check(async()=>assert.equal(await recovery!.reconcile(s,one.id),'succeeded'));
  await check(async()=>assert.equal(await recovery!.reconcile(s,one.id),'succeeded'));
  await check(async()=>assert.equal(Number((await journal.query(`SELECT count(*) FROM ${table}.synthetic_receipts WHERE command_id=$1`,[one.id])).rows[0].count),1));
  await check(()=>assert.rejects(journal.query(`DELETE FROM ${table}.dispatch_intents WHERE command_id=$1`,[one.id]),/append only/));
  await check(()=>assert.rejects(app.query(`UPDATE ${table}.commands SET body='{}' WHERE id=$1`,[one.id]),/Frozen/));
  await check(()=>assert.rejects(app.query(`UPDATE ${table}.inbox SET outcome='failed' WHERE command_id=$1`,[one.id]),/append only/));

  const journalScope={...s,lender:'SYN-journal'}; await recovery.appoint(journalScope);
  const failed=await recovery.enqueue({...input('failure'),...journalScope}); const failedClaim=await recovery.claim(journalScope,failed.id);
  await check(async()=>assert.deepEqual(await recovery!.dispatch(failedClaim!,{outcome:'failed'}),{state:'failed',dispatched:true}));
  await check(()=>assert.rejects(recovery!.enqueue({...input('failure'),...journalScope,requestKey:'SYN-fresh-failed'}),/Independent dispatch evidence/));
  const unavailable=await recovery.enqueue({...input('journal-down'),...journalScope}), unavailableClaim=await recovery.claim(journalScope,unavailable.id);
  await journal.query(`ALTER TABLE ${table}.dispatch_intents RENAME TO hidden_intents`);
  try { await check(()=>assert.rejects(recovery!.dispatch(unavailableClaim!))); }
  finally { await journal.query(`ALTER TABLE ${table}.hidden_intents RENAME TO dispatch_intents`); }
  await check(async()=>assert.equal((await recovery!.read(journalScope,unavailable.id))!.state,'unknown'));
  await check(async()=>assert.equal(Number((await journal.query(`SELECT count(*) FROM ${table}.synthetic_receipts WHERE command_id=$1`,[unavailable.id])).rows[0].count),0));
  const blocked=await recovery.enqueue({...input('locked-journal'),...journalScope}), blockedClaim=await recovery.claim(journalScope,blocked.id);
  const holder=await journal.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`INSERT INTO ${table}.dispatch_intents(command_id,workspace,lender,purpose,economic_key,fingerprint,body) VALUES($1,$2,$3,$4,$5,$6,$7)`,[blocked.id,journalScope.workspace,journalScope.lender,journalScope.purpose,blocked.body.economicKey,blocked.fingerprint,blocked.body]);
    const begin=Date.now();
    await check(()=>assert.rejects(recovery!.dispatch(blockedClaim!),/lock timeout/));
    await check(()=>assert.ok(Date.now()-begin<15000,'journal lock waits are bounded'));
  } finally { await holder.query('ROLLBACK');holder.release(); }
  await check(async()=>assert.equal((await recovery!.read(journalScope,blocked.id))!.state,'unknown'));

  const old=await recovery.enqueue(input('stale')); const stale=await recovery.claim(s,old.id,1);
  await new Promise(r=>setTimeout(r,15)); const fresh=await recovery.claim(s,old.id);
  await check(()=>assert.ok(stale&&fresh&&BigInt(fresh.fence)>BigInt(stale.fence)));
  await check(()=>assert.rejects(recovery!.dispatch(stale!),/no longer valid/));
  await check(async()=>assert.deepEqual(await recovery!.dispatch(fresh!,{fault:'before-provider'}),{state:'unknown',dispatched:false}));
  await check(async()=>assert.equal(await recovery!.reconcile(s,old.id),'unknown'));
  await check(async()=>assert.equal(Number((await journal.query(`SELECT count(*) FROM ${table}.synthetic_receipts WHERE command_id=$1`,[old.id])).rows[0].count),0));

  const stopped=await recovery.enqueue(input('stop')); const stoppedClaim=await recovery.claim(s,stopped.id);
  await recovery.stop(s);
  await check(()=>assert.rejects(recovery!.dispatch(stoppedClaim!),/no longer valid/));
  await check(()=>assert.rejects(recovery!.enqueue(input('after-stop')),/Current/));
  await check(async()=>assert.equal(await recovery!.reconcile(s,one.id),'succeeded'));
  await app.query(`UPDATE ${table}.authorities SET stopped=false WHERE workspace=$1 AND lender=$2`,[s.workspace,s.lender]);
  await check(()=>assert.rejects(recovery!.dispatch({...stoppedClaim!,authority_version:'2'}),/Frozen/));

  // Lose the entire disposable app schema, retaining the separately committed journal database.
  await recovery.close(); recovery=undefined;
  await app.query(`DROP SCHEMA ${table} CASCADE`); await install(app,appMigration);
  recovery=new SyntheticInstructionRecovery(dbUrl(appName),dbUrl(journalName),schema);
  await recovery.appoint(s);
  await check(()=>assert.rejects(recovery!.enqueue(input('one')),/Independent dispatch evidence/));
  const recoverScope={...s}, recovered=recovery.recover(recoverScope,one.id); recoverScope.lender='SYN-mutated';
  await check(async()=>assert.equal(await recovered,'succeeded'));
  await check(async()=>assert.equal((await app.query(`SELECT stopped FROM ${table}.authorities WHERE workspace=$1 AND lender=$2`,[s.workspace,s.lender])).rows[0].stopped,true));
  await check(async()=>assert.equal(await recovery!.recover(s,old.id),'unknown'));
  await check(async()=>assert.equal(await recovery!.claim(s,old.id),undefined));
  await check(()=>assert.rejects(recovery!.recover({...s,lender:'SYN-other'},one.id),/Valid independent/));
  await check(()=>assert.rejects(recovery!.enqueue(input('restored')),/Current/));
  await check(async()=>assert.equal(Number((await journal.query(`SELECT count(*) FROM ${table}.synthetic_receipts r JOIN ${table}.dispatch_intents i USING(command_id) WHERE i.lender=$1`,[s.lender])).rows[0].count),1));
  // A restored conflicting request cannot cause recovery's stop to roll back.
  await app.query(`UPDATE ${table}.authorities SET stopped=false`);
  const fake={...input('stale'),requestKey:'SYN-conflict'};
  await app.query(`DELETE FROM ${table}.commands WHERE id=$1`,[old.id]);
  await app.query(`INSERT INTO ${table}.commands(id,workspace,lender,purpose,economic_key,request_key,fingerprint,body,authority_version) VALUES('00000000-0000-0000-0000-000000000001',$1,$2,$3,$4,$5,$6,$7,1)`,[s.workspace,s.lender,s.purpose,fake.economicKey,fake.requestKey,'b'.repeat(64),fake]);
  await check(()=>assert.rejects(recovery!.recover(s,old.id),/conflicts/));
  await check(async()=>assert.equal((await app.query(`SELECT stopped FROM ${table}.authorities`)).rows[0].stopped,true));
  console.log(`Synthetic instruction recovery: ${checks} checks passed, including 100 claim contenders and independent-journal application-loss recovery. No external provider called.`);
} finally {
  await recovery?.close(); await app.end(); await journal.end();
  for(const name of [appName,journalName]) {
    if(!/^valopay_instruction_(app|journal)_[a-f0-9]{12}$/.test(name)) throw Error('Refusing unexpected cleanup database');
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  }
  await admin.end();
}
