// The build and test tooling, offline: the build stamp names a checkout with
// uncommitted changes; the integration runner runs every suite and names the
// ones that failed; the migration rehearsals skip, saying why, where they
// cannot build a throwaway database, and fail instead under CI; and the
// recovery rehearsal fails under CI when its opt-ins are missing rather than
// passing with no evidence; the traceability validator refuses a code pointer
// whose symbol its file no longer declares; and the integration runner and the
// read-index command, started through a symlinked path, still reach their
// refusals instead of exiting silently. Nothing here reaches a database: the
// suites and commands stop at their checks before they connect.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildStamp } from "../artifacts/api-server/build-stamp.mjs";
import { runSuites, suites } from "./run-integration-tests.mjs";

const root = resolve(import.meta.dirname, "..");
const tsx = join(root, "scripts", "node_modules", "tsx", "dist", "cli.mjs");
const loader = pathToFileURL(join(root, "scripts", "node_modules", "tsx", "dist", "loader.mjs")).href;
const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:VALO_PAY_1_|DATABASE_URL$|CI$)/.test(name)));
let checks = 0;

// ---- The build stamp: the commit, marked -dirty when a tracked file differs from it ----
const checkout = mkdtempSync(join(tmpdir(), "valo-pay-1-stamp-"));
try {
  const git = (...args) => execFileSync("git", ["-c", "user.name=Stamp test", "-c", "user.email=stamp@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: checkout, stdio: "ignore" });
  const at = new Date("2026-09-23T07:00:00.000Z");
  assert.equal(buildStamp(checkout, at), "unknown 2026-09-23T07:00:00.000Z", "outside a checkout the commit is unknown");
  git("init", "-q");
  writeFileSync(join(checkout, "source.ts"), "export const version = 1;\n");
  git("add", "source.ts");
  git("commit", "-q", "-m", "Synthetic commit");
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  assert.equal(buildStamp(checkout, at), `${commit} 2026-09-23T07:00:00.000Z`, "a clean checkout is its commit");
  writeFileSync(join(checkout, "notes.txt"), "an untracked file never reaches the bundle unless a tracked one imports it\n");
  assert.equal(buildStamp(checkout, at), `${commit} 2026-09-23T07:00:00.000Z`, "an untracked file alone leaves it clean");
  writeFileSync(join(checkout, "source.ts"), "export const version = 2;\n");
  assert.equal(buildStamp(checkout, at), `${commit}-dirty 2026-09-23T07:00:00.000Z`, "a changed tracked file marks it dirty");
  git("add", "source.ts");
  assert.equal(buildStamp(checkout, at), `${commit}-dirty 2026-09-23T07:00:00.000Z`, "and so does a staged one");
  checks += 5;
} finally { rmSync(checkout, { recursive: true, force: true }); }

// ---- The integration runner: every suite runs, and the failures are named at the end ----
const ran = [], said = [];
const failed = runSuites(["one", "two", "three", "four"], (suite) => { ran.push(suite); return suite === "two" ? 1 : suite === "three" ? null : 0; }, { log: (line) => said.push(line), error: (line) => said.push(line) });
assert.deepEqual(ran, ["one", "two", "three", "four"], "a failure does not stop the suites after it");
assert.deepEqual(failed, ["two", "three"], "a suite killed by a signal counts as failed");
assert.deepEqual(said.filter((line) => line.startsWith("✕")), ["✕ two failed", "✕ three failed"]);
assert.ok(suites.length >= 17 && suites.every((suite) => /^artifacts\/api-server\/tests\/[\w-]+\.integration\.test\.ts$/.test(suite)));
checks += 4;

// ---- The migration rehearsals: a loopback server whose login can create databases, or a skip that says why ----
const suite = (file, env) => spawnSync(process.execPath, [tsx, `artifacts/api-server/tests/${file}`], { cwd: root, env: { ...clean, ...env }, encoding: "utf8", timeout: 60_000 });
const remote = { VALO_PAY_1_RUN_INTEGRATION: "1", DATABASE_URL: "postgres://synthetic@db.example.test:5432/valo-pay-1" };
for (const [file, name] of [["record-index-migration.integration.test.ts", "Record index migration rehearsal"], ["pilot-workflow-migration.integration.test.ts", "Pilot workflow migration rehearsal"], ["schema-push.integration.test.ts", "Schema push rehearsal"]]) {
  let result = suite(file, remote);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^${name} skipped: it creates throwaway databases beside DATABASE_URL, so it runs only against a loopback PostgreSQL`, "m"));
  result = suite(file, { ...remote, CI: "true" });
  assert.equal(result.status, 1, "under CI, where it must run, a skip is a failure");
  assert.match(result.stderr, new RegExp(`^${name} cannot run: `, "m"));
  checks += 4;
}
// A login that cannot create databases: the pool is ended and the suite skipped, or failed under CI.
const noCreate = (env) => spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e",
  "import { requireCreateDatabase } from './artifacts/api-server/tests/throwaway-database.ts'; let ended = false; process.on('exit', () => { if (!ended) console.error('the pool was left open'); }); await requireCreateDatabase('Synthetic rehearsal', { query: async () => ({ rows: [{ allowed: false }] }), end: async () => { ended = true; } }); console.log('ran');"],
  { cwd: root, env: { ...clean, ...env }, encoding: "utf8", timeout: 60_000 });
let result = noCreate({});
assert.equal(result.status, 0, result.stderr);
assert.equal(result.stdout.trim(), "Synthetic rehearsal skipped: the login in DATABASE_URL cannot create databases (it needs CREATEDB), and the rehearsal builds a throwaway one.");
assert.doesNotMatch(result.stderr, /pool was left open/);
result = noCreate({ CI: "true" });
assert.equal(result.status, 1);
checks += 4;

// ---- The recovery rehearsal: never green in CI without its opt-ins ----
result = suite("recovery-rehearsal.integration.test.ts", { CI: "true", VALO_PAY_1_RUN_INTEGRATION: "1" });
assert.equal(result.status, 1, "CI without VALO_PAY_1_RUN_RECOVERY fails");
assert.match(result.stderr, /^Recovery rehearsal cannot run: CI needs VALO_PAY_1_RUN_INTEGRATION=1 and VALO_PAY_1_RUN_RECOVERY=1/m);
result = suite("recovery-rehearsal.integration.test.ts", {});
assert.equal(result.status, 0, "outside CI it is opt-in, as before");
checks += 3;

// ---- The traceability validator: a code pointer's symbol must still be declared in its file ----
// A scratch copy of the validator, its matrix and every file a pointer names, edited case by case.
const matrixFile = "docs/refactor-2026-09-29/traceability.json", validator = "docs/refactor-2026-09-29/validate-traceability.mjs";
const matrix = JSON.parse(readFileSync(join(root, matrixFile), "utf8"));
const evidenceFile = "docs/product-identity/historical-files.json", mapFile = "docs/product-identity/path-map.json";
const historicalEvidence = JSON.parse(readFileSync(join(root, evidenceFile), "utf8")), identityMap = JSON.parse(readFileSync(join(root, mapFile), "utf8"));
const mapped = (path) => {
  const entry = Object.entries(identityMap.paths).sort(([a], [b]) => b.length - a.length).find(([before]) => path === before || path.startsWith(`${before}/`));
  return entry ? entry[1] + path.slice(entry[0].length) : path;
};
const pointers = Object.values(matrix.components).flatMap((component) => [...component.implementation, ...component.contracts, ...component.test_sources]);
const scratch = mkdtempSync(join(tmpdir(), "valo-pay-1-traceability-")), parser = join(scratch, "node_modules");
let linked = false;
try {
  for (const path of new Set([validator, evidenceFile, mapFile, ...pointers.map((pointer) => mapped(pointer.path)), ...Object.values(identityMap.paths)])) {
    if (statSync(join(root, path)).isDirectory()) { mkdirSync(join(scratch, path), { recursive: true }); continue; }
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    copyFileSync(join(root, path), join(scratch, path));
  }
  symlinkSync(join(root, "node_modules"), parser, "junction"); // the validator's TypeScript parser
  linked = true;
  const validate = (edit = () => {}, { pinEvidence = true, map = identityMap, crlf = false } = {}) => {
    const copy = structuredClone(matrix);
    edit(copy);
    const serialized = `${JSON.stringify(copy, null, 2)}\n`;
    writeFileSync(join(scratch, matrixFile), crlf ? serialized.replaceAll("\n", "\r\n") : serialized);
    const evidence = structuredClone(historicalEvidence);
    // Pointer-negative fixtures simulate a reviewed matrix update, so the declaration checks still run.
    // The separate unpinned case below verifies an unreviewed edit never acquires historical mappings.
    if (pinEvidence) evidence.files.find(entry => entry.path === matrixFile).sha256 = createHash("sha256").update(serialized).digest("hex");
    writeFileSync(join(scratch, evidenceFile), JSON.stringify(evidence));
    writeFileSync(join(scratch, mapFile), JSON.stringify(map));
    return spawnSync(process.execPath, [join(scratch, validator)], { encoding: "utf8", timeout: 60_000 });
  };
  const repoint = (component, symbol, change) => (copy) => Object.assign(copy.components[component].implementation.find((pointer) => pointer.symbol === symbol), change);
  // A synthetic module in the scratch tree only, so these cases do not depend on how the real pricing code is written.
  const probe = "artifacts/api-server/src/domain/pricing-probe.ts";
  const probing = (source) => (copy) => { writeFileSync(join(scratch, probe), source); repoint("BIL", "designPartnerDiscount", { path: probe })(copy); };
  const refused = (edit, pattern, reason) => {
    const run = validate(edit);
    assert.equal(run.status, 1, reason);
    assert.match(run.stderr, pattern);
  };
  const accepted = (edit) => { const run = validate(edit); assert.equal(run.status, 0, run.stderr); };
  accepted();
  const windowsCheckout = validate(undefined, { crlf: true });
  assert.equal(windowsCheckout.status, 0, `Windows checkout line endings preserve the canonical evidence digest: ${windowsCheckout.stderr}`);
  const unpinned = validate(copy => { copy.requirements[0].summary = "An unreviewed historical edit."; }, { pinEvidence: false });
  assert.equal(unpinned.status, 1, "changed historical bytes cannot silently use compatibility mappings");
  assert.match(unpinned.stderr, /Historical traceability bytes changed without a reviewed evidence digest/);
  refused(repoint("BIL", "designPartnerDiscount", { path: "artifacts/valo-pay/src/no-such-module.ts" }),
    /Missing repository pointer artifacts\/valo-pay\/src\/no-such-module\.ts \(current path artifacts\/valo-pay-1\/src\/no-such-module\.ts\)/,
    "an approved directory mapping does not excuse a missing child file");
  refused(repoint("BIL", "designPartnerDiscount", { path: "artifacts/valo-pay-shadow/src/no-such-module.ts" }),
    /current path artifacts\/valo-pay-shadow\/src\/no-such-module\.ts/,
    "a mapping applies only at an exact directory boundary, not a matching name prefix");
  const missingTarget = validate(undefined, { map: { ...identityMap, paths: { ...identityMap.paths, "scripts/old-probe.mjs": "scripts/missing-probe.mjs" } } });
  assert.equal(missingTarget.status, 1, "every approved mapping target must exist even when no matrix pointer uses it");
  assert.match(missingTarget.stderr, /Missing approved identity mapping target scripts\/missing-probe\.mjs/);
  const escaping = validate(undefined, { map: { ...identityMap, paths: { ...identityMap.paths, "scripts/old-probe.mjs": "../outside.mjs" } } });
  assert.equal(escaping.status, 1, "a map cannot resolve a repository pointer outside the repository");
  assert.match(escaping.stderr, /Identity path mappings must contain distinct safe repository paths/);
  // After PR #78 removed discountRateFor from billing.ts, the matrix still pointed at it and the validator passed.
  refused(repoint("BIL", "designPartnerDiscount", { path: "artifacts/api-server/src/domain/billing.ts", symbol: "discountRateFor" }),
    /artifacts\/api-server\/src\/domain\/billing\.ts no longer declares discountRateFor/, "a pointer to a symbol its file no longer declares fails the validator");
  // connected.ts only re-exports consentActive from connected-consents.ts.
  refused(repoint("OB-CNS", "consentActive", { path: "artifacts/api-server/src/domain/connected.ts" }),
    /connected\.ts no longer declares consentActive/, "a re-export is not a declaration");
  refused(probing(`// designPartnerDiscount prices the month.\nimport { designPartnerDiscount } from "./commercial-terms";\nexport { designPartnerDiscount as pricing };\nexport const label = "designPartnerDiscount", fields = { designPartnerDiscount: true };\nexport const decision = designPartnerDiscount(undefined, "2027-01");\n`),
    /pricing-probe\.ts no longer declares designPartnerDiscount/, "a comment, an import, an export alias, a string, a field name or a call is not a declaration");
  // A binding taken from require() or import(), however the value is unwrapped, is an import; `declare` describes code elsewhere.
  for (const [source, reason] of [
    ['export const { designPartnerDiscount } = await import("./billing");\n', "a binding destructured from a dynamic import is not a declaration"],
    ['const { designPartnerDiscount } = require("./billing");\n', "a binding destructured from require() is not a declaration"],
    ['export const designPartnerDiscount = (require("./billing") as { designPartnerDiscount: unknown }).designPartnerDiscount!;\n', "a property of require() read through parentheses, as and a non-null assertion is not a declaration"],
    ['export const designPartnerDiscount = (await import("./billing"))["designPartnerDiscount"] satisfies unknown;\n', "an element of an awaited import read through satisfies is not a declaration"],
    ['export declare function designPartnerDiscount(data: unknown, period: string): unknown;\ndeclare const designPartnerDiscount: unknown;\n', "an ambient declare is not a declaration"],
  ]) refused(probing(source), /pricing-probe\.ts no longer declares designPartnerDiscount/, reason);
  // Only the top level counts: a nested function or variable, or a class method, of the same name does not.
  for (const [source, reason] of [
    ["export function outer() { function designPartnerDiscount() {} return designPartnerDiscount; }\n", "a nested function is not a top-level declaration"],
    ["export function outer() { const designPartnerDiscount = 1; return designPartnerDiscount; }\n", "a nested variable is not a top-level declaration"],
    ["export class Terms { designPartnerDiscount() {} }\n", "a class method is not a top-level declaration"],
  ]) refused(probing(source), /pricing-probe\.ts no longer declares designPartnerDiscount/, reason);
  refused((copy) => Object.assign(Object.values(copy.components).flatMap((component) => component.contracts).find((pointer) => pointer.path.endsWith(".md")), { symbol: "deployment" }),
    /Only a TypeScript or JavaScript file declares a symbol/, "a document cannot declare a symbol");
  // Lines moving and a declaration reformatted, or rewritten as a constant, leave the pointer valid.
  accepted(probing(`export const before = 1;\n\n\n/** Moved down and wrapped. */\nexport function\n  designPartnerDiscount (\n    data: unknown,\n  ) {\n  return data;\n}\n`));
  accepted(probing("export const designPartnerDiscount = (data: unknown) => data;\n"));
  accepted(probing("const rules = { designPartnerDiscount: (data: unknown) => data };\nexport const { designPartnerDiscount } = rules;\n"));
  checks += 22;
} finally {
  if (linked) unlinkSync(parser); // the link alone, never the dependencies it names
  rmSync(scratch, { recursive: true, force: true });
}

// ---- Started through a symlinked path, the integration runner and the read-index command still run ----
// Node gives a module its real path; a guard comparing that with the path the command was started by once made both
// exit 0 without a word. Without their opt-ins and DATABASE_URL they reach their refusals, never a database.
const links = mkdtempSync(join(tmpdir(), "valo-pay-1-linked-scripts-")), linkedScripts = join(links, "scripts");
symlinkSync(join(root, "scripts"), linkedScripts, "junction");
try {
  const linkedRun = (script) => spawnSync(process.execPath, [join(linkedScripts, script)], { cwd: root, env: clean, encoding: "utf8", timeout: 60_000 });
  result = linkedRun("run-integration-tests.mjs");
  assert.equal(result.status, 1, "started through a symlinked path, the integration runner still refuses without VALO_PAY_1_RUN_INTEGRATION=1");
  assert.match(result.stderr, /Set VALO_PAY_1_RUN_INTEGRATION=1 to run the database-backed suites/);
  result = linkedRun("apply-record-list-indexes.mjs");
  assert.equal(result.status, 1, "started through a symlinked path, the read-index command still refuses without DATABASE_URL");
  assert.match(result.stderr, /^DATABASE_URL must be supplied by the deployment environment/m);
  checks += 4;
} finally {
  unlinkSync(linkedScripts); // the link alone, never the scripts it names
  rmSync(links, { recursive: true, force: true });
}

console.log(`Tooling checks passed (${checks}): the build stamp marks uncommitted tracked changes, the integration runner runs every suite and names the failures, the migration rehearsals skip with their reason (and fail under CI) where they cannot build a throwaway database, the recovery rehearsal never passes in CI without its opt-ins, the traceability validator refuses a code pointer whose symbol its file no longer declares, however the declaration is formatted, and the integration runner and the read-index command started through a symlinked path still reach their refusals.`);
