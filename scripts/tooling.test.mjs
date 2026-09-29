// The build and test tooling, offline: the build stamp names a checkout with
// uncommitted changes; the integration runner runs every suite and names the
// ones that failed; the migration rehearsals skip, saying why, where they
// cannot build a throwaway database, and fail instead under CI; and the
// recovery rehearsal fails under CI when its opt-ins are missing rather than
// passing with no evidence; and the traceability validator refuses a code
// pointer whose symbol its file no longer declares. Nothing here reaches a
// database: the suites stop at their checks before they connect.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildStamp } from "../artifacts/api-server/build-stamp.mjs";
import { runSuites, suites } from "./run-integration-tests.mjs";

const root = resolve(import.meta.dirname, "..");
const tsx = join(root, "scripts", "node_modules", "tsx", "dist", "cli.mjs");
const loader = pathToFileURL(join(root, "scripts", "node_modules", "tsx", "dist", "loader.mjs")).href;
const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:VALOPAY_|DATABASE_URL$|CI$)/.test(name)));
let checks = 0;

// ---- The build stamp: the commit, marked -dirty when a tracked file differs from it ----
const checkout = mkdtempSync(join(tmpdir(), "valopay-stamp-"));
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
const remote = { VALOPAY_RUN_INTEGRATION: "1", DATABASE_URL: "postgres://synthetic@db.example.test:5432/valopay" };
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
result = suite("recovery-rehearsal.integration.test.ts", { CI: "true", VALOPAY_RUN_INTEGRATION: "1" });
assert.equal(result.status, 1, "CI without VALOPAY_RUN_RECOVERY fails");
assert.match(result.stderr, /^Recovery rehearsal cannot run: CI needs VALOPAY_RUN_INTEGRATION=1 and VALOPAY_RUN_RECOVERY=1/m);
result = suite("recovery-rehearsal.integration.test.ts", {});
assert.equal(result.status, 0, "outside CI it is opt-in, as before");
checks += 3;

// ---- The traceability validator: a code pointer's symbol must still be declared in its file ----
// A scratch copy of the validator, its matrix and every file a pointer names, edited case by case.
const matrixFile = "docs/refactor-2026-09-29/traceability.json", validator = "docs/refactor-2026-09-29/validate-traceability.mjs";
const matrix = JSON.parse(readFileSync(join(root, matrixFile), "utf8"));
const pointers = Object.values(matrix.components).flatMap((component) => [...component.implementation, ...component.contracts, ...component.test_sources]);
const scratch = mkdtempSync(join(tmpdir(), "valopay-traceability-")), parser = join(scratch, "node_modules");
let linked = false;
try {
  for (const path of new Set([validator, ...pointers.map((pointer) => pointer.path)])) {
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    copyFileSync(join(root, path), join(scratch, path));
  }
  symlinkSync(join(root, "node_modules"), parser, "junction"); // the validator's TypeScript parser
  linked = true;
  const validate = (edit = () => {}) => {
    const copy = structuredClone(matrix);
    edit(copy);
    writeFileSync(join(scratch, matrixFile), `${JSON.stringify(copy, null, 2)}\n`);
    return spawnSync(process.execPath, [join(scratch, validator)], { encoding: "utf8", timeout: 60_000 });
  };
  const repoint = (component, symbol, change) => (copy) => Object.assign(copy.components[component].implementation.find((pointer) => pointer.symbol === symbol), change);
  const refused = (edit, pattern, reason) => {
    const run = validate(edit);
    assert.equal(run.status, 1, reason);
    assert.match(run.stderr, pattern);
  };
  let run = validate();
  assert.equal(run.status, 0, run.stderr);
  // After PR #78 removed discountRateFor from billing.ts, the matrix still pointed at it and the validator passed.
  refused(repoint("BIL", "designPartnerDiscount", { path: "artifacts/api-server/src/domain/billing.ts", symbol: "discountRateFor" }),
    /artifacts\/api-server\/src\/domain\/billing\.ts no longer declares discountRateFor/, "a pointer to a symbol its file no longer declares fails the validator");
  // billing.ts imports and calls designPartnerDiscount and names a field after it; commercial-terms.ts declares it.
  refused(repoint("BIL", "designPartnerDiscount", { path: "artifacts/api-server/src/domain/billing.ts" }),
    /billing\.ts no longer declares designPartnerDiscount/, "an import, a call or a field name is not a declaration");
  // connected.ts only re-exports consentActive from connected-consents.ts.
  refused(repoint("OB-CNS", "consentActive", { path: "artifacts/api-server/src/domain/connected.ts" }),
    /connected\.ts no longer declares consentActive/, "a re-export is not a declaration");
  refused((copy) => Object.assign(Object.values(copy.components).flatMap((component) => component.contracts).find((pointer) => pointer.path.endsWith(".md")), { symbol: "deployment" }),
    /Only a TypeScript or JavaScript file declares a symbol/, "a document cannot declare a symbol");
  // Lines moving and a declaration reformatted, or rewritten as a constant, leave the pointer valid.
  const terms = join(scratch, "artifacts/api-server/src/domain/commercial-terms.ts"), original = readFileSync(terms, "utf8");
  writeFileSync(terms, `// Moved down.\n\n${original.replace("export function designPartnerDiscount(", "export function\n  designPartnerDiscount (")}`);
  run = validate();
  assert.equal(run.status, 0, run.stderr);
  writeFileSync(terms, original.replace("export function designPartnerDiscount(data: Terms | undefined, period: string): DiscountDecision {", "export const designPartnerDiscount = (data: Terms | undefined, period: string): DiscountDecision => {"));
  run = validate();
  assert.equal(run.status, 0, run.stderr);
  checks += 7;
} finally {
  if (linked) unlinkSync(parser); // the link alone, never the dependencies it names
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`Tooling checks passed (${checks}): the build stamp marks uncommitted tracked changes, the integration runner runs every suite and names the failures, the migration rehearsals skip with their reason (and fail under CI) where they cannot build a throwaway database, the recovery rehearsal never passes in CI without its opt-ins, and the traceability validator refuses a code pointer whose symbol its file no longer declares, however the declaration is formatted.`);
