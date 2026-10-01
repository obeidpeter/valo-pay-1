// What reading the operations journal costs (the third review of the audit fixes, edge finding 1). A keyed write's
// journal entry keeps its request as it was sent, fields no route reads included, up to the 2 MB body limit. The
// Operations list, the retention screens and runs, a repeat of a key and a cancel read an entry's identity and
// outcome, never its request, so a lender whose entries hold large bodies cannot make one read parse and digest them
// all on the API's only thread: an anonymous sandbox's 100 keyed writes of 2 MB each held it for about 2.5 s on every
// GET /v1/lifecycle. Only a retry from Operations, which sends the request through its route again, and approving or
// executing a retention run an earlier build prepared, whose digests covered the stored request, read one. The
// database sends the API every jsonb value a query selects; this suite counts those that carry the bodies' marker.
// Operations also summarises each request (backlog item UX-B02-X3) from its method, path and a few short body fields,
// which the database extracts by jsonb operators and sends as text: this suite counts text values with the marker too.
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
if (process.env.VALOPAY_RUN_INTEGRATION !== "1") { console.log("Journal reads integration requires a disposable local PostgreSQL database."); process.exit(0); }
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Refuse a non-local integration database.");
// The anonymous sandbox's configuration: no staff access and no payload encryption, so a body is stored as JSON.
for (const name of ["VALOPAY_STAFF_ACCESS", "VALOPAY_RUNTIME_ISOLATION", "VALOPAY_PAYLOAD_ENCRYPTION"]) process.env[name] = "off";
const { pool } = await import("@workspace/db");
const marker = `journal-reads-${randomUUID()}`;
let bodyReads = 0, textReads = 0, journalRows = 0;
// Each connection counts the jsonb values it receives that hold the marker (a stored request is the only one), the
// text values that hold it, and the rows of the journal it receives.
pool.on("connect", (client) => {
  client.setTypeParser(3802, "text", (text: string) => { if (text.includes(marker)) bodyReads += 1; return JSON.parse(text); });
  client.setTypeParser(25, "text", (text: string) => { if (text.includes(marker)) textReads += 1; return text; });
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  (client as unknown as { query: typeof query }).query = (...args) => {
    const result = query(...args);
    return typeof args[0] === "string" && args[0].includes("FROM valopay_operations") && result instanceof Promise ? result.then((answer: { rows?: unknown[] }) => { journalRows += answer?.rows?.length ?? 0; return answer; }) : result;
  };
});
const { default: router } = await import("../src/routes/index");
const { errorHandler } = await import("../src/lib/error-handler");
const { canonicalDigest } = await import("../src/lib/digests");
const app = express();
app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {} }; next(); });
app.use(express.json({ limit: "3mb" }));
app.use((req, _res, next) => { (req as any).auth = Object.assign(() => ({ userId: null }), { [Symbol.for("@clerk/express.auth")]: true }); next(); });
app.use("/api", router); app.use(errorHandler);
const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`, cookie = `valopay_sandbox=${randomBytes(32).toString("hex")}`;
/** A request's status, answer and how many stored bodies, text values with the marker and journal rows the API received while it ran. */
async function call(path: string, method = "GET", body?: unknown, key?: string) {
  const before = bodyReads, textBefore = textReads, rowsBefore = journalRows;
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...(key ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() as any, bodyReads: bodyReads - before, textReads: textReads - textBefore, journalRows: journalRows - rowsBefore };
}
const ok = (result: { status: number; data: any }) => { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
let workspaceId: string | undefined;
let checks = 0;
try {
  const lender = ok(await call("/v1/workspace")).merchants[0].id as string;
  workspaceId = (await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1", [lender])).rows[0].workspace_id;
  // The review's shape: an unused field of 9,990 keys of 200 characters, about 2 MB, inside every limit.
  const unused = Object.fromEntries(Array.from({ length: 9_990 }, (_, i) => [`${i % 2 ? "A" : "a"}${"a".repeat(195)}${i.toString(36).padStart(4, "0")}`, 0]));
  const customer = (name: string, consent = true) => ({ name, reference: `READS-${randomUUID()}`, data: consent ? { consentProvenance: "Synthetic consent" } : {}, [marker]: unused });
  const customers = `/v1/records/customers?merchantId=${lender}`;
  const entry = async (key: string) => (await pool.query("SELECT id,status,updated_at,request_key,request_hash FROM valopay_operations WHERE merchant_id=$1 AND request_key=$2", [lender, key])).rows[0];
  const saved: Array<{ key: string; body: ReturnType<typeof customer>; record: any }> = [];
  for (let i = 0; i < 3; i++) {
    const key = randomUUID(), body = customer(`Large keyed write ${i}`), written = await call(customers, "POST", body, key);
    saved.push({ key, body, record: ok(written) });
  }
  assert.ok(JSON.stringify(saved[0]!.body).length > 2_000_000, "each body is about 2 MB");
  assert.equal(JSON.stringify(saved[0]!.record).includes(marker), false, "the saved record keeps none of the unused field, so only a stored request carries the marker");
  const refusedKey = randomUUID(), refused = await call(customers, "POST", customer("Refused large write", false), refusedKey);
  assert.equal(refused.status, 400);
  const pendingKey = randomUUID();
  assert.equal((await call(customers, "POST", customer("Unconfirmed large write", false), pendingKey)).status, 400);
  // A request whose outcome never came back (a crash before its refusal was recorded).
  await pool.query("UPDATE valopay_operations SET status='pending',receipt=NULL WHERE merchant_id=$1 AND request_key=$2", [lender, pendingKey]);
  checks += 4;

  // ---- Operations lists what it shows, reading the receipt's refusal and record reference by jsonb operators ----
  const listed = await call(`/v1/operations?merchantId=${lender}`);
  assert.equal(listed.bodyReads, 0, "the Operations list reads no stored request");
  assert.equal(listed.textReads, 0, "nor any part of one but its summary's fields");
  assert.equal(ok(listed).total, 5);
  for (const hidden of [marker, "Large keyed write", "Refused large write", "Unconfirmed large write", "READS-", "Synthetic consent"]) assert.equal(JSON.stringify(listed.data).includes(hidden), false, `the list shows no ${hidden}`);
  const item = (key: string) => listed.data.items.find((candidate: any) => candidate.id === (listedIds.get(key)));
  const listedIds = new Map<string, string>();
  for (const key of [...saved.map((write) => write.key), refusedKey, pendingKey]) listedIds.set(key, (await entry(key)).id);
  for (const write of saved) {
    const shown = item(write.key);
    assert.deepEqual([shown.status, shown.recordId, shown.recordKind, shown.message], ["completed", write.record.id, "customers", "Valo Pay saved this request."]);
  }
  assert.equal(item(refusedKey).status, "cancelled");
  assert.match(item(refusedKey).message, /^Valo Pay refused this request: .+ Correct it and send it again\.$/, "a refused request shows the reason it was given");
  assert.deepEqual([item(pendingKey).status, item(pendingKey).recordId, item(pendingKey).message], ["pending", null, "Valo Pay has not confirmed this request yet. Check the original request."]);
  // Each entry says what it asked, from its path: a new customer record. Its name, reference and consent are not read.
  for (const key of listedIds.keys()) assert.deepEqual(item(key).summary, { action: "Add a record", targetKind: "customers", targetId: null, details: [] });
  const paged = await call(`/v1/operations?merchantId=${lender}&offset=3`);
  assert.deepEqual([paged.bodyReads, paged.textReads, ok(paged).items.length, paged.data.total], [0, 0, 2, 5]);
  // The count the console shows on its Operations link: the one pending entry, counted without reading it.
  const pendingCount = await call(`/v1/operations/pending?merchantId=${lender}`);
  assert.deepEqual([ok(pendingCount), pendingCount.bodyReads, pendingCount.textReads], [{ pending: 1 }, 0, 0]);
  checks += 13;

  // ---- A repeat of a saved key, a cancel and a retry: only the retry opens the request, to send it again ----
  const repeated = await call(customers, "POST", saved[0]!.body, saved[0]!.key);
  assert.deepEqual([repeated.status, repeated.data, repeated.bodyReads], [200, saved[0]!.record, 0], "a repeat of a saved key replays its answer without reading the stored request");
  const cancelled = await call(`/v1/operations/${listedIds.get(pendingKey)}/cancel?merchantId=${lender}`, "POST", {});
  assert.deepEqual([cancelled.status, cancelled.bodyReads], [200, 0], "a cancel reads no stored request");
  assert.deepEqual(ok(await call(`/v1/operations/pending?merchantId=${lender}`)), { pending: 0 }, "a cancelled request no longer waits");
  const retried = await call(`/v1/operations/${listedIds.get(saved[1]!.key)}/retry?merchantId=${lender}`, "POST", {});
  assert.deepEqual([retried.status, retried.data, retried.bodyReads], [200, saved[1]!.record, 1], "a retry opens its own request, and only it");
  checks += 3;

  // ---- The retention screens: every terminal entry, with a digest that needs no body ----
  let lifecycle = await call(`/v1/lifecycle?merchantId=${lender}`);
  assert.equal(lifecycle.bodyReads, 0, "the retention view reads no stored request");
  const journal = (view: any) => view.targets.filter((target: any) => target.kind === "journal_payload");
  assert.equal(journal(ok(lifecycle)).length, 5, "three completed and two cancelled requests are retained");
  // A terminal entry's payload changes only when it settles, which moves its version, or when retention purges it,
  // so its digest covers the request's fingerprint, its key, its outcome and its version.
  const digestOf = (row: any) => canonicalDigest({ hash: row.request_hash, key: row.request_key, status: row.status, version: row.updated_at.toISOString() });
  for (const key of listedIds.keys()) {
    const row = await entry(key), target = journal(lifecycle.data).find((candidate: any) => candidate.sourceId === row.id);
    assert.deepEqual([target.status, target.version, target.digest], [row.status, row.updated_at.toISOString(), digestOf(row)], `the digest of ${row.status} entry ${row.id}`);
  }
  checks += 7;
  // Old enough for a 30-day policy; the run is prepared, approved and executed without reading a body.
  const at = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  await pool.query("UPDATE valopay_operations SET updated_at=$2::timestamptz WHERE merchant_id=$1 AND status IN ('completed','cancelled')", [lender, at(31)]);
  lifecycle = await call(`/v1/lifecycle/policy?merchantId=${lender}`, "POST", { policy: { rawCsvDays: null, journalPayloadDays: 30, exportFileDays: null, auditTrail: "retain" }, expectedRevision: lifecycle.data.policyRevision, reason: "Synthetic journal retention rehearsal" }, randomUUID());
  assert.deepEqual([lifecycle.status, lifecycle.bodyReads, lifecycle.data.eligibleCount], [200, 0, 5]);
  let run = await call(`/v1/lifecycle/runs?merchantId=${lender}`, "POST", { expectedPolicyRevision: lifecycle.data.policyRevision }, randomUUID());
  assert.deepEqual([run.status, run.bodyReads, run.data.candidates.length], [200, 0, 5], "a preview reads no stored request");
  for (const candidate of run.data.candidates) assert.equal(candidate.digest, digestOf(await pool.query("SELECT status,updated_at,request_key,request_hash FROM valopay_operations WHERE id=$1", [candidate.sourceId]).then((result) => result.rows[0])));
  run = await call(`/v1/lifecycle/runs/${run.data.id}/approve?merchantId=${lender}`, "POST", { expectedUpdatedAt: run.data.updatedAt, previewDigest: run.data.previewDigest, reason: "Approve the exact synthetic journal cleanup" }, randomUUID());
  assert.deepEqual([run.status, run.bodyReads], [200, 0], "an approval reads no stored request");
  run = await call(`/v1/lifecycle/runs/${run.data.id}/execute?merchantId=${lender}`, "POST", { previewDigest: run.data.previewDigest }, randomUUID());
  assert.deepEqual([run.status, run.bodyReads, run.data.status, run.data.successful], [200, 0, "completed", 5], "nor does removing each payload");
  const purged = (await pool.query("SELECT request->>'purged' AS purged FROM valopay_operations WHERE merchant_id=$1 AND id=ANY($2::text[])", [lender, [...listedIds.values()]])).rows;
  assert.deepEqual(purged.map((row) => row.purged), ["true", "true", "true", "true", "true"], "every retained payload was purged");
  lifecycle = await call(`/v1/lifecycle?merchantId=${lender}`);
  assert.equal(lifecycle.bodyReads, 0);
  assert.deepEqual(journal(ok(lifecycle)).filter((target: any) => [...listedIds.values()].includes(target.sourceId)), [], "a purged payload is no longer retained");
  checks += 12;

  // ---- A run an earlier build prepared: its digests covered the stored request and receipt ----
  // They are computed again for that run's own sources, which it compares, and match as they did; each stored version
  // of an entry is read once in a process. The run is made here as that build made it.
  const earlierKeys = [randomUUID(), randomUUID()];
  for (const [index, key] of earlierKeys.entries()) ok(await call(customers, "POST", customer(`Earlier build write ${index}`), key));
  await pool.query("UPDATE valopay_operations SET updated_at=$3::timestamptz WHERE merchant_id=$1 AND request_key=ANY($2::text[])", [lender, earlierKeys, at(32)]);
  lifecycle = await call(`/v1/lifecycle?merchantId=${lender}`);
  const earlierDigest = async (id: string) => { const row = (await pool.query("SELECT request,receipt,request_key,request_hash,status FROM valopay_operations WHERE id=$1", [id])).rows[0]; return canonicalDigest({ request: row.request, receipt: row.receipt, key: row.request_key, hash: row.request_hash, status: row.status }, "legacy-en-us-null"); };
  /** A preview whose journal digests an earlier build computed (`digests` names a wrong one to give a source). */
  async function earlierPreview(digests: (id: string) => Promise<string>) {
    const preview = ok(await call(`/v1/lifecycle/runs?merchantId=${lender}`, "POST", { expectedPolicyRevision: lifecycle.data.policyRevision }, randomUUID()));
    const stored = (await pool.query("SELECT data FROM valopay_records WHERE id=$1 AND merchant_id=$2", [preview.id, lender])).rows[0].data;
    const candidates = await Promise.all(stored.candidates.map(async (candidate: any) => ({ ...candidate, digest: await digests(candidate.sourceId) })));
    const previewDigest = canonicalDigest({ merchantId: lender, policyRevision: stored.policyRevision, candidates }, "legacy-en-us-replacer");
    await pool.query("UPDATE valopay_records SET data=$3 WHERE id=$1 AND merchant_id=$2", [preview.id, lender, { ...stored, candidates, previewDigest }]);
    return { ...preview, previewDigest, candidates };
  }
  const earlier = await earlierPreview(earlierDigest);
  assert.equal(earlier.candidates.length, 2);
  assert.notEqual(earlier.candidates[0].digest, journal(lifecycle.data).find((target: any) => target.sourceId === earlier.candidates[0].sourceId).digest, "the earlier build's digest is not this build's");
  lifecycle = await call(`/v1/lifecycle?merchantId=${lender}`);
  assert.equal(lifecycle.bodyReads, 0, "the retention view computes no earlier digest, even with such a run saved");
  const approved = await call(`/v1/lifecycle/runs/${earlier.id}/approve?merchantId=${lender}`, "POST", { expectedUpdatedAt: earlier.updatedAt, previewDigest: earlier.previewDigest, reason: "Approve a run an earlier build prepared" }, randomUUID());
  assert.deepEqual([approved.status, approved.bodyReads], [200, 2], "its approval matches its two sources as before, reading their requests and nothing else");
  const executed = await call(`/v1/lifecycle/runs/${earlier.id}/execute?merchantId=${lender}`, "POST", { previewDigest: earlier.previewDigest }, randomUUID());
  assert.deepEqual([executed.status, executed.bodyReads, executed.data.status, executed.data.successful], [200, 0, "completed", 2], "its execution matches them again from what the approval read");
  checks += 5;
  // A source whose stored payload no longer gives the digest the earlier build saw is refused, as that build refused it.
  const changedKey = randomUUID();
  ok(await call(customers, "POST", customer("Earlier build write changed since"), changedKey));
  await pool.query("UPDATE valopay_operations SET updated_at=$3::timestamptz WHERE merchant_id=$1 AND request_key=$2", [lender, changedKey, at(33)]);
  lifecycle = await call(`/v1/lifecycle?merchantId=${lender}`);
  const changed = await earlierPreview(async () => "f".repeat(64));
  let refusedRun = await call(`/v1/lifecycle/runs/${changed.id}/approve?merchantId=${lender}`, "POST", { expectedUpdatedAt: changed.updatedAt, previewDigest: changed.previewDigest, reason: "A changed source must not be approved" }, randomUUID());
  assert.deepEqual([refusedRun.status, refusedRun.bodyReads], [409, 1], "the source is read once and refused");
  assert.match(refusedRun.data.error, /A file in this preview has changed/);
  refusedRun = await call(`/v1/lifecycle/runs/${changed.id}/approve?merchantId=${lender}`, "POST", { expectedUpdatedAt: changed.updatedAt, previewDigest: changed.previewDigest, reason: "A changed source must not be approved" }, randomUUID());
  assert.deepEqual([refusedRun.status, refusedRun.bodyReads], [409, 0], "and not read again while it is unchanged");
  checks += 3;

  // ---- However many requests a lender retains, a retention request reads a page of them ----
  // 3,000 more small entries, three to an instant, most of them old enough to delete. A view's page reads the journal
  // from its offset less the lender's import batches and exports, which bound its other sources, and that many and 100
  // more; a preview reads the first 100 and one for each held request; a run reads its own. The rest are counted.
  await pool.query(`INSERT INTO valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label,status,created_at,updated_at)
    SELECT encode(sha256(convert_to($2||i,'UTF8')),'hex'),$1,o.owner,o.actor,o.role,$2||i,encode(sha256(convert_to($3||i,'UTF8')),'hex'),'{"method":"POST","path":"/v1/records/customers","body":{}}','Save records customers',CASE WHEN i%5=0 THEN 'cancelled' ELSE 'completed' END,t,t
    FROM generate_series(1,3000) i, LATERAL (SELECT now()-interval '60 days'+(i/3)*interval '1 minute'+CASE WHEN i>2600 THEN interval '59 days' ELSE interval '0' END AS t) stamp,
      (SELECT owner,actor,role FROM valopay_operations WHERE merchant_id=$1 AND request_key=$4) o`, [lender, `scale-${randomUUID()}-`, `hash-${randomUUID()}-`, changedKey]);
  const others = Number((await pool.query("SELECT count(*) FROM valopay_records WHERE merchant_id=$1 AND kind IN ('import-batches','exports')", [lender])).rows[0].count);
  const retained = (await pool.query(`SELECT id,date_trunc('milliseconds',updated_at) < now()-interval '30 days' AS old FROM valopay_operations WHERE merchant_id=$1 AND status IN ('completed','cancelled') AND NOT(request ? 'purged') ORDER BY date_trunc('milliseconds',updated_at),id COLLATE "C"`, [lender])).rows as Array<{ id: string; old: boolean }>;
  assert.ok(retained.length > 3000 && others < 50);
  const pages: any[] = [];
  let first: any;
  for (let offset = 0; ; offset += 100) {
    const page = await call(`/v1/lifecycle?merchantId=${lender}&offset=${offset}`);
    first ??= ok(page);
    assert.deepEqual([page.status, page.bodyReads], [200, 0]);
    assert.ok(page.journalRows <= others + 100 + 1, `the page at ${offset} read ${page.journalRows} journal rows`);
    pages.push(...page.data.targets);
    if (offset + 100 >= page.data.targetTotal) break;
  }
  const keyOf = (target: any) => `${target.kind}:${target.sourceId}`;
  assert.equal(pages.length, first.targetTotal, "the pages list every retained source once");
  assert.equal(new Set(pages.map(keyOf)).size, pages.length);
  assert.ok(pages.every((target, index) => !index || pages[index - 1].createdAt < target.createdAt || (pages[index - 1].createdAt === target.createdAt && keyOf(pages[index - 1]) < keyOf(target))), "in the inventory's order");
  assert.deepEqual(pages.filter((target) => target.kind === "journal_payload").map((target) => target.sourceId), retained.map((row) => row.id), "and every retained request, in the journal's order");
  const old = new Set(retained.filter((row) => row.old).map((row) => row.id));
  assert.equal(first.eligibleCount, old.size, "every request old enough is counted eligible (the policy keeps the other categories)");
  checks += 5;
  run = await call(`/v1/lifecycle/runs?merchantId=${lender}`, "POST", { expectedPolicyRevision: first.policyRevision }, randomUUID());
  assert.deepEqual([run.status, run.bodyReads, run.data.candidates.length, run.data.moreEligible], [200, 0, 100, first.eligibleCount - 100]);
  // Beside the journal's own reads of the request's entry: its key, the pending count and the write's check.
  const own = 5;
  assert.ok(run.journalRows <= 100 + own, `a preview read ${run.journalRows} journal rows`);
  assert.deepEqual(run.data.candidates.map((candidate: any) => candidate.sourceId), pages.filter((target) => target.kind === "journal_payload" && old.has(target.sourceId)).slice(0, 100).map((target) => target.sourceId), "a preview takes the oldest eligible requests");
  run = await call(`/v1/lifecycle/runs/${run.data.id}/approve?merchantId=${lender}`, "POST", { expectedUpdatedAt: run.data.updatedAt, previewDigest: run.data.previewDigest, reason: "Approve the oldest synthetic requests" }, randomUUID());
  assert.deepEqual([run.status, run.bodyReads], [200, 0]);
  assert.ok(run.journalRows <= 100 + own, `an approval read ${run.journalRows} journal rows: its own sources`);
  run = await call(`/v1/lifecycle/runs/${run.data.id}/execute?merchantId=${lender}`, "POST", { previewDigest: run.data.previewDigest }, randomUUID());
  assert.deepEqual([run.status, run.bodyReads, run.data.status, run.data.successful], [200, 0, "completed", 100]);
  assert.ok(run.journalRows <= 200 + own, `an execution read ${run.journalRows} journal rows: its own sources, and each again as it is purged`);
  const after = ok(await call(`/v1/lifecycle?merchantId=${lender}`));
  // The preview, the approval and the execution are requests of their own, retained and too recent to delete.
  assert.deepEqual([after.targetTotal, after.eligibleCount], [first.targetTotal - 100 + 3, first.eligibleCount - 100], "the purged requests are no longer retained or counted");
  checks += 8;

  // ---- Backlog item UX-B02-X3: each entry says what it asked, and nothing of its body but a few short fields ----
  // A change to a record whose outcome never came back, an action the service refused, whose reason holds the marker,
  // and two entries stored as others are: an export an earlier build completed, which kept its answer's kind, and a
  // request sealed by payload encryption.
  const [target] = ok(await call(customers)).items as Array<{ id: string }>;
  const mandate = (ok(await call(`/v1/records/mandates?merchantId=${lender}`)).items as Array<{ id: string }>)[0]!;
  const changeKey = randomUUID(), actionKey = randomUUID();
  const change = await call(`/v1/records/customers/${encodeURIComponent(target!.id)}?merchantId=${lender}`, "PATCH", { status: "not_a_status", name: `Private ${marker}`, data: { note: marker } }, changeKey);
  assert.equal(change.status, 400, JSON.stringify(change.data));
  await pool.query("UPDATE valopay_operations SET status='pending',receipt=NULL WHERE merchant_id=$1 AND request_key=$2", [lender, changeKey]);
  const action = await call(`/v1/actions?merchantId=${lender}`, "POST", { action: "mandate_suspend", recordId: mandate.id, reason: marker, data: { unknown: marker } }, actionKey);
  assert.ok([200, 400, 409].includes(action.status), JSON.stringify(action.data));
  const stored = async (key: string, request: unknown, status: string, receipt: unknown) => {
    const id = `summary-${randomUUID()}`;
    await pool.query(`INSERT INTO valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label,status,receipt,created_at,updated_at)
      SELECT $1,$2,owner,actor,role,$3,$4,$5,'Save exports',$6,$7,now(),now() FROM valopay_operations WHERE merchant_id=$2 AND request_key=$8`, [id, lender, key, `hash-${key}`, request, status, receipt, changeKey]);
    return id;
  };
  const exported = await stored(randomUUID(), { method: "POST", path: "/v1/exports", body: { kind: "customers", format: "csv" } }, "completed", { id: "export-earlier", kind: "customers" });
  const sealedRequest = { protectedPayload: 1, key: "projects/p/locations/l/keyRings/r/cryptoKeys/k", wrappedKey: "a", iv: "b", tag: "c", ciphertext: marker };
  const sealed = await stored(randomUUID(), sealedRequest, "pending", null);
  // Fix review: an export an earlier build completed and payload encryption sealed. Its answer named the kind it
  // exported and its sealed request cannot name its route, so the kind of the record its answer names is the lender's.
  const sealedExport = `export-${randomUUID()}`;
  await pool.query("INSERT INTO valopay_records(id,merchant_id,kind,name,status,data) VALUES($1,$2,'exports','Customer register','ready','{}')", [sealedExport, lender]);
  const sealedExportId = await stored(randomUUID(), sealedRequest, "completed", { id: sealedExport, kind: "customers" });
  const summarised = await call(`/v1/operations?merchantId=${lender}`);
  assert.deepEqual([summarised.bodyReads, summarised.textReads], [0, 0], "the summaries read no body, and no field but theirs");
  assert.equal(JSON.stringify(ok(summarised)).includes(marker), false, "nothing the bodies hold beyond those fields is shown");
  const shownAs = (id: string) => summarised.data.items.find((candidate: any) => candidate.id === id);
  const changeId = (await entry(changeKey)).id, actionId = (await entry(actionKey)).id;
  assert.deepEqual(shownAs(changeId).summary, { action: "Change a record", targetKind: "customers", targetId: target!.id, details: [{ name: "Status", value: "Not a status" }] }, "a change names its record and the status it sent, in words");
  assert.deepEqual(shownAs(actionId).summary, { action: "Suspend mandate", targetKind: "mandates", targetId: mandate.id, details: [] }, "an action names the record its recordId names, and that record's kind");
  assert.deepEqual([shownAs(exported).recordId, shownAs(exported).recordKind, shownAs(exported).summary.action], ["export-earlier", "exports", "Create an export"], "an export's saved result is the export, whatever kind it exports");
  assert.equal(shownAs(sealed).summary, null, "a sealed request is not opened for its summary");
  assert.deepEqual([shownAs(sealedExportId).recordId, shownAs(sealedExportId).recordKind, shownAs(sealedExportId).summary], [sealedExport, "exports", null], "a sealed export's saved result is the export too");
  const counted = await call(`/v1/operations/pending?merchantId=${lender}`);
  assert.deepEqual([ok(counted), counted.bodyReads, counted.textReads], [{ pending: 2 }, 0, 0], "the changed record and the sealed request wait");
  checks += 11;
  console.log(`Journal reads PostgreSQL integration passed (${checks} checks): the Operations list, its summaries and pending count, the retention view, policy, preview, approval and execution, a repeat of a key and a cancel read no stored request; a retry reads its own; a run an earlier build prepared matches its sources as before, reading each once; and with ${retained.length} retained requests a retention request reads a page of them.`);
} finally {
  server.close(); await once(server, "close");
  if (workspaceId) {
    await pool.query("DELETE FROM valopay_idempotency WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)", [workspaceId]);
    await pool.query("DELETE FROM valopay_operations WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)", [workspaceId]);
    await pool.query("DELETE FROM valopay_records WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id=$1)", [workspaceId]);
    await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [workspaceId]);
    await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [workspaceId]);
  }
  await pool.end();
}
