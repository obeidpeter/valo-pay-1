/** Operator-only aggregate status and bounded retry. Uses the sandbox service's database and storage identity. */
export {};
const args = process.argv.slice(2).filter(arg => arg !== '--');
if (args.some(arg => arg !== '--retry') || args.length > 1) {
  console.error('Use: pnpm run check:export-cleanup [--retry]. No option values are accepted.');
  process.exitCode = 1;
} else if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required for the sandbox service cleanup queue.');
  process.exitCode = 1;
} else {
  const { closeDatabase, exportCleanupStatus, runExportCleanupPass } = await import('../../artifacts/api-server/src/lib/valopay-store');
  try {
    const retry = args.includes('--retry') ? await runExportCleanupPass() : undefined;
    const status = await exportCleanupStatus();
    console.log(JSON.stringify({ status, ...(retry ? { retry } : {}) }, null, 2));
    if (status.pending > 0) process.exitCode = 2;
  } catch {
    console.error('Export cleanup could not be checked. Verify the service database, migration 013 and private storage access.');
    process.exitCode = 1;
  } finally { await closeDatabase(); }
}
