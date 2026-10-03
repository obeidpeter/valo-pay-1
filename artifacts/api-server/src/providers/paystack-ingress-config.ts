import { z } from 'zod';

/**
 * The Paystack test ingress settings, read from the process environment only. No database
 * import: the route checks a delivery's signature with these before it locks or reads a
 * lender, and `pnpm run check:paystack` reports them without starting the API.
 */
const connectionSchema = z.record(z.string().regex(/^[a-f0-9]{64}$/), z.object({ workspaceId:z.string().min(1).max(100), merchantId:z.string().min(1).max(100) }).strict());
/** Operator-provisioned opaque connection IDs, each naming one existing workspace and synthetic lender. */
export type PaystackConnectionMap = z.infer<typeof connectionSchema>;
const unavailable = (message: string): never => { throw Object.assign(new Error(message), { status: 503 }); };

/** The configured `sk_test_` key; a 503 while the ingress is off or the key is missing or not a test key. */
export function paystackTestSecretKey(): string {
  if (process.env.VALO_PAY_1_PAYSTACK_INGRESS !== 'test') unavailable('Paystack test ingress is not configured.');
  const key = process.env.PAYSTACK_TEST_SECRET_KEY || '';
  if (!/^sk_test_[A-Za-z0-9_]{16,128}$/.test(key)) unavailable('A Paystack test credential is required.');
  return key;
}

/** The server-only connection map; a 503 when it is not valid JSON of 64-character hexadecimal IDs. */
export function paystackConnections(): PaystackConnectionMap {
  try { return connectionSchema.parse(JSON.parse(process.env.VALO_PAY_1_PAYSTACK_CONNECTIONS || '{}')); }
  catch { return unavailable('Paystack test connection configuration is invalid.'); }
}

/** What this process would do with a delivery: off, on for test events, or on but refusing every delivery. Counts mappings, never names them. */
export function paystackIngressStatus(): { webhookIngestion: 'disabled' | 'test_only' | 'misconfigured'; mappedConnections: number } {
  if (process.env.VALO_PAY_1_PAYSTACK_INGRESS !== 'test') return { webhookIngestion: 'disabled', mappedConnections: 0 };
  try { paystackTestSecretKey(); return { webhookIngestion: 'test_only', mappedConnections: Object.keys(paystackConnections()).length }; }
  catch { return { webhookIngestion: 'misconfigured', mappedConnections: 0 }; }
}
