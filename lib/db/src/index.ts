import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;
/** Separate pools are used by the readiness check and disposable rehearsals. */
export { Pool };

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

/** How many connections one API process may hold (VALOPAY_DATABASE_POOL_SIZE, 2 to 100, default 10). One tenant may use at most a third of them for its lenders (the connection gate in the API's lib/repository/core.ts). */
export const poolSize = (() => {
  const configured = process.env.VALOPAY_DATABASE_POOL_SIZE;
  if (configured === undefined || configured === "") return 10;
  const size = /^[0-9]{1,3}$/.test(configured) ? Number(configured) : Number.NaN;
  if (!(size >= 2 && size <= 100)) throw new Error("VALOPAY_DATABASE_POOL_SIZE must be a whole number from 2 to 100.");
  return size;
})();
/** How long a transaction waits for a free connection, or for a new one to open, before it is turned away. */
export const POOL_WAIT_MS = 5_000;

// Statement, lock and idle limits are set per transaction (SET LOCAL), never
// on the connection, so they end with each transaction and also hold behind a
// transaction-mode pooler.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: poolSize, connectionTimeoutMillis: POOL_WAIT_MS });
export const db = drizzle(pool, { schema });

export * from "./schema";
export type { PoolClient } from "pg";
