/** Real command entrypoints, with a closed loopback database and synthetic configuration. No provider calls. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const tsx = path.join(root, "scripts/node_modules/tsx/dist/cli.mjs");
const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:VALO_PAY_1_|VALOPAY_|PAYSTACK_|CLERK_|DATABASE_URL$|NODE_ENV$|REPLIT_|PRIVATE_OBJECT_DIR$|LOG_)/.test(name)));
const env = { ...clean, NODE_ENV: "production", VALO_PAY_1_ENVIRONMENT: "production", VALO_PAY_1_RESOURCE_BINDINGS: JSON.stringify({ applicationId: "valo-pay" }), DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused", LOG_LEVEL: "silent", CLERK_TELEMETRY_DISABLED: "1" };
const connectionId = "a".repeat(64);
const cases = [
  ["scripts/provision-pilot.ts", ["--synthetic-staging", "org_Synthetic", "user_Synthetic", "Synthetic"], { VALO_PAY_1_STAFF_ACCESS: "staging" }],
  ["scripts/rewrap-payloads.ts", ["--limit", "1"], { VALO_PAY_1_PAYLOAD_ENCRYPTION: "kms", VALO_PAY_1_KMS_KEY: "projects/synthetic/locations/global/keyRings/synthetic/cryptoKeys/synthetic" }],
  ["scripts/src/export-cleanup.ts", ["--retry"], { PRIVATE_OBJECT_DIR: "/synthetic-bucket/private" }],
  ["scripts/src/financial-projection.ts", ["--schema", "valopay_finance_staging_synthetic", "--initialise"], { VALO_PAY_1_FINANCIAL_PROJECTION: "staging" }],
  ["scripts/src/check-paystack.ts", [], {}],
  ["scripts/src/verify-paystack-event.ts", ["--connection-id", connectionId, "--event-id", "synthetic-event"], { VALO_PAY_1_PAYSTACK_INGRESS: "test", PAYSTACK_TEST_SECRET_KEY: ["sk", "test", "SYNTHETIC", "0".repeat(30)].join("_"), VALO_PAY_1_PAYSTACK_CONNECTIONS: JSON.stringify({ [connectionId]: { workspaceId: "synthetic-workspace", merchantId: "synthetic-lender" } }) }],
  ["scripts/apply-record-list-indexes.mjs", ["--apply", "--database", "unused"], {}],
];
for (const [script, args, settings] of cases) {
  const result = spawnSync(process.execPath, [...(script.endsWith(".ts") ? [tsx] : []), script, ...args], { cwd: root, env: { ...env, ...settings }, encoding: "utf8", timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1, `${script} refuses the foreign identity`);
  assert.match(result.stdout + result.stderr, /resource identity|resource binding|RESOURCE_BINDINGS|identify Valo Pay 1/i, `${script} refuses before accessing a provider or database`);
  assert.doesNotMatch(result.stdout + result.stderr, /ECONNREFUSED|ETIMEDOUT|synthetic-event|SYNTHETIC_0/, `${script} emits no connection error or credential`);
}
console.log(`Operator identity checks: ${cases.length} entrypoints refused foreign bindings before database or provider work.`);
