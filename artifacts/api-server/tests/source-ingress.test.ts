import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import express from "express";
import { seedMerchant } from "../src/lib/valo-pay-1-seed";
process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
const { createPaystackIngress } = await import("../src/routes/sources");
const key = ["sk", "test", "OFFLINE", "0".repeat(20)].join("_");
const connectionId = "a".repeat(64), wrongConnection = "b".repeat(64);
let state = seedMerchant("mapped-lender", true); state.records = [];
const ctx = { actor: "System · Paystack test ingress", role: "Admin", now: "2026-09-22T12:00:00.000Z" };
// `opened` counts lender transactions: a delivery whose signature has not been verified must never open one.
let opened = 0, configured = true;
const app = express();
app.use(createPaystackIngress({
  secretKey: () => { if (!configured) throw Object.assign(new Error("Paystack test ingress is not configured."), { status: 503 }); return key; },
  transact: async (id, apply) => {
    opened++;
    if (id !== connectionId) throw Object.assign(new Error("Test connection is not available."), { status: 404 });
    const copy = structuredClone(state), result = await apply({ state: copy, context: ctx });
    state = copy; return result;
  },
}));
app.use(express.json());
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status || 400).json({ error: error.message }); });
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const address = server.address(); assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const body = JSON.stringify({ event: "charge.success", data: { domain: "test", id: "800001", status: "success", amount: 10000, currency: "NGN", reference: "INGRESS-SYNTHETIC-001", channel: "direct_debit" } });
const signature = createHmac("sha512", key).update(body).digest("hex"), forged = "f".repeat(128);
// `sig: null` sends no signature header at all; a default parameter would turn an explicit undefined back into the valid signature.
const send = (raw = body, sig: string | null = signature, id = connectionId, contentType = "application/json") => fetch(`${base}/v1/providers/paystack/${id}/events?merchantId=attacker-chosen-lender`, { method: "POST", headers: { "content-type": contentType, ...(sig === null ? {} : { "x-paystack-signature": sig }) }, body: raw });
try {
  assert.equal((await send(`${body} `)).status, 401);
  assert.equal(opened, 0, "Tampered bytes never open the lender.");
  assert.equal((await send(body, forged)).status, 401);
  assert.equal(opened, 0, "A forged signature never opens the lender.");
  assert.equal((await send(body, null)).status, 401);
  assert.equal(opened, 0, "A missing signature never opens the lender.");
  assert.equal((await send(body, forged, wrongConnection)).status, 401, "An unsigned caller cannot tell mapped connection IDs from unmapped ones.");
  assert.equal(opened, 0);
  configured = false;
  const off = await send(); assert.equal(off.status, 503); assert.equal(((await off.json()) as { error: string }).error, "Paystack test ingress is not configured.");
  assert.equal(opened, 0, "An ingress that is switched off never opens the lender."); configured = true;
  const live = body.replace('"domain":"test"', '"domain":"live"');
  assert.equal((await send(live, createHmac("sha512", key).update(live).digest("hex"))).status, 400);
  assert.equal(opened, 0, "A signed live-mode event is refused before the lender is opened.");
  assert.equal(state.records.length, 0, "Refused deliveries leave no durable receipt.");
  assert.equal((await send(body, signature, wrongConnection)).status, 404);
  assert.equal(opened, 1, "Only a verified event reaches the connection lookup.");
  assert.equal(state.records.length, 0, "Unknown connections do not bootstrap lenders.");
  assert.equal((await send(body, signature, connectionId, "text/plain")).status, 400);
  assert.equal(opened, 1);
  const first = await send(); assert.equal(first.status, 200); assert.deepEqual(await first.json(), { accepted: true, duplicate: false });
  assert.equal(opened, 2);
  assert.equal(state.records.length, 1); assert.equal(state.records[0]!.merchantId, "mapped-lender");
  assert.equal(state.records[0]!.data.mode, "test");
  const repeated = await send(); assert.equal(repeated.status, 200); assert.deepEqual(await repeated.json(), { accepted: true, duplicate: true });
  assert.equal(state.records.length, 1); assert.equal(state.records[0]!.data.deliveryCount, 2);
  assert.equal(state.records[0]!.status, "awaiting_verification");
} finally { await new Promise<void>((resolve,reject) => server.close(error=>error?reject(error):resolve())); }

// The ingress settings, read from the process environment only: what the route and `pnpm run check:paystack` see.
const { paystackIngressStatus, paystackTestSecretKey, paystackConnections } = await import("../src/providers/paystack-ingress-config");
const names = ["VALO_PAY_1_PAYSTACK_INGRESS", "PAYSTACK_TEST_SECRET_KEY", "VALO_PAY_1_PAYSTACK_CONNECTIONS"] as const;
const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
const refusedWith = (status: number, message: RegExp) => (error: any) => error.status === status && message.test(error.message);
try {
  for (const name of names) delete process.env[name];
  assert.deepEqual(paystackIngressStatus(), { webhookIngestion: "disabled", mappedConnections: 0 });
  assert.throws(paystackTestSecretKey, refusedWith(503, /not configured/));
  process.env.VALO_PAY_1_PAYSTACK_INGRESS = "test"; process.env.PAYSTACK_TEST_SECRET_KEY = "not-a-key";
  assert.deepEqual(paystackIngressStatus(), { webhookIngestion: "misconfigured", mappedConnections: 0 });
  assert.throws(paystackTestSecretKey, refusedWith(503, /test credential is required/));
  process.env.PAYSTACK_TEST_SECRET_KEY = key;
  process.env.VALO_PAY_1_PAYSTACK_CONNECTIONS = JSON.stringify({ [connectionId]: { workspaceId: "w1", merchantId: "m1" }, [wrongConnection]: { workspaceId: "w2", merchantId: "m2" } });
  assert.deepEqual(paystackIngressStatus(), { webhookIngestion: "test_only", mappedConnections: 2 }, "the status counts mappings and never names them");
  assert.equal(paystackTestSecretKey(), key);
  assert.deepEqual(Object.keys(paystackConnections()).sort(), [connectionId, wrongConnection]);
  process.env.VALO_PAY_1_PAYSTACK_CONNECTIONS = "not json";
  assert.deepEqual(paystackIngressStatus(), { webhookIngestion: "misconfigured", mappedConnections: 0 });
  assert.throws(paystackConnections, refusedWith(503, /configuration is invalid/));
  process.env.VALO_PAY_1_PAYSTACK_CONNECTIONS = JSON.stringify({ short: { workspaceId: "w1", merchantId: "m1" } });
  assert.throws(paystackConnections, refusedWith(503, /configuration is invalid/), "a connection ID must be 64 hexadecimal characters");
} finally {
  for (const name of names) { const value = saved[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
}

// The real connection lookup, with the lender lock and the read without it standing in for the database: a lock
// that is not taken is either a busy lender (503, retry) or a mapping to a lender that is not there (404, correct it).
const { createPaystackConnectionTransaction } = await import("../src/lib/paystack-connection");
const goneConnection = "c".repeat(64), missingLender = "The lender mapped to this Paystack test connection was not found. Correct the connection mapping.";
let locks = 0, lenderInWorkspace = false;
const lookups: string[][] = [];
const lookup = express();
lookup.use(createPaystackIngress({ secretKey: paystackTestSecretKey, transact: createPaystackConnectionTransaction({
  inMerchantAsSystem: async () => { locks++; return undefined; },
  merchantInWorkspace: async (merchantId, workspaceId) => { lookups.push([merchantId, workspaceId]); return lenderInWorkspace; },
}) }));
lookup.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status || 400).json({ error: error.message }); });
const lookupServer = lookup.listen(0, "127.0.0.1");
await new Promise<void>(resolve => lookupServer.once("listening", resolve));
const lookupAddress = lookupServer.address(); assert.ok(lookupAddress && typeof lookupAddress !== "string");
const deliver = async (sig: string, id = goneConnection) => { const response = await fetch(`http://127.0.0.1:${lookupAddress.port}/v1/providers/paystack/${id}/events`, { method: "POST", headers: { "content-type": "application/json", "x-paystack-signature": sig }, body }); return { status: response.status, error: ((await response.json()) as { error: string }).error }; };
try {
  process.env.VALO_PAY_1_PAYSTACK_INGRESS = "test"; process.env.PAYSTACK_TEST_SECRET_KEY = key;
  process.env.VALO_PAY_1_PAYSTACK_CONNECTIONS = JSON.stringify({ [goneConnection]: { workspaceId: "mapped-workspace", merchantId: "removed-lender" } });
  assert.equal((await deliver(forged)).status, 401);
  assert.deepEqual([locks, lookups], [0, []], "a forged delivery never tries the lock or looks for the lender");
  assert.deepEqual(await deliver(signature), { status: 404, error: missingLender }, "a verified delivery to a lender that is not there names the mapping, not a busy lender");
  assert.deepEqual([locks, lookups], [1, [["removed-lender", "mapped-workspace"]]], "the lender is looked for in the mapped workspace only after the lock was not taken");
  lenderInWorkspace = true;
  assert.deepEqual(await deliver(signature), { status: 503, error: "The test lender is busy. Retry this delivery." }, "a lender that is there but locked stays busy");
  assert.deepEqual(await deliver(signature, connectionId), { status: 404, error: "Paystack test connection not found." });
  assert.deepEqual([locks, lookups.length], [2, 2], "an unmapped connection never tries a lock");
} finally {
  for (const name of names) { const value = saved[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  await new Promise<void>((resolve, reject) => lookupServer.close(error => error ? reject(error) : resolve()));
}
// One connection's signed deliveries are limited whichever addresses they come from (a replayed capture can
// rotate them): the 61st in a minute is refused before the lender is tried.
const limitedConnection = "d".repeat(64);
let tries = 0;
const limited = express();
limited.use(createPaystackIngress({ secretKey: paystackTestSecretKey, transact: createPaystackConnectionTransaction({ inMerchantAsSystem: async () => { tries++; return undefined; }, merchantInWorkspace: async () => true }) }));
limited.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status || 400).json({ error: error.message }); });
const limitedServer = limited.listen(0, "127.0.0.1");
await new Promise<void>(resolve => limitedServer.once("listening", resolve));
try {
  process.env.VALO_PAY_1_PAYSTACK_INGRESS = "test"; process.env.PAYSTACK_TEST_SECRET_KEY = key;
  process.env.VALO_PAY_1_PAYSTACK_CONNECTIONS = JSON.stringify({ [limitedConnection]: { workspaceId: "w1", merchantId: "m1" } });
  const statuses: number[] = [];
  for (let i = 0; i < 61; i++) { const response = await fetch(`http://127.0.0.1:${(limitedServer.address() as { port: number }).port}/v1/providers/paystack/${limitedConnection}/events`, { method: "POST", headers: { "content-type": "application/json", "x-paystack-signature": signature }, body }); statuses.push(response.status); await response.arrayBuffer(); }
  assert.deepEqual([statuses.filter(status => status === 503).length, statuses.at(-1)], [60, 429], "60 signed deliveries a minute per connection; the busy lender answers each of them 503");
  assert.equal(tries, 60, "a refused delivery never tries the lender");
} finally {
  for (const name of names) { const value = saved[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  await new Promise<void>((resolve, reject) => limitedServer.close(error => error ? reject(error) : resolve()));
}

// A repeat delivery writes nothing within a minute of its receipt's last write, and never an audit entry:
// only a new receipt is saved with one. Repeats in between are counted at the receipt's next write.
const { createDeliveryRecorder } = await import("../src/lib/paystack-connection");
const { receivePaystackEvent } = await import("../src/providers/paystack-inbox");
const { parsePaystackTestWebhook } = await import("../src/providers/paystack");
const recorder = createDeliveryRecorder(60_000), event = parsePaystackTestWebhook(Buffer.from(body), signature, key);
let stored = seedMerchant("recorded-lender", true); stored.records = [];
/** One delivery in its own transaction: what it would write, and what is stored afterwards. */
const deliverAt = (now: string) => {
  const working = structuredClone(stored), seen = recorder.before(working);
  receivePaystackEvent(working, { ...ctx, now }, event, { connectionId, mode: "test" });
  const write = recorder.after(working, seen, "recorded-lender", now);
  if (write !== "none") stored = working;
  return write;
};
assert.equal(deliverAt("2026-09-22T12:00:00.000Z"), "receipt", "a new event is a receipt, saved with its audit entry");
assert.deepEqual([deliverAt("2026-09-22T12:00:10.000Z"), deliverAt("2026-09-22T12:00:20.000Z"), deliverAt("2026-09-22T12:00:59.999Z")], ["none", "none", "none"], "repeats within a minute of the last write write nothing");
assert.equal(stored.records[0]!.data.deliveryCount, 1);
assert.equal(deliverAt("2026-09-22T12:01:00.000Z"), "count", "a minute after the last write, the count alone is written");
assert.deepEqual([stored.records.length, stored.records[0]!.data.deliveryCount, stored.records[0]!.data.lastReceivedAt], [1, 5, "2026-09-22T12:01:00.000Z"], "with the repeats tallied meanwhile, and no other record");
assert.equal(deliverAt("2026-09-22T12:01:30.000Z"), "none", "and the next minute starts from that write");
console.log("Raw Paystack ingress checks passed: signature verified on the exact bytes before any lender is opened, mapped-lender isolation, duplicate acknowledgement, test-only boundary, ingress settings, a busy lender told from a mapping to a missing one, a delivery limit per connection, and repeats written at most once a minute without an audit entry.");
