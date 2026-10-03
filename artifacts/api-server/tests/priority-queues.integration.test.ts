import { SANDBOX_COOKIE } from "../src/lib/sandbox-cookie";
// Only a disposable database. Validate SQL paging against the reference queue semantics.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { pageQueue, queueViews, type QueueName, type QueueQuery } from '../src/lib/valo-pay-1-queues';
if (process.env.VALO_PAY_1_RUN_INTEGRATION !== '1') process.exit(0);
const { pool } = await import('@workspace/valo-pay-1-db');
const { inWorkspace, listMerchants, listQueue, loadState } = await import('../src/lib/valo-pay-1-store');
const tokens = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
const request = (token = tokens[0]) => ({ headers: { cookie: `${SANDBOX_COOKIE}=${token}` }, secure: false, auth: Object.assign(() => ({ userId: null }), { [Symbol.for('@clerk/express.auth')]: true }) }) as any;
const response = () => ({ cookie() {} }) as any;
try {
  const merchants = await inWorkspace(request(), response(), listMerchants);
  const merchantId = merchants[0]!.id, siblingId = merchants[1]!.id;
  const state = await inWorkspace(request(), response(), ctx => loadState(ctx, merchantId, 'share'), 'read');
  const customer = state.records.find(row => row.kind === 'customers')!, mandate = state.records.find(row => row.kind === 'mandates')!;
  const foreign = await inWorkspace(request(), response(), ctx => loadState(ctx, siblingId, 'share'), 'read');
  const foreignCustomer = foreign.records.find(row => row.kind === 'customers')!;
  await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,customer_id,data,amount_kobo)
    SELECT $1 || '-queue-ex-' || lpad(i::text,5,'0'),$1,'exceptions','Queue exception ' || i,
      CASE WHEN i%4=0 THEN 'resolved' ELSE 'open' END,'QEX-' || i,$2,
      jsonb_build_object('synthetic',true,'severity',CASE WHEN i%3=0 THEN 'high' ELSE 'medium' END,
        'owner',CASE WHEN i%2=0 THEN 'Finance' ELSE 'Operations' END,'type','unallocated_payment',
        'dueBy',CASE WHEN i%5=0 THEN 'invalid legacy date' WHEN i%7=0 THEN '2026-09-18T23:30:00-02:00' ELSE '2026-09-19' END),1000000
    FROM generate_series(1,2000) i`, [merchantId, customer.id]);
  await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,customer_id,data,amount_kobo)
    SELECT $1 || '-queue-due-' || lpad(i::text,5,'0'),$1,'due-items','Queue instalment ' || i,
      CASE WHEN i%4=0 THEN 'paid' ELSE 'scheduled' END,'QDUE-' || i,CASE WHEN i=1 THEN $4 ELSE $2 END,
      jsonb_build_object('synthetic',true,'mandateId',$3::text,'owner',CASE WHEN i%2=0 THEN 'lender' ELSE 'valopay' END,
        'dueDate',CASE WHEN i%5=0 THEN '2026-09-18' ELSE '2026-09-19' END),1000000
    FROM generate_series(1,2000) i`, [merchantId, customer.id, mandate.id, foreignCustomer.id]);
  await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,customer_id,data,amount_kobo)
    SELECT $1 || '-queue-attempt-' || lpad(i::text,5,'0'),$1,'attempts','Queue attempt ' || i,'failed','QATT-' || i,$2,
      jsonb_build_object('synthetic',true,'dueItemId',$1 || '-queue-due-' || lpad(i::text,5,'0'),'occurredAt','2026-09-18T12:00:00Z'),1000000
    FROM generate_series(1,2000) i`, [merchantId, customer.id]);
  // Date-only deadlines on today's and yesterday's West Africa Time dates (23 September audit, API item 5): each is
  // due all of its WAT day and overdue only after it, in every queue, as the reference queue and the alerts read it.
  const watToday = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10), watYesterday = new Date(Date.now() + 3_600_000 - 86_400_000).toISOString().slice(0, 10);
  const dated: Record<string, string> = {};
  for (const [label, date] of [['today', watToday], ['yesterday', watYesterday]] as const) {
    dated[`exception-${label}`] = `${merchantId}-dated-exception-${label}`; dated[`mandate-${label}`] = `${merchantId}-dated-mandate-${label}`; dated[`due-${label}`] = `${merchantId}-dated-due-${label}`;
    await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,customer_id,data,amount_kobo) VALUES
      ($1,$4,'exceptions','Dated exception','open','DEX-' || $1,$5,jsonb_build_object('synthetic',true,'severity','low','owner','Finance','type','unallocated_payment','dueBy',$7::text),1000000),
      ($2,$4,'mandates','Dated mandate','pending_activation','DMN-' || $2,$5,jsonb_build_object('synthetic',true,'workflow','hosted_consent','consentEvidence','Synthetic','activationDeadline',$7::text),5000000),
      ($3,$4,'due-items','Dated instalment','scheduled','DDU-' || $3,$5,jsonb_build_object('synthetic',true,'mandateId',$6::text,'owner','lender','dueDate',$7::text),1000000)`,
      [dated[`exception-${label}`], dated[`mandate-${label}`], dated[`due-${label}`], merchantId, customer.id, mandate.id, date]);
  }
  for (const [queue, kind] of [['exceptions', 'exception'], ['mandates', 'mandate'], ['collections', 'due']] as const) {
    await inWorkspace(request(), response(), async ctx => {
      // A target is located among the view's filtered rows: its page holds it only when the view does.
      const inView = async (view: string, id: string) => (await listQueue(ctx, merchantId, queue, { view, target: id, limit: 100 })).items.some(row => row.id === id);
      const today = dated[`${kind}-today`]!, yesterday = dated[`${kind}-yesterday`]!;
      assert.deepEqual([await inView('overdue', today), await inView('due-today', today)], [false, true], `${queue}: a date-only deadline on today's WAT date is due today, not overdue`);
      assert.deepEqual([await inView('overdue', yesterday), await inView('due-today', yesterday)], [true, false], `${queue}: yesterday's is overdue`);
    }, 'read');
  }
  const baseline = await inWorkspace(request(), response(), ctx => loadState(ctx, merchantId, 'share'), 'read');
  const normalise = (page: ReturnType<typeof pageQueue>) => ({ ...page, related: page.related.sort((a, b) => a.id.localeCompare(b.id)) });
  const timings: number[] = [];
  for (const queue of Object.keys(queueViews) as QueueName[]) {
    const cases: QueueQuery[] = queueViews[queue].flatMap(view => [{ view, limit: 25 }, { view, limit: 25, offset: 25 }, { view, limit: 100, offset: 99999 }]);
    cases.push({q:'Queue instalment',limit:25},{q:'QDUE-1999',limit:25},{q:customer.name.normalize('NFD').replace(/[\u0300-\u036f]/g,''),limit:25},{q:'%_',limit:25});
    cases.push({ owner: queue === 'exceptions' ? 'Finance' : 'lender', type: queue === 'exceptions' ? 'unallocated_payment' : '', limit: 25 });
    if (queue === 'collections') cases.push({ view: 'failed', target: `${merchantId}-queue-attempt-01999`, limit: 25 }, { view: 'all', target: `${merchantId}-queue-due-00001`, limit: 25 });
    if (queue === 'mandates') cases.push({ record: mandate.id, view: 'overdue', limit: 25 });
    for (const query of cases) {
      await inWorkspace(request(), response(), async ctx => {
        const start = performance.now();
        const actual = await listQueue(ctx, merchantId, queue, query);
        timings.push(performance.now() - start);
        const expected = pageQueue(baseline.records, queue, query, ctx.now);
        assert.deepEqual(normalise(actual), normalise(expected), `${queue}: ${JSON.stringify(query)}`);
        assert.ok(actual.items.length <= (query.limit || 25));
        assert.ok(!actual.related.some(row => row.merchantId !== merchantId), 'related rows stay in the active lender');
      }, 'read');
    }
  }
  await assert.rejects(() => inWorkspace(request(tokens[1]), response(), ctx => listQueue(ctx, merchantId, 'exceptions', { limit: 25 }), 'read'), (error: any) => error.status === 404);
  const sibling = await inWorkspace(request(), response(), ctx => listQueue(ctx, siblingId, 'collections', { record: `${merchantId}-queue-due-00001`, limit: 25 }), 'read');
  assert.equal(sibling.total, 0);
  assert.equal(sibling.related.length, 0);
  console.log(JSON.stringify({ benchmark: 'priority-queue-pages', syntheticRows: 6000, pages: timings.length, medianMs: Math.round([...timings].sort((a, b) => a - b)[Math.floor(timings.length / 2)]!), maximumMs: Math.round(Math.max(...timings)), note: 'Disposable CI database; not a production latency guarantee.' }));
  await assert.rejects(() => inWorkspace(request(), response(), ctx => listQueue(ctx, merchantId, 'collections', { view: 'invalid' }), 'read'), (error: any) => error.status === 400);
  // Pilot scale: 6,000 instalments, each with a failed attempt. Every attempt
  // reads its instalment by key; comparing every attempt with every instalment
  // took over two seconds a page at this size and grew with its square.
  await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,customer_id,data,amount_kobo)
    SELECT $1 || '-scale-due-' || lpad(i::text,5,'0'),$1,'due-items','Scale instalment ' || i,'scheduled','SDUE-' || i,$2,
      jsonb_build_object('synthetic',true,'mandateId',$3::text,'owner','valopay','dueDate',CASE WHEN i%2=0 THEN '2026-09-18' ELSE '2026-09-20' END),1000000
    FROM generate_series(1,4000) i`, [merchantId, customer.id, mandate.id]);
  await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,customer_id,data,amount_kobo)
    SELECT $1 || '-scale-attempt-' || lpad(i::text,5,'0'),$1,'attempts','Scale attempt ' || i,'failed','SATT-' || i,$2,
      jsonb_build_object('synthetic',true,'dueItemId',$1 || '-scale-due-' || lpad(i::text,5,'0'),'occurredAt','2026-09-18T12:00:00Z'),1000000
    FROM generate_series(1,4000) i`, [merchantId, customer.id]);
  await pool.query('ANALYZE valopay_records');
  const scaled = await inWorkspace(request(), response(), ctx => loadState(ctx, merchantId, 'share'), 'read');
  for (const view of ['failed', 'overdue', 'all']) {
    await inWorkspace(request(), response(), async ctx => {
      const start = performance.now();
      const actual = await listQueue(ctx, merchantId, 'collections', { view, limit: 25 });
      const elapsed = performance.now() - start;
      assert.deepEqual(normalise(actual), normalise(pageQueue(scaled.records, 'collections', { view, limit: 25 }, ctx.now)), `collections at pilot scale: ${view}`);
      assert.ok(elapsed < 2000, `A pilot-scale collections page (${view}) returns in ${Math.round(elapsed)} ms.`);
    }, 'read');
  }
  // A lender loaded since the last ANALYZE, which the statistics describe as
  // empty. Each attempt still reads its instalment by primary key; as a plain
  // join PostgreSQL scanned all of the lender's instalments for every row
  // (22 s for a 25,000-record lender, past the request statement limit).
  await pool.query('ALTER TABLE valopay_records SET (autovacuum_enabled = false)');
  try {
    tokens.push(randomBytes(32).toString('hex'));
    const unanalysedId = (await inWorkspace(request(tokens[2]), response(), listMerchants))[0]!.id;
    const seeded = await inWorkspace(request(tokens[2]), response(), ctx => loadState(ctx, unanalysedId, 'share'), 'read');
    const payer = seeded.records.find(row => row.kind === 'customers')!, payerMandate = seeded.records.find(row => row.kind === 'mandates')!;
    await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,customer_id,data,amount_kobo)
      SELECT $1 || '-fresh-due-' || lpad(i::text,5,'0'),$1,'due-items','Fresh instalment ' || i,'scheduled','FDUE-' || i,$2,
        jsonb_build_object('synthetic',true,'mandateId',$3::text,'owner','valopay','dueDate','2026-09-18'),1000000
      FROM generate_series(1,6000) i`, [unanalysedId, payer.id, payerMandate.id]);
    await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,customer_id,data,amount_kobo)
      SELECT $1 || '-fresh-attempt-' || lpad(i::text,5,'0'),$1,'attempts','Fresh attempt ' || i,'failed','FATT-' || i,$2,
        jsonb_build_object('synthetic',true,'dueItemId',$1 || '-fresh-due-' || lpad(i::text,5,'0'),'occurredAt','2026-09-18T12:00:00Z'),1000000
      FROM generate_series(1,6000) i`, [unanalysedId, payer.id]);
    const loaded = await inWorkspace(request(tokens[2]), response(), ctx => loadState(ctx, unanalysedId, 'share'), 'read');
    for (const view of ['failed', 'all']) {
      await inWorkspace(request(tokens[2]), response(), async ctx => {
        const start = performance.now();
        const actual = await listQueue(ctx, unanalysedId, 'collections', { view, limit: 25 });
        const elapsed = performance.now() - start;
        assert.deepEqual(normalise(actual), normalise(pageQueue(loaded.records, 'collections', { view, limit: 25 }, ctx.now)), `collections before ANALYZE: ${view}`);
        assert.ok(elapsed < 2000, `A collections page (${view}) for a lender loaded since the last ANALYZE returns in ${Math.round(elapsed)} ms.`);
      }, 'read');
    }
  } finally { await pool.query('ALTER TABLE valopay_records RESET (autovacuum_enabled)'); }
  console.log('Priority queue integration passed: 6,000 rows, all filters, complete counts, bounded pages, deep links, related-record scoping, malformed legacy dates, date-only deadlines due all of their WAT day in every queue, a 14,000-row collections queue in linear time, and the same for a lender loaded since the last ANALYZE.');
} finally {
  const principals = tokens.map(token => createHash('sha256').update(`demo:${token}`).digest('hex'));
  const scope = 'SELECT id FROM valopay_merchants WHERE workspace_id IN (SELECT id FROM valopay_workspaces WHERE principal_hash=ANY($1::text[]))';
  await pool.query(`DELETE FROM valopay_idempotency WHERE merchant_id IN (${scope})`, [principals]);
  await pool.query(`DELETE FROM valopay_records WHERE merchant_id IN (${scope})`, [principals]);
  await pool.query('DELETE FROM valopay_merchants WHERE workspace_id IN (SELECT id FROM valopay_workspaces WHERE principal_hash=ANY($1::text[]))', [principals]);
  await pool.query('DELETE FROM valopay_workspaces WHERE principal_hash=ANY($1::text[])', [principals]);
  await pool.end();
}
