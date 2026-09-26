import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createPaystackTestAdapter, parsePaystackTestWebhook, PaystackError, reconcilePaystackEvidence, reconcilePaystackMandateEvidence, type ExpectedPayment, type VerifiedPayment } from '../src/providers/paystack.js';

// Entirely synthetic, deliberately public fixture key. All HTTP is injected; no network or environment access.
// Construct unmistakably synthetic credentials locally; no provider-issued key is stored.
const key = ['sk', 'test', 'OFFLINE', 'FIXTURE', '0'.repeat(20)].join('_');
const liveKey = ['sk', 'live', '0'.repeat(32)].join('_');
const publicKey = ['pk', 'test', '0'.repeat(32)].join('_');
const expected: ExpectedPayment = { reference: 'SAMPLE-DD-001', amountKobo: 100029, currency: 'NGN', channel: 'direct_debit' };
const fixture = { id: 4099260516, domain: 'test', status: 'success', reference: expected.reference, amount: expected.amountKobo, currency: 'NGN', channel: 'direct_debit', customer: { email: 'private@example.test' }, authorization: { authorization_code: 'AUTH_private_do_not_return' } };
let checks = 0;
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const errorCode = (code: string) => (error: unknown) => error instanceof PaystackError && error.code === code;
const sign = (bytes: Uint8Array) => createHmac('sha512', key).update(bytes).digest('hex');
const event = (data: unknown = fixture) => Buffer.from(JSON.stringify({ event: 'charge.success', data }));
function harness(payload: unknown = { status: true, data: fixture }, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), init }); return response(payload, status); };
  return { calls, adapter: createPaystackTestAdapter({ secretKey: key, fetch: fetcher }) };
}

for (const secretKey of ['', liveKey, publicKey, `${key}\n`]) {
  assert.throws(() => createPaystackTestAdapter({ secretKey }), errorCode('configuration')); checks++;
}
assert.throws(() => createPaystackTestAdapter({ secretKey: key, timeoutMs: 15001 }), errorCode('configuration')); checks++;

const good = harness();
const verified = await good.adapter.verifyTransaction(expected);
assert.equal(verified.state, 'succeeded');
assert.equal(verified.amountKobo, 100029);
assert.equal(verified.transactionId, '4099260516');
assert.equal(good.calls[0]!.url, 'https://api.paystack.co/transaction/verify/SAMPLE-DD-001');
assert.equal(good.calls[0]!.init?.method, 'GET');
assert.equal(good.calls[0]!.init?.redirect, 'error');
assert.equal((good.calls[0]!.init?.headers as Record<string, string>).Authorization, `Bearer ${key}`);
assert.ok(good.calls[0]!.init?.signal instanceof AbortSignal);
assert.ok(!JSON.stringify(verified).includes('private'));
checks += 9;

// Capture credentials when creating the adapter; caller mutation cannot switch a validated test key to live.
const mutableOptions = { secretKey: key, fetch: (async (_url, init) => {
  assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${key}`);
  return response({ status: true, data: [] });
}) as typeof fetch };
const immutableConnection = createPaystackTestAdapter(mutableOptions);
mutableOptions.secretKey = liveKey;
assert.equal((await immutableConnection.checkConnection()).directDebitAvailability, 'unconfirmed'); checks += 2;

const connection = harness({ status: true, data: [] });
assert.deepEqual(await connection.adapter.checkConnection(), { provider: 'paystack', mode: 'test', authenticated: true, directDebitAvailability: 'unconfirmed' });
assert.equal(connection.calls[0]!.url, 'https://api.paystack.co/transaction?perPage=1&page=1');
await assert.rejects(harness({ status: true, data: [{ domain: 'live' }] }).adapter.checkConnection(), errorCode('live_mode'));
checks += 3;

for (const input of [
  { ...expected, reference: '../secrets' }, { ...expected, reference: 'https://other.example/' },
  { ...expected, amountKobo: 1.1 }, { ...expected, amountKobo: 0 }, { ...expected, amountKobo: Number.MAX_SAFE_INTEGER + 1 },
  { ...expected, currency: 'USD' } as unknown as ExpectedPayment,
]) {
  const local = harness();
  await assert.rejects(local.adapter.verifyTransaction(input), errorCode('invalid_input'));
  assert.equal(local.calls.length, 0); checks += 2;
}
for (const [changed, code] of [
  // A test transaction in another currency disagrees; a currency that is not a code is unreadable.
  [{ amount: 100030 }, 'mismatch'], [{ reference: 'OTHER-REFERENCE' }, 'mismatch'], [{ currency: 'USD' }, 'mismatch'],
  [{ currency: 'usd' }, 'invalid_response'], [{ currency: 566 }, 'invalid_response'], [{ currency: 'USD', domain: 'live' }, 'live_mode'],
  [{ amount: '100029' }, 'invalid_response'], [{ amount: 100029.1 }, 'invalid_response'], [{ amount: Number.MAX_SAFE_INTEGER + 1 }, 'invalid_response'],
  [{ channel: 'card' }, 'mismatch'], [{ domain: 'live' }, 'live_mode'], [{ domain: undefined }, 'live_mode'],
  [{ status: 'unknown_new_provider_status' }, 'invalid_response'], [{ id: Number.MAX_SAFE_INTEGER + 1 }, 'invalid_response'],
] as Array<[Record<string, unknown>, string]>) {
  await assert.rejects(harness({ status: true, data: { ...fixture, ...changed } }).adapter.verifyTransaction(expected), errorCode(code)); checks++;
}
assert.equal((await harness({ status: true, data: { ...fixture, id: '18446744073709551615' } }).adapter.verifyTransaction(expected)).transactionId, '18446744073709551615'); checks++;

// Signature is checked over exact original bytes, before any JSON parsing.
const bytes = event();
const parsed = parsePaystackTestWebhook(bytes, sign(bytes), key);
assert.equal(parsed.kind, 'payment');
assert.throws(() => parsePaystackTestWebhook(bytes, undefined, key), errorCode('invalid_signature'));
assert.throws(() => parsePaystackTestWebhook(bytes, 'bad', key), errorCode('invalid_signature'));
assert.throws(() => parsePaystackTestWebhook(Buffer.from('not json'), '0'.repeat(128), key), errorCode('invalid_signature'));
assert.throws(() => parsePaystackTestWebhook(Buffer.from('not json'), sign(Buffer.from('not json')), key), errorCode('invalid_response'));
assert.throws(() => parsePaystackTestWebhook(event({ ...fixture, amount: 1 }), sign(bytes), key), errorCode('invalid_signature'));
const live = event({ ...fixture, domain: 'live' });
assert.throws(() => parsePaystackTestWebhook(live, sign(live), key), errorCode('live_mode'));
const missingDomain = event({ ...fixture, domain: undefined });
assert.throws(() => parsePaystackTestWebhook(missingDomain, sign(missingDomain), key), errorCode('live_mode'));
const oversized = Buffer.alloc(256 * 1024 + 1, 32);
assert.throws(() => parsePaystackTestWebhook(oversized, sign(oversized), key), errorCode('invalid_signature'));
checks += 9;

// Semantic receipt identity survives repeat delivery and changes to JSON order/whitespace.
const repeated = parsePaystackTestWebhook(bytes, sign(bytes), key);
const reformatted = Buffer.from(JSON.stringify({ data: fixture, event: 'charge.success' }, null, 2));
const reordered = parsePaystackTestWebhook(reformatted, sign(reformatted), key);
assert.ok(parsed.kind === 'payment' && repeated.kind === 'payment' && reordered.kind === 'payment');
assert.equal(parsed.dedupeKey, repeated.dedupeKey);
assert.equal(parsed.dedupeKey, reordered.dedupeKey);
assert.ok(!JSON.stringify(parsed).includes('private')); checks += 4;

const paymentEvent = harness();
assert.deepEqual(await paymentEvent.adapter.verifyPaymentWebhook(bytes, sign(bytes), expected), { dedupeKey: parsed.dedupeKey, payment: verified });
const badEvent = harness();
await assert.rejects(badEvent.adapter.verifyPaymentWebhook(bytes, '0'.repeat(128), expected), errorCode('invalid_signature'));
assert.equal(badEvent.calls.length, 0);
const differentAmount = event({ ...fixture, amount: 200000 });
await assert.rejects(badEvent.adapter.verifyPaymentWebhook(differentAmount, sign(differentAmount), expected), errorCode('mismatch'));
assert.equal(badEvent.calls.length, 0);
await assert.rejects(harness({ status: true, data: { ...fixture, id: 999 } }).adapter.verifyPaymentWebhook(bytes, sign(bytes), expected), errorCode('mismatch'));
assert.equal((await harness({ status: true, data: { ...fixture, status: 'pending' } }).adapter.verifyPaymentWebhook(bytes, sign(bytes), expected)).payment.state, 'pending', 'an old success notification does not override current verification');
checks += 7;

// Pure evidence decisions are persisted by a future tenant-bound inbox; there is no in-memory production dedupe claim.
assert.equal(reconcilePaystackEvidence(undefined, verified).decision, 'apply');
assert.equal(reconcilePaystackEvidence(verified, verified).decision, 'duplicate');
const pending: VerifiedPayment = { ...verified, state: 'pending' };
assert.equal(reconcilePaystackEvidence(pending, verified).decision, 'apply');
assert.deepEqual(reconcilePaystackEvidence(verified, pending), { decision: 'ignored_stale', current: verified });
assert.equal(reconcilePaystackEvidence(verified, { ...verified, state: 'failed' }).decision, 'review');
assert.equal(reconcilePaystackEvidence(verified, { ...verified, state: 'reversed' }).decision, 'apply');
assert.equal(reconcilePaystackEvidence({ ...verified, state: 'reversed' }, verified).decision, 'review');
assert.equal(reconcilePaystackEvidence(verified, { ...verified, reference: 'OTHER' }).decision, 'review');
assert.equal(reconcilePaystackEvidence(verified, { ...verified, transactionId: '99' }).decision, 'review');
checks += 9;

for (const active of [false, true]) {
  const body = Buffer.from(JSON.stringify({ event: active ? 'direct_debit.authorization.active' : 'direct_debit.authorization.created', data: { active, channel: 'direct_debit', authorization_code: 'AUTH_private_mandate_code' } }));
  const mandate = parsePaystackTestWebhook(body, sign(body), key);
  assert.equal(mandate.kind, 'mandate');
  assert.ok(!JSON.stringify(mandate).includes('AUTH_private'));
  const check = await harness({ status: true, data: { active, channel: 'direct_debit', authorization_code: 'AUTH_private_mandate_code' } }).adapter.verifyMandate('TEST-MANDATE-001');
  assert.equal(check.state, active ? 'active' : 'pending');
  assert.equal(check.directDebitAvailability, 'observed_for_this_test_mandate');
  checks += 4;
}
const mandatePending = { authorizationFingerprint: 'same-test-authorization-fingerprint', state: 'pending' as const };
const mandateActive = { ...mandatePending, state: 'active' as const };
assert.equal(reconcilePaystackMandateEvidence(undefined, mandateActive).decision, 'apply');
assert.deepEqual(reconcilePaystackMandateEvidence(mandateActive, mandatePending), { decision: 'ignored_stale', current: mandateActive });
assert.equal(reconcilePaystackMandateEvidence(mandateActive, mandateActive).decision, 'duplicate');
assert.equal(reconcilePaystackMandateEvidence(mandatePending, mandateActive).decision, 'apply');
assert.equal(reconcilePaystackMandateEvidence(mandateActive, { ...mandatePending, authorizationFingerprint: 'different' }).decision, 'review');
checks += 5;

// Timeout recovery performs only GET, always at the original reference. An unknown result never authorises a new debit.
const recoverCalls: Array<{ url: string; method: string | undefined }> = [];
let first = true;
const recover = createPaystackTestAdapter({ secretKey: key, timeoutMs: 5, fetch: async (url, init) => {
  recoverCalls.push({ url: String(url), method: init?.method });
  if (first) { first = false; return new Promise<Response>((_resolve, rejectFetch) => { init?.signal?.addEventListener('abort', () => rejectFetch(new Error(`private transport ${key}`)), { once: true }); }); }
  return response({ status: true, data: fixture });
} });
const unknown = await recover.recoverUnknown(expected);
assert.deepEqual(unknown, { outcome: 'unknown', reason: 'timeout', nextAction: 'verify_same_reference', reissue: false });
const recovered = await recover.recoverUnknown(expected);
assert.equal(recovered.outcome, 'verified');
assert.equal(recovered.reissue, false);
assert.equal(recoverCalls.length, 2);
assert.equal(recoverCalls[0]!.url, recoverCalls[1]!.url);
assert.ok(recoverCalls.every(call => call.method === 'GET'));
checks += 6;
for (const [status, code] of [[401, 'authentication'], [403, 'authentication'], [404, 'not_found'], [429, 'rate_limited'], [500, 'unavailable']] as const) {
  const outcome = await harness({ status: false, message: `Do not expose ${key} or private@example.test` }, status).adapter.recoverUnknown(expected);
  assert.equal(outcome.outcome, 'unknown');
  assert.equal(outcome.reissue, false);
  if (outcome.outcome === 'unknown') assert.equal(outcome.reason, code);
  // A refused key or a transport failure says nothing about the payment: put it right and verify the same reference.
  assert.equal(outcome.nextAction, 'verify_same_reference');
  assert.ok(!JSON.stringify(outcome).includes(key)); checks += 5;
}
// Only a disagreement needs review; an unreadable or live-mode answer is checked again.
for (const [payload, code, nextAction] of [
  [{ status: true, data: { ...fixture, amount: 100030 } }, 'mismatch', 'manual_review'],
  [{ status: true, data: { ...fixture, domain: 'live' } }, 'live_mode', 'verify_same_reference'],
  [{ status: false }, 'invalid_response', 'verify_same_reference'],
] as const) {
  const outcome = await harness(payload).adapter.recoverUnknown(expected);
  assert.deepEqual(outcome, { outcome: 'unknown', reason: code, nextAction, reissue: false }); checks++;
}
const leaked = createPaystackTestAdapter({ secretKey: key, fetch: async () => { throw new Error(`Transport included ${key} and private@example.test`); } });
await assert.rejects(leaked.verifyTransaction(expected), error => error instanceof PaystackError && !error.message.includes(key) && !error.message.includes('private@example') && !('cause' in error)); checks++;
await assert.rejects(harness({ status: true, data: fixture, padding: 'x'.repeat(256 * 1024) }).adapter.verifyTransaction(expected), errorCode('invalid_response')); checks++;

console.log(`Paystack offline adapter: ${checks} checks passed. No external connection verified.`);
