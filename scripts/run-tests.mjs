// Runs every offline check: no database, no network, no Replit services.
// Database-backed integration tests stay opt-in (see README).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tsx = path.join(root, "scripts", "node_modules", "tsx", "dist", "cli.mjs");
const vitest = path.join(root, "artifacts", "valo-pay", "node_modules", "vitest", "vitest.mjs");
if (!existsSync(tsx) || !existsSync(vitest)) throw new Error("tsx or vitest is missing; run pnpm install first.");
const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL || "postgres://unused:unused@127.0.0.1:1/unused" };
const steps = [
  ["node", ["scripts/check-db-boundary.test.mjs"]],
  ['node', ['scripts/check-effect-boundaries.mjs']],
  ['node', ['scripts/check-effect-boundaries.test.mjs']],
  [tsx, ['artifacts/api-server/tests/exact-money.test.ts']],
  [tsx, ['artifacts/api-server/tests/database-money.test.ts']],
  [tsx, ['artifacts/api-server/tests/connected-authority.test.ts']],
  [tsx, ['artifacts/api-server/tests/connected-replay.test.ts']],
  [tsx, ['artifacts/api-server/tests/paystack-verification.test.ts']],
  ['node', ['scripts/paystack-verification-command.test.mjs']],
  ['node', ['scripts/commission-operations.test.mjs']],
  ['node', ['scripts/rehearse-pilot.test.mjs']],
  [tsx, ['artifacts/api-server/tests/financial-projection.test.ts']],
  ['node',['scripts/run-operations-tests.mjs']],
  [tsx, ['artifacts/api-server/tests/connected-workflows.test.ts']],
  [tsx, ['artifacts/api-server/tests/pilot-workflow.test.ts']],
  [tsx, ['artifacts/api-server/tests/connected-credit.test.ts']],
  [tsx, ['artifacts/api-server/tests/connected-cash.test.ts']],
  [tsx, ['artifacts/api-server/tests/connected-cash-service.test.ts']],
  ["node", ["scripts/check-db-boundary.mjs"]],
  ["node", ["scripts/github-snapshot.test.mjs"]],
  ["node", ["scripts/check-docs.mjs"]],
  ["node", ["scripts/monitor-valopay.test.mjs"]],
  ["node", ["scripts/operator-commands.test.mjs"]],
  ["node", ["scripts/tooling.test.mjs"]],
  [tsx, ["artifacts/api-server/tests/startup-config.test.ts"]],
  [tsx, ["artifacts/api-server/tests/close-pass.test.ts"]],
  [tsx, ["artifacts/api-server/tests/background-worker.test.ts"]],
  [tsx, ["artifacts/api-server/tests/edit-versions.test.ts"]],
  [tsx, ["artifacts/api-server/tests/canonical-json.test.ts"]],
  [tsx, ["artifacts/api-server/tests/canonical-json-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/record-kinds.test.ts"]],
  [tsx, ["artifacts/api-server/tests/valopay-store-guards.test.ts"]],
  [tsx, ["artifacts/api-server/tests/export-download.test.ts"]],
  [tsx, ["artifacts/api-server/tests/export-jobs.test.ts"]],
  [tsx, ["artifacts/api-server/tests/clerk-proxy-budgets.test.ts"]],
  [tsx, ["artifacts/api-server/tests/storage-dependency.test.ts"]],
  [tsx, ["artifacts/api-server/tests/record-identity-guards.test.ts"]],
  [tsx, ["artifacts/api-server/tests/financial-migrations.test.ts"]],
  [tsx, ["artifacts/api-server/tests/api-security.test.ts"]],
  [tsx, ["artifacts/api-server/tests/edge-security.test.ts"]],
  [tsx, ["artifacts/api-server/tests/api-contract.test.ts"]],
  [tsx, ["artifacts/api-server/tests/answer-schemas.test.ts"]],
  [tsx, ["artifacts/api-server/tests/i18n.test.ts"]],
  [tsx, ["artifacts/api-server/tests/counted-text.test.ts"]],
  [tsx, ["artifacts/api-server/tests/import-mapping.test.ts"]],
  [tsx, ["artifacts/api-server/tests/import-rows.test.ts"]],
  [tsx, ["artifacts/api-server/tests/observability.test.ts"]],
  [tsx, ["artifacts/api-server/tests/database-limits.test.ts"]],
  [tsx, ["artifacts/api-server/tests/pilot-security.test.ts"]],
  [tsx, ["artifacts/api-server/tests/runtime-isolation-policy.test.ts"]],
  [tsx, ["artifacts/api-server/tests/paystack.test.ts"]],
  [tsx, ["artifacts/api-server/tests/validation-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/input-semantics.test.ts"]],
  [tsx, ["artifacts/api-server/tests/retry-engine-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/reconciliation-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/measurement-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/dispute-pack.test.ts"]],
  [tsx, ["artifacts/api-server/tests/billing-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/test5-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/ret07-alerts-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/api-shell-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/close-schedule-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/payment-lifecycle-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/payment-evidence-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/settlement-currency-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/reconciliation-scale-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/dispute-lifecycle-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/workflow-performance.test.ts"]],
  // The console pages in jsdom against an in-memory API built on the domain code.
  [vitest, ["run", "--root", "artifacts/valo-pay", "--config", "vitest.config.ts"]],
];
for (const [command, args] of steps) {
  console.log(`\n▶ ${args.join(" ")}`);
  const result = spawnSync(process.execPath, command === 'node' ? args : [command,...args], { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) { console.error(`✕ ${args.join(" ")} failed`); process.exit(result.status ?? 1); }
}
console.log("\nAll offline checks passed.");
