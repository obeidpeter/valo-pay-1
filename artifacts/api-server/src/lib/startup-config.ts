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
import { createPublicKey, type KeyObject } from "node:crypto";
import { appendFileSync, mkdirSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { BUILD } from "./build-info";

/** What the process is: the web server, or the one-shot close pass, which listens on no port. */
export type StartupPurpose = "server" | "close-pass";
/** The logger's levels (pino's). */
export const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
/** The checked settings a process starts with. */
export interface StartupConfig {
  /** The port the server listens on; null for the close pass. */
  port: number | null;
  /**
   * Whether this process runs the scheduled daily close: VALOPAY_CLOSE_SCHEDULER, on, off or external in any case,
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
/** The PEM armour, and the fixed base64 that opens and closes a 2048-bit RSA public key with the exponent 65537. */
const PEM_HEADER = "-----BEGIN PUBLIC KEY-----", PEM_TRAILER = "-----END PUBLIC KEY-----", RSA_PREFIX = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA", RSA_SUFFIX = "IDAQAB";
/**
 * The modulus Clerk takes from CLERK_JWT_KEY, byte for byte as its loader does (@clerk/backend's loadClerkJwkFromPem,
 * which the package does not export): it removes the line breaks, then the first header, trailer, prefix and suffix,
 * and makes + and / base64url. Nothing else is removed; its runtime's base64 decoding skips white space and quotes.
 */
const clerkModulus = (pem: string) => pem.replace(/\r\n|\n|\r/g, "").replace(PEM_HEADER, "").replace(PEM_TRAILER, "").replace(RSA_PREFIX, "").replace(RSA_SUFFIX, "").replace(/\+/g, "-").replace(/\//g, "_");
/** The RSA public key with this modulus and the exponent 65537 (Clerk's), imported as Clerk imports it: node:crypto reads a JWK as Web Crypto does. */
function rsaKey(modulus: string): KeyObject | undefined {
  try { const key = createPublicKey({ key: { kty: "RSA", n: modulus, e: "AQAB" }, format: "jwk" }); return key.asymmetricKeyType === "rsa" ? key : undefined; } catch { return undefined; }
}
const modulusBytes = (key: KeyObject | undefined) => key && Buffer.from(key.export({ format: "jwk" }).n!, "base64url");
const sameBytes = (a: Buffer | undefined, b: Buffer | undefined) => (a && b ? a.equals(b) : a === b);
const SPACE_NAMES: Record<string, string> = { "\u202f": "a narrow no-break space", "\u205f": "a medium mathematical space" };
/**
 * The characters of a modulus that Clerk misreads: its runtime's base64 decoding keeps only the last byte of a UTF-16
 * unit above U+00FF, so U+202F reads as / and U+205F as _, and a unit ending in = ends the key. Named by code point.
 */
const misreadCharacters = (modulus: string) => [...new Set([...modulus].filter((character) => character.split("").some((unit) => unit.charCodeAt(0) > 0xff && /[A-Za-z0-9+/=_-]/.test(String.fromCharCode(unit.charCodeAt(0) & 0xff)))))]
  .map((character) => `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}${SPACE_NAMES[character] ? ` (${SPACE_NAMES[character]})` : ""}`);
const UNUSABLE_JWT_KEY = "CLERK_JWT_KEY must be the Clerk instance's JWT public key as Clerk shows it with the instance's API keys: a 2048-bit RSA public key in PEM form, from -----BEGIN PUBLIC KEY----- to -----END PUBLIC KEY-----.";
/**
 * Why Clerk could not verify sessions with this CLERK_JWT_KEY, or undefined when it can. The check derives the key as
 * Clerk's loader does and imports it as Clerk's runtime does, then confirms, comparing decoded bytes, that it is the key
 * the value spells (its ASCII base64 alone, and the public key its base64 encodes when it encodes one) and a 2048-bit
 * RSA key. So every form Clerk reads starts: the PEM as Clerk shows it, with any line ends, indented, joined, with
 * spaces for its line breaks, as its body alone or in quotes. A value Clerk cannot use is refused, saying why: \n
 * escapes, a character Clerk misreads, a key Clerk would read as another, or no 2048-bit RSA public key at all.
 */
function jwtKeyProblem(value: string): string | undefined {
  if (value.includes("\\n")) return "CLERK_JWT_KEY holds \\n in place of its line breaks, which Clerk cannot read: give the PEM public key with real line breaks, as Clerk shows it, from -----BEGIN PUBLIC KEY----- to -----END PUBLIC KEY-----.";
  const modulus = clerkModulus(value), read = rsaKey(modulus);
  if (!sameBytes(modulusBytes(read), modulusBytes(rsaKey(modulus.split("").filter((unit) => unit.charCodeAt(0) < 0x80).join(""))))) {
    const misread = misreadCharacters(modulus), names = misread.length > 1 ? `${misread.slice(0, -1).join(", ")} and ${misread.at(-1)}` : misread[0] ?? "a character outside ASCII";
    return `CLERK_JWT_KEY holds ${names}, which Clerk misreads as part of the key, so it would refuse every session: remove ${misread.length > 1 ? "them" : "it"}, or paste the PEM public key again as Clerk shows it.`;
  }
  const details = read?.asymmetricKeyDetails;
  if (details?.modulusLength !== 2048 || details.publicExponent !== 65537n) return UNUSABLE_JWT_KEY;
  // The public key the value's base64 encodes, when it encodes one: Clerk removes the first suffix it finds, which is
  // the key's closing bytes only when its modulus holds none (one key in about 200 million does).
  const base64 = value.replaceAll(PEM_HEADER, "").replaceAll(PEM_TRAILER, "").replace(/[^A-Za-z0-9+/=_-]/g, "");
  let encoded: KeyObject | undefined;
  try { encoded = createPublicKey({ key: Buffer.from(base64, "base64"), format: "der", type: "spki" }); } catch { /* the value holds the modulus alone, or more than a key */ }
  if (encoded?.asymmetricKeyType !== "rsa" || sameBytes(modulusBytes(encoded), modulusBytes(read))) return undefined;
  return base64.indexOf(RSA_SUFFIX) < base64.length - RSA_SUFFIX.length ? `CLERK_JWT_KEY holds a key Clerk reads as another: its base64 holds ${RSA_SUFFIX}, the key's closing bytes, before its end, and Clerk removes the first ${RSA_SUFFIX} it finds, so it would refuse every session. Have Clerk rotate the instance's signing key.` : UNUSABLE_JWT_KEY;
}

/**
 * The sign-in proxy's limits an operator may set (SEC-02, clerkProxyMiddleware.ts), read by the start-up check and by
 * the proxy with this one rule: the requests a minute one client network may send (VALOPAY_CLERK_PROXY_RATE, 60 to
 * 6,000, default 240), its requests at once (VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY, 2 to 64, default 8) and the
 * process's requests at once (VALOPAY_CLERK_PROXY_CONCURRENCY, up to 512), which always leave room for eight networks
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
  const requestsPerMinute = whole("VALOPAY_CLERK_PROXY_RATE", values.rate, 60, 6_000, 240);
  const networkConcurrency = whole("VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY", values.networkConcurrency, 2, 64, 8);
  const least = 8 * networkConcurrency;
  const concurrency = whole("VALOPAY_CLERK_PROXY_CONCURRENCY", values.concurrency, least, 512, least, `a whole number from ${least} to 512, room for eight networks at VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY`);
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
  const pool = given("VALOPAY_DATABASE_POOL_SIZE");
  if (pool !== undefined) {
    // lib/db's own rule, which reads the value again when it loads: at most three digits, so 0010 is refused there too.
    if (/^[0-9]{1,3}$/.test(pool) && wholeNumber(pool, 2, 100)) databasePoolSize = Number(pool);
    else problems.push("VALOPAY_DATABASE_POOL_SIZE must be a whole number from 2 to 100.");
  }
  const logLevel = oneOf("LOG_LEVEL", logLevels, "info");
  const logFormat = given("LOG_FORMAT") === undefined ? null : oneOf("LOG_FORMAT", ["pretty", "json"] as const, "json");
  const nodeEnv = given("NODE_ENV") === undefined ? null : oneOf("NODE_ENV", ["development", "production", "test"] as const, "production");
  // REC-01's switch fails closed: a value that is not on, off or external stops the process rather than scheduling closes.
  const closeScheduler = oneOf("VALOPAY_CLOSE_SCHEDULER", ["on", "off", "external"] as const, "on", true);
  // The store deletes expired sandboxes only for exactly "on"; any other spelling is refused here, not read as off.
  const expiredWorkspaceCleanup = oneOf("VALOPAY_EXPIRED_WORKSPACE_CLEANUP", ["on", "off"] as const, "off");

  const staffAccess = oneOf("VALOPAY_STAFF_ACCESS", ["off", "staging"] as const, "off");
  if (staffAccess === "staging") {
    if (!httpsOrigin(given("VALOPAY_STAFF_ISSUER") ?? "")) problems.push("VALOPAY_STAFF_ISSUER must be the Clerk issuer's HTTPS origin when VALOPAY_STAFF_ACCESS is staging.");
    const origins = (given("VALOPAY_STAFF_ORIGINS") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    if (!origins.length || !origins.every(httpsOrigin)) problems.push("VALOPAY_STAFF_ORIGINS must list one or more HTTPS origins, separated by commas, when VALOPAY_STAFF_ACCESS is staging.");
    // Staff sign in through Clerk: without its secret key no one could, so the server does not start (the close pass signs no one in).
    if (purpose === "server" && given("CLERK_SECRET_KEY") === undefined) problems.push("CLERK_SECRET_KEY is required when VALOPAY_STAFF_ACCESS is staging: without it no one can sign in.");
  }
  // With CLERK_JWT_KEY, Clerk verifies a session here with no call to its Backend API (staff-access.ts clerkOptions).
  // A value it cannot use would refuse every session while the process reads as ready, so the server does not start
  // with one. A staff host needs the key: without it a forged token makes Clerk fetch the instance's keys with the
  // secret key, bounded only by the per-network request limit. The close pass signs no one in.
  if (purpose === "server") {
    const jwtKey = given("CLERK_JWT_KEY");
    const problem = jwtKey === undefined ? (staffAccess === "staging" ? "CLERK_JWT_KEY is required when VALOPAY_STAFF_ACCESS is staging: the Clerk instance's JWT public key, with which staff sessions are verified without a call to Clerk's Backend API." : undefined) : jwtKeyProblem(jwtKey);
    if (problem) problems.push(problem);
  }
  // The origins the console is served at outside staff mode (staff-access.ts appOrigins), when they are given.
  if (!(given("VALOPAY_APP_ORIGINS") ?? "").split(",").map((value) => value.trim()).filter(Boolean).every(httpsOrigin)) {
    problems.push("VALOPAY_APP_ORIGINS must list HTTPS origins, separated by commas, such as https://valopay.example.");
  }
  // The sign-in proxy's limits, read by the proxy with the same rule; the close pass has no proxy.
  if (purpose === "server") problems.push(...clerkProxyTuning({ rate: given("VALOPAY_CLERK_PROXY_RATE"), networkConcurrency: given("VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY"), concurrency: given("VALOPAY_CLERK_PROXY_CONCURRENCY") }).problems);
  const payloadEncryption = oneOf("VALOPAY_PAYLOAD_ENCRYPTION", ["off", "kms"] as const, "off");
  if (payloadEncryption === "kms" && !KMS_KEY.test(given("VALOPAY_KMS_KEY") ?? "")) problems.push("VALOPAY_KMS_KEY must be a Cloud KMS CryptoKey name (projects/…/locations/…/keyRings/…/cryptoKeys/…) when VALOPAY_PAYLOAD_ENCRYPTION is kms.");
  if (!(given("VALOPAY_KMS_PREVIOUS_KEYS") ?? "").split(",").map((value) => value.trim()).filter(Boolean).every((key) => KMS_KEY.test(key))) {
    problems.push("VALOPAY_KMS_PREVIOUS_KEYS must list Cloud KMS CryptoKey names, separated by commas.");
  }
  const runtimeIsolation = oneOf("VALOPAY_RUNTIME_ISOLATION", ["off", "staging"] as const, "off");
  const financialProjection = oneOf("VALOPAY_FINANCIAL_PROJECTION", ["off", "staging"] as const, "off");
  if (financialProjection === 'staging' && !/^valopay_finance_staging_[a-z0-9_]{1,32}$/.test(given('VALOPAY_FINANCIAL_PROJECTION_SCHEMA') ?? '')) {
    problems.push('VALOPAY_FINANCIAL_PROJECTION_SCHEMA must name an isolated valopay_finance_staging_<suffix> schema when VALOPAY_FINANCIAL_PROJECTION is staging.');
  }
  if (runtimeIsolation === "staging") {
    const needs = "when VALOPAY_RUNTIME_ISOLATION is staging";
    if (!RUNTIME_SCHEMA.test(given("VALOPAY_RUNTIME_SCHEMA") ?? "")) problems.push(`VALOPAY_RUNTIME_SCHEMA must name a valopay_runtime_staging_<suffix> schema ${needs}.`);
    if (!RUNTIME_ROLE.test(given("VALOPAY_RUNTIME_ROLE") ?? "")) problems.push(`VALOPAY_RUNTIME_ROLE must be the restricted login's name (3 to 63 lower-case letters, digits and underscores) ${needs}.`);
    if (staffAccess !== "staging") problems.push(`VALOPAY_STAFF_ACCESS must be staging ${needs}.`);
    if (payloadEncryption !== "kms") problems.push(`VALOPAY_PAYLOAD_ENCRYPTION must be kms ${needs}.`);
    if (!/^org_[A-Za-z0-9]+$/.test(given("VALOPAY_RUNTIME_SERVICE_ORG") ?? "")) problems.push(`VALOPAY_RUNTIME_SERVICE_ORG must be the service member's Clerk organisation ID (org_…) ${needs}.`);
    if (!/^user_[A-Za-z0-9]+$/.test(given("VALOPAY_RUNTIME_SERVICE_USER") ?? "")) problems.push(`VALOPAY_RUNTIME_SERVICE_USER must be the service member's Clerk user ID (user_…) ${needs}.`);
  }
  if (problems.length) throw new InvalidConfiguration(problems);
  return { port, closeScheduler, logLevel, logFormat, nodeEnv, databasePoolSize, expiredWorkspaceCleanup, staffAccess, runtimeIsolation, payloadEncryption };
}

/** The fatal line for a configuration that cannot start, in the logger's shape and fields. */
export function invalidConfigurationLine(problems: string[], purpose: StartupPurpose, time = Date.now()): string {
  return JSON.stringify({
    level: 60, time, pid: process.pid, hostname: hostname(), service: "valopay-api", build: BUILD,
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
