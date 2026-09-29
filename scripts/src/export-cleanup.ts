/** Operator-only aggregate status, bounded retry and review of parked files. Uses the sandbox service's database and storage identity. */
export {};
const usage = 'Use: pnpm run check:export-cleanup [-- --retry | --requeue EXPORT_ID | --release EXPORT_ID --reason "why"]. Option values are never repeated here.';
const given = process.argv.slice(2).filter(arg => arg !== '--');
// One action a run, each option once: --requeue, --release and --reason take a value, and --reason goes with --release alone.
const options = new Map<string, string | true>();
let usable = true;
for (let index = 0; index < given.length && usable; index++) {
  const name = given[index]!, takesValue = ['--requeue', '--release', '--reason'].includes(name), value = given[index + 1];
  usable = (name === '--retry' || takesValue) && !options.has(name) && (!takesValue || (value !== undefined && !value.startsWith('--')));
  if (usable) options.set(name, takesValue ? given[++index]! : true);
}
usable &&= [...options.keys()].filter(name => name !== '--reason').length <= 1 && options.has('--reason') === options.has('--release');
const exportId = String(options.get('--requeue') ?? options.get('--release') ?? ''), reason = String(options.get('--reason') ?? '').trim();
// A retry reaches private storage: without the service's storage setting each due file it claims would fail and wait in backoff.
const storageConfigured = /^\/?[^/]+\/.+/.test(process.env.PRIVATE_OBJECT_DIR ?? '');
const refusal = !usable ? usage
  : exportId && !/^[A-Za-z0-9_-]{1,100}$/.test(exportId) ? "The export ID must be the queued export's ID: letters, digits, hyphens and underscores, at most 100. It is not repeated here."
  // As releaseParkedExportFile requires, checked before the database is reached.
  : options.has('--release') && !/^[^\p{Cc}\u2028\u2029]{1,200}$/u.test(reason) ? 'Give the release a reason of 1 to 200 characters on one line: it is written to the service log.'
  : !process.env.DATABASE_URL ? 'DATABASE_URL is required for the sandbox service cleanup queue.'
  : options.has('--retry') && !storageConfigured ? "Private storage is not configured here (PRIVATE_OBJECT_DIR), so --retry was refused and no file was claimed: a retry that cannot reach storage would push every due file into backoff. Run it where the service's storage settings and credentials are, or leave the files to the service's background worker."
  : undefined;
if (refusal) {
  console.error(refusal);
  process.exitCode = 1;
} else {
  const { closeDatabase, exportCleanupStatus, runExportCleanupPass, parkedExportFiles, requeueParkedExportFile, releaseParkedExportFile } = await import('../../artifacts/api-server/src/lib/valopay-store');
  const { logger } = await import('../../artifacts/api-server/src/lib/logger');
  try {
    // Re-queueing and releasing a parked file change only the queue: neither ever deletes a stored object.
    const retry = options.has('--retry') ? await runExportCleanupPass() : undefined;
    const requeued = options.has('--requeue') ? await requeueParkedExportFile(exportId) : undefined;
    const released = options.has('--release') ? await releaseParkedExportFile(exportId, reason, logger) : undefined;
    const status = await exportCleanupStatus();
    const parkedFiles = status.parked ? await parkedExportFiles() : [];
    console.log(JSON.stringify({ status, ...(parkedFiles.length ? { parkedFiles } : {}), ...(retry ? { retry } : {}), ...(requeued ? { requeued } : {}), ...(released ? { released } : {}) }, null, 2));
    if (status.pending > 0) process.exitCode = 2;
  } catch (error) {
    // The queue's own refusals (no parked file with that ID, a restricted runtime) are fixed sentences; any other failure could quote a connection.
    const status = (error as { status?: unknown }).status;
    console.error([400, 403, 404].includes(status as number) ? (error as Error).message : 'Export cleanup could not be checked. Verify the service database, migration 013 and private storage access.');
    process.exitCode = 1;
  } finally { await closeDatabase(); }
}
