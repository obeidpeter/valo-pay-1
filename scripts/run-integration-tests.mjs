// Runs the database-backed suites against the database in DATABASE_URL, in
// order, every one of them, and then names the ones that failed.  Opt-in
// only: each suite creates fresh synthetic fixtures in that database, so it
// must be a disposable development database with the schema pushed, never
// production.  The three migration rehearsals also create throwaway databases
// beside it, so they need a loopback PostgreSQL whose login can create
// databases; elsewhere they skip, saying why.  The export-stream suite (App
// Storage credentials) and the HTTP suites (Replit development domain and
// Clerk) stay outside; see the README.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const tsx = path.join(root, "scripts", "node_modules", "tsx", "dist", "cli.mjs");
export const suites = [
  'artifacts/api-server/tests/submission-recovery.integration.test.ts',
  'artifacts/api-server/tests/financial-projection.integration.test.ts',
  'artifacts/api-server/tests/instruction-recovery.integration.test.ts',
  'artifacts/api-server/tests/connected-replay.integration.test.ts',
  'artifacts/api-server/tests/financial-concurrency.integration.test.ts',
  'artifacts/api-server/tests/source-close-controls.integration.test.ts',
  'artifacts/api-server/tests/staff-lender-access.integration.test.ts',
  'artifacts/api-server/tests/staff-governance.integration.test.ts',
  'artifacts/api-server/tests/runtime-isolation.integration.test.ts',
  'artifacts/api-server/tests/operations-controls.integration.test.ts',
  'artifacts/api-server/tests/payload-rewrap.integration.test.ts',
  "artifacts/api-server/tests/pilot-workflow.integration.test.ts",
  "artifacts/api-server/tests/api-contract.integration.test.ts",
  "artifacts/api-server/tests/connected-workflows.integration.test.ts",
  "artifacts/api-server/tests/record-index-migration.integration.test.ts",
  "artifacts/api-server/tests/record-identity-migration.integration.test.ts",
  "artifacts/api-server/tests/pilot-workflow-migration.integration.test.ts",
  "artifacts/api-server/tests/schema-push.integration.test.ts",
  "artifacts/api-server/tests/integrity-guards.integration.test.ts",
  "artifacts/api-server/tests/valopay-store.integration.test.ts",
  "artifacts/api-server/tests/close-scheduler.integration.test.ts",
  "artifacts/api-server/tests/background-worker.integration.test.ts",
  "artifacts/api-server/tests/pilot-administrators.integration.test.ts",
  "artifacts/api-server/tests/record-lists.integration.test.ts",
  "artifacts/api-server/tests/priority-queues.integration.test.ts",
  "artifacts/api-server/tests/console-read-models.integration.test.ts",
  "artifacts/api-server/tests/workspace-concurrency.integration.test.ts",
  "artifacts/api-server/tests/journal-outcomes.integration.test.ts",
  "artifacts/api-server/tests/journal-reads.integration.test.ts",
  "artifacts/api-server/tests/lender-history.integration.test.ts",
  "artifacts/api-server/tests/audit-daily-check.integration.test.ts",
  "artifacts/api-server/tests/input-semantics.integration.test.ts",
  "artifacts/api-server/tests/allocation-decisions.integration.test.ts",
  "artifacts/api-server/tests/export-jobs.integration.test.ts",
  "artifacts/api-server/tests/export-expiry.integration.test.ts",
  "artifacts/api-server/tests/workflow-performance.integration.test.ts",
  "artifacts/api-server/tests/paystack-verification.integration.test.ts",
];

/** Runs each suite whatever the ones before it did, and returns the ones that failed. */
export function runSuites(list, run, say = console) {
  const failed = [];
  for (const suite of list) {
    say.log(`\n▶ ${suite}`);
    const status = run(suite);
    if (status !== 0) { say.error(`✕ ${suite} failed`); failed.push(suite); }
  }
  return failed;
}

// Real paths: started through a symlinked path, argv names the link while this module's URL names the file, and the
// runner would exit 0 without running a suite.
const startedDirectly = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (startedDirectly()) {
  if (!existsSync(tsx)) throw new Error("tsx is missing; run pnpm install first.");
  if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
    throw new Error("Set VALOPAY_RUN_INTEGRATION=1 to run the database-backed suites; they write synthetic fixtures to DATABASE_URL.");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must point at a disposable development database that carries the pushed schema.");
  }
  const env = { ...process.env, NODE_ENV: process.env.NODE_ENV || "development" };
  const failed = runSuites(suites, (suite) => spawnSync(process.execPath, [tsx, suite], { cwd: root, env, stdio: "inherit" }).status);
  if (failed.length) {
    console.error(`\n${failed.length} of ${suites.length} database-backed suites failed:\n${failed.map((suite) => `  ${suite}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`\nAll ${suites.length} database-backed suites passed.`);
}
