import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Deliberately disconnected from the public API and any instruction dispatcher. */
export const PAYSTACK_API_ORIGIN = 'https://api.paystack.co';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_UINT64 = 18446744073709551615n;
export type PaystackErrorCode = 'configuration' | 'invalid_input' | 'invalid_signature' | 'invalid_response' | 'live_mode' | 'mismatch' | 'authentication' | 'not_found' | 'rate_limited' | 'unavailable' | 'timeout';

/** Only fixed, safe messages cross the adapter boundary. Never attach a raw response, key or cause. */
export class PaystackError extends Error {
  constructor(public readonly code: PaystackErrorCode, message: string) { super(message); this.name = 'PaystackError'; }
}
function reject(code: PaystackErrorCode, message: string): never { throw new PaystackError(code, message); }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : reject('invalid_response', 'Paystack returned an unexpected response.');
const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex');

function testKey(secretKey: string): void {
  if (!/^sk_test_[A-Za-z0-9_]{16,128}$/.test(secretKey)) reject('configuration', 'Set a valid Paystack test secret key. Live keys are not accepted.');
}
function reference(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._=-]{1,100}$/.test(value)) reject('invalid_input', 'Use a valid Paystack reference of 1 to 100 characters.');
  return value;
}
function amount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) reject('invalid_input', 'The expected amount must be a positive, safe integer in kobo.');
  return value;
}
function transactionId(value: unknown): string {
  // JSON numeric IDs above MAX_SAFE_INTEGER are already lossy. Require a decimal string in that case.
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : '';
  if (!/^[1-9]\d{0,19}$/.test(text) || BigInt(text) > MAX_UINT64) reject('invalid_response', 'Paystack returned an invalid transaction identity.');
  return text;
}
const transactionStatuses = { success: 'succeeded', failed: 'failed', abandoned: 'failed', ongoing: 'pending', pending: 'pending', processing: 'pending', queued: 'pending', reversed: 'reversed' } as const;
export type PaymentState = 'pending' | 'succeeded' | 'failed' | 'reversed';
export type ExpectedPayment = { reference: string; amountKobo: number; currency: 'NGN'; channel?: 'direct_debit' };
export type VerifiedPayment = Readonly<{ provider: 'paystack'; domain: 'test'; transactionId: string; reference: string; amountKobo: number; currency: 'NGN'; state: PaymentState; channel: string }>;
function expectedPayment(expected: ExpectedPayment): void {
  reference(expected.reference); amount(expected.amountKobo);
  if (expected.currency !== 'NGN' || (expected.channel !== undefined && expected.channel !== 'direct_debit')) reject('invalid_input', 'This adapter checks NGN payments and an optional direct-debit channel only.');
}
function normalisePayment(value: unknown): VerifiedPayment {
  const data = object(value);
  if (data.domain !== 'test') reject('live_mode', 'Only explicitly marked test-mode transactions are accepted.');
  if (typeof data.amount !== 'number' || !Number.isSafeInteger(data.amount) || data.amount <= 0 || data.currency !== 'NGN') reject('invalid_response', 'Paystack returned an unsupported amount or currency.');
  if (typeof data.reference !== 'string' || !/^[A-Za-z0-9._=-]{1,100}$/.test(data.reference)) reject('invalid_response', 'Paystack returned an invalid transaction reference.');
  if (typeof data.status !== 'string' || !Object.hasOwn(transactionStatuses, data.status)) reject('invalid_response', 'Paystack returned an unrecognised transaction status.');
  if (typeof data.channel !== 'string' || !/^[a-z_]{1,40}$/.test(data.channel)) reject('invalid_response', 'Paystack returned an unrecognised payment channel.');
  return { provider: 'paystack', domain: 'test', transactionId: transactionId(data.id), reference: data.reference, amountKobo: data.amount, currency: 'NGN', state: transactionStatuses[data.status as keyof typeof transactionStatuses], channel: data.channel };
}
const mismatch = (): never => reject('mismatch', 'Paystack verification does not match the expected reference, amount, currency or channel. Hold this item for review.');
function checkMatch(payment: VerifiedPayment, expected: ExpectedPayment): void {
  if (payment.reference !== expected.reference || payment.amountKobo !== expected.amountKobo || payment.currency !== expected.currency || (expected.channel && payment.channel !== expected.channel)) mismatch();
}

export type PaystackWebhook =
  | { kind: 'payment'; event: 'charge.success'; dedupeKey: string; payment: VerifiedPayment }
  | { kind: 'mandate'; event: 'direct_debit.authorization.created' | 'direct_debit.authorization.active'; dedupeKey: string; authorizationFingerprint: string; state: 'pending' | 'active' }
  | { kind: 'ignored'; event: 'unsupported' };

/** Authenticate exact raw bytes before JSON parsing. This does not persist or apply an event. */
export function parsePaystackTestWebhook(rawBody: Uint8Array, signature: string | undefined, secretKey: string): PaystackWebhook {
  testKey(secretKey);
  if (rawBody.byteLength === 0 || rawBody.byteLength > MAX_BODY_BYTES || !signature || !/^[a-fA-F0-9]{128}$/.test(signature)) reject('invalid_signature', 'The Paystack webhook signature is invalid.');
  const expected = createHmac('sha512', secretKey).update(rawBody).digest();
  const received = Buffer.from(signature, 'hex');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) reject('invalid_signature', 'The Paystack webhook signature is invalid.');
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(rawBody).toString('utf8')); } catch { reject('invalid_response', 'The signed Paystack event is not valid JSON.'); }
  const envelope = object(parsed), data = object(envelope.data);
  if ((envelope.domain !== undefined && envelope.domain !== 'test') || (data.domain !== undefined && data.domain !== 'test')) reject('live_mode', 'Live-mode Paystack events are not accepted.');
  if (envelope.event === 'charge.success') {
    const payment = normalisePayment(data);
    if (payment.state !== 'succeeded') reject('invalid_response', 'The signed Paystack event has inconsistent payment status.');
    return { kind: 'payment', event: 'charge.success', dedupeKey: `paystack:test:charge.success:${payment.transactionId}`, payment };
  }
  if (envelope.event === 'direct_debit.authorization.created' || envelope.event === 'direct_debit.authorization.active') {
    const active = envelope.event === 'direct_debit.authorization.active';
    if (data.active !== active || data.channel !== 'direct_debit' || typeof data.authorization_code !== 'string' || !/^AUTH_[A-Za-z0-9_]{1,128}$/.test(data.authorization_code)) reject('invalid_response', 'The signed Paystack mandate event is inconsistent.');
    // Authorization codes can initiate debits. Never return or log the raw code here.
    const authorizationFingerprint = fingerprint(data.authorization_code);
    return { kind: 'mandate', event: envelope.event, dedupeKey: `paystack:test:${envelope.event}:${authorizationFingerprint}`, authorizationFingerprint, state: active ? 'active' : 'pending' };
  }
  return { kind: 'ignored', event: 'unsupported' };
}

export type EvidenceDecision = { decision: 'apply' | 'duplicate' | 'ignored_stale' | 'review'; current: VerifiedPayment };
/** Caller must persist this decision and its receipt atomically under its tenant + provider connection. */
export function reconcilePaystackEvidence(previous: VerifiedPayment | undefined, incoming: VerifiedPayment): EvidenceDecision {
  if (!previous) return { decision: 'apply', current: incoming };
  if (previous.reference !== incoming.reference || previous.transactionId !== incoming.transactionId || previous.amountKobo !== incoming.amountKobo || previous.currency !== incoming.currency || previous.channel !== incoming.channel) return { decision: 'review', current: previous };
  if (previous.state === incoming.state) return { decision: 'duplicate', current: previous };
  if (incoming.state === 'pending' && previous.state !== 'pending') return { decision: 'ignored_stale', current: previous };
  if (previous.state === 'reversed' || (previous.state === 'succeeded' && incoming.state === 'failed')) return { decision: 'review', current: previous };
  return { decision: 'apply', current: incoming };
}

export type MandateEvidence = Readonly<{ authorizationFingerprint: string; state: 'pending' | 'active' }>;
/** Created and active deliveries may arrive out of order. Neither implies a new consent or debit. */
export function reconcilePaystackMandateEvidence(previous: MandateEvidence | undefined, incoming: MandateEvidence): { decision: 'apply' | 'duplicate' | 'ignored_stale' | 'review'; current: MandateEvidence } {
  if (!previous) return { decision: 'apply', current: incoming };
  if (previous.authorizationFingerprint !== incoming.authorizationFingerprint) return { decision: 'review', current: previous };
  if (previous.state === incoming.state) return { decision: 'duplicate', current: previous };
  if (previous.state === 'active') return { decision: 'ignored_stale', current: previous };
  return { decision: 'apply', current: incoming };
}

export type PaystackTestAdapterOptions = { secretKey: string; timeoutMs?: number; fetch?: typeof globalThis.fetch };
export type RecoveryResult = { outcome: 'verified'; payment: VerifiedPayment; nextAction: 'record_verified_result' | 'verify_same_reference'; reissue: false } | { outcome: 'unknown'; reason: PaystackErrorCode; nextAction: 'verify_same_reference' | 'manual_review'; reissue: false };

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) return reject('invalid_response', 'Paystack returned an empty response.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) { void reader.cancel().catch(() => {}); reject('invalid_response', 'Paystack returned an oversized response.'); }
      chunks.push(value);
    }
    try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { return reject('invalid_response', 'Paystack returned an unreadable response.'); }
  } finally { reader.releaseLock(); }
}

/** Read-only test connection. No method in this adapter can initialize or repeat a debit. */
export function createPaystackTestAdapter(options: PaystackTestAdapterOptions) {
  const secretKey = options.secretKey;
  testKey(secretKey);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) reject('configuration', 'Paystack timeout must be between 1 and 15,000 milliseconds.');
  const fetcher = options.fetch ?? globalThis.fetch;
  async function get(path: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetcher(`${PAYSTACK_API_ORIGIN}${path}`, { method: 'GET', headers: { Authorization: `Bearer ${secretKey}`, Accept: 'application/json' }, redirect: 'error', signal: controller.signal });
          if (response.status === 401 || response.status === 403) reject('authentication', 'Paystack refused the test credentials.');
          if (response.status === 404) reject('not_found', 'Paystack has not returned this test reference. Keep its outcome unknown.');
          if (response.status === 429) reject('rate_limited', 'Paystack rate limited this check. Verify the same reference later.');
          if (!response.ok) reject('unavailable', 'Paystack could not complete this check.');
          const result = await readResponse(response);
          if (result.status !== true) reject('invalid_response', 'Paystack did not confirm this check.');
          return result;
        })(),
        new Promise<never>((_resolve, rejectTimeout) => { timer = setTimeout(() => { controller.abort(); rejectTimeout(new PaystackError('timeout', 'Paystack verification timed out. Keep the outcome unknown and verify the same reference.')); }, timeoutMs); }),
      ]);
    } catch (error) {
      if (error instanceof PaystackError) throw error;
      throw new PaystackError(controller.signal.aborted ? 'timeout' : 'unavailable', 'Paystack could not complete this check. Keep the outcome unknown and verify the same reference.');
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  async function verifyTransaction(expected: ExpectedPayment): Promise<VerifiedPayment> {
    expectedPayment(expected);
    const response = await get(`/transaction/verify/${encodeURIComponent(expected.reference)}`);
    // A test transaction in another currency disagrees with the expectation; it is not an unreadable answer.
    const data = object(response.data);
    if (data.domain === 'test' && typeof data.currency === 'string' && /^[A-Z]{3}$/.test(data.currency) && data.currency !== expected.currency) mismatch();
    const payment = normalisePayment(data);
    checkMatch(payment, expected);
    return payment;
  }
  return {
    async checkConnection() {
      const result = await get('/transaction?perPage=1&page=1');
      if (!Array.isArray(result.data) || result.data.some(value => object(value).domain !== 'test')) reject('live_mode', 'Only test-mode transaction lists are accepted.');
      return { provider: 'paystack', mode: 'test', authenticated: true, directDebitAvailability: 'unconfirmed' } as const;
    },
    verifyTransaction,
    async verifyPaymentWebhook(rawBody: Uint8Array, signature: string | undefined, expected: ExpectedPayment) {
      expectedPayment(expected);
      const event = parsePaystackTestWebhook(rawBody, signature, secretKey);
      if (event.kind !== 'payment') reject('invalid_input', 'A charge-success event is required for payment verification.');
      checkMatch(event.payment, expected);
      const payment = await verifyTransaction(expected);
      if (payment.transactionId !== event.payment.transactionId) reject('mismatch', 'Paystack webhook and verification identify different transactions. Hold this item for review.');
      return { dedupeKey: event.dedupeKey, payment };
    },
    async verifyMandate(mandateReference: string) {
      const response = await get(`/customer/authorization/verify/${encodeURIComponent(reference(mandateReference))}`);
      const data = object(response.data);
      if (data.domain !== undefined && data.domain !== 'test') reject('live_mode', 'Live-mode mandate details are not accepted.');
      if (data.channel !== 'direct_debit' || typeof data.active !== 'boolean' || typeof data.authorization_code !== 'string' || !/^AUTH_[A-Za-z0-9_]{1,128}$/.test(data.authorization_code)) reject('invalid_response', 'Paystack has not confirmed a direct-debit test mandate.');
      return { provider: 'paystack', mode: 'test', authorizationFingerprint: fingerprint(data.authorization_code), state: data.active ? 'active' : 'pending', directDebitAvailability: 'observed_for_this_test_mandate' } as const;
    },
    async recoverUnknown(expected: ExpectedPayment): Promise<RecoveryResult> {
      expectedPayment(expected);
      try {
        const payment = await verifyTransaction(expected);
        return { outcome: 'verified', payment, nextAction: payment.state === 'pending' ? 'verify_same_reference' : 'record_verified_result', reissue: false };
      } catch (error) {
        if (!(error instanceof PaystackError)) throw error;
        // Only a disagreement needs review. A refused key, an unreadable or live-mode answer or a transport
        // failure says nothing about the payment: put the cause right, then verify the same reference.
        return { outcome: 'unknown', reason: error.code, nextAction: error.code === 'mismatch' ? 'manual_review' : 'verify_same_reference', reissue: false };
      }
    },
  };
}
