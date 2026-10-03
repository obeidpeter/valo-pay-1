import { createPaystackTestAdapter, PaystackError, type ExpectedPayment } from '../../artifacts/api-server/src/providers/paystack.js';
import { paystackIngressStatus } from '../../artifacts/api-server/src/providers/paystack-ingress-config.js';
import { assertOperatorConfiguration } from '../../artifacts/api-server/src/lib/product-identity';

// Operator-only, read-only check. Never accept a key as a command-line argument.
const usage = 'Use: check-paystack [--reference TEST_REFERENCE --amount-kobo POSITIVE_INTEGER] [--direct-debit] [--mandate-reference TEST_MANDATE_REFERENCE]';
try {
  // `pnpm run check:paystack -- --reference …` passes the `--` on: skip it, so both forms work.
  const given = process.argv.slice(2);
  const args = given[0] === '--' ? given.slice(1) : given;
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (key === '--help') { console.log(usage); process.exit(0); }
    if (key === '--direct-debit') { flags.set(key, 'true'); continue; }
    const valued = ['--reference', '--amount-kobo', '--mandate-reference'], option = /^(--?[A-Za-z][\w-]{0,40})(=?)/.exec(key)?.[1];
    // A mistyped option is named, and an option written as --name=value is shown the form it takes; neither repeats a value.
    if (option && !valued.includes(option) && !['--direct-debit', '--help'].includes(option)) throw new PaystackError('invalid_input', `Unknown option ${option}. ${usage}`);
    if (option && key !== option) throw new PaystackError('invalid_input', `Give ${option}'s value after a space, not after "=". ${usage}`);
    if (!valued.includes(key) || flags.has(key) || !args[index + 1] || args[index + 1]!.startsWith('--')) throw new PaystackError('invalid_input', usage);
    flags.set(key, args[++index]!);
  }
  const paymentReference = flags.get('--reference');
  const amountText = flags.get('--amount-kobo');
  if (Boolean(paymentReference) !== Boolean(amountText) || (flags.has('--direct-debit') && !paymentReference)) throw new PaystackError('invalid_input', usage);
  if (amountText && (!/^[1-9]\d*$/.test(amountText) || BigInt(amountText) > BigInt(Number.MAX_SAFE_INTEGER))) throw new PaystackError('invalid_input', 'The expected amount must be a positive, safe integer in kobo.');
  try { assertOperatorConfiguration(); }
  catch { throw new PaystackError('configuration', 'The Valo Pay 1 resource identity is not configured correctly. Review VALO_PAY_1_RESOURCE_BINDINGS before checking the provider.'); }
  const adapter = createPaystackTestAdapter({ secretKey: process.env.PAYSTACK_TEST_SECRET_KEY || '' });
  const connection = await adapter.checkConnection();
  // The ingress setting of the process this check runs in: a count of mapped connections, never their IDs.
  const output: Record<string, unknown> = { connection, applicationConnection: 'not_connected', ...paystackIngressStatus(), instructions: 'disabled' };
  if (paymentReference && amountText) {
    const expected: ExpectedPayment = { reference: paymentReference, amountKobo: Number(amountText), currency: 'NGN', ...(flags.has('--direct-debit') ? { channel: 'direct_debit' as const } : {}) };
    const verified = await adapter.verifyTransaction(expected);
    // Do not print the reference, amount, customer, authorization or full provider payload.
    output.transactionCheck = { referenceMatched: true, amountMatched: true, currency: 'NGN', mode: 'test', state: verified.state, directDebitObserved: verified.channel === 'direct_debit' };
  }
  const mandateReference = flags.get('--mandate-reference');
  if (mandateReference) {
    const mandate = await adapter.verifyMandate(mandateReference);
    output.mandateCheck = { mode: mandate.mode, state: mandate.state, directDebitAvailability: mandate.directDebitAvailability };
  }
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  const safe = error instanceof PaystackError ? error : new PaystackError('unavailable', 'The Paystack test check could not be completed.');
  console.error(JSON.stringify({ result: 'not_verified', code: safe.code, message: safe.message }));
  process.exitCode = 1;
}
