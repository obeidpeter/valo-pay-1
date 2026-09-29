// The operator commands as an operator runs them, offline: each script's own
// entry point, its options after the `--` that `pnpm run x -- --flag` passes
// on, a mistyped option, and the refusals that come before any provider,
// database or host is reached. Nothing here leaves this machine: the monitor
// probes a closed loopback port, and the other checks stop before they would
// connect.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tsx = path.join(root, "scripts", "node_modules", "tsx", "dist", "cli.mjs");
// Nothing the operator's shell holds reaches the scripts: each case sets what it needs.
const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:VALOPAY_|PAYSTACK_|DATABASE_URL$|REPLIT_DEV_DOMAIN$)/.test(name)));
const unusableDatabase = "postgres://unused:unused@127.0.0.1:1/unused";

function run(script, args, env = {}) {
  const child = spawn(process.execPath, script.endsWith(".ts") ? [tsx, script, ...args] : [script, ...args], { cwd: root, env: { ...clean, ...env } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 60_000);
  return new Promise((resolve) => child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, output: stdout + stderr }); }));
}

// ---- pnpm run check:operations ----
// Cleanup's operator entry must refuse malformed options and missing configuration before reaching any service.
const cleanup = 'scripts/src/export-cleanup.ts';
const badCleanup = await run(cleanup, ['--', '--retry=synthetic-secret']);
assert.equal(badCleanup.status, 1); assert.ok(!badCleanup.output.includes('synthetic-secret'));
assert.match(badCleanup.stderr, /Use: pnpm run check:export-cleanup/);
const noCleanupDatabase = await run(cleanup, ['--']);
assert.equal(noCleanupDatabase.status, 1); assert.match(noCleanupDatabase.stderr, /DATABASE_URL is required/);
// A retry reaches private storage: without the service's storage setting it is refused before the store loads, so no
// due file is claimed and pushed into backoff by a storage failure of the operator's shell.
const noCleanupStorage = await run(cleanup, ['--', '--retry'], { DATABASE_URL: unusableDatabase });
assert.equal(noCleanupStorage.status, 1);
assert.match(noCleanupStorage.stderr, /^Private storage is not configured here \(PRIVATE_OBJECT_DIR\), so --retry was refused and no file was claimed/);
assert.doesNotMatch(noCleanupStorage.output, /ECONNREFUSED|could not be checked/);
// Releasing a parked file needs its export ID and a reason, and one action at a time; a refusal repeats no value.
for (const args of [['--release'], ['--release', 'synthetic-export'], ['--release', 'synthetic-export', '--reason'], ['--reason', 'Synthetic review note'], ['--requeue'], ['--requeue', 'synthetic-export', '--retry'],
  ['--', '--release', 'synthetic-export', '--requeue', 'synthetic-export', '--reason', 'Synthetic review note'], ['--release=synthetic-export', '--reason', 'Synthetic review note'], ['--requeue', 'synthetic-export', '--requeue', 'synthetic-export']]) {
  const refused = await run(cleanup, args, { DATABASE_URL: unusableDatabase });
  assert.equal(refused.status, 1, args.join(' '));
  assert.match(refused.stderr, /^Use: pnpm run check:export-cleanup \[-- --retry \| --requeue EXPORT_ID \| --release EXPORT_ID --reason "why"\]/, args.join(' '));
  assert.ok(!refused.output.includes('synthetic-export') && !refused.output.includes('Synthetic review note'), args.join(' '));
}
for (const [args, refusal] of [[['--requeue', 'synthetic/export'], /^The export ID must be the queued export's ID/], [['--release', 'synthetic-export', '--reason', ' '], /^Give the release a reason/],
  [['--release', 'synthetic-export', '--reason', 'x'.repeat(201)], /^Give the release a reason/], [['--release', 'synthetic-export', '--reason', 'Synthetic\nsecond line'], /^Give the release a reason/]]) {
  const refused = await run(cleanup, args, { DATABASE_URL: unusableDatabase });
  assert.equal(refused.status, 1, args.join(' '));
  assert.match(refused.stderr, refusal, args.join(' '));
  assert.ok(!refused.output.includes('synthetic/export') && !refused.output.includes('Synthetic'), args.join(' '));
}
// Re-queueing and releasing need only the database: with none they stop there.
for (const args of [['--requeue', 'synthetic-export'], ['--release', 'synthetic-export', '--reason', 'Synthetic review note']]) {
  const noDatabase = await run(cleanup, args);
  assert.equal(noDatabase.status, 1, args.join(' ')); assert.match(noDatabase.stderr, /DATABASE_URL is required/, args.join(' '));
}

const monitor = "scripts/monitor-valopay.mjs";
let result = await run(monitor, ["--"], { VALOPAY_MONITOR_ORIGIN: "https://127.0.0.1:1" });
assert.equal(result.status, 0, result.output);
const probe = JSON.parse(result.stdout);
assert.equal(probe.mode, "dry-run");
assert.deepEqual(probe.codes, ["database_unready", "service_unavailable"], "a dry run reports an unreachable service by its codes");
// `--deliver` after the `--` is accepted; with no receiver it stops at the configuration, in the general words, and prints no key.
result = await run(monitor, ["--", "--deliver"], { VALOPAY_MONITOR_ORIGIN: "https://127.0.0.1:1", VALOPAY_ALERT_RESEND_KEY: "synthetic-provider-key" });
assert.equal(result.status, 1);
assert.match(result.stderr, /^Operational monitoring failed\. Check configuration/);
assert.ok(!result.output.includes("synthetic-provider-key"));
// Without its origin the monitor says which setting is missing, rather than the general failure.
result = await run(monitor, []);
assert.equal(result.status, 1);
assert.equal(result.stderr.trim(), "VALOPAY_MONITOR_ORIGIN is not set: set it to the HTTPS origin of the service to probe (docs/operational-rehearsals.md).");
result = await run(monitor, ["--", "--delivr"]);
assert.equal(result.status, 1);
assert.match(result.stderr, /^Unknown option --delivr\. Use: pnpm run check:operations \[--deliver\]/, "a mistyped option is named, with the usage");
// An option given a value is named without it; the value could be a credential.
result = await run(monitor, ["--deliver=synthetic-secret-value"]);
assert.equal(result.status, 1);
assert.match(result.stderr, /^The option --deliver takes no value \(its value is not repeated here\)\./);
result = await run(monitor, ["--token=synthetic-secret-value"]);
assert.match(result.stderr, /^Unknown option --token \(its value is not repeated here\)\./);
assert.ok(!result.output.includes("synthetic-secret-value"));
// A word that is not an option is counted, not repeated: it could be a receiver address or a key.
result = await run(monitor, ["https://alerts.example/synthetic-receiver-token"], { VALOPAY_MONITOR_ORIGIN: "https://127.0.0.1:1" });
assert.equal(result.status, 1);
assert.match(result.stderr, /^Argument 1 is not an option/);
assert.ok(!result.output.includes("synthetic-receiver-token"));
// A scheduler expectation the monitor does not know stops it, named without its value, rather than checking nothing.
result = await run(monitor, [], { VALOPAY_MONITOR_ORIGIN: "https://127.0.0.1:1", VALOPAY_MONITOR_EXPECT_SCHEDULER: "synthetic-typo" });
assert.equal(result.status, 1);
assert.equal(result.stderr.trim(), "VALOPAY_MONITOR_EXPECT_SCHEDULER must be on or external when it is set (docs/operational-rehearsals.md).");
assert.ok(!result.output.includes("synthetic-typo"));
result = await run(monitor, ["--"], { VALOPAY_MONITOR_ORIGIN: "https://127.0.0.1:1", VALOPAY_MONITOR_EXPECT_SCHEDULER: "External" });
assert.equal(result.status, 0, result.output);
assert.deepEqual(JSON.parse(result.stdout).codes, ["database_unready", "service_unavailable"], "external, in any case, is taken");

// ---- pnpm run check:paystack ----
const paystack = "scripts/src/check-paystack.ts";
// The options after the `--` are read; without a key the check stops before any request, and never prints the reference.
result = await run(paystack, ["--", "--mandate-reference", "SYNTHETIC_MANDATE_REFERENCE"]);
assert.equal(result.status, 1);
assert.equal(JSON.parse(result.stderr).code, "configuration");
assert.ok(!result.output.includes("SYNTHETIC_MANDATE_REFERENCE"));
result = await run(paystack, ["--", "--reference", "SYNTHETIC_REFERENCE"]);
assert.equal(result.status, 1);
assert.equal(JSON.parse(result.stderr).code, "invalid_input", "a reference needs its expected amount");
assert.ok(!result.output.includes("SYNTHETIC_REFERENCE"));
// A mistyped option is named; a value joined with "=" is shown the spaced form; neither repeats the value.
result = await run(paystack, ["--refrence", "SYNTHETIC_REFERENCE"]);
assert.equal(result.status, 1);
assert.match(JSON.parse(result.stderr).message, /^Unknown option --refrence\. Use: check-paystack/);
result = await run(paystack, ["--reference=SYNTHETIC_REFERENCE", "--amount-kobo", "100"]);
assert.match(JSON.parse(result.stderr).message, /^Give --reference's value after a space/);
assert.ok(!result.output.includes("SYNTHETIC_REFERENCE"));
result = await run(paystack, ["--", "--help"]);
assert.equal(result.status, 0);
assert.match(result.stdout, /^Use: check-paystack /);

// ---- provision-pilot.ts: provision, --add-administrator and --renew ----
const provision = "scripts/provision-pilot.ts";
for (const args of [[], ["--synthetic-staging", "org_Synthetic", "user_Synthetic"], ["--", "--staging", "org_Synthetic", "user_Synthetic", "Synthetic workspace"], ["--synthetic-staging", "org_Synthetic", "user_Synthetic", "Synthetic", "workspace"],
  ["--synthetic-staging", "--renew", "org_Synthetic"], ["--synthetic-staging", "--renew", "org_Synthetic", "user_Synthetic", "Synthetic workspace"], ["--renew", "org_Synthetic", "user_Synthetic"],
  ["--synthetic-staging", "--add-administrator", "org_Synthetic", "user_Synthetic"], ["--synthetic-staging", "--add-administrator", "--renew", "org_Synthetic", "user_Synthetic"], ["--synthetic-staging", "--rennew", "org_Synthetic", "user_Synthetic"]]) {
  result = await run(provision, args);
  assert.equal(result.status, 1, args.join(" "));
  assert.match(result.stderr, /^Usage: VALOPAY_STAFF_ACCESS=staging pnpm --filter @workspace\/scripts exec tsx \.\/provision-pilot\.ts --synthetic-staging/);
  assert.match(result.stderr, /--add-administrator org_ID user_ID "Display name"\n.*--renew org_ID user_ID$/m, "the usage names all three modes");
}
// Right arguments without staff access stop before the store loads, in every mode: there is no DATABASE_URL, which loading it would need.
for (const args of [["--", "--synthetic-staging", "org_Synthetic", "user_Synthetic", "Synthetic workspace"], ["--synthetic-staging", "--renew", "org_Synthetic", "user_Synthetic"], ["--synthetic-staging", "--add-administrator", "org_Synthetic", "user_Synthetic", "Second administrator"]]) {
  result = await run(provision, args);
  assert.equal(result.status, 1, args.join(" "));
  assert.match(result.stderr, /^Set VALOPAY_STAFF_ACCESS=staging/);
}
// With staff access, the store loads (the import that once failed to resolve) and refuses a malformed organisation before it opens a connection,
// in its own words: no stack, no connection error.
for (const [args, refusal] of [[["--synthetic-staging", "organisation", "user_Synthetic", "Synthetic workspace"], "Provide a staging organisation, administrator user ID and workspace name."],
  [["--synthetic-staging", "--renew", "org_Synthetic", "user"], "Provide a staging organisation and administrator user ID."],
  [["--synthetic-staging", "--add-administrator", "org_Synthetic", "user_Synthetic", " "], "Provide a staging organisation, administrator user ID and display name."]]) {
  result = await run(provision, args, { VALOPAY_STAFF_ACCESS: "staging", DATABASE_URL: unusableDatabase });
  assert.equal(result.status, 1, args.join(" "));
  assert.equal(result.stderr.split("\n").filter((line) => line && !/DEP0040|trace-deprecation/.test(line)).join("\n"), refusal);
  assert.doesNotMatch(result.output, /ERR_MODULE_NOT_FOUND|ECONNREFUSED|\n\s+at /);
}

// ---- rewrap-payloads.ts: re-seal protected payloads under the current wrapping key ----
const rewrap = "scripts/rewrap-payloads.ts";
for (const args of [["--limit"], ["--limit", "0"], ["--limit", "1001"], ["--limit", "ten"], ["--limt", "10"], ["10"], ["--limit", "5", "--limit", "6"]]) {
  result = await run(rewrap, args);
  assert.equal(result.status, 1, args.join(" "));
  assert.match(result.stderr, /^Usage: pnpm --filter @workspace\/scripts exec tsx \.\/rewrap-payloads\.ts \[--limit N\]/);
}
// Right arguments without the key settings stop before the store loads: there is no DATABASE_URL, which loading it would need.
for (const [args, env] of [[[], {}], [["--", "--limit", "5"], { VALOPAY_PAYLOAD_ENCRYPTION: "kms" }], [["--limit", "5"], { VALOPAY_KMS_KEY: "projects/p/locations/l/keyRings/r/cryptoKeys/k" }]]) {
  result = await run(rewrap, args, env);
  assert.equal(result.status, 1, args.join(" "));
  assert.match(result.stderr, /^Set VALOPAY_PAYLOAD_ENCRYPTION=kms and VALOPAY_KMS_KEY to the key payloads move to/);
}
// With the key settings the store loads, and refuses a schema that is not a restricted runtime's before it opens a
// connection, in its own words. The connection itself is checked on PostgreSQL (tests/payload-rewrap.integration.test.ts).
result = await run(rewrap, ["--limit", "5"], { VALOPAY_PAYLOAD_ENCRYPTION: "kms", VALOPAY_KMS_KEY: "projects/p/locations/l/keyRings/r/cryptoKeys/k", VALOPAY_RUNTIME_SCHEMA: "public", DATABASE_URL: unusableDatabase });
assert.equal(result.status, 1);
assert.equal(result.stderr.split("\n").filter((line) => line && !/DEP0040|trace-deprecation/.test(line)).join("\n"), "VALOPAY_RUNTIME_SCHEMA must name a restricted runtime's schema (valopay_runtime_staging_<suffix>), or be unset for the tables the connection's search path reaches.");
assert.doesNotMatch(result.output, /ERR_MODULE_NOT_FOUND|ECONNREFUSED|\n\s+at /);

// ---- pnpm run test:smoke and test:security-api ----
// Both refuse any host but a Replit development domain before they send anything: a loopback listener counts every connection.
let connections = 0;
const listener = createServer((socket) => { connections += 1; socket.destroy(); });
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const local = `127.0.0.1:${listener.address().port}`;
try {
  for (const script of ["scripts/smoke-valopay.mjs", "scripts/security-valopay.mjs"]) {
    for (const domain of [undefined, local, `${local}/sandbox.replit.dev`]) {
      result = await run(script, [], domain === undefined ? {} : { REPLIT_DEV_DOMAIN: domain });
      assert.notEqual(result.status, 0, `${script} with ${domain}`);
      assert.match(result.stderr, /Refusing to run: REPLIT_DEV_DOMAIN must be a \*\.replit\.dev host\./, `${script} with ${domain}`);
    }
  }
  assert.equal(connections, 0, "nothing was sent to a host that is not a Replit development domain");
} finally { listener.close(); }

console.log("Operator commands passed offline: the cleanup command's refusals, a retry without private storage among them, before it reaches the database, options after pnpm's --, a named mistyped option, uncopied values, the monitor's dry run, its missing origin named and its careful failure, the Paystack check's refusals before any request, provision-pilot's three modes with their usage, staff-access check and store refusal before any connection, rewrap-payloads' usage, key settings and runtime schema refusal before any connection, and the smoke and security scripts' refusal of any host but a Replit development domain.");
