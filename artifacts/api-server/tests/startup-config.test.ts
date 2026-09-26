// The settings are checked once, at startup, before any module reads them: a
// bad value ends the process with one structured fatal line naming the
// setting, never its value; the close scheduler's switch takes on, off or
// external in any case and refuses anything else instead of failing open;
// Clerk's JWT key is checked as Clerk reads it, so the check passes exactly the
// forms with which Clerk's own verifier signs a genuine session in, and a staff
// host needs it; and the export worker slows down while its queue cannot be
// read, logging the outage once and the recovery once instead of an error at
// every poll. Offline: the processes this starts use an unusable loopback
// database, and Clerk verifies with the key alone, with no network call.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createPublicKey, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { verifyToken } from "@clerk/express";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import { InvalidConfiguration, clerkProxyTuning, invalidConfigurationLine, readStartupConfig } from "../src/lib/startup-config";
import { financialProjectionSchema } from "../src/lib/financial-projection";

let checks = 0;
const database = "postgres://unused:unused@127.0.0.1:1/unused";
// The export worker's modules load the database pool, which needs an address; nothing connects to it.
process.env["DATABASE_URL"] ??= database;
const { EXPORT_QUEUE_MAX_BACKOFF_MS, exportQueueDelay, startExportWorker } = await import("../src/lib/export-worker");
const base = { PORT: "8080", DATABASE_URL: database };
const problems = (env: Record<string, string | undefined>, purpose: "server" | "close-pass" = "server") => {
  try { readStartupConfig(env, purpose); return []; } catch (error) { assert.ok(error instanceof InvalidConfiguration); return error.problems; }
};

// ---- The defaults, and the switch that used to fail open ----
const defaults = readStartupConfig(base, "server");
assert.deepEqual(defaults, { port: 8080, closeScheduler: "on", logLevel: "info", logFormat: null, nodeEnv: null, databasePoolSize: 10, expiredWorkspaceCleanup: "off", staffAccess: "off", runtimeIsolation: "off", payloadEncryption: "off" });
for (const value of ["off", "OFF", "Off"]) assert.equal(readStartupConfig({ ...base, VALOPAY_CLOSE_SCHEDULER: value }, "server").closeScheduler, "off", value);
for (const value of ["on", "ON", ""]) assert.equal(readStartupConfig({ ...base, VALOPAY_CLOSE_SCHEDULER: value }, "server").closeScheduler, "on", value);
// external: closes run from a separate scheduled job (the one-shot close pass), so this process schedules none either.
for (const value of ["external", "EXTERNAL", "External"]) assert.equal(readStartupConfig({ ...base, VALOPAY_CLOSE_SCHEDULER: value }, "server").closeScheduler, "external", value);
assert.equal(readStartupConfig({ DATABASE_URL: database, VALOPAY_CLOSE_SCHEDULER: "external" }, "close-pass").closeScheduler, "external", "the close pass checks the switch as the server does");
for (const value of ["false", "0", "no", "disabled", "of", "extern", "job"]) assert.deepEqual(problems({ ...base, VALOPAY_CLOSE_SCHEDULER: value }), ["VALOPAY_CLOSE_SCHEDULER must be on, off or external (in any case)."], value);
assert.deepEqual(problems({ DATABASE_URL: database, VALOPAY_CLOSE_SCHEDULER: "false" }, "close-pass"), ["VALOPAY_CLOSE_SCHEDULER must be on, off or external (in any case)."], "and refuses what the server refuses");
checks += 17;

// Financial dual writes are opt-in. Default/empty/off must preserve the existing
// startup result and must not require (or validate) an inactive schema setting.
const financialSchemaProblem = 'VALOPAY_FINANCIAL_PROJECTION_SCHEMA must name an isolated valopay_finance_staging_<suffix> schema when VALOPAY_FINANCIAL_PROJECTION is staging.';
for (const mode of [undefined, '', 'off']) {
  for (const schema of [undefined, '', 'public', 'synthetic-secret']) {
    assert.deepEqual(readStartupConfig({...base,VALOPAY_FINANCIAL_PROJECTION:mode,VALOPAY_FINANCIAL_PROJECTION_SCHEMA:schema},'server'),defaults);
    checks++;
  }
}
for (const mode of ['on','true','false','STAGING','OFF',' staging','staging ','synthetic-secret']) {
  const found=problems({...base,VALOPAY_FINANCIAL_PROJECTION:mode});
  assert.deepEqual(found,['VALOPAY_FINANCIAL_PROJECTION must be off or staging.']);
  assert.ok(!found.join(' ').includes('synthetic-secret'),'invalid financial mode values are not echoed');checks+=2;
}
for (const schema of [undefined,'','public','valopay_finance_staging_','valopay_runtime_staging_pilot','valopay_finance_staging_UPPER',`valopay_finance_staging_${'a'.repeat(33)}`,'valopay_finance_staging_pilot;DROP SCHEMA public','synthetic-secret']) {
  assert.throws(()=>financialProjectionSchema(schema || ''),/isolated/);
  for (const purpose of ['server','close-pass'] as const) {
    const found=problems({...base,VALOPAY_FINANCIAL_PROJECTION:'staging',VALOPAY_FINANCIAL_PROJECTION_SCHEMA:schema},purpose);
    assert.deepEqual(found,[financialSchemaProblem]);assert.ok(!found.join(' ').includes('synthetic-secret'));checks+=2;
  }
  checks++;
}
for (const schema of ['valopay_finance_staging_a','valopay_finance_staging_pilot_2026',`valopay_finance_staging_${'a'.repeat(32)}`]) {
  assert.equal(financialProjectionSchema(schema),schema);
  for (const purpose of ['server','close-pass'] as const) assert.deepEqual(problems({...base,VALOPAY_FINANCIAL_PROJECTION:'staging',VALOPAY_FINANCIAL_PROJECTION_SCHEMA:schema},purpose),[]);
  checks+=3;
}

// ---- Each rule, named without the value ----
const rules: Array<[Record<string, string>, string]> = [
  [{ PORT: "70000" }, "PORT must be a whole number from 1 to 65535."],
  [{ PORT: "0" }, "PORT must be a whole number from 1 to 65535."],
  [{ PORT: "80a" }, "PORT must be a whole number from 1 to 65535."],
  [{ PORT: "" }, "PORT is required: the port this server listens on."],
  [{ DATABASE_URL: "" }, "DATABASE_URL is required: the PostgreSQL connection URL."],
  [{ DATABASE_URL: "mysql://synthetic-secret@db/x" }, "DATABASE_URL must be a postgres:// or postgresql:// connection URL."],
  [{ DATABASE_URL: "synthetic-secret" }, "DATABASE_URL must be a postgres:// or postgresql:// connection URL."],
  [{ VALOPAY_DATABASE_POOL_SIZE: "1" }, "VALOPAY_DATABASE_POOL_SIZE must be a whole number from 2 to 100."],
  [{ VALOPAY_DATABASE_POOL_SIZE: "101" }, "VALOPAY_DATABASE_POOL_SIZE must be a whole number from 2 to 100."],
  [{ LOG_LEVEL: "verbose" }, "LOG_LEVEL must be fatal, error, warn, info, debug, trace or silent."],
  [{ LOG_FORMAT: "text" }, "LOG_FORMAT must be pretty or json."],
  [{ NODE_ENV: "staging" }, "NODE_ENV must be development, production or test."],
  [{ VALOPAY_EXPIRED_WORKSPACE_CLEANUP: "ON" }, "VALOPAY_EXPIRED_WORKSPACE_CLEANUP must be on or off."],
  [{ VALOPAY_STAFF_ACCESS: "on" }, "VALOPAY_STAFF_ACCESS must be off or staging."],
  [{ VALOPAY_APP_ORIGINS: "https://valopay.example.test, valopay.example.test" }, "VALOPAY_APP_ORIGINS must list HTTPS origins, separated by commas, such as https://valopay.example."],
  [{ VALOPAY_PAYLOAD_ENCRYPTION: "yes" }, "VALOPAY_PAYLOAD_ENCRYPTION must be off or kms."],
  [{ VALOPAY_PAYLOAD_ENCRYPTION: "kms", VALOPAY_KMS_KEY: "synthetic-secret" }, "VALOPAY_KMS_KEY must be a Cloud KMS CryptoKey name (projects/…/locations/…/keyRings/…/cryptoKeys/…) when VALOPAY_PAYLOAD_ENCRYPTION is kms."],
  [{ VALOPAY_KMS_PREVIOUS_KEYS: "projects/p/locations/l/keyRings/r/cryptoKeys/k, synthetic-secret" }, "VALOPAY_KMS_PREVIOUS_KEYS must list Cloud KMS CryptoKey names, separated by commas."],
  [{ VALOPAY_RUNTIME_ISOLATION: "true" }, "VALOPAY_RUNTIME_ISOLATION must be off or staging."],
];
for (const [change, problem] of rules) {
  const found = problems({ ...base, ...change });
  assert.deepEqual(found, [problem], JSON.stringify(change));
  assert.ok(!found.join(" ").includes("synthetic-secret"), "a value is never repeated: it may be a credential");
  checks += 2;
}
// The sign-in proxy's limits an operator may set (the review of PRs #61 to #67, finding L), which the proxy reads with
// the same rule (clerkProxyTuning): the process always has room for eight networks at their limit, eight times the
// network's limit when unset. The close pass has no proxy, so it leaves them alone.
const proxyRules: Array<[Record<string, string>, string]> = [
  [{ VALOPAY_CLERK_PROXY_RATE: "59" }, "VALOPAY_CLERK_PROXY_RATE must be a whole number from 60 to 6000."],
  [{ VALOPAY_CLERK_PROXY_RATE: "6001" }, "VALOPAY_CLERK_PROXY_RATE must be a whole number from 60 to 6000."],
  [{ VALOPAY_CLERK_PROXY_RATE: "synthetic-secret" }, "VALOPAY_CLERK_PROXY_RATE must be a whole number from 60 to 6000."],
  [{ VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY: "1" }, "VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY must be a whole number from 2 to 64."],
  [{ VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY: "8.5" }, "VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY must be a whole number from 2 to 64."],
  [{ VALOPAY_CLERK_PROXY_CONCURRENCY: "32" }, "VALOPAY_CLERK_PROXY_CONCURRENCY must be a whole number from 64 to 512, room for eight networks at VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY."],
  [{ VALOPAY_CLERK_PROXY_CONCURRENCY: "513" }, "VALOPAY_CLERK_PROXY_CONCURRENCY must be a whole number from 64 to 512, room for eight networks at VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY."],
  [{ VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY: "16", VALOPAY_CLERK_PROXY_CONCURRENCY: "100" }, "VALOPAY_CLERK_PROXY_CONCURRENCY must be a whole number from 128 to 512, room for eight networks at VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY."],
];
for (const [change, problem] of proxyRules) {
  const found = problems({ ...base, ...change });
  assert.deepEqual(found, [problem], JSON.stringify(change));
  assert.ok(!found.join(" ").includes("synthetic-secret"), "a value is never repeated");
  assert.deepEqual(clerkProxyTuning({ rate: change.VALOPAY_CLERK_PROXY_RATE, networkConcurrency: change.VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY, concurrency: change.VALOPAY_CLERK_PROXY_CONCURRENCY }).problems, [problem], "the proxy reads it with the same rule");
  assert.deepEqual(problems({ DATABASE_URL: database, ...change }, "close-pass"), [], "the close pass has no proxy");
  checks += 4;
}
assert.deepEqual(clerkProxyTuning({}).limits, { requestsPerMinute: 240, networkConcurrency: 8, concurrency: 64 });
assert.deepEqual(clerkProxyTuning({ networkConcurrency: "16" }).limits, { requestsPerMinute: 240, networkConcurrency: 16, concurrency: 128 }, "unset, the process's limit is eight networks' worth");
assert.deepEqual(problems({ ...base, VALOPAY_CLERK_PROXY_RATE: "1200", VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY: "4", VALOPAY_CLERK_PROXY_CONCURRENCY: "32" }), []);
assert.deepEqual(readStartupConfig({ ...base, VALOPAY_CLERK_PROXY_RATE: "", VALOPAY_CLERK_PROXY_CONCURRENCY: "" }, "server"), defaults, "an empty value counts as unset");
checks += 4;
// lib/db reads the pool size again when it loads: the check accepts exactly what it does (up to three digits, 2 to
// 100), so a value the check passes never ends the process with lib/db's bare stack instead of the fatal line.
const databaseModule = new URL("../../../lib/db/src/index.ts", import.meta.url).href;
for (const size of ["2", "10", "010", "002", "100", "0010", "0002", "0100", "1", "0", "101", "999", "1000", "1e1", "+10", " 10", "10.0", "0x10"]) {
  process.env["VALOPAY_DATABASE_POOL_SIZE"] = size;
  const loaded = await import(`${databaseModule}?poolSize=${encodeURIComponent(size)}`).then(async (db) => { await db.pool.end(); return db.poolSize as number; }, () => undefined);
  const checked = problems({ ...base, VALOPAY_DATABASE_POOL_SIZE: size }).length ? undefined : readStartupConfig({ ...base, VALOPAY_DATABASE_POOL_SIZE: size }, "server").databasePoolSize;
  assert.equal(checked, loaded, `VALOPAY_DATABASE_POOL_SIZE=${JSON.stringify(size)}: the start-up check and lib/db read it alike`);
  checks += 1;
}
delete process.env["VALOPAY_DATABASE_POOL_SIZE"];
// The close pass listens on no port, so it needs none.
assert.equal(readStartupConfig({ DATABASE_URL: database }, "close-pass").port, null);
assert.deepEqual(problems({ DATABASE_URL: database, PORT: "not a port" }, "close-pass"), []);
checks += 2;

// Staff access and the restricted runtime need their companions, checked here instead of on every request.
const jwtKeyRequired = "CLERK_JWT_KEY is required when VALOPAY_STAFF_ACCESS is staging: the Clerk instance's JWT public key, with which staff sessions are verified without a call to Clerk's Backend API.";
assert.deepEqual(problems({ ...base, VALOPAY_STAFF_ACCESS: "staging" }), [
  "VALOPAY_STAFF_ISSUER must be the Clerk issuer's HTTPS origin when VALOPAY_STAFF_ACCESS is staging.",
  "VALOPAY_STAFF_ORIGINS must list one or more HTTPS origins, separated by commas, when VALOPAY_STAFF_ACCESS is staging.",
  "CLERK_SECRET_KEY is required when VALOPAY_STAFF_ACCESS is staging: without it no one can sign in.",
  jwtKeyRequired,
]);
const { publicKey: instanceKey, privateKey: instancePrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwtKey = instanceKey.export({ type: "spki", format: "pem" }).toString();
const staff = { ...base, VALOPAY_STAFF_ACCESS: "staging", VALOPAY_STAFF_ISSUER: "https://clerk.example.test", VALOPAY_STAFF_ORIGINS: "https://valopay.example.test, https://staff.example.test", CLERK_SECRET_KEY: "sk_test_synthetic", CLERK_JWT_KEY: jwtKey };
assert.equal(readStartupConfig(staff, "server").staffAccess, "staging");
const { CLERK_JWT_KEY: _jwtKey, ...staffWithoutJwtKey } = staff;
assert.deepEqual(problems(staffWithoutJwtKey), [jwtKeyRequired], "a staff host needs Clerk's JWT key beside its secret key");
// The close pass signs no one in, so a staff host's close pass needs neither Clerk key.
const { CLERK_SECRET_KEY: _clerk, ...staffWithoutClerk } = staffWithoutJwtKey;
assert.deepEqual(problems(staffWithoutClerk, "close-pass"), []);
checks += 3;
// CLERK_JWT_KEY is checked as Clerk reads it (the review of 4edd897, finding 2): with a value Clerk cannot use every
// session would be refused, and the process would still start and read as ready. The check derives the key as Clerk's
// loader does and confirms it is a 2048-bit RSA public key, the one the value holds (the review of 8267b99, findings 3
// and 4): Clerk reads joined lines, spaces, lone carriage returns, indentation, the body alone and quotes, so those
// start; it misreads a character such as U+202F as part of the key, so that is refused, naming it. Outside staff mode
// the key may be left unset.
const escaped = "CLERK_JWT_KEY holds \\n in place of its line breaks, which Clerk cannot read: give the PEM public key with real line breaks, as Clerk shows it, from -----BEGIN PUBLIC KEY----- to -----END PUBLIC KEY-----.";
const unusable = "CLERK_JWT_KEY must be the Clerk instance's JWT public key as Clerk shows it with the instance's API keys: a 2048-bit RSA public key in PEM form, from -----BEGIN PUBLIC KEY----- to -----END PUBLIC KEY-----.";
const misread = (characters: string, several = false) => `CLERK_JWT_KEY holds ${characters}, which Clerk misreads as part of the key, so it would refuse every session: remove ${several ? "them" : "it"}, or paste the PEM public key again as Clerk shows it.`;
const lines = jwtKey.trim().split("\n"), body = instanceKey.export({ type: "spki", format: "der" }).toString("base64");
const endingLine = (character: string) => [lines[0], `${lines[1]}${character}`, ...lines.slice(2)].join("\n");
const jwtKeys: Array<[string, string, string | undefined]> = [
  ["as Clerk shows it", jwtKey, undefined],
  ["without its final line break", jwtKey.trim(), undefined],
  ["with Windows line breaks and a trailing space", `${jwtKey.replaceAll("\n", "\r\n")} `, undefined],
  ["with spaces for its line breaks, which Clerk reads", jwtKey.trim().replaceAll("\n", " "), undefined],
  ["with its lines joined, which Clerk reads", jwtKey.trim().replaceAll("\n", ""), undefined],
  ["with carriage returns alone for its line breaks, which Clerk reads", jwtKey.replaceAll("\n", "\r"), undefined],
  ["indented, which Clerk reads", lines.map((line) => `  ${line}`).join("\n"), undefined],
  ["as its body alone, which Clerk reads", body, undefined],
  ["in double quotes, which Clerk reads", `"${jwtKey.trim()}"`, undefined],
  ["with a no-break space after its first line, which Clerk skips", jwtKey.replace("-----\n", "-----\u00a0\n"), undefined],
  ["with a narrow no-break space ending a line, which Clerk misreads", endingLine("\u202f"), misread("U+202F (a narrow no-break space)")],
  ["with a medium mathematical space ending a line, which Clerk misreads", endingLine("\u205f"), misread("U+205F (a medium mathematical space)")],
  ["with both, which Clerk misreads", endingLine("\u205f\u202f"), misread("U+205F (a medium mathematical space) and U+202F (a narrow no-break space)", true)],
  ["on one line with \\n escapes", jwtKey.trim().replaceAll("\n", "\\n"), escaped],
  ["with a comment line before it, which Clerk reads as part of the key", `# staging\n${jwtKey}`, unusable],
  ["as PKCS#1", instanceKey.export({ type: "pkcs1", format: "pem" }).toString(), unusable],
  ["the private key", instancePrivateKey.export({ type: "pkcs8", format: "pem" }).toString(), unusable],
  ["a 4,096-bit key", generateKeyPairSync("rsa", { modulusLength: 4096 }).publicKey.export({ type: "spki", format: "pem" }).toString(), unusable],
  ["an elliptic-curve key", generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }).toString(), unusable],
  ["not a key", "synthetic-secret", unusable],
];
for (const [form, value, problem] of jwtKeys) {
  const found = problems({ ...base, CLERK_JWT_KEY: value });
  assert.deepEqual(found, problem ? [problem] : [], `CLERK_JWT_KEY ${form}`);
  assert.deepEqual(problems({ ...staff, CLERK_JWT_KEY: value }), problem ? [problem] : [], `CLERK_JWT_KEY ${form}, on a staff host`);
  assert.ok(!/synthetic-secret|MII/.test(found.join(" ")), "a value is never repeated");
  checks += 3;
}
// A key whose base64 holds IDAQAB, the closing bytes Clerk removes, before its end (one key in about 200 million):
// Clerk removes that one instead and reads another key. node:crypto takes any modulus as a JWK, so one is made here.
const instanceModulus = instanceKey.export({ format: "jwk" }).n!;
const closingEarly = createPublicKey({ key: { kty: "RSA", n: `${instanceModulus.slice(0, 120)}IDAQAB${instanceModulus.slice(126)}`, e: "AQAB" }, format: "jwk" }).export({ type: "spki", format: "pem" }).toString();
assert.deepEqual(problems({ ...base, CLERK_JWT_KEY: closingEarly }), ["CLERK_JWT_KEY holds a key Clerk reads as another: its base64 holds IDAQAB, the key's closing bytes, before its end, and Clerk removes the first IDAQAB it finds, so it would refuse every session. Have Clerk rotate the instance's signing key."]);
checks += 1;
// The check agrees with Clerk on every form (the review of 8267b99, findings 3 and 4). A genuine session token signed
// with the instance's key is verified by Clerk's own verifier (verifyToken with the key, as clerkMiddleware does) with
// each form of the key, and the check passes exactly the forms with which Clerk signs the session in: the forms an
// operator might paste, for three keys; each white-space character at the start, the end and every line end; and
// 3,000 values with up to four of them put anywhere.
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url"), issued = Math.floor(Date.now() / 1000);
function sessionToken(privateKey: KeyObject) {
  const signed = `${encode({ alg: "RS256", typ: "JWT", kid: "ins_synthetic" })}.${encode({ sub: "user_synthetic", sid: "sess_synthetic", azp: "https://pilot.example", iat: issued - 5, nbf: issued - 5, exp: issued + 600 })}`;
  return `${signed}.${createSign("RSA-SHA256").update(signed).sign(privateKey).toString("base64url")}`;
}
const clerkSignsIn = async (token: string, value: string) => { try { return (await verifyToken(token, { jwtKey: value, authorizedParties: ["https://pilot.example"] })).sub === "user_synthetic"; } catch { return false; } };
let agreed = 0, signedIn = 0;
async function agrees(token: string, value: string, form: string) {
  const clerk = await clerkSignsIn(token, value), passes = problems({ ...base, CLERK_JWT_KEY: value }).length === 0;
  assert.equal(passes, clerk, `CLERK_JWT_KEY ${form}: the check ${passes ? "passes" : "refuses"} it, and Clerk ${clerk ? "signs the session in" : "cannot"} with it`);
  agreed += 1; if (clerk) signedIn += 1;
}
const forms: Array<[string, (pem: string, der: string) => string]> = [
  ["as Node exports it (64-character lines, final line break)", (pem) => pem],
  ["without its final line break", (pem) => pem.trim()],
  ["with CRLF line ends", (pem) => pem.replaceAll("\n", "\r\n")],
  ["with CR line ends", (pem) => pem.replaceAll("\n", "\r")],
  ["with a trailing space on every line", (pem) => pem.trim().split("\n").map((line) => `${line} `).join("\n")],
  ["indented by two spaces", (pem) => pem.trim().split("\n").map((line) => `  ${line}`).join("\n")],
  ["with its body lines indented by a tab", (pem) => pem.trim().split("\n").map((line, index, all) => (index && index < all.length - 1 ? `\t${line}` : line)).join("\n")],
  ["with a blank line after its first", (pem) => pem.replace("-----\n", "-----\n\n")],
  ["between blank lines", (pem) => `\n\n${pem}\n\n`],
  ["after a space", (pem) => ` ${pem}`],
  ["with 76-character body lines", (_pem, der) => `-----BEGIN PUBLIC KEY-----\n${der.match(/.{1,76}/g)!.join("\n")}\n-----END PUBLIC KEY-----\n`],
  ["with its body on one line between the armour's", (_pem, der) => `-----BEGIN PUBLIC KEY-----\n${der}\n-----END PUBLIC KEY-----\n`],
  ["on one line", (_pem, der) => `-----BEGIN PUBLIC KEY-----${der}-----END PUBLIC KEY-----`],
  ["on one line with spaces", (_pem, der) => `-----BEGIN PUBLIC KEY----- ${der} -----END PUBLIC KEY-----`],
  ["with spaces for its line breaks", (pem) => pem.trim().replaceAll("\n", " ")],
  ["as its body alone", (_pem, der) => der],
  ["with \\n escapes", (pem) => pem.trim().replaceAll("\n", "\\n")],
  ["with \\r\\n escapes", (pem) => pem.trim().replaceAll("\n", "\\r\\n")],
  ["in double quotes", (pem) => `"${pem.trim()}"`],
  ["with a no-break space after its first line", (pem) => pem.replace("-----\n", "-----\u00a0\n")],
  ["after a comment line", (pem) => `# staging\n${pem}`],
];
for (let run = 0; run < 3; run++) {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 }), token = sessionToken(pair.privateKey);
  const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString(), der = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  for (const [form, make] of forms) await agrees(token, make(pem, der), form);
}
const spaces = [" ", "\t", "\v", "\f", "\u00a0", "\u1680", "\u2000", "\u2007", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff", "\r", "\n", "\r\n"];
const named = (text: string) => [...text].map((character) => `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ");
const instanceToken = sessionToken(instancePrivateKey);
const spots = new Set([0, lines[0]!.length, lines[0]!.length + 1, jwtKey.lastIndexOf("-----END"), jwtKey.trimEnd().length, jwtKey.length, 30, 100, 200, 300, ...[...jwtKey].flatMap((character, index) => (character === "\n" ? [index] : []))]);
for (const space of spaces) for (const at of spots) await agrees(instanceToken, jwtKey.slice(0, at) + space + jwtKey.slice(at), `with ${named(space)} at ${at}`);
let seed = 7;
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (let variant = 0; variant < 3000; variant++) {
  let value = jwtKey;
  for (let added = 0; added < 1 + Math.floor(random() * 4); added++) { const at = Math.floor(random() * (value.length + 1)); value = value.slice(0, at) + spaces[Math.floor(random() * spaces.length)] + value.slice(at); }
  await agrees(instanceToken, value, `with white space put in (${JSON.stringify(value)})`);
}
assert.ok(signedIn > 1000 && agreed - signedIn > 100, `both outcomes are exercised: ${signedIn} of ${agreed} forms sign in`);
checks += agreed + 1;
assert.deepEqual(problems({ DATABASE_URL: database, CLERK_JWT_KEY: "synthetic-secret" }, "close-pass"), [], "the close pass signs no one in and leaves the key alone");
checks += 1;
assert.deepEqual(problems({ ...staff, VALOPAY_STAFF_ORIGINS: "http://valopay.example.test" }), ["VALOPAY_STAFF_ORIGINS must list one or more HTTPS origins, separated by commas, when VALOPAY_STAFF_ACCESS is staging."]);
assert.deepEqual(problems({ ...base, VALOPAY_RUNTIME_ISOLATION: "staging" }).length, 6, "every missing companion of the restricted runtime is named at once");
const isolated = { ...staff, VALOPAY_RUNTIME_ISOLATION: "staging", VALOPAY_RUNTIME_SCHEMA: "valopay_runtime_staging_pilot", VALOPAY_RUNTIME_ROLE: "valopay_runtime_login", VALOPAY_PAYLOAD_ENCRYPTION: "kms", VALOPAY_KMS_KEY: "projects/p/locations/l/keyRings/r/cryptoKeys/k", VALOPAY_RUNTIME_SERVICE_ORG: "org_Synthetic", VALOPAY_RUNTIME_SERVICE_USER: "user_Synthetic" };
assert.equal(readStartupConfig(isolated, "server").runtimeIsolation, "staging");
assert.deepEqual(problems({ ...isolated, VALOPAY_RUNTIME_SCHEMA: "valopay_runtime_staging" }), ["VALOPAY_RUNTIME_SCHEMA must name a valopay_runtime_staging_<suffix> schema when VALOPAY_RUNTIME_ISOLATION is staging."]);
// Several problems are one line, all of them named.
assert.equal(problems({ PORT: "70000", DATABASE_URL: database, LOG_LEVEL: "verbose", VALOPAY_CLOSE_SCHEDULER: "false" }).length, 3);
const line = JSON.parse(invalidConfigurationLine(["PORT must be a whole number from 1 to 65535."], "server", 0));
assert.deepEqual([line.level, line.event, line.service, line.purpose, line.problems], [60, "config.invalid", "valopay-api", "server", ["PORT must be a whole number from 1 to 65535."]]);
checks += 8;

// ---- The processes: one fatal line before anything loads, and the switch as the health answer reports it ----
const root = path.resolve(import.meta.dirname, "..", "..", "..");
const tsx = path.join(root, "scripts", "node_modules", "tsx", "dist", "cli.mjs");
const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:VALOPAY_|LOG_|PORT$|DATABASE_URL$|NODE_ENV$|CLERK_)/.test(name)));
function start(entry: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [tsx, path.join(root, "artifacts", "api-server", "src", entry)], { cwd: root, env: { ...clean, ...env } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => child.on("close", (status) => resolve(status)));
  return { child, exited, output: () => ({ stdout, stderr }) };
}
const refusals: Array<[string, Record<string, string>, string]> = [
  ["index.ts", { PORT: "70000", DATABASE_URL: database }, "PORT must be a whole number from 1 to 65535."],
  ["index.ts", { PORT: "18093", DATABASE_URL: database, LOG_LEVEL: "verbose" }, "LOG_LEVEL must be fatal, error, warn, info, debug, trace or silent."],
  ["index.ts", { PORT: "18093", DATABASE_URL: database, VALOPAY_DATABASE_POOL_SIZE: "1" }, "VALOPAY_DATABASE_POOL_SIZE must be a whole number from 2 to 100."],
  ["index.ts", { PORT: "18093", DATABASE_URL: database, VALOPAY_DATABASE_POOL_SIZE: "0010" }, "VALOPAY_DATABASE_POOL_SIZE must be a whole number from 2 to 100."],
  ["index.ts", { PORT: "18093", DATABASE_URL: database, VALOPAY_CLOSE_SCHEDULER: "false" }, "VALOPAY_CLOSE_SCHEDULER must be on, off or external (in any case)."],
  ["index.ts", { PORT: "18093" }, "DATABASE_URL is required: the PostgreSQL connection URL."],
  ["index.ts", { PORT: "18093", DATABASE_URL: database, CLERK_JWT_KEY: jwtKey.trim().replaceAll("\n", "\\n") }, escaped],
  ["close-pass.ts", { DATABASE_URL: database, VALOPAY_RUNTIME_ISOLATION: "on" }, "VALOPAY_RUNTIME_ISOLATION must be off or staging."],
  ["index.ts", { PORT: "18093", DATABASE_URL: database, VALOPAY_FINANCIAL_PROJECTION: "synthetic-secret" }, "VALOPAY_FINANCIAL_PROJECTION must be off or staging."],
  ["index.ts", { PORT: "18093", DATABASE_URL: database, VALOPAY_FINANCIAL_PROJECTION: "staging" }, financialSchemaProblem],
  ["close-pass.ts", { DATABASE_URL: database, VALOPAY_FINANCIAL_PROJECTION: "staging", VALOPAY_FINANCIAL_PROJECTION_SCHEMA: "public" }, financialSchemaProblem],
];
for (const [entry, env, problem] of refusals) {
  const refused = start(entry, env);
  const status = await refused.exited, { stdout, stderr } = refused.output();
  assert.equal(status, 1, `${entry} ${JSON.stringify(env)}: ${stdout}${stderr}`);
  const lines = stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `one line, nothing before it: ${stdout}`);
  const fatal = JSON.parse(lines[0]!);
  assert.deepEqual([fatal.level, fatal.event, fatal.problems], [60, "config.invalid", [problem]]);
  assert.doesNotMatch(stderr, /\n\s+at /, "no stack");
  checks += 4;
}

// OFF and External, in any case: the health answer and the log say which, nothing is scheduled, and the background
// worker thread starts with the export worker alone.
for (const [value, state, event] of [["OFF", "off", "scheduler.off"], ["External", "external", "scheduler.external"]] as const) {
  const free = createServer();
  free.listen(0, "127.0.0.1");
  await once(free, "listening");
  const port = (free.address() as { port: number }).port;
  free.close();
  const server = start("index.ts", { PORT: String(port), DATABASE_URL: database, VALOPAY_CLOSE_SCHEDULER: value, LOG_FORMAT: "json", CLERK_SECRET_KEY: "sk_test_placeholder", CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.example.test$").toString("base64")}`, CLERK_TELEMETRY_DISABLED: "1" });
  try {
    let health: { scheduler?: { state?: string } } | undefined;
    for (let attempt = 0; attempt < 100 && !health; attempt++) {
      health = await fetch(`http://127.0.0.1:${port}/api/healthz`).then((response) => response.ok ? response.json() as Promise<typeof health> : undefined, () => undefined);
      if (!health) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(health?.scheduler?.state, state, server.output().stdout);
    const lines = () => server.output().stdout.split("\n").filter((text) => text.startsWith("{")).map((text) => JSON.parse(text) as Record<string, unknown>);
    for (let wait = 0; wait < 50 && !lines().some((line) => line.event === "background.started"); wait++) await new Promise((resolve) => setTimeout(resolve, 100));
    const events = lines().map((line) => line.event);
    assert.ok(events.includes(event) && !events.includes("scheduler.started"), `${value}: ${events.join(",")}`);
    assert.deepEqual(lines().filter((line) => line.event === "background.started").map((line) => [line.closes, line.exports]), [[false, true]], `${value}: the thread runs the export worker and no scheduled close`);
    checks += 3;
  } finally {
    server.child.kill("SIGTERM");
    await server.exited;
  }
}

// ---- The export worker: slower looks at a queue that cannot be read, and two lines for the whole outage ----
assert.deepEqual([0, 1, 2, 3, 6, 7, 40].map((failures) => exportQueueDelay(failures, 1500)), [1500, 3000, 6000, 12000, 60000, 60000, 60000]);
assert.equal(EXPORT_QUEUE_MAX_BACKOFF_MS, 60_000);
checks += 2;
const logged: Array<Record<string, unknown>> = [];
const log = { info: (fields: Record<string, unknown>) => logged.push({ level: "info", ...fields }), error: (fields: Record<string, unknown>) => logged.push({ level: "error", ...fields }) } as any;
let looks = 0, failedLooks = 0, failing = true;
const outage = new Error("connect ECONNREFUSED 127.0.0.1:1");
const repository = { queueEnd: async () => undefined, candidates: async () => { looks += 1; if (failing) { failedLooks += 1; throw outage; } return []; } } as any;
const worker = startExportWorker({ intervalMs: 10, maxBackoffMs: 80, log, repository });
await new Promise((resolve) => setTimeout(resolve, 400));
// Without the backoff a look every 10 ms is about 40 looks; with it, 0, 20, 60, 140, 220 and 300 ms.
assert.ok(looks >= 3 && looks <= 8, `looks while failing: ${looks}`);
failing = false;
for (let wait = 0; wait < 50 && !logged.some((line) => line.event === "export.queue_recovered"); wait++) await new Promise((resolve) => setTimeout(resolve, 20));
worker.stop();
await worker.settle();
assert.deepEqual(logged.map((line) => [line.level, line.event]), [["error", "export.queue_error"], ["info", "export.queue_recovered"]]);
assert.equal(logged[0]!.err, outage);
assert.equal(logged[0]!.retryInMs, 20);
assert.equal(logged[1]!.failures, failedLooks);
checks += 5;

console.log(`Startup configuration checks passed (${checks}): every setting checked once with one fatal line that names it and never its value, the close scheduler's switch in any case and refusing anything but on, off or external, Clerk's JWT key checked as Clerk reads it and required on a staff host, the sign-in proxy's limits read as the proxy reads them with room for eight networks at their limit, off and external starting the thread without the scheduled close, and an export queue outage slowing the worker's looks and logged once when it starts and once when it ends.`);
