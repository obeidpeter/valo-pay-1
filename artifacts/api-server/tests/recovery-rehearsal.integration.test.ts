import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { DomainState } from '../src/domain/types';
import { recoveryBytes, recoveryManifestSchema, verifyRecoveryManifest, type RecoveryConfiguration, type RecoveryObject } from '../src/lib/recovery-manifest';
import type { WrappingKeyProvider } from '../src/lib/protected-payloads';

if (process.env.VALO_PAY_1_RUN_INTEGRATION !== '1' || process.env.VALO_PAY_1_RUN_RECOVERY !== '1') {
  // CI runs this to measure a recovery and keep its evidence: there, a missing opt-in fails instead of passing with no evidence.
  if (process.env.CI) { console.error('Recovery rehearsal cannot run: CI needs VALO_PAY_1_RUN_INTEGRATION=1 and VALO_PAY_1_RUN_RECOVERY=1, and a skipped rehearsal leaves no evidence.'); process.exit(1); }
  console.log('Recovery rehearsal requires two opt-ins and a disposable local PostgreSQL instance.'); process.exit(0);
}
const connection = new URL(process.env.DATABASE_URL || '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(connection.hostname), 'recovery automation refuses remote database hosts');
assert.equal(connection.pathname, '/valo_pay_1_test', 'use the disposable CI database named valo_pay_1_test');
const { pool, Pool } = await import('@workspace/valo-pay-1-db');
const { seedMerchant } = await import('../src/lib/valo-pay-1-seed');
const { appendAudit, verifyAudit } = await import('../src/lib/valo-pay-1-store');
const { canonicalJson } = await import('@workspace/valo-pay-1-schema');
const { encryptField, decryptField, rotateField } = await import('../src/lib/field-encryption');
const { runDailyClose } = await import('../src/domain/actions');
const { makeRecord } = await import('../src/domain/records');
const { buildExportBytes } = await import('../src/lib/valo-pay-1-exports');
const { sealPayload, openPayload } = await import('../src/lib/protected-payloads');
const suffix = randomUUID().replaceAll('-', '');
const sourceName = `valopay_source_rehearsal_${suffix}`;
const targetName = `valopay_restore_rehearsal_${suffix}`;
const identifier = (value: string) => { assert.match(value, /^valopay_(?:source|restore)_rehearsal_[a-f0-9]{32}$/); return `"${value}"`; };
const forDatabase = (database: string) => { const url = new URL(connection); url.pathname = `/${database}`; return url.toString(); };
const pgEnv = (database: string) => ({ ...process.env, PGHOST: connection.hostname, PGPORT: connection.port || '5432', PGUSER: decodeURIComponent(connection.username), PGPASSWORD: decodeURIComponent(connection.password), PGDATABASE: database });
const runPg = (command: string, args: string[], database: string) => {
  const result = spawnSync(command, args, { env: pgEnv(database), encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed during the disposable recovery rehearsal; no connection details are logged.`);
};
const tables = ['valopay_workspaces', 'valopay_merchants', 'valopay_records', 'valopay_idempotency', 'valopay_operations', 'valopay_teams', 'valopay_staff_memberships', 'valopay_staff_invitations', 'valopay_staff_events', 'valopay_staff_lender_access', 'valopay_export_cleanup'];
let source: InstanceType<typeof Pool> | undefined, target: InstanceType<typeof Pool> | undefined;
let sourceCreated = false, targetCreated = false;
const directory = await mkdtemp(join(tmpdir(), 'valo-pay-1-recovery-'));
const started = performance.now();
const oldKey = randomBytes(32), newKey = randomBytes(32);
const wrappingKeyId = 'projects/synthetic-rehearsal/locations/global/keyRings/recovery/cryptoKeys/fixture-v1';
const wrappingKey = randomBytes(32);
/** Test-only vault: the runtime never accepts this provider or exports managed master keys. */
const fixtureProvider = (keys: Map<string, Buffer>): WrappingKeyProvider => ({
  async wrap(id, key, aad) {
    const master = keys.get(id); assert.ok(master, 'fixture wrapping key is available');
    const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',master,iv);cipher.setAAD(aad);
    const encrypted=Buffer.concat([cipher.update(key),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]);
  },
  async unwrap(id, wrapped, aad) {
    const master=keys.get(id);assert.ok(master,'fixture wrapping key is available');
    const decipher=createDecipheriv('aes-256-gcm',master,wrapped.subarray(0,12));decipher.setAAD(aad);decipher.setAuthTag(wrapped.subarray(12,28));return Buffer.concat([decipher.update(wrapped.subarray(28)),decipher.final()]);
  },
});
const sourceKeys=new Map([[wrappingKeyId,wrappingKey]]), objectInventory: RecoveryObject[]=[];
const configuration: RecoveryConfiguration={schemaVersion:'013_export_cleanup',runtimeDatabaseRole:'valopay_runtime',staffMode:'staging',issuer:'https://recovery-fixture.clerk.accounts.dev',origins:['https://pilot.example.test'],encryptionKeyIds:[wrappingKeyId],privateObjectAccess:'authenticated_lender_scoped',schedulerEnabled:false,liveOperationsEnabled:false};
let restoredWrappingKey: Buffer | undefined;
try {
  await pool.query(`CREATE DATABASE ${identifier(sourceName)}`); sourceCreated = true;
  await pool.query(`CREATE DATABASE ${identifier(targetName)}`); targetCreated = true;
  source = new Pool({ connectionString: forDatabase(sourceName) });
  target = new Pool({ connectionString: forDatabase(targetName) });
  const schemaDump = join(directory, 'schema.dump');
  runPg('pg_dump', ['--format=custom', '--schema-only', '--no-owner', ...tables.map(table => `--table=public.${table}`), `--file=${schemaDump}`], 'valo_pay_1_test');
  runPg('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', `--dbname=${sourceName}`, schemaDump], sourceName);
  const snapshotAt = new Date().toISOString();
  const expectedStates: DomainState[] = [];
  for (const index of [1, 2]) {
    const merchant = { id: `restore-merchant-${index}`, name: `Synthetic lender ${index}`, shortName: `L${index}`, segment: 'cooperative', mode: 'observation', status: 'sandbox', provider: 'Sandbox Rail', monthlyVolume: 10, killSwitch: false, preDataReady: false, preLiveReady: false };
    const state = seedMerchant(merchant.id, index === 2);
    state.merchant = merchant;
    const ctx = { role: 'Admin', actor: 'Synthetic recovery operator', now: snapshotAt };
    runDailyClose(state, ctx, 'manual');
    appendAudit(state, ctx, 'recovery.fixture', merchant.id, 'Synthetic recovery fixture');
    const record = state.records.find(item => item.kind === 'customers')!;
    record.data.protectedTest = encryptField(`SYNTHETIC: protected lender ${index}`, { tenantId: merchant.id, recordId: record.id, field: 'protectedTest' }, { activeKeyId: 'rehearsal-v1', keys: new Map([['rehearsal-v1', oldKey]]) });
    const batchId=`restore-batch-${index}`;
    const batchCsv=await sealPayload('source_row_id,name\nSYNTHETIC-001,Recovery fixture',{lender:merchant.id,record:batchId,field:'csv'},wrappingKeyId,fixtureProvider(sourceKeys));
    makeRecord(state,'import-batches',{id:batchId,name:'Protected synthetic source',status:'ready',createdAt:snapshotAt,data:{csv:batchCsv,source:'recovery-fixture',sourceBatchId:`batch-${index}`,synthetic:true}});
    const exportId=`restore-export-${index}`, storageKey=`exports/${merchant.id}/${exportId}.json`;
    const exported=await buildExportBytes(state,ctx,{kind:'closes',format:'json'});
    const object: RecoveryObject={lenderId:merchant.id,exportId,storageKey,private:true,...recoveryBytes(exported.bytes)};
    const objectPath=join(directory,'source-objects',storageKey);await mkdir(dirname(objectPath),{recursive:true});
    await writeFile(objectPath,exported.bytes,{mode:0o600});await writeFile(`${objectPath}.metadata.json`,JSON.stringify(object),{mode:0o600});objectInventory.push(object);
    makeRecord(state,'exports',{id:exportId,name:'Private close evidence',status:'ready',createdAt:snapshotAt,data:{kind:'closes',format:'json',checksum:object.checksum,byteLength:object.byteLength,storage:{bucket:'synthetic-private',objectName:storageKey},synthetic:true}});
    await source.query('INSERT INTO valopay_workspaces(id,principal_hash) VALUES($1,$2)', [`workspace-${index}`, `principal-${index}`]);
    await source.query('INSERT INTO valopay_merchants(id,workspace_id,info,settings) VALUES($1,$2,$3,$4)', [merchant.id, `workspace-${index}`, merchant, state.settings]);
    for (const item of state.records) await source.query('INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [item.id, merchant.id, item.kind, item.name, item.status, item.reference, item.amountKobo, item.customerId, item.data, item.createdAt, item.updatedAt]);
    const response=await sealPayload({completed:true,recordId:record.id},{lender:merchant.id,record:`key-${index}`,field:'response'},wrappingKeyId,fixtureProvider(sourceKeys));
    const request=await sealPayload({method:'POST',path:'/v1/records/customers',body:{name:'Synthetic restoration fixture'}},{lender:merchant.id,record:`operation-${index}`,field:'request'},wrappingKeyId,fixtureProvider(sourceKeys));
    const receipt=index===1?await sealPayload({id:record.id},{lender:merchant.id,record:`operation-${index}`,field:'receipt'},wrappingKeyId,fixtureProvider(sourceKeys)):null;
    await source.query('INSERT INTO valopay_idempotency(id,merchant_id,request_hash,response) VALUES($1,$2,$3,$4)', [`key-${index}`, merchant.id, 'synthetic-fingerprint', response]);
    await source.query('INSERT INTO valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label,status,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [`operation-${index}`,merchant.id,`principal-${index}`,ctx.actor,'Admin',`key-${index}`,'synthetic-fingerprint',request,'Save customers',index===1?'completed':'pending',receipt]);
    await source.query('INSERT INTO valopay_teams(workspace_id,organization_id,name) VALUES($1,$2,$3)',[`workspace-${index}`,`org_restore${index}`,`Synthetic team ${index}`]);
    await source.query('INSERT INTO valopay_staff_memberships(id,workspace_id,user_id,display_name,role,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[`member-${index}`,`workspace-${index}`,`user_restore${index}`,'Synthetic staff','Admin',index===1?'active':'revoked','2030-01-01']);
    await source.query('INSERT INTO valopay_staff_invitations(id,workspace_id,email,role,token_hash,invited_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[`invite-${index}`,`workspace-${index}`,`restore${index}@example.test`,'Finance',createHash('sha256').update(`unusable-fixture-${index}`).digest('hex'),ctx.actor,'2030-01-01']);
    await source.query('INSERT INTO valopay_staff_events(id,workspace_id,actor,action,subject,detail) VALUES($1,$2,$3,$4,$5,$6)',[`staff-event-${index}`,`workspace-${index}`,ctx.actor,'staff.changed',`member-${index}`,{reason:'Synthetic restore rehearsal'}]);
    await source.query('INSERT INTO valopay_staff_lender_access(membership_id,merchant_id,granted_by) VALUES($1,$2,$3)',[`member-${index}`,merchant.id,ctx.actor]);
    expectedStates.push(state);
  }
  // These tombstones deliberately have no source lender or export row: workspace expiry already
  // removed them. Recovery must retain deletion obligations, retry backoff and any claimed lease.
  const cleanupNextAttemptAt = new Date(Date.parse(snapshotAt) + 5 * 60_000).toISOString();
  const cleanupLeaseUntil = new Date(Date.parse(snapshotAt) + 60_000).toISOString();
  for (const [id, attempts, leaseToken, leaseUntil] of [
    ['restore-cleanup-retry', 2, null, null],
    ['restore-cleanup-leased', 3, 'synthetic-cleanup-lease', cleanupLeaseUntil],
  ] as const) {
    await source.query(`INSERT INTO valopay_export_cleanup
      (id,merchant_id,bucket,object_name,checksum,attempts,last_failure,next_attempt_at,lease_token,lease_until,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`, [
      id, 'expired-recovery-lender', 'synthetic-private', `exports/expired-recovery-lender/${id}.json`,
      createHash('sha256').update(id).digest('hex'), attempts, 'storage_unavailable', cleanupNextAttemptAt,
      leaseToken, leaseUntil, snapshotAt,
    ]);
  }
  // The fixture key vault is deliberately separate from the DB/object package.
  // Real KMS keys are not exportable; the equivalent real drill restores IAM and access to retained key versions.
  await writeFile(join(directory,'separate-fixture-vault.json'),JSON.stringify({id:wrappingKeyId,key:wrappingKey.toString('base64')}),{mode:0o600});
  const baselineRows=new Map<string,Record<string,any>[]>();
  for(const table of tables){const order=table==='valopay_teams'?'workspace_id':table==='valopay_staff_lender_access'?'membership_id,merchant_id':'id';baselineRows.set(table,(await source.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows);}
  const dump = join(directory, 'synthetic.dump');
  const backupStart = performance.now();
  runPg('pg_dump', ['--format=custom', '--no-owner', `--file=${dump}`], sourceName);
  const backupMs = Math.round(performance.now() - backupStart);
  const manifest=recoveryManifestSchema.parse({version:2,snapshotAt,database:recoveryBytes(await readFile(dump)),configuration,objects:objectInventory});
  await writeFile(join(directory,'recovery-manifest.json'),JSON.stringify(manifest),{mode:0o600});
  const packageDirectory=join(directory,'backup-objects');
  for(const object of objectInventory){const targetPath=join(packageDirectory,object.storageKey);await mkdir(dirname(targetPath),{recursive:true});await copyFile(join(directory,'source-objects',object.storageKey),targetPath);await copyFile(`${join(directory,'source-objects',object.storageKey)}.metadata.json`,`${targetPath}.metadata.json`);}
  const completeBackupMs=Math.round(performance.now()-backupStart);
  // A write after the snapshot is intentionally absent on restore: report observed data loss honestly.
  await source.query('INSERT INTO valopay_idempotency(id,merchant_id,request_hash,response) VALUES($1,$2,$3,$4)',['post-snapshot-write','restore-merchant-1','synthetic-post-snapshot',{synthetic:true}]);
  sourceKeys.clear();wrappingKey.fill(0);
  assert.equal(Number((await target.query("SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n), 0, 'restore target is empty');
  const restoreStart = performance.now();
  runPg('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', `--dbname=${targetName}`, dump], targetName);
  const restoreMs = Math.round(performance.now() - restoreStart);
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const key = table === 'valopay_teams' ? 'workspace_id' : table === 'valopay_staff_lender_access' ? 'membership_id,merchant_id' : 'id';
    const sourceRows: Record<string, any>[] = baselineRows.get(table)!;
    const restoredRows: Record<string, any>[] = (await target.query(`SELECT * FROM ${table} ORDER BY ${key}`)).rows;
    assert.deepEqual(restoredRows, sourceRows, `${table}: every restored value matches the snapshot`);
    counts[table] = restoredRows.length;
  }
  assert.equal(counts.valopay_export_cleanup, 2, 'both orphan deletion obligations survive restoration');
  const restoredCleanup = (await target.query(`SELECT c.* FROM valopay_export_cleanup c
    LEFT JOIN valopay_merchants m ON m.id=c.merchant_id
    LEFT JOIN valopay_records r ON r.id=c.id
    WHERE m.id IS NULL AND r.id IS NULL ORDER BY c.id`)).rows;
  assert.equal(restoredCleanup.length, 2, 'cleanup survives without a source lender or export');
  const leasedCleanup = restoredCleanup.find(row => row.id === 'restore-cleanup-leased')!;
  assert.equal(leasedCleanup.attempts, 3, 'restore does not reset retry history');
  assert.equal(leasedCleanup.lease_token, 'synthetic-cleanup-lease', 'restore does not clear an in-flight claim');
  assert.equal(leasedCleanup.lease_until.toISOString(), cleanupLeaseUntil);
  assert.equal(leasedCleanup.next_attempt_at.toISOString(), cleanupNextAttemptAt, 'restore preserves retry backoff');
  const restoredObjectsDirectory=join(directory,'restored-objects');
  for(const object of objectInventory){const targetPath=join(restoredObjectsDirectory,object.storageKey);await mkdir(dirname(targetPath),{recursive:true});await copyFile(join(packageDirectory,object.storageKey),targetPath);await copyFile(`${join(packageDirectory,object.storageKey)}.metadata.json`,`${targetPath}.metadata.json`);}
  const measuredObjects=async()=>Promise.all(objectInventory.map(async object=>{
    const path=join(restoredObjectsDirectory,object.storageKey), metadata=JSON.parse(await readFile(`${path}.metadata.json`,'utf8'));
    const row=(await target!.query('SELECT merchant_id,data FROM valopay_records WHERE id=$1 AND kind=$2',[object.exportId,'exports'])).rows[0];
    assert.equal(row.merchant_id,metadata.lenderId);assert.equal(row.data.storage.objectName,metadata.storageKey);assert.equal(row.data.checksum,metadata.checksum);
    return {...metadata,...recoveryBytes(await readFile(path))} as RecoveryObject;
  }));
  const restoredManifest=JSON.parse(await readFile(join(directory,'recovery-manifest.json'),'utf8'));
  const restoredDatabaseBytes=await readFile(dump);
  assert.equal(verifyRecoveryManifest(restoredManifest,restoredDatabaseBytes,await measuredObjects(),configuration).objects,2);
  assert.throws(()=>verifyRecoveryManifest(restoredManifest,restoredDatabaseBytes,[],configuration),/missing/);
  assert.throws(()=>verifyRecoveryManifest(restoredManifest,restoredDatabaseBytes,objectInventory,{...configuration,issuer:'https://unexpected.example.test'}),/configuration/);
  const corruptObject=objectInventory[0]!, corruptPath=join(restoredObjectsDirectory,corruptObject.storageKey);
  const originalBytes=await readFile(corruptPath);await writeFile(corruptPath,Buffer.concat([originalBytes,Buffer.from('corruption')]));
  const corruptedInventory=await measuredObjects();assert.throws(()=>verifyRecoveryManifest(restoredManifest,restoredDatabaseBytes,corruptedInventory,configuration),/changed/);
  await writeFile(corruptPath,originalBytes);
  const restoredVault=JSON.parse(await readFile(join(directory,'separate-fixture-vault.json'),'utf8'));
  assert.equal(restoredVault.id,wrappingKeyId);restoredWrappingKey=Buffer.from(restoredVault.key,'base64');
  const recoveredProvider=fixtureProvider(new Map([[wrappingKeyId,restoredWrappingKey]]));
  const unavailableProvider=fixtureProvider(new Map());
  for (const expected of expectedStates) {
    const rows: Record<string, any>[] = (await target.query('SELECT * FROM valopay_records WHERE merchant_id=$1 ORDER BY created_at,id', [expected.merchant.id])).rows;
    const restored: DomainState = { ...expected, records: rows.map(row => ({ id: row.id, merchantId: row.merchant_id, kind: row.kind, name: row.name, status: row.status, reference: row.reference, amountKobo: Number(row.amount_kobo), customerId: row.customer_id, data: row.data, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() })) };
    assert.equal(verifyAudit(restored).valid, true);
    for (const kind of ['allocations', 'due-items', 'closes']) assert.equal(canonicalJson(restored.records.filter(item => item.kind === kind).sort((a,b) => a.id.localeCompare(b.id))), canonicalJson(expected.records.filter(item => item.kind === kind).sort((a,b) => a.id.localeCompare(b.id))));
    const customer = restored.records.find(item => item.kind === 'customers' && item.data.protectedTest)!;
    const scope = { tenantId: expected.merchant.id, recordId: customer.id, field: 'protectedTest' };
    const ring = { activeKeyId: 'rehearsal-v2', keys: new Map([['rehearsal-v1', oldKey], ['rehearsal-v2', newKey]]) };
    assert.match(decryptField(customer.data.protectedTest, scope, ring), /^SYNTHETIC:/);
    const rotated = rotateField(customer.data.protectedTest, scope, ring);
    assert.equal(decryptField(rotated, scope, ring), decryptField(customer.data.protectedTest, scope, ring));
    assert.throws(() => decryptField(customer.data.protectedTest, { ...scope, tenantId: 'wrong-lender' }, ring));
    assert.throws(() => decryptField(customer.data.protectedTest, scope, { activeKeyId: 'rehearsal-v2', keys: new Map([['rehearsal-v2', newKey]]) }));
    const savedBatch=restored.records.find(item=>item.kind==='import-batches')!;
    const payloadScope={lender:expected.merchant.id,record:savedBatch.id,field:'csv'};
    await assert.rejects(()=>openPayload(savedBatch.data.csv,payloadScope,unavailableProvider),/cannot be opened/);
    await assert.rejects(()=>openPayload(savedBatch.data.csv,payloadScope,fixtureProvider(new Map([[wrappingKeyId,newKey]]))),/cannot be opened/);
    await assert.rejects(()=>openPayload(savedBatch.data.csv,{...payloadScope,lender:'another-lender'},recoveredProvider),/cannot be opened/);
    assert.equal(await openPayload(savedBatch.data.csv,payloadScope,recoveredProvider),'source_row_id,name\nSYNTHETIC-001,Recovery fixture');
    const operation: Record<string,any>=(await target.query('SELECT * FROM valopay_operations WHERE merchant_id=$1',[expected.merchant.id])).rows[0];
    assert.equal((await openPayload(operation.request,{lender:expected.merchant.id,record:operation.id,field:'request'},recoveredProvider)).path,'/v1/records/customers');
    if(operation.receipt) assert.equal((await openPayload(operation.receipt,{lender:expected.merchant.id,record:operation.id,field:'receipt'},recoveredProvider)).id,customer.id);
    const replay: Record<string,any>=(await target.query('SELECT * FROM valopay_idempotency WHERE merchant_id=$1',[expected.merchant.id])).rows[0];
    assert.equal((await openPayload(replay.response,{lender:expected.merchant.id,record:replay.id,field:'response'},recoveredProvider)).recordId,customer.id);
    const grant: Record<string,any>=(await target.query('SELECT a.merchant_id,m.status FROM valopay_staff_lender_access a JOIN valopay_staff_memberships m ON m.id=a.membership_id WHERE a.merchant_id=$1',[expected.merchant.id])).rows[0];
    assert.equal(grant.merchant_id,expected.merchant.id);assert.ok(['active','revoked'].includes(grant.status));
  }
  assert.equal(Number((await target.query('SELECT count(*) AS n FROM valopay_idempotency WHERE id=$1',['post-snapshot-write'])).rows[0].n),0);
  const finalVerification=verifyRecoveryManifest(restoredManifest,restoredDatabaseBytes,await measuredObjects(),configuration);
  const evidence = { version: 2, outcome: 'passed', scope: 'disposable synthetic PostgreSQL, private local object backups and an independently restored fixture wrapping-key provider', snapshotAt, databaseBackupMs:backupMs, completeBackupMs, databaseRestoreMs:restoreMs, completeRestoreMs:Math.round(performance.now()-restoreStart), recoverableSnapshotAgeMs:Date.now()-Date.parse(snapshotAt), simulatedWritesAfterSnapshot:1, observedDataLossRecords:1, totalMs: Math.round(performance.now() - started), counts, privateObjectsRestored:finalVerification.objects, checks: ['all eleven application/service tables and settings', 'orphan export cleanup tombstones, retry history, backoff and lease state', 'outstanding amounts and allocations', 'close snapshots', 'encrypted idempotency and recovery payloads', 'audit chains', 'lender-specific access grants and revocations', 'restored encrypted source files', 'retained wrapping-key access and missing-key refusal', 'wrong-lender envelope refusal', 'private export ownership and checksum inventory', 'missing/corrupt file refusal', 'reviewed issuer/origin/runtime-role/key manifest', 'post-snapshot data-loss measurement'], externalObjectStorageVerified: false, externalKeyCustodyVerified:false, productionRestoreVerified: false };
  if (process.env.VALO_PAY_1_REHEARSAL_REPORT) await writeFile(resolve(process.env.VALO_PAY_1_REHEARSAL_REPORT), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} catch (error) {
  // A failed rehearsal leaves its report too, so CI keeps evidence either way: that it failed and after how long,
  // never the error itself, which could quote a synthetic record.
  if (process.env.VALO_PAY_1_REHEARSAL_REPORT) await writeFile(resolve(process.env.VALO_PAY_1_REHEARSAL_REPORT), JSON.stringify({ version: 2, outcome: 'failed', failedAfterMs: Math.round(performance.now() - started), productionRestoreVerified: false }, null, 2));
  throw error;
} finally {
  oldKey.fill(0); newKey.fill(0); wrappingKey.fill(0); restoredWrappingKey?.fill(0);
  await source?.end(); await target?.end();
  if (targetCreated) await pool.query(`DROP DATABASE ${identifier(targetName)}`);
  if (sourceCreated) await pool.query(`DROP DATABASE ${identifier(sourceName)}`);
  await pool.end();
  assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('valo-pay-1-recovery-'));
  await rm(directory, { recursive: true, force: true });
}
