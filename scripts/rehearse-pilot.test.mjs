import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rehearsalEnvironment, rehearsalSuites, runRehearsal, validateRehearsalEnvironment } from './rehearse-pilot.mjs';

const root = path.resolve(import.meta.dirname, '..');
// The unusable password is supplied through URL's setter to keep fixture text distinct from real connection strings.
const privateUrl = (value, password = 'do-not-print') => { const url = new URL(value); url.password = password; return url.toString(); };
const enabled = { VALOPAY_RUN_INTEGRATION: '1', VALOPAY_RUN_PILOT_REHEARSAL: '1', DATABASE_URL: privateUrl('postgresql://synthetic@127.0.0.1:1/valopay', 'private-fixture') };
let checks = 0;
for (const overrides of [
  { VALOPAY_RUN_INTEGRATION: '' }, { VALOPAY_RUN_PILOT_REHEARSAL: '' },
  { DATABASE_URL: privateUrl('postgresql://synthetic@db.example.test/valopay') },
  { DATABASE_URL: privateUrl('postgresql://synthetic@localhost/production') },
  { DATABASE_URL: privateUrl('postgresql://synthetic@localhost/valopay?host=db.example.test') },
  { DATABASE_URL: privateUrl('postgresql://synthetic@localhost/valopay#fragment') },
  { DATABASE_URL: 'https://localhost/valopay' }, { DATABASE_URL: 'do-not-print' },
  { NODE_ENV: 'production' },
]) {
  assert.throws(() => validateRehearsalEnvironment({ ...enabled, ...overrides }), error => !/do-not-print|private-fixture/.test(error.message));
  checks++;
}
assert.throws(() => validateRehearsalEnvironment(enabled, ['do-not-print']), /No command arguments/); checks++;
for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) {
  validateRehearsalEnvironment({ ...enabled, DATABASE_URL: `postgresql://synthetic@${hostname}/valopay_pilot_rehearsal` }); checks++;
}
const env = rehearsalEnvironment({ ...enabled, PATH: 'retained', PAYSTACK_TEST_SECRET_KEY: 'do-not-print', CLERK_SECRET_KEY: 'do-not-print', GOOGLE_APPLICATION_CREDENTIALS: 'do-not-print', PRIVATE_OBJECT_DIR: 'do-not-print', VALOPAY_CLOSE_SCHEDULER: 'on', VALOPAY_STAFF_ACCESS: 'staging', NODE_OPTIONS: 'do-not-print' });
assert.equal(env.DATABASE_URL, enabled.DATABASE_URL); assert.equal(env.PATH, 'retained');
for (const key of ['PAYSTACK_TEST_SECRET_KEY', 'CLERK_SECRET_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'PRIVATE_OBJECT_DIR', 'NODE_OPTIONS']) assert.equal(env[key], undefined);
assert.deepEqual([env.VALOPAY_RUN_INTEGRATION, env.VALOPAY_CLOSE_SCHEDULER, env.VALOPAY_STAFF_ACCESS, env.CI], ['1', 'off', 'off', 'true']); checks += 8;

const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false, fileCount: 1, sourceDigestSha256: 'c'.repeat(64) };
const ran = [], said = [];
let clock = 0;
const report = runRehearsal({
  fingerprint: () => source, clock: () => clock++, now: () => new Date('2026-09-26T00:00:00Z'), say: { log: line => said.push(line) },
  run: suite => { ran.push(suite.id); return { status: suite.id === 'allocation-decisions' ? 1 : 0, stdout: 'do-not-print', stderr: 'postgres://private-fixture@localhost/valopay' }; },
});
assert.deepEqual(ran, rehearsalSuites.map(suite => suite.id), 'a failure never hides later results');
assert.equal(report.outcome, 'failed'); assert.equal(report.suites.filter(suite => suite.outcome === 'failed').length, 1);
assert.doesNotMatch(JSON.stringify(report) + said.join('\n'), /do-not-print|private-fixture|postgres:\/\//);
assert.equal(report.boundaries.observedHumanStudy, 'not_performed'); checks += 5;
for (const failed of [{ status: null, signal: 'SIGTERM' }, { status: 0, error: new Error('do-not-print') }]) {
  assert.equal(runRehearsal({ fingerprint: () => source, run: () => failed, say: { log() {} } }).outcome, 'failed'); checks++;
}
let reads = 0;
assert.equal(runRehearsal({ fingerprint: () => reads++ ? { ...source, sourceDigestSha256: 'd'.repeat(64) } : source, run: () => ({ status: 0 }), say: { log() {} } }).outcome, 'source_changed_during_run'); checks++;
assert.equal(runRehearsal({ fingerprint: () => source, run: () => ({ status: 0 }), say: { log() {} } }).outcome, 'passed'); checks++;

// Exercise the actual executable's refusal path: no database modules or services are started.
for (const overrides of [{ DATABASE_URL: 'postgres://do-not-print@remote.example/valopay' }, { VALOPAY_PILOT_REHEARSAL_REPORT: path.join(root, 'must-not-be-created.json') }]) {
  const child = spawnSync(process.execPath, [path.join(root, 'scripts/rehearse-pilot.mjs')], { env: { ...process.env, ...enabled, ...overrides }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 1); assert.doesNotMatch(child.stdout + child.stderr, /do-not-print|private-fixture/); checks += 2;
}
// Started through a symlinked path the command still runs, here to its refusal without the opt-ins: Node gives the
// module its real path, and a guard comparing that with the path it was started by once exited 0 without a word.
const links = mkdtempSync(path.join(tmpdir(), 'valopay-linked-rehearsal-')), linked = path.join(links, 'scripts');
symlinkSync(path.join(root, 'scripts'), linked, 'junction');
try {
  const unset = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:VALOPAY_|DATABASE_URL$)/.test(name)));
  const child = spawnSync(process.execPath, [path.join(linked, 'rehearse-pilot.mjs')], { env: unset, encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 1, 'started through a symlinked path, the rehearsal still refuses without its opt-ins');
  assert.match(child.stderr, /^Set VALOPAY_RUN_INTEGRATION=1 and VALOPAY_RUN_PILOT_REHEARSAL=1/m); checks += 2;
} finally { unlinkSync(linked); rmSync(links, { recursive: true, force: true }); }
// A report path that reaches the checkout through a link, in a directory above it or at the path itself, is refused as a
// path inside it is. PATH holds no git, so even a build that accepted the path stops at the source fingerprint, before any suite.
const outside = mkdtempSync(path.join(tmpdir(), 'valopay-rehearsal-report-'));
const name = `rehearsal-report-${process.pid}.json`, checkoutLink = path.join(outside, 'checkout'), reportLink = path.join(outside, 'report.json');
symlinkSync(root, checkoutLink, 'junction');
symlinkSync(path.join(root, 'docs'), reportLink, process.platform === 'win32' ? 'junction' : 'dir');
try {
  const gitless = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^path$/i.test(key))), ...enabled, PATH: outside };
  for (const report of [path.join(checkoutLink, name), reportLink]) {
    const child = spawnSync(process.execPath, [path.join(root, 'scripts/rehearse-pilot.mjs')], { env: { ...gitless, VALOPAY_PILOT_REHEARSAL_REPORT: report }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /^Write the evidence report outside this checkout/m, `a report path that leads into the checkout through a link is refused: ${report}`);
    assert.equal(existsSync(path.join(root, name)), false); checks += 3;
  }
} finally { unlinkSync(checkoutLink); unlinkSync(reportLink); rmSync(outside, { recursive: true, force: true }); }
console.log(`Pilot rehearsal command checks passed (${checks}): unsafe destinations refused, a report path leading into the checkout through a link refused, host credentials excluded, all failures retained, source changes detected, evidence stays free of child output, and a run started through a symlinked path still refuses.`);
