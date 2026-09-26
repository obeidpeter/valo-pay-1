import { Router, type IRouter, type RequestHandler } from "express";
import { HealthCheckResponse, ReadinessCheckResponse } from "@workspace/api-zod";
import { BUILD, STARTED_AT } from "../lib/build-info";
import { schedulerStatus } from "../lib/close-scheduler";
import { pingDatabase, type DatabaseReadiness } from "../lib/valopay-store";
import { contractAnswer } from "../lib/contract";
import { clientNetwork, createWindowCounter, refuseRequest } from "../lib/request-limits";
import { routerOptions } from "./router-options";

const router: IRouter = Router(routerOptions);

/**
 * The readiness answer for one check: 200 when the database answers and holds
 * every table, column, unique index and check constraint this build needs;
 * otherwise 503, degraded. A read index a migration adds that is missing
 * leaves the answer ready, marked `indexes_missing`: every request still
 * works, only slower, and taking every instance out of rotation for it would
 * be an outage. The answer says only which state; the names of what is
 * missing, and a connection error, stay in the log.
 */
export function readinessAnswer(database: DatabaseReadiness) {
  const ready = database.status === "ok" && (database.schema.status === "ok" || database.schema.status === "indexes_missing");
  return { httpStatus: ready ? 200 : 503, body: contractAnswer(ReadinessCheckResponse, { status: ready ? "ok" : "degraded", build: BUILD, checks: { database: { status: database.status, latencyMs: database.latencyMs }, schema: { status: database.schema.status } } }) };
}

let reportedIndexes = "";
/**
 * The warning line a readiness check writes, if any: every time the database
 * does not answer, lacks a table, column, unique index or check constraint,
 * or holds a guard this build replaced;
 * for missing read indexes, once until what is missing changes, so a host
 * polling readiness every few seconds does not write the same warning each
 * time.
 */
export function readinessWarning(database: DatabaseReadiness): { fields: Record<string, unknown>; message: string } | undefined {
  const indexes = database.status === "ok" && database.schema.status === "indexes_missing" ? database.schema.missing.join("\n") : "";
  const repeated = indexes === reportedIndexes;
  reportedIndexes = indexes;
  // Which schema was read: the isolated runtime schema, or the tables the connection's search path reaches.
  const schema = database.searched ?? "search_path";
  if (database.status !== "ok") return { fields: { event: "readiness.failed", latencyMs: database.latencyMs, reason: database.error }, message: "Readiness check failed: the database did not answer" };
  if (database.schema.status === "incomplete") return { fields: { event: "readiness.failed", latencyMs: database.latencyMs, reason: "schema incomplete", schema, missing: database.schema.missing }, message: "Readiness check failed: the database lacks a table, column, unique index or check constraint this build needs, or holds a guard it replaced" };
  if (indexes && !repeated) return { fields: { event: "readiness.indexes_missing", schema, missing: database.schema.missing }, message: "Ready, but the database lacks an index this build expects: some reads are slower until its migration is applied" };
  return undefined;
}

/** How long a finished readiness check answers for: a burst of probes shares one database round trip. */
export const READINESS_REUSE_MS = 1_000;
/**
 * Readiness checks coalesced: while one runs, every caller waits for it, and
 * for READINESS_REUSE_MS after it finishes its answer is reused, so a burst
 * of probes makes one round trip instead of queueing on the check's single
 * connection until they time out. Its warning, if any, is written once per
 * check, on the line of the request that started it.
 */
export function createReadinessCheck(ping: () => Promise<DatabaseReadiness> = pingDatabase, reuseMs = READINESS_REUSE_MS, clock: () => number = Date.now) {
  let latest: { result: Promise<DatabaseReadiness>; settledAt?: number } | undefined;
  return (log?: { warn(fields: object, message: string): void }): Promise<DatabaseReadiness> => {
    if (latest && (latest.settledAt === undefined || clock() - latest.settledAt < reuseMs)) return latest.result;
    const check: { result: Promise<DatabaseReadiness>; settledAt?: number } = {
      result: ping().then((database) => {
        check.settledAt = clock();
        const warning = readinessWarning(database);
        if (warning) log?.warn(warning.fields, warning.message);
        return database;
      }),
    };
    latest = check;
    return check.result;
  };
}
const readiness = createReadinessCheck();

/** Health checks one client network may make a minute, both addresses together; a host probe makes a few. */
export const HEALTH_CHECK_LIMIT = 120;
const healthChecks = createWindowCounter({ limit: HEALTH_CHECK_LIMIT, windowMs: 60_000 });
/** The health addresses sit outside /api/v1 and its limits, and ahead of sign-in, so they carry their own per-network limit. */
const limited: RequestHandler = (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  const key = clientNetwork(req.ip);
  if (!healthChecks.take(key)) return refuseRequest(req, res, healthChecks, key, "health", "Too many health checks from this network. Try again in one minute.");
  next();
};

/**
 * Two questions a host or a person can ask without a sandbox or a sign-in.
 * Liveness (/healthz): the process answers, and says which build it is, how
 * long it has been up and what its scheduler is doing, with the lenders still
 * owed a close as its latest pass counted them. It never touches the
 * database, so a database outage does not read as a dead process. Readiness
 * (/readyz): one bounded round trip to the database on its own connection, so
 * a busy request pool does not read as an unreachable database, which also
 * reads whether the database holds the tables and columns this build needs,
 * so a migration not yet applied is not ready; 503 while either fails, so
 * traffic can be held back from an instance that cannot serve it. Neither
 * needs Clerk: app.ts mounts them before sign-in.
 */
router.get("/healthz", limited, (_req, res) => {
  res.json(contractAnswer(HealthCheckResponse, { status: "ok", build: BUILD, startedAt: STARTED_AT, uptimeSeconds: Math.round(process.uptime()), scheduler: schedulerStatus() }));
});

router.get("/readyz", limited, async (req, res) => {
  const answer = readinessAnswer(await readiness(req.log));
  res.status(answer.httpStatus).json(answer.body);
});

export default router;
