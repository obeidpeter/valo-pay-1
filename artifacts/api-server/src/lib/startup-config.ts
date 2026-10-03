/**
 * The settings a process of this API starts with, read from the environment
 * once and checked together before any other module reads them. A value
 * outside its rule ends the process with one structured fatal line that names
 * each setting to correct, never its value (which may be a credential),
 * instead of a bare stack from whichever module read it first, a crash on the
 * first request, a safety switch that fails open or a worker that logs the
 * same error at every poll. The modules that use these settings still read
 * the environment themselves; this check accepts exactly what they accept, so
 * nothing it passes is read differently there, Clerk's JWT key included.
 */
import { appendFileSync, mkdirSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { BUILD } from "./build-info";
import { productIdentityProblems } from "./product-identity";
import { jwtKeyProblem } from "./clerk-jwt-key";

/** What the process is: the web server, or the one-shot close pass, which listens on no port. */
export type StartupPurpose = "server" | "close-pass";
/** The logger's levels (pino's). */
export const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
/** The checked settings a process starts with. */
export interface StartupConfig {
  /** The port the server listens on; null for the close pass. */
  port: number | null;
  /**
   * Whether this process runs the scheduled daily close: VALO_PAY_1_CLOSE_SCHEDULER, on, off or external in any case,
   * default on. Neither off nor external runs it; external says a separate scheduled job does (the one-shot close
   * pass), so a close it misses is still reported as missed.
   */
  closeScheduler: "on" | "off" | "external";
  logLevel: (typeof logLevels)[number];
  logFormat: "pretty" | "json" | null;
  nodeEnv: "development" | "production" | "test" | null;
  databasePoolSize: number;
  expiredWorkspaceCleanup: "on" | "off";
  staffAccess: "off" | "staging";
  runtimeIsolation: "off" | "staging";
  payloadEncryption: "off" | "kms";
}

/** Every setting that breaks its rule, in the words the fatal line gives them. */
export class InvalidConfiguration extends Error {
  constructor(readonly problems: string[]) { super(problems.join(" ")); }
}

// The rules runtime-isolation.ts, protected-payloads.ts and pilot-access.ts apply. Those modules load the
// database pool or the key client, so this one repeats their patterns rather than importing them.
const RUNTIME_SCHEMA = /^valopay_runtime_(staging|test)_[a-z0-9_]+$/;
const RUNTIME_ROLE = /^[a-z][a-z0-9_]{2,62}$/;
const KMS_KEY = /^projects\/[a-zA-Z0-9_-]+\/locations\/[a-zA-Z0-9_-]+\/keyRings\/[a-zA-Z0-9_-]+\/cryptoKeys\/[a-zA-Z0-9_-]+$/;
const httpsOrigin = (value: string) => { try { const url = new URL(value); return url.protocol === "https:" && url.origin === value; } catch { return false; } };
const words = (values: readonly string[]) => values.length === 1 ? values[0]! : `${values.slice(0, -1).join(", ")} or ${values.at(-1)}`;
/**
 * The sign-in proxy's limits an operator may set (SEC-02, clerkProxyMiddleware.ts), read by the start-up check and by
 * the proxy with this one rule: the requests a minute one client network may send (VALO_PAY_1_CLERK_PROXY_RATE, 60 to
 * 6,000, default 240), its requests at once (VALO_PAY_1_CLERK_PROXY_NETWORK_CONCURRENCY, 2 to 64, default 8) and the
 * process's requests at once (VALO_PAY_1_CLERK_PROXY_CONCURRENCY, up to 512), which always leave room for eight networks
 * at their limit, so a handful of networks cannot take every slot: eight times the network's limit when unset, and
 * refused below it. An empty value counts as unset; a problem names the setting, never its value.
 */
export function clerkProxyTuning(values: { rate?: string; networkConcurrency?: string; concurrency?: string }): { limits: { requestsPerMinute: number; networkConcurrency: number; concurrency: number }; problems: string[] } {
  const problems: string[] = [];
  const whole = (name: string, value: string | undefined, low: number, high: number, fallback: number, rule = `a whole number from ${low} to ${high}`) => {
    if (value === undefined || value === "") return fallback;
    if (/^[0-9]{1,6}$/.test(value) && Number(value) >= low && Number(value) <= high) return Number(value);
    problems.push(`${name} must be ${rule}.`);
    return fallback;
  };
  const requestsPerMinute = whole("VALO_PAY_1_CLERK_PROXY_RATE", values.rate, 60, 6_000, 240);
  const networkConcurrency = whole("VALO_PAY_1_CLERK_PROXY_NETWORK_CONCURRENCY", values.networkConcurrency, 2, 64, 8);
  const least = 8 * networkConcurrency;
  const concurrency = whole("VALO_PAY_1_CLERK_PROXY_CONCURRENCY", values.concurrency, least, 512, least, `a whole number from ${least} to 512, room for eight networks at VALO_PAY_1_CLERK_PROXY_NETWORK_CONCURRENCY`);
  return { limits: { requestsPerMinute, networkConcurrency, concurrency }, problems };
}

/**
 * Reads and checks the settings; throws InvalidConfiguration naming every
 * setting that breaks its rule. An empty value counts as unset.
 */
export function readStartupConfig(env: Record<string, string | undefined>, purpose: StartupPurpose): StartupConfig {
  const problems: string[] = [];
  const given = (name: string) => { const value = env[name]; return value === undefined || value === "" ? undefined : value; };
  function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T, anyCase = false): T {
    const raw = given(name);
    if (raw === undefined) return fallback;
    const value = anyCase ? raw.toLowerCase() : raw;
    if ((allowed as readonly string[]).includes(value)) return value as T;
    problems.push(`${name} must be ${words(allowed)}${anyCase ? " (in any case)" : ""}.`);
    return fallback;
  }
  const wholeNumber = (value: string, low: number, high: number) => /^[0-9]{1,6}$/.test(value) && Number(value) >= low && Number(value) <= high;

  let port: number | null = null;
  if (purpose === "server") {
    const raw = given("PORT");
    if (raw === undefined) problems.push("PORT is required: the port this server listens on.");
    else if (!wholeNumber(raw, 1, 65535)) problems.push("PORT must be a whole number from 1 to 65535.");
    else port = Number(raw);
  }
  // Only the form is checked, and the value is never repeated; the repository alone connects (check-db-boundary.mjs).
  const database = env.DATABASE_URL || undefined;
  if (database === undefined) problems.push("DATABASE_URL is required: the PostgreSQL connection URL.");
  else {
    let protocol = "";
    try { protocol = new URL(database).protocol; } catch { /* named below, without the value */ }
    if (protocol !== "postgres:" && protocol !== "postgresql:") problems.push("DATABASE_URL must be a postgres:// or postgresql:// connection URL.");
  }
  let databasePoolSize = 10;
  const pool = given("VALO_PAY_1_DATABASE_POOL_SIZE");
  if (pool !== undefined) {
    // lib/db's own rule, which reads the value again when it loads: at most three digits, so 0010 is refused there too.
    if (/^[0-9]{1,3}$/.test(pool) && wholeNumber(pool, 2, 100)) databasePoolSize = Number(pool);
    else problems.push("VALO_PAY_1_DATABASE_POOL_SIZE must be a whole number from 2 to 100.");
  }
  const logLevel = oneOf("LOG_LEVEL", logLevels, "info");
  const logFormat = given("LOG_FORMAT") === undefined ? null : oneOf("LOG_FORMAT", ["pretty", "json"] as const, "json");
  const nodeEnv = given("NODE_ENV") === undefined ? null : oneOf("NODE_ENV", ["development", "production", "test"] as const, "production");
  // REC-01's switch fails closed: a value that is not on, off or external stops the process rather than scheduling closes.
  const closeScheduler = oneOf("VALO_PAY_1_CLOSE_SCHEDULER", ["on", "off", "external"] as const, "on", true);
  // The store deletes expired sandboxes only for exactly "on"; any other spelling is refused here, not read as off.
  const expiredWorkspaceCleanup = oneOf("VALO_PAY_1_EXPIRED_WORKSPACE_CLEANUP", ["on", "off"] as const, "off");

  const staffAccess = oneOf("VALO_PAY_1_STAFF_ACCESS", ["off", "staging"] as const, "off");
  if (staffAccess === "staging") {
    if (!httpsOrigin(given("VALO_PAY_1_STAFF_ISSUER") ?? "")) problems.push("VALO_PAY_1_STAFF_ISSUER must be the Clerk issuer's HTTPS origin when VALO_PAY_1_STAFF_ACCESS is staging.");
    const origins = (given("VALO_PAY_1_STAFF_ORIGINS") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    if (!origins.length || !origins.every(httpsOrigin)) problems.push("VALO_PAY_1_STAFF_ORIGINS must list one or more HTTPS origins, separated by commas, when VALO_PAY_1_STAFF_ACCESS is staging.");
    // Staff sign in through Clerk: without its secret key no one could, so the server does not start (the close pass signs no one in).
    if (purpose === "server" && given("CLERK_SECRET_KEY") === undefined) problems.push("CLERK_SECRET_KEY is required when VALO_PAY_1_STAFF_ACCESS is staging: without it no one can sign in.");
  }
  // With CLERK_JWT_KEY, Clerk verifies a session here with no call to its Backend API (staff-access.ts clerkOptions).
  // A value it cannot use would refuse every session while the process reads as ready, so the server does not start
  // with one. A staff host needs the key: without it a forged token makes Clerk fetch the instance's keys with the
  // secret key, bounded only by the per-network request limit. The close pass signs no one in.
  if (purpose === "server") {
    const jwtKey = given("CLERK_JWT_KEY");
    const problem = jwtKey === undefined ? (staffAccess === "staging" ? "CLERK_JWT_KEY is required when VALO_PAY_1_STAFF_ACCESS is staging: the Clerk instance's JWT public key, with which staff sessions are verified without a call to Clerk's Backend API." : undefined) : jwtKeyProblem(jwtKey);
    if (problem) problems.push(problem);
  }
  // The origins the console is served at outside staff mode (staff-access.ts appOrigins), when they are given.
  if (!(given("VALO_PAY_1_APP_ORIGINS") ?? "").split(",").map((value) => value.trim()).filter(Boolean).every(httpsOrigin)) {
    problems.push("VALO_PAY_1_APP_ORIGINS must list HTTPS origins, separated by commas, such as https://valo-pay-1.example.");
  }
  // The sign-in proxy's limits, read by the proxy with the same rule; the close pass has no proxy.
  if (purpose === "server") problems.push(...clerkProxyTuning({ rate: given("VALO_PAY_1_CLERK_PROXY_RATE"), networkConcurrency: given("VALO_PAY_1_CLERK_PROXY_NETWORK_CONCURRENCY"), concurrency: given("VALO_PAY_1_CLERK_PROXY_CONCURRENCY") }).problems);
  const payloadEncryption = oneOf("VALO_PAY_1_PAYLOAD_ENCRYPTION", ["off", "kms"] as const, "off");
  if (payloadEncryption === "kms" && !KMS_KEY.test(given("VALO_PAY_1_KMS_KEY") ?? "")) problems.push("VALO_PAY_1_KMS_KEY must be a Cloud KMS CryptoKey name (projects/…/locations/…/keyRings/…/cryptoKeys/…) when VALO_PAY_1_PAYLOAD_ENCRYPTION is kms.");
  if (!(given("VALO_PAY_1_KMS_PREVIOUS_KEYS") ?? "").split(",").map((value) => value.trim()).filter(Boolean).every((key) => KMS_KEY.test(key))) {
    problems.push("VALO_PAY_1_KMS_PREVIOUS_KEYS must list Cloud KMS CryptoKey names, separated by commas.");
  }
  const runtimeIsolation = oneOf("VALO_PAY_1_RUNTIME_ISOLATION", ["off", "staging"] as const, "off");
  const financialProjection = oneOf("VALO_PAY_1_FINANCIAL_PROJECTION", ["off", "staging"] as const, "off");
  if (financialProjection === 'staging' && !/^valopay_finance_staging_[a-z0-9_]{1,32}$/.test(given('VALO_PAY_1_FINANCIAL_PROJECTION_SCHEMA') ?? '')) {
    problems.push('VALO_PAY_1_FINANCIAL_PROJECTION_SCHEMA must name an isolated valopay_finance_staging_<suffix> schema when VALO_PAY_1_FINANCIAL_PROJECTION is staging.');
  }
  if (runtimeIsolation === "staging") {
    const needs = "when VALO_PAY_1_RUNTIME_ISOLATION is staging";
    if (!RUNTIME_SCHEMA.test(given("VALO_PAY_1_RUNTIME_SCHEMA") ?? "")) problems.push(`VALO_PAY_1_RUNTIME_SCHEMA must name a valopay_runtime_staging_<suffix> schema ${needs}.`);
    if (!RUNTIME_ROLE.test(given("VALO_PAY_1_RUNTIME_ROLE") ?? "")) problems.push(`VALO_PAY_1_RUNTIME_ROLE must be the restricted login's name (3 to 63 lower-case letters, digits and underscores) ${needs}.`);
    if (staffAccess !== "staging") problems.push(`VALO_PAY_1_STAFF_ACCESS must be staging ${needs}.`);
    if (payloadEncryption !== "kms") problems.push(`VALO_PAY_1_PAYLOAD_ENCRYPTION must be kms ${needs}.`);
    if (!/^org_[A-Za-z0-9]+$/.test(given("VALO_PAY_1_RUNTIME_SERVICE_ORG") ?? "")) problems.push(`VALO_PAY_1_RUNTIME_SERVICE_ORG must be the service member's Clerk organisation ID (org_…) ${needs}.`);
    if (!/^user_[A-Za-z0-9]+$/.test(given("VALO_PAY_1_RUNTIME_SERVICE_USER") ?? "")) problems.push(`VALO_PAY_1_RUNTIME_SERVICE_USER must be the service member's Clerk user ID (user_…) ${needs}.`);
  }
  problems.push(...productIdentityProblems(env));
  if (problems.length) throw new InvalidConfiguration(problems);
  return { port, closeScheduler, logLevel, logFormat, nodeEnv, databasePoolSize, expiredWorkspaceCleanup, staffAccess, runtimeIsolation, payloadEncryption };
}

/** The fatal line for a configuration that cannot start, in the logger's shape and fields. */
export function invalidConfigurationLine(problems: string[], purpose: StartupPurpose, time = Date.now()): string {
  return JSON.stringify({
    level: 60, time, pid: process.pid, hostname: hostname(), service: "valo-pay-1-api", build: BUILD,
    event: "config.invalid", purpose, problems,
    msg: `Not started: ${problems.length === 1 ? "one setting needs" : `${problems.length} settings need`} correcting`,
  });
}

/**
 * The checked settings, or, when one breaks its rule, one fatal line where the
 * log goes (LOG_FILE, else stdout) and exit status 1. Called by the module
 * each entry point imports first, before any module that reads a setting.
 */
export function startupConfigOrExit(purpose: StartupPurpose, env: Record<string, string | undefined> = process.env): StartupConfig {
  try {
    return readStartupConfig(env, purpose);
  } catch (error) {
    if (!(error instanceof InvalidConfiguration)) throw error;
    const line = `${invalidConfigurationLine(error.problems, purpose)}\n`;
    const file = env["LOG_FILE"];
    try {
      if (file) { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, line); } else writeSync(1, line);
    } catch { writeSync(2, line); }
    process.exit(1);
  }
}
