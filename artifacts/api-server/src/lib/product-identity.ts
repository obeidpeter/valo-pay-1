/** Deployment bindings are reviewed non-secret identifiers, never credentials. Changing
 * an environment variable name alone does not separate two products' resources. */
import { createHash } from "node:crypto";
import { clerkPublicKey } from "./clerk-jwt-key";

export const APPLICATION_ID = "valo-pay-1";
/** Immutable provider identity retained exclusively by this generation. Checked against product-identity.json in CI. */
export const RETAINED_REPLIT_ID = "da98915e-a44c-4f6e-af96-a37614f3a217";
export const RETAINED_ORIGIN = "https://valo-pay.replit.app";
export const deploymentEnvironments = ["development", "test", "staging", "production"] as const;
export type DeploymentEnvironment = (typeof deploymentEnvironments)[number];
type Environment = Record<string, string | undefined>;
export interface ResourceBindings {
  applicationId: typeof APPLICATION_ID;
  environment: DeploymentEnvironment;
  deploymentId: string;
  origins: string[];
  database: { targetSha256: string; database: string; user: string; schema: string };
  storagePrivateDirectory: string | null;
  authentication: { issuer: string; jwtPublicKeySha256: string; publishableKeySha256: string; secretKeySha256: string } | null;
  kms: { activeKey: string; previousKeys: string[] } | null;
  paystackTestKeySha256: string | null;
}
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0;
const origin = (value: unknown): value is string => { try { return typeof value === "string" && new URL(value).protocol === "https:" && new URL(value).origin === value; } catch { return false; } };
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(nonempty);
const list = (value: string | undefined) => (value || "").split(",").map(item => item.trim()).filter(Boolean);
const sameList = (a: string[], b: string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());

/** Node's production mode and provider deployment marker cannot opt out by declaring development. */
export const bindingRequired = (env: Environment): boolean => env.NODE_ENV === "production" || Boolean(env.REPLIT_DEPLOYMENT && env.REPLIT_DEPLOYMENT !== "0") || ["staging", "production"].includes(env.VALO_PAY_1_ENVIRONMENT || "");
export function deploymentEnvironment(env: Environment = process.env): DeploymentEnvironment {
  const value = env.VALO_PAY_1_ENVIRONMENT;
  if ((deploymentEnvironments as readonly unknown[]).includes(value)) return value as DeploymentEnvironment;
  if (!value && !bindingRequired(env)) return env.NODE_ENV === "test" ? "test" : "development";
  throw new Error("VALO_PAY_1_ENVIRONMENT must explicitly identify the deployment environment.");
}

/** A digest of the actual URL target, excluding its password and TLS credentials. A query override is refused. */
export function databaseTarget(connection: string): { targetSha256: string; database: string; user: string } {
  try {
    const url = new URL(connection);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1) || !url.username) throw new Error();
    if ([...url.searchParams.keys()].some(key => ["host", "hostaddr", "port", "user", "database", "dbname", "options", "service"].includes(key.toLowerCase()))) throw new Error();
    const target = { hostname: url.hostname.toLowerCase(), port: url.port || "5432", database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username) };
    return { targetSha256: sha256(JSON.stringify(target)), database: target.database, user: target.user };
  } catch { throw new Error("DATABASE_URL must identify one explicit PostgreSQL host, database and user without target or search-path overrides."); }
}
export function publicKeyFingerprint(value: string): string {
  try { return sha256(clerkPublicKey(value).export({ type: "spki", format: "der" })); }
  catch { throw new Error("CLERK_JWT_KEY must be a usable public key for the reviewed authentication binding."); }
}
/** Fingerprinting a high-entropy provider key detects accidental credential reuse without reporting it. */
export const credentialFingerprint = (value: string): string => sha256(value);
export function clerkIssuer(publishableKey: string): string | undefined {
  if (!/^pk_(test|live)_/.test(publishableKey)) return undefined;
  try {
    const host = Buffer.from(publishableKey.replace(/^pk_(test|live)_/, ""), "base64").toString("utf8");
    if (!host.endsWith("$") || !/^[a-zA-Z0-9.-]+\$$/.test(host)) return undefined;
    return new URL(`https://${host.slice(0, -1)}`).origin;
  } catch { return undefined; }
}
export function readResourceBindings(env: Environment): ResourceBindings | undefined {
  if (!env.VALO_PAY_1_RESOURCE_BINDINGS) return undefined;
  let value: unknown;
  try { value = JSON.parse(env.VALO_PAY_1_RESOURCE_BINDINGS); } catch { throw new Error("VALO_PAY_1_RESOURCE_BINDINGS must contain the reviewed non-secret JSON resource bindings."); }
  if (!object(value) || value.applicationId !== APPLICATION_ID || !(deploymentEnvironments as readonly unknown[]).includes(value.environment) || !nonempty(value.deploymentId)
    || !strings(value.origins) || !value.origins.length || !value.origins.every(origin) || !object(value.database) || !hash(value.database.targetSha256)
    || !nonempty(value.database.database) || !nonempty(value.database.user) || !nonempty(value.database.schema)
    || !(value.storagePrivateDirectory === null || nonempty(value.storagePrivateDirectory))
    || !(value.authentication === null || (object(value.authentication) && origin(value.authentication.issuer) && hash(value.authentication.jwtPublicKeySha256) && hash(value.authentication.publishableKeySha256) && hash(value.authentication.secretKeySha256)))
    || !(value.kms === null || (object(value.kms) && nonempty(value.kms.activeKey) && strings(value.kms.previousKeys)))
    || !(value.paystackTestKeySha256 === null || hash(value.paystackTestKeySha256))) {
    throw new Error("VALO_PAY_1_RESOURCE_BINDINGS must identify Valo Pay 1 and every reviewed deployment resource; placeholders and incomplete bindings are refused.");
  }
  return value as unknown as ResourceBindings;
}

/** All errors identify settings only, never the supplied identifiers, URLs or credentials. */
export function productIdentityProblems(env: Environment): string[] {
  const problems: string[] = [];
  if (env.VALO_PAY_1_LEGACY_COOKIE_ORIGIN || env.VALO_PAY_1_LEGACY_COOKIE_UNTIL) {
    const deadline = Date.parse(env.VALO_PAY_1_LEGACY_COOKIE_UNTIL || "");
    if (env.VALO_PAY_1_LEGACY_COOKIE_ORIGIN !== RETAINED_ORIGIN || !Number.isFinite(deadline) || deadline > Date.now() + 30 * 86400_000) problems.push("Legacy sandbox migration requires the exact retained HTTPS origin and an explicit VALO_PAY_1_LEGACY_COOKIE_UNTIL deadline no more than 30 days ahead.");
  }
  const legacy = Object.keys(env).filter(key => key.startsWith("VALOPAY_") && env[key]);
  if (legacy.length) problems.push("Legacy VALOPAY_ settings are present. Move the reviewed settings to VALO_PAY_1_ names and remove the legacy keys; no fallback is accepted.");
  let environment: DeploymentEnvironment;
  try { environment = deploymentEnvironment(env); } catch (error) { problems.push((error as Error).message); return problems; }
  let expected: ResourceBindings | undefined;
  try { expected = readResourceBindings(env); } catch (error) { problems.push((error as Error).message); return problems; }
  if (!expected) {
    if (bindingRequired(env)) problems.push("VALO_PAY_1_RESOURCE_BINDINGS is required before this deployment may access data or start workers.");
    return problems;
  }
  if (expected.environment !== environment) problems.push("VALO_PAY_1_RESOURCE_BINDINGS.environment differs from VALO_PAY_1_ENVIRONMENT.");
  if (env.VALO_PAY_1_LEGACY_COOKIE_ORIGIN && !expected.origins.includes(RETAINED_ORIGIN)) problems.push("The legacy-cookie transition origin must remain an explicitly reviewed deployment origin until the transition is retired.");
  if (bindingRequired(env) && !["staging", "production"].includes(environment)) problems.push("A deployed or production-mode process must use the staging or production environment binding.");
  if (expected.deploymentId !== RETAINED_REPLIT_ID || env.REPL_ID !== expected.deploymentId) problems.push("REPL_ID does not match the retained, reviewed Valo Pay 1 deployment identity.");
  try {
    const actual = databaseTarget(env.DATABASE_URL || "");
    if (actual.targetSha256 !== expected.database.targetSha256 || actual.database !== expected.database.database || actual.user !== expected.database.user) problems.push("DATABASE_URL does not match the reviewed Valo Pay 1 database target.");
  } catch (error) { problems.push((error as Error).message); }
  const schema = env.VALO_PAY_1_RUNTIME_ISOLATION === "staging" ? env.VALO_PAY_1_RUNTIME_SCHEMA : "public";
  if (schema !== expected.database.schema) problems.push("The runtime schema differs from VALO_PAY_1_RESOURCE_BINDINGS.database.schema.");
  const configuredOrigins = list(env.VALO_PAY_1_STAFF_ACCESS === "staging" ? env.VALO_PAY_1_STAFF_ORIGINS : env.VALO_PAY_1_APP_ORIGINS);
  if (!configuredOrigins.length || !sameList(configuredOrigins, expected.origins)) problems.push("Explicit Valo Pay 1 sign-in origins must exactly match the reviewed resource binding; provider-derived defaults are not accepted.");
  if ((env.PRIVATE_OBJECT_DIR || null) !== expected.storagePrivateDirectory) problems.push("PRIVATE_OBJECT_DIR differs from the reviewed Valo Pay 1 storage binding.");
  if (expected.authentication) {
    const auth = expected.authentication;
    if (!env.CLERK_SECRET_KEY || !env.CLERK_PUBLISHABLE_KEY || !env.CLERK_JWT_KEY) problems.push("CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY and CLERK_JWT_KEY are required for the reviewed authentication binding.");
    else {
      if (credentialFingerprint(env.CLERK_PUBLISHABLE_KEY) !== auth.publishableKeySha256 || clerkIssuer(env.CLERK_PUBLISHABLE_KEY) !== auth.issuer) problems.push("CLERK_PUBLISHABLE_KEY does not identify the reviewed authentication instance.");
      if (credentialFingerprint(env.CLERK_SECRET_KEY) !== auth.secretKeySha256) problems.push("CLERK_SECRET_KEY differs from the reviewed authentication credential binding.");
      try { if (publicKeyFingerprint(env.CLERK_JWT_KEY) !== auth.jwtPublicKeySha256) problems.push("CLERK_JWT_KEY does not match the reviewed authentication instance's public key."); } catch (error) { problems.push((error as Error).message); }
    }
    if (env.VALO_PAY_1_STAFF_ACCESS === "staging" && env.VALO_PAY_1_STAFF_ISSUER !== auth.issuer) problems.push("VALO_PAY_1_STAFF_ISSUER differs from the reviewed authentication issuer.");
  } else if (env.CLERK_SECRET_KEY || env.CLERK_PUBLISHABLE_KEY || env.CLERK_JWT_KEY) problems.push("Clerk credentials are present but the resource binding declares authentication disabled.");
  const activeKey = env.VALO_PAY_1_PAYLOAD_ENCRYPTION === "kms" ? env.VALO_PAY_1_KMS_KEY || "" : null;
  if (activeKey !== (expected.kms?.activeKey ?? null) || !sameList(list(env.VALO_PAY_1_KMS_PREVIOUS_KEYS), expected.kms?.previousKeys || [])) problems.push("The configured KMS keys differ from the reviewed Valo Pay 1 encryption binding.");
  const paymentKey = env.PAYSTACK_TEST_SECRET_KEY;
  if (env.VALO_PAY_1_PAYSTACK_INGRESS && !["off", "test"].includes(env.VALO_PAY_1_PAYSTACK_INGRESS)) problems.push("VALO_PAY_1_PAYSTACK_INGRESS must be off or test; an ambiguous provider mode is refused.");
  if (expected.paystackTestKeySha256 ? !paymentKey || !paymentKey.startsWith("sk_test_") || credentialFingerprint(paymentKey) !== expected.paystackTestKeySha256 : Boolean(paymentKey) || env.VALO_PAY_1_PAYSTACK_INGRESS === "test") problems.push("Paystack test configuration differs from the reviewed Valo Pay 1 credential binding; live or unbound credentials are refused.");
  return problems;
}

export interface DatabaseIdentityObservation { database: string; user: string; schema: string | null; bound_schema_exists: boolean }
/** The live server must agree with the URL, including schema resolution; this check performs no write. */
export function assertObservedDatabaseIdentity(binding: ResourceBindings, observed: DatabaseIdentityObservation | undefined): void {
  if (!observed || observed.database !== binding.database.database || observed.user !== binding.database.user || !observed.bound_schema_exists || (binding.database.schema === "public" && observed.schema !== "public")) throw new Error("The connected database identity does not match the reviewed Valo Pay 1 resource binding. No server or worker was started.");
}

/** Direct operator entrypoints must not treat a remote database as an unbound local development database. */
export function assertOperatorConfiguration(env: Environment = process.env): void {
  const problems = productIdentityProblems(env);
  if (problems.length) throw new Error(problems.join(" "));
  if (readResourceBindings(env) || !env.DATABASE_URL) return;
  let hostname: string;
  try { hostname = new URL(env.DATABASE_URL).hostname; } catch { throw new Error("DATABASE_URL must identify the reviewed Valo Pay 1 database."); }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) throw new Error("A remote database requires explicit VALO_PAY_1_RESOURCE_BINDINGS before any operator command or service may connect.");
}

/** These owner-run maintenance commands deliberately support only their documented public source tables. */
export function assertPublicOperatorSchema(env: Environment = process.env): void {
  const binding = readResourceBindings(env);
  if ((binding && binding.database.schema !== "public") || env.VALO_PAY_1_RUNTIME_ISOLATION === "staging") throw new Error("This operator command supports only a reviewed public-schema resource binding; restricted runtime schemas require their separate reviewed procedure. No changes were made.");
}

/** Even a stored job may address only this generation's reviewed private namespace. */
export function assertBoundStorageObject(bucket: string, objectName: string, env: Environment = process.env): void {
  const binding = readResourceBindings(env);
  if (!binding && !bindingRequired(env)) return;
  const parts = binding?.storagePrivateDirectory?.replace(/^\//, "").replace(/\/+$/, "").split("/") || [];
  const expectedBucket = parts.shift(), prefix = parts.join("/");
  if (!expectedBucket || !prefix || bucket !== expectedBucket || !objectName.startsWith(`${prefix}/`)) throw new Error("The export location is outside the reviewed Valo Pay 1 private storage binding. No storage request was made.");
}
