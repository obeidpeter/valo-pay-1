// Reuse the real API/PostgreSQL acceptance suites, with a small shareable report.
// This is an automated synthetic rehearsal, not an observed usability study.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
export const rehearsalSuites = [
  { id: 'pilot-journey', file: 'artifacts/api-server/tests/pilot-workflow.integration.test.ts', covers: ['empty_lender', 'checked_imports', 'payment_matching', 'case_handover_and_resolution', 'daily_close', 'evidence_content', 'lost_response_and_concurrent_commit', 'staff_permission_and_revocation'] },
  { id: 'allocation-decisions', file: 'artifacts/api-server/tests/allocation-decisions.integration.test.ts', covers: ['concurrent_finance_decisions', 'stale_proposal_refusal', 'no_duplicate_allocation'] },
  { id: 'close-review', file: 'artifacts/api-server/tests/source-close-controls.integration.test.ts', covers: ['source_completeness', 'independent_review', 'late_source_invalidates_current_approval', 'frozen_reviewed_evidence'] },
  { id: 'durable-export', file: 'artifacts/api-server/tests/export-jobs.integration.test.ts', covers: ['queued_evidence_export', 'lost_queue_response', 'interrupted_worker_recovery', 'single_private_object', 'lender_isolation'] },
];

/** All guards run before loading any application or database module. */
export function validateRehearsalEnvironment(env, args = []) {
  if (args.length) throw new Error('No command arguments are accepted. Configure the rehearsal through its documented environment variables.');
  if (env.VALO_PAY_1_RUN_INTEGRATION !== '1' || env.VALO_PAY_1_RUN_PILOT_REHEARSAL !== '1') {
    throw new Error('Set VALO_PAY_1_RUN_INTEGRATION=1 and VALO_PAY_1_RUN_PILOT_REHEARSAL=1 for a disposable local synthetic database.');
  }
  let database;
  try { database = new URL(env.DATABASE_URL); } catch { throw new Error('DATABASE_URL must identify a disposable local PostgreSQL database.'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)
    || !['/valo_pay_1_test', '/valo_pay_1_pilot_rehearsal'].includes(database.pathname) || database.search || database.hash) {
    throw new Error('Refusing the database: use a loopback PostgreSQL database named valo_pay_1_test or valo_pay_1_pilot_rehearsal, without URL options.');
  }
  if (env.NODE_ENV === 'production') throw new Error('Refusing production mode. Use a disposable local development environment.');
}

/** Do not pass host provider/identity/monitor/key-service settings into the suites. */
export function rehearsalEnvironment(env) {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([name]) => !/^(?:VALO_PAY_1_|CLERK_|PAYSTACK_|VITE_|GOOGLE_|AWS_|AZURE_|REPLIT_|PRIVATE_OBJECT_DIR$|PUBLIC_OBJECT_SEARCH_PATHS$|NODE_OPTIONS$)/i.test(name)));
  return {
    ...cleaned,
    NODE_ENV: 'development', CI: 'true',
    VALO_PAY_1_RUN_INTEGRATION: '1', VALO_PAY_1_STAFF_ACCESS: 'off',
    VALO_PAY_1_RUNTIME_ISOLATION: 'off', VALO_PAY_1_PAYLOAD_ENCRYPTION: 'off',
    VALO_PAY_1_CLOSE_SCHEDULER: 'off', VALO_PAY_1_PAYSTACK_INGRESS: 'off',
    VALO_PAY_1_PAYSTACK_CONNECTIONS: 'off', LOG_LEVEL: 'silent',
  };
}

export function sourceEvidence(cwd = root) {
  const git = (...args) => {
    const result = spawnSync('git', ['-c', `safe.directory=${cwd}`, ...args], { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error('Cannot identify the rehearsal source checkout.');
    return result.stdout;
  };
  const commit = git('rev-parse', 'HEAD').trim(), tree = git('rev-parse', 'HEAD^{tree}').trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit) || !/^[a-f0-9]{40,64}$/.test(tree)) throw new Error('Cannot identify the rehearsal source revision.');
  // Includes untracked source files, so a dirty checkout never borrows the
  // identity of HEAD. Generated reports belong outside the checkout.
  const files = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))].sort();
  const digest = createHash('sha256');
  let fileCount = 0;
  for (const file of files) {
    try {
      const bytes = readFileSync(path.join(cwd, file));
      digest.update(file).update('\0').update(String(bytes.length)).update('\0').update(bytes);
      fileCount++;
    } catch (error) {
      // A tracked deletion is included, rather than silently hashing HEAD's copy.
      if (error.code !== 'ENOENT') throw new Error('Cannot fingerprint the rehearsal source files.');
      digest.update(file).update('\0deleted\0');
    }
  }
  return { commit, tree, dirty: Boolean(git('status', '--porcelain').trim()), fileCount, sourceDigestSha256: digest.digest('hex') };
}

/** Failure never stops later independent suites, and raw child output is never copied into the report. */
export function runRehearsal({ run, fingerprint, now = () => new Date(), clock = () => performance.now(), say = console }) {
  const source = fingerprint(), startedAt = now().toISOString(), started = clock();
  const suites = rehearsalSuites.map(suite => {
    const begin = clock();
    let result;
    try { result = run(suite); } catch { result = { status: null, error: true }; }
    const passed = result.status === 0 && !result.error && !result.signal;
    say.log(`${passed ? 'PASS' : 'FAIL'} ${suite.id}`);
    return { ...suite, outcome: passed ? 'passed' : 'failed', elapsedMs: Math.max(0, Math.round(clock() - begin)) };
  });
  const sourceAfter = fingerprint(), sourceStable = source.sourceDigestSha256 === sourceAfter.sourceDigestSha256 && source.commit === sourceAfter.commit;
  return {
    schemaVersion: 1, evidenceType: 'automated_synthetic_api_postgresql_rehearsal',
    startedAt, completedAt: now().toISOString(), elapsedMs: Math.max(0, Math.round(clock() - started)),
    outcome: suites.some(suite => suite.outcome === 'failed') ? 'failed' : sourceStable ? 'passed' : 'source_changed_during_run',
    source, sourceAfter, sourceStable, suites,
    boundaries: {
      hostedDataAccessed: false, externalProviderAcceptance: 'not_tested',
      hostedRecovery: 'not_tested', inboxDelivery: 'not_tested',
      browserJourney: 'separate_playwright_database_check', observedHumanStudy: 'not_performed',
      identity: 'verified_session_fixtures', exportStorage: 'in_process_private_storage_fixture',
    },
  };
}

/** The operating system's real path: on Windows the native call also resolves a subst or mapped drive letter. */
const realPath = file => { try { return realpathSync.native(file); } catch { return realpathSync(file); } };

/** Where a file written at this path lands: links at the path itself are followed from their real directory, as the
 * system follows them, then the real path of the nearest existing ancestor is taken. */
function landingPath(file) {
  let target = path.resolve(file);
  for (let hops = 0; lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink(); hops++) {
    if (hops === 40) throw new Error('Write the evidence report to a path whose links resolve, outside this checkout.');
    target = path.resolve(realPath(path.dirname(target)), readlinkSync(target));
  }
  let existing = target;
  while (!existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  return path.join(realPath(existing), path.relative(existing, target));
}

// Real paths: started through a symlinked path, argv names the link while this module's URL names the file, and the
// rehearsal would exit 0 without running or refusing.
const startedDirectly = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (startedDirectly()) {
  try {
    validateRehearsalEnvironment(process.env, process.argv.slice(2));
    const output = process.env.VALO_PAY_1_PILOT_REHEARSAL_REPORT;
    if (!output) throw new Error('Set VALO_PAY_1_PILOT_REHEARSAL_REPORT to an evidence file outside this checkout.');
    // Real paths on both sides, so a link in a directory above the report, or at the report itself, cannot lead it into the checkout.
    const reportPath = path.resolve(output), checkout = realPath(root);
    const refuseInside = () => {
      const relative = path.relative(checkout, landingPath(reportPath));
      if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
        throw new Error('Write the evidence report outside this checkout so it does not change the source fingerprint.');
      }
    };
    refuseInside();
    // The report's directory is made now, before any suite, so one that cannot be made (under a dangling link, say) fails
    // here rather than after the whole rehearsal; once it exists, where it really is is checked again.
    try { mkdirSync(path.dirname(reportPath), { recursive: true }); } catch {
      throw new Error('Write the evidence report to a directory that exists or can be created, outside this checkout.');
    }
    refuseInside();
    const env = rehearsalEnvironment(process.env);
    const report = runRehearsal({
      fingerprint: () => sourceEvidence(),
      run: suite => spawnSync(process.execPath, [path.join(root, 'scripts/node_modules/tsx/dist/cli.mjs'), suite.file], {
        cwd: root, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
      }),
    });
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(`Pilot rehearsal ${report.outcome}; ${report.suites.filter(suite => suite.outcome === 'passed').length}/${report.suites.length} suites passed. Evidence report written.`);
    if (report.outcome !== 'passed') {
      console.error('Suite outcomes remain in the report. Run a failed suite directly on the disposable database for diagnostics; repeat after source changes settle.');
      process.exitCode = 1;
    }
  } catch (error) {
    // Every message above is fixed; do not echo URL/parser/spawn exception text.
    const safe = error instanceof Error && /^(Set |Refusing |No command |DATABASE_URL |Cannot |Write the evidence)/.test(error.message);
    console.error(safe ? error.message : 'Pilot rehearsal could not complete; no connection details or child output are logged.');
    process.exitCode = 1;
  }
}
