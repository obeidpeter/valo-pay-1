/** Disposable collision harness. No provider credentials, network calls or stateful migrations. */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { APPLICATION_ID, RETAINED_REPLIT_ID, RETAINED_ORIGIN, assertBoundStorageObject, assertObservedDatabaseIdentity, assertOperatorConfiguration, assertPublicOperatorSchema, credentialFingerprint, databaseTarget, deploymentEnvironment, productIdentityProblems, publicKeyFingerprint, type ResourceBindings } from "../src/lib/product-identity";
import { HOST_SANDBOX_COOKIE, PREVIOUS_HOST_SANDBOX_COOKIE, PREVIOUS_SANDBOX_COOKIE, SANDBOX_COOKIE, readSandboxCookie, sandboxPrincipal, withoutSandboxCookies, writeSandboxCookie } from "../src/lib/sandbox-cookie";

const fixtureDatabase = new URL("postgres://db.example.invalid:5432/existing_product");
fixtureDatabase.username = "existing_owner";
fixtureDatabase.password = "synthetic-password";
const connection = fixtureDatabase.toString();
const target = databaseTarget(connection);
const binding: ResourceBindings = {
  applicationId: APPLICATION_ID, environment: "production", deploymentId: RETAINED_REPLIT_ID,
  origins: [RETAINED_ORIGIN], database: { ...target, schema: "public" },
  storagePrivateDirectory: "/retained-bucket/private", authentication: null, kms: null, paystackTestKeySha256: null,
};
const base = { NODE_ENV: "production", REPLIT_DEPLOYMENT: "1", REPL_ID: RETAINED_REPLIT_ID, VALO_PAY_1_ENVIRONMENT: "production", DATABASE_URL: connection, PRIVATE_OBJECT_DIR: binding.storagePrivateDirectory!, VALO_PAY_1_APP_ORIGINS: RETAINED_ORIGIN, VALO_PAY_1_RESOURCE_BINDINGS: JSON.stringify(binding) };
let checks = 0;
const refused = (changes: Record<string, string | undefined>, pattern: RegExp) => { const problems = productIdentityProblems({ ...base, ...changes }); assert.ok(problems.some(problem => pattern.test(problem)), problems.join(" ")); assert.ok(!JSON.stringify(problems).includes("synthetic-password")); checks += 2; };
assert.deepEqual(productIdentityProblems(base), []); checks++;
assert.doesNotThrow(() => assertOperatorConfiguration(base)); checks++;
assert.doesNotThrow(() => assertPublicOperatorSchema(base)); checks++;
assert.throws(() => assertPublicOperatorSchema({ ...base, VALO_PAY_1_RESOURCE_BINDINGS: JSON.stringify({ ...binding, database: { ...binding.database, schema: "valopay_runtime_staging_synthetic" } }) }), /only a reviewed public-schema/); checks++;
assert.throws(() => assertPublicOperatorSchema({ VALO_PAY_1_RUNTIME_ISOLATION: "staging" }), /only a reviewed public-schema/); checks++;
assert.throws(() => assertOperatorConfiguration({ DATABASE_URL: connection }), /remote database requires/); checks++;
assert.doesNotThrow(() => assertOperatorConfiguration({ DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused" })); checks++;
assert.throws(() => assertOperatorConfiguration({ NODE_ENV: "production", DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused" }), /ENVIRONMENT/); checks++;
assert.doesNotThrow(() => assertBoundStorageObject("retained-bucket", "private/exports/example.pdf", base)); checks++;
for (const [bucket, name] of [["future-bucket", "private/exports/example.pdf"], ["retained-bucket", "private-other/exports/example.pdf"], ["retained-bucket", "future/exports/example.pdf"]]) { assert.throws(() => assertBoundStorageObject(bucket!, name!, base), /outside the reviewed/); checks++; }
assert.throws(() => assertBoundStorageObject("retained-bucket", "private/exports/example.pdf", { NODE_ENV: "production" }), /outside the reviewed/); checks++;
assert.equal(deploymentEnvironment({ NODE_ENV: "test" }), "test"); checks++;
assert.deepEqual(productIdentityProblems({ NODE_ENV: "test" }), []); checks++;
assert.equal(databaseTarget(connection.replace("synthetic-password", "different-password")).targetSha256, target.targetSha256, "resource digest excludes the password"); checks++;
for (const changed of [connection.replace("db.example", "future-db.example"), connection.replace("existing_product", "future_product"), connection.replace("existing_owner", "future_owner"), connection.replace(":5432", ":5433")]) {
  refused({ DATABASE_URL: changed }, /database target/);
}
for (const param of ["host=other.example.invalid", "user=other", "database=other", "options=-c%20search_path%3Dfuture"]) refused({ DATABASE_URL: `${connection}?${param}` }, /overrides/);
refused({ VALO_PAY_1_ENVIRONMENT: undefined }, /ENVIRONMENT/);
refused({ VALO_PAY_1_ENVIRONMENT: "development" }, /staging or production/);
refused({ VALO_PAY_1_ENVIRONMENT: "staging" }, /environment differs/);
refused({ VALO_PAY_1_RESOURCE_BINDINGS: undefined }, /RESOURCE_BINDINGS is required/);
refused({ VALO_PAY_1_RESOURCE_BINDINGS: "not-json" }, /non-secret JSON/);
refused({ VALO_PAY_1_RESOURCE_BINDINGS: JSON.stringify({ ...binding, applicationId: "valo-pay" }) }, /identify Valo Pay 1/);
refused({ REPL_ID: "future-replit-id" }, /REPL_ID/);
refused({ PRIVATE_OBJECT_DIR: "/future-bucket/private" }, /storage binding/);
refused({ VALO_PAY_1_APP_ORIGINS: "https://future.example.invalid" }, /origins/);
refused({ VALO_PAY_1_APP_ORIGINS: undefined, REPLIT_DOMAINS: "valo-pay.replit.app" }, /origins/);
refused({ VALO_PAY_1_RUNTIME_ISOLATION: "staging", VALO_PAY_1_RUNTIME_SCHEMA: "valopay_runtime_staging_other" }, /runtime schema/);
refused({ CLERK_SECRET_KEY: "sk_test_synthetic-password" }, /authentication disabled/);
refused({ PAYSTACK_TEST_SECRET_KEY: "sk_test_synthetic-password" }, /Paystack/);
refused({ VALO_PAY_1_PAYSTACK_INGRESS: "live" }, /provider mode/);
refused({ VALOPAY_CLOSE_SCHEDULER: "on" }, /Legacy VALOPAY_/);
refused({ VALO_PAY_1_PAYLOAD_ENCRYPTION: "kms", VALO_PAY_1_KMS_KEY: "projects/other/locations/global/keyRings/other/cryptoKeys/other" }, /KMS/);

const publicKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
const issuer = "https://retained.clerk.accounts.dev";
const publishableKey = `pk_test_${Buffer.from("retained.clerk.accounts.dev$").toString("base64")}`;
const secretKey = "sk_test_synthetic-auth-only";
const authentication = { issuer, jwtPublicKeySha256: publicKeyFingerprint(publicKey), publishableKeySha256: credentialFingerprint(publishableKey), secretKeySha256: credentialFingerprint(secretKey) };
const auth = { ...base, CLERK_SECRET_KEY: secretKey, CLERK_PUBLISHABLE_KEY: publishableKey, CLERK_JWT_KEY: publicKey, VALO_PAY_1_RESOURCE_BINDINGS: JSON.stringify({ ...binding, authentication }) };
assert.deepEqual(productIdentityProblems(auth), []); checks++;
for (const keyForm of [publicKey.replaceAll("\n", ""), publicKey.replaceAll("\n", " "), publicKey.replaceAll("\n", "\r\n"), publicKey.replace(/-----[^\n]+-----/g, "").replaceAll("\n", ""), `"${publicKey.trim()}"`]) {
  assert.equal(publicKeyFingerprint(keyForm), authentication.jwtPublicKeySha256, "Clerk-readable key formatting preserves the instance fingerprint"); checks++;
  assert.deepEqual(productIdentityProblems({ ...auth, CLERK_JWT_KEY: keyForm }), []); checks++;
}
assert.throws(() => publicKeyFingerprint(publicKey.replaceAll("\n", "\\n")), /CLERK_JWT_KEY/); checks++;
assert.ok(productIdentityProblems({ ...auth, CLERK_SECRET_KEY: "sk_test_other-instance" }).some(problem => /credential binding/.test(problem))); checks++;
assert.ok(productIdentityProblems({ ...auth, CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("future.clerk.accounts.dev$").toString("base64")}` }).some(problem => /authentication instance/.test(problem))); checks++;
assert.ok(productIdentityProblems({ ...auth, CLERK_JWT_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString() }).some(problem => /public key/.test(problem))); checks++;
const managedAuthentication = { ...authentication, jwtPublicKeySha256: null };
const managedAuth = { ...auth, CLERK_JWT_KEY: undefined, VALO_PAY_1_RESOURCE_BINDINGS: JSON.stringify({ ...binding, authentication: managedAuthentication }) };
assert.deepEqual(productIdentityProblems(managedAuth), [], "an explicitly bound absence preserves non-staff managed Clerk verification"); checks++;
assert.doesNotThrow(() => assertOperatorConfiguration(managedAuth)); checks++;
assert.deepEqual(productIdentityProblems({ ...managedAuth, CLERK_JWT_KEY: "" }), [], "an empty environment value is absent, as in the startup configuration"); checks++;
for (const key of [publicKey, "invalid-public-key"]) {
  assert.ok(productIdentityProblems({ ...managedAuth, CLERK_JWT_KEY: key }).some(problem => /declares it absent/.test(problem)), "a configured key requires an explicit reviewed fingerprint"); checks++;
}
for (const key of [undefined, ""]) {
  assert.ok(productIdentityProblems({ ...auth, CLERK_JWT_KEY: key }).some(problem => /required by the reviewed authentication binding/.test(problem)), "a bound key cannot be silently removed"); checks++;
}
assert.ok(productIdentityProblems({ ...managedAuth, VALO_PAY_1_RESOURCE_BINDINGS: JSON.stringify({ ...binding, authentication: { ...authentication, jwtPublicKeySha256: undefined } }) }).some(problem => /incomplete bindings/.test(problem)), "missing is not an explicit null binding"); checks++;
const staff = { VALO_PAY_1_STAFF_ACCESS: "staging", VALO_PAY_1_STAFF_ISSUER: issuer, VALO_PAY_1_STAFF_ORIGINS: RETAINED_ORIGIN };
assert.ok(productIdentityProblems({ ...managedAuth, ...staff }).some(problem => /public-key fingerprint are required/.test(problem)), "staff access still requires the instance public key"); checks++;
assert.throws(() => assertOperatorConfiguration({ ...managedAuth, ...staff }), /public-key fingerprint are required/); checks++;
assert.deepEqual(productIdentityProblems({ ...auth, ...staff }), []); checks++;
assert.ok(productIdentityProblems({ ...managedAuth, CLERK_SECRET_KEY: "sk_test_other-instance" }).some(problem => /credential binding/.test(problem))); checks++;
assert.ok(productIdentityProblems({ ...managedAuth, CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("future.clerk.accounts.dev$").toString("base64")}` }).some(problem => /authentication instance/.test(problem))); checks++;
assert.ok(productIdentityProblems({ ...managedAuth, VALO_PAY_1_RESOURCE_BINDINGS: JSON.stringify({ ...binding, authentication: { ...managedAuthentication, issuer: "https://future.clerk.accounts.dev" } }) }).some(problem => /authentication instance/.test(problem))); checks++;
for (const changes of [{ CLERK_SECRET_KEY: undefined }, { CLERK_PUBLISHABLE_KEY: undefined }]) {
  assert.ok(productIdentityProblems({ ...managedAuth, ...changes }).some(problem => /required for the reviewed authentication binding/.test(problem))); checks++;
}
const paymentKey = "sk_test_synthetic-paystack-only";
const payments = { ...base, PAYSTACK_TEST_SECRET_KEY: paymentKey, VALO_PAY_1_PAYSTACK_INGRESS: "test", VALO_PAY_1_RESOURCE_BINDINGS: JSON.stringify({ ...binding, paystackTestKeySha256: credentialFingerprint(paymentKey) }) };
assert.deepEqual(productIdentityProblems(payments), []); checks++;
assert.ok(productIdentityProblems({ ...payments, PAYSTACK_TEST_SECRET_KEY: "sk_live_synthetic-refused" }).some(problem => /Paystack/.test(problem))); checks++;
assert.ok(productIdentityProblems({ ...payments, PAYSTACK_TEST_SECRET_KEY: "sk_test_other-account" }).some(problem => /Paystack/.test(problem))); checks++;
const observation = { database: target.database, user: target.user, schema: "public", bound_schema_exists: true };
assert.doesNotThrow(() => assertObservedDatabaseIdentity(binding, observation)); checks++;
for (const changed of [{ database: "future_product" }, { user: "future_owner" }, { schema: "future" }, { bound_schema_exists: false }]) { assert.throws(() => assertObservedDatabaseIdentity(binding, { ...observation, ...changed }), /connected database identity/); checks++; }

const now = Date.parse("2026-10-03T12:00:00Z");
const transition = { VALO_PAY_1_LEGACY_COOKIE_ORIGIN: RETAINED_ORIGIN, VALO_PAY_1_LEGACY_COOKIE_UNTIL: "2026-10-10T12:00:00Z" };
const token = "a".repeat(64), another = "b".repeat(64), old = `${PREVIOUS_HOST_SANDBOX_COOKIE}=${token}`;
const migrated = readSandboxCookie(old, true, RETAINED_ORIGIN, transition, now);
assert.equal(migrated.name, HOST_SANDBOX_COOKIE); assert.equal(migrated.token, token); assert.equal(sandboxPrincipal(migrated.token!), sandboxPrincipal(token)); checks += 3;
for (const [secure, actualOrigin, config, clock] of [
  [false, RETAINED_ORIGIN, transition, now], [true, "https://future.example.invalid", transition, now],
  [true, RETAINED_ORIGIN, {}, now], [true, RETAINED_ORIGIN, transition, now + 8 * 86400_000],
  [true, RETAINED_ORIGIN, { ...transition, VALO_PAY_1_LEGACY_COOKIE_UNTIL: "2030-01-01T00:00:00Z" }, now],
] as const) { assert.equal(readSandboxCookie(old, secure, actualOrigin, config, clock).token, undefined); checks++; }
assert.equal(readSandboxCookie(`${PREVIOUS_SANDBOX_COOKIE}=${token}`, true, RETAINED_ORIGIN, transition, now).token, undefined, "a plain legacy cookie is never trusted"); checks++;
assert.equal(readSandboxCookie(`${old}; ${HOST_SANDBOX_COOKIE}=${another}`, true, RETAINED_ORIGIN, transition, now).token, another, "current generation wins; no workspace switching"); checks++;
assert.throws(() => readSandboxCookie(`${old}; ${PREVIOUS_HOST_SANDBOX_COOKIE}=${another}`, true, RETAINED_ORIGIN, transition, now), /two different legacy/); checks++;
assert.equal(readSandboxCookie(`valo-pay_production_sandbox=${token}`, false, RETAINED_ORIGIN, transition, now).token, undefined, "dummy future cookie is not adopted"); checks++;
const writes: Array<{ name: string; token: string; options: Record<string, unknown> }> = [];
writeSandboxCookie({ cookie: ((name: string, value: string, options: Record<string, unknown>) => { writes.push({ name, token: value, options }); }) as never }, migrated, token, true, 86400_000);
assert.equal(writes[0]?.name, HOST_SANDBOX_COOKIE); assert.equal(writes[0]?.token, token); assert.equal(writes[0]?.options.secure, true); assert.equal(writes[0]?.options.domain, undefined);
assert.ok(writes.some(write => write.name === PREVIOUS_HOST_SANDBOX_COOKIE && write.token === "" && (write.options.expires as Date).getTime() === 0)); checks += 5;
assert.equal(withoutSandboxCookies(`${old}; ${SANDBOX_COOKIE}=${token}; __session=clerk-session`), "__session=clerk-session"); checks++;
assert.equal(withoutSandboxCookies(`__Host-valo-pay-1_staging_sandbox=${token}; valo-pay-1_production_sandbox=${another}; __session=clerk-session`), "__session=clerk-session", "another generation-1 environment's bearer is also withheld from Clerk"); checks++;
console.log(`Product identity: ${checks} deployment, resource collision and bounded session recovery checks passed.`);
