/**
 * For the suites that build throwaway databases beside the one in
 * DATABASE_URL (the migration rehearsals): they run against any loopback
 * PostgreSQL whose login can create databases, and elsewhere skip, saying
 * why, except under CI, where they must run and a skip is a failure. A
 * throwaway database is named after the database in DATABASE_URL, so on a
 * shared server everything a run creates starts with the name it was given.
 */
import { randomBytes } from "node:crypto";

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** Ends the suite without running it: a skip that says why, or a failure under CI. */
export function skipSuite(suite: string, reason: string): never {
  if (process.env["CI"]) {
    console.error(`${suite} cannot run: ${reason}`);
    process.exit(1);
  }
  console.log(`${suite} skipped: ${reason}`);
  process.exit(0);
}

/** Before the pool is loaded: the server must be a loopback one. */
export function requireLoopback(suite: string, connection: URL): void {
  if (!LOOPBACK.includes(connection.hostname)) skipSuite(suite, "it creates throwaway databases beside DATABASE_URL, so it runs only against a loopback PostgreSQL (127.0.0.1, localhost or ::1).");
}

/** The login must be able to create databases; otherwise the pool is ended and the suite skipped. */
export async function requireCreateDatabase(suite: string, pool: { query(sql: string): Promise<{ rows: Array<{ allowed?: boolean }> }>; end(): Promise<void> }): Promise<void> {
  const allowed = (await pool.query("SELECT rolcreatedb OR rolsuper AS allowed FROM pg_roles WHERE rolname = current_user")).rows[0]?.allowed === true;
  if (allowed) return;
  await pool.end();
  skipSuite(suite, "the login in DATABASE_URL cannot create databases (it needs CREATEDB), and the rehearsal builds a throwaway one.");
}

/** A throwaway database's name: the database in DATABASE_URL (or valo_pay_1_test, when that name is not plain), what it is for and a random suffix. */
export function throwawayDatabaseName(connection: URL, purpose: "index_rehearsal" | "pilot_rehearsal" | "push_rehearsal"): string {
  const base = decodeURIComponent(connection.pathname.slice(1));
  const name = `${/^[a-z][a-z0-9_]{0,29}$/.test(base) ? base : "valo_pay_1_test"}_${purpose}_${randomBytes(8).toString("hex")}`;
  // Checked before it is written into SQL: only these characters, and within PostgreSQL's 63-byte names.
  if (!/^[a-z][a-z0-9_]*_(?:index|pilot|push)_rehearsal_[a-f0-9]{16}$/.test(name) || name.length > 63) throw new Error("The throwaway database name is not the expected shape.");
  return name;
}
