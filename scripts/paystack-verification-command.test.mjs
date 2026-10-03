import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const command = path.join(root, "scripts/src/verify-paystack-event.ts");
const tsx = path.join(root, "scripts/node_modules/tsx/dist/cli.mjs");
const clean = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/^(?:VALO_PAY_1_|PAYSTACK_|DATABASE_URL$|LOG_)/.test(name),
  ),
);
const logs = mkdtempSync(path.join(tmpdir(), "valo-pay-1-paystack-command-"));
const id = "a".repeat(64),
  eventId = "synthetic-event-do-not-echo",
  secret = "synthetic-secret-do-not-echo";
const args = ["--", "--connection-id", id, "--event-id", eventId];
const testKey = ["sk", "test", "OFFLINE", "0".repeat(30)].join("_");
const mapped = {
  VALO_PAY_1_PAYSTACK_INGRESS: "test",
  PAYSTACK_TEST_SECRET_KEY: testKey,
  VALO_PAY_1_PAYSTACK_CONNECTIONS: JSON.stringify({
    [id]: { workspaceId: "synthetic-workspace", merchantId: "synthetic-lender" },
  }),
};
let checks = 0,
  runs = 0;
function run(args, extra = {}) {
  const logFile = path.join(logs, `run-${++runs}.log`);
  const result = spawnSync(process.execPath, [tsx, command, ...args], {
    cwd: root,
    env: { ...clean, ...extra, LOG_FILE: logFile },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.ifError(result.error);
  checks++;
  let log = "";
  try {
    log = readFileSync(logFile, "utf8");
  } catch {
    // --help writes no line.
  }
  return { ...result, log };
}
// The report is the JSON the command prints; a runtime warning may precede it.
const reportOf = (text) => JSON.parse(text.slice(text.indexOf("{\n")));
assert.match(run(["--help"]).stdout, /^Use: verify-paystack-event/);
// Each refusal names its own outcome, exits 1 when the operator must put something right
// and 2 when the same event can simply be checked again later, and writes one log line
// naming it. Neither ever repeats the key or an identifier.
for (const [input, extra, outcome, exitCode] of [
  [[], {}, "usage", 1],
  [["--key", secret], {}, "usage", 1],
  [["--connection-id", "not-valid", "--event-id", eventId], {}, "usage", 1],
  [args, {}, "not_configured", 1],
  [args, { VALO_PAY_1_PAYSTACK_INGRESS: "test", PAYSTACK_TEST_SECRET_KEY: ["sk", "live", "0".repeat(30)].join("_") }, "not_configured", 1],
  [args, { VALO_PAY_1_PAYSTACK_INGRESS: "test", PAYSTACK_TEST_SECRET_KEY: testKey }, "connection_not_mapped", 1],
  // Even a complete test mapping cannot call a provider without the database, which is read first.
  [args, mapped, "not_configured", 1],
  [args, { ...mapped, DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused" }, "database_unavailable", 2],
]) {
  const result = run(input, extra);
  assert.equal(result.status, exitCode, `${outcome} exits ${exitCode}`);
  const report = reportOf(result.stderr);
  assert.equal(report.result, outcome);
  assert.equal(report.exitCode, exitCode);
  assert.equal(report.instructions, "disabled");
  const lines = result.log.trim().split("\n").map((line) => JSON.parse(line)).filter((line) => line.event === "paystack.test_verification");
  assert.equal(lines.length, 1, "one log line per run");
  assert.equal(lines[0].outcome, outcome);
  assert.equal(lines[0].exitCode, exitCode);
  for (const text of [result.stdout, result.stderr, result.log]) {
    for (const hidden of [eventId, id, secret, testKey, extra.PAYSTACK_TEST_SECRET_KEY ?? "never-present"])
      assert.ok(!text.includes(hidden), `${outcome} never repeats a key or an identifier`);
  }
  checks += 3;
}
rmSync(logs, { recursive: true, force: true });
console.log(
  `Paystack verification command: ${checks} offline help, argument, credential, database and outcome checks passed, each run logging its outcome without a key or an identifier.`,
);
