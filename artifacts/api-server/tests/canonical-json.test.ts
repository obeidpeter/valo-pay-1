// One canonical JSON helper (audit item 26). The byte-identity proof: every
// private helper the API and the console used before, copied here verbatim
// from the commit that replaced them (9fdfb59), writes exactly the text of the
// shared module's form that replaced it, for a large set of values: keys whose
// locale order and code-unit order differ, nested objects and arrays,
// undefined, null, dates and numbers, and the same values read back from the
// database. Then the locale proof: the stored digests are the same under any
// host locale, which they were not while helpers called localeCompare.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
const root = path.resolve(import.meta.dirname, "..", "..", "..");
const tsx = path.join(root, "scripts", "node_modules", "tsx", "dist", "cli.mjs");
const REPORT = process.env.VALO_PAY_1_CANONICAL_JSON_REPORT === "1";

// Windows does not use LANG/LC_ALL for ICU's default locale. Simulate only
// the default-locale entry points there; explicit locales still use the real
// ICU implementation. Linux CI continues to exercise actual process locales.
// Without this adapter the en-US bootstrap below recursively spawned itself.
if (process.platform === 'win32') {
  const locale = REPORT ? String(process.env.LC_ALL || 'en_US').split('.')[0]!.replace('_', '-') : 'en-US';
  const NativeCollator = Intl.Collator, compare = String.prototype.localeCompare;
  Intl.Collator = new Proxy(NativeCollator, {
    construct(target, args) { return Reflect.construct(target, [args[0] ?? locale, args[1]]); },
    apply(target, receiver, args) { return Reflect.apply(target, receiver, [args[0] ?? locale, args[1]]); },
  });
  String.prototype.localeCompare = function(other: string, locales?: Intl.LocalesArgument, options?: Intl.CollatorOptions) { return compare.call(this, other, locales ?? locale, options); };
}

// The legacy copies call localeCompare, so the comparison is made where
// earlier builds ran: a host whose default locale is en-US.
if (!REPORT && new Intl.Collator().resolvedOptions().locale !== "en-US") {
  const result = spawnSync(process.execPath, [tsx, import.meta.filename], { cwd: root, env: { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" }, stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const { canonicalJson, canonicalJsonForms, legacyCollatedCompare, codeUnitCompare, sameJson, LEGACY_COLLATION_LOCALE } = await import("@workspace/valo-pay-1-schema");
const { requestFingerprint, auditEntryData, verifyAuditChain, walkAuditChain, canonicalDigest, sha256Hex } = await import("../src/lib/digests.js");
const { cashEvidenceHash } = await import("../src/domain/connected-cash.js");
const { appendAudit, verifyAudit } = await import("../src/lib/valo-pay-1-store.js");
const { lifecyclePolicy, lifecycleHolds, lifecycleCandidates } = await import("../src/domain/lifecycle.js");
const { personalWorkItems } = await import("../src/domain/personal-work.js");
const { sourceFileId } = await import("../src/domain/source-completeness.js");
const { decisionFingerprint } = await import("../src/domain/policy-engine.js");
const { seedMerchant } = await import("../src/lib/valo-pay-1-seed.js");
type DomainState = import("../src/domain/types.js").DomainState;

// ---- The helpers this module replaced, verbatim (only renamed) ----
/* eslint-disable */
// artifacts/api-server/src/lib/valo-pay-1-store.ts (the audit chain, request fingerprints, save digests, guards)
function storeCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(storeCanonical).join(",")}]`;
  // Preserve the historical byte format regardless of JSONB key order.
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${storeCanonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
// artifacts/api-server/src/lib/pilot-staging-store.ts (since removed with the staging rehearsal)
const stagingCanonical = (value: any): string => Array.isArray(value) ? `[${value.map(stagingCanonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stagingCanonical(item)}`).join(',')}}` : JSON.stringify(value) ?? 'null';
// artifacts/api-server/src/domain/close-review.ts
const closeReviewCanonical = (value: any): string => Array.isArray(value) ? `[${value.map(closeReviewCanonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${closeReviewCanonical(value[key])}`).join(",")}}` : JSON.stringify(value) ?? "null";
// artifacts/api-server/src/domain/source-completeness.ts
const sourceCanonical = (value: any): string => Array.isArray(value) ? `[${value.map(sourceCanonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${sourceCanonical(value[key])}`).join(",")}}` : JSON.stringify(value) ?? "null";
// artifacts/api-server/src/domain/policy-engine.ts (item 13's retry-decision fingerprint)
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? "null" : stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
// artifacts/api-server/src/providers/paystack-inbox.ts
const paystackCanonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
// artifacts/api-server/src/lib/recovery-manifest.ts
const recoveryCanonical = (value: unknown): string => JSON.stringify(value, (_key,item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item);
// artifacts/api-server/src/lib/valo-pay-1-import.ts (inline, before hashing)
const importRowJson = (record: unknown) => JSON.stringify(record, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
// artifacts/api-server/src/domain/personal-work.ts
function workCanonical(value: unknown): string { return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item); }
// artifacts/api-server/src/domain/lifecycle.ts
const lifecycleCanonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
// artifacts/api-server/src/domain/import-corrections.ts
const correctionCanonical = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
// artifacts/api-server/src/domain/connected-cash.ts
function cashStable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(cashStable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${cashStable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
// artifacts/api-server/src/domain/connected-credit.ts
function creditCanonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(creditCanonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${creditCanonical(item)}`)
    .join(",")}}`;
}
// artifacts/valo-pay-1/src/lib/safe-mutations.ts
function submissionFingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
// artifacts/valo-pay-1/tests/fake-api.ts
const fakeApiCanonical = (value: unknown): string => JSON.stringify(value, (_key, item) => (item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : item));
/* eslint-enable */

// ---- Values ----
// Keys whose en-US order differs from their code-unit order (case, underscores,
// digits, accents, canonically equivalent spellings) or from other locales'.
const trickyKeys = [
  "a", "A", "b", "B", "z", "Z", "_a", "a_b", "ab", "aB", "Ab", "a1", "a10", "a9", "0", "1", "2", "9", "10", "01", "-1", "1.5",
  "é", "e", "f", "E", "é", "ä", "Ä", "zeta", "ärende", "checksum", "hash", "hint", "aabenraa", "tab", "zone", "j", "y",
  "I", "i", "ı", "İ", "ß", "ss", "changeDigest", "changedAt", "objectId", "objectid", "$x", "-x", " x", "x ", "", "😀", " ",
  "amountKobo", "amount_kobo", "amount", "Amount", "customerId", "customer_id", "R1", "R10", "R2", "r1", "toJSON", "__proto__",
];
let seed = 0x2026_0923;
const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const leaves: unknown[] = [
  null, true, false, 0, -0, 1, -1, 1.5, 0.1 + 0.2, 1e21, 1e-7, 2 ** 53, -(2 ** 53), Number.MAX_VALUE, Number.MIN_VALUE, NaN, Infinity, -Infinity,
  "", "text", "quote \" and \\ backslash", "line\nbreak\ttab", "\u0000\u001f", "é", "é", "😀", "\ud800", "</script>", "2026-09-23T07:00:00.000Z",
  undefined,
];
/** JSON data as the database returns it, plus undefined values, which an object being written can hold. */
function randomValue(depth: number, exotic: boolean): unknown {
  const roll = random();
  if (depth <= 0 || roll < 0.35) {
    if (exotic && roll < 0.04) return pick([new Date(Date.UTC(2026, 8, 23, 7)), new Date(Number.NaN)]);
    return pick(leaves);
  }
  if (roll < 0.6) return Array.from({ length: Math.floor(random() * 5) }, () => randomValue(depth - 1, exotic));
  const object: Record<string, unknown> = {};
  for (let count = Math.floor(random() * 7); count > 0; count -= 1) Object.defineProperty(object, pick(trickyKeys), { value: randomValue(depth - 1, exotic), enumerable: true, configurable: true, writable: true });
  return object;
}
const readBack = (value: unknown): unknown => { const text = JSON.stringify(value); return text === undefined ? undefined : JSON.parse(text); };
const own = (entries: Array<[string, unknown]>) => { const object: Record<string, unknown> = {}; for (const [key, value] of entries) Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true }); return object; };

const fixed: unknown[] = [
  undefined, null, 0, -0, NaN, "", [], {}, [undefined], [null, undefined, [undefined]], { a: undefined }, { a: undefined, b: null },
  own(trickyKeys.map((key, index) => [key, index])), own([...trickyKeys].reverse().map((key, index) => [key, { [key]: [index, undefined, null] }])),
  { nested: { deeper: { deepest: [{ Z: 1, a: 2, _b: 3, "10": 4, "9": 5 }] } } },
  // Shapes the platform stores digests of.
  { sequence: 12, actor: "Sandbox Admin", action: "record.create", objectId: "rec-1", summary: "Synthetic", changeDigest: "c".repeat(64), previousHash: "GENESIS", timestamp: "2026-09-23T07:00:00.000Z" },
  { path: "/v1/records/customers", method: "POST", body: { name: "Ada", data: { consentProvenance: "Signed", Zeta: 1, ärende: 2, amount_kobo: 3, amountKobo: 4 } }, actor: "Sandbox Operations" },
  { merchantId: "m-1", policy: { rawCsvDays: 30, journalPayloadDays: null, exportFileDays: 90, auditTrail: "retain" }, recordId: null },
  { id: "batch-1", version: "2026-09-23T07:00:00.000Z", csv: "Name,Amount\nAda,100", preview: [{ row: 2, values: { Name: "Ada", Amount: "100", amount_kobo: "1", ärende: "x" } }] },
];
const corpus = [...fixed, ...Array.from({ length: 2500 }, () => randomValue(4, false))];
const exoticCorpus = [...corpus, ...Array.from({ length: 800 }, () => randomValue(4, true)), new Date(Date.UTC(2026, 8, 23)), [new Date(0)], { at: new Date(0) }, [1, , 3], { fn() { return 1; } }];
const stored = corpus.map(readBack).filter((value) => value !== undefined);
let checks = 0;
const same = (actual: string, expected: string | undefined, message: string) => { checks += 1; assert.equal(actual, expected ?? "null", message); };

if (!REPORT) {
  // ---- 1. The collation is fixed, and it is what production's localeCompare used ----
  assert.equal(LEGACY_COLLATION_LOCALE, "en-US");
  assert.deepEqual(new Intl.Collator(LEGACY_COLLATION_LOCALE).resolvedOptions(), { locale: "en-US", usage: "sort", sensitivity: "variant", ignorePunctuation: false, collation: "default", numeric: false, caseFirst: "false" });
  for (const a of trickyKeys) for (const b of trickyKeys) {
    checks += 2;
    assert.equal(Math.sign(legacyCollatedCompare(a, b)), Math.sign(a.localeCompare(b)), `en-US order of ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
    assert.equal(Math.sign(codeUnitCompare(a, b)), a === b ? 0 : [a, b].sort()[0] === a ? -1 : 1);
  }
  assert.deepEqual([...canonicalJsonForms], ["canonical", "legacy-en-us-null", "legacy-code-unit-null", "legacy-en-us-omit", "legacy-en-us-replacer"]);

  // ---- 2. Each legacy form is byte for byte the helpers it replaced, dates, undefined and holes included ----
  for (const value of exoticCorpus) {
    const text = (form: Parameters<typeof canonicalJson>[1]) => canonicalJson(value, form);
    same(text("legacy-en-us-null"), storeCanonical(value), "store canonical");
    same(text("legacy-en-us-null"), stagingCanonical(value), "staging canonical");
    same(text("legacy-code-unit-null"), closeReviewCanonical(value), "close review canonical");
    same(text("legacy-code-unit-null"), sourceCanonical(value), "source completeness canonical");
    same(text("legacy-en-us-omit"), cashStable(value), "connected cash stable");
    for (const legacy of [paystackCanonical, recoveryCanonical, importRowJson, workCanonical, lifecycleCanonical, correctionCanonical, submissionFingerprint, fakeApiCanonical]) {
      same(text("legacy-en-us-replacer"), legacy(value), `${legacy.name} replacer form`);
    }
    // Connected credit's copy differed from connected cash's only for a function or symbol, which parsed evidence cannot hold.
    if (!JSON.stringify(value, (_key, item) => (typeof item === "function" ? "<fn>" : item))?.includes("<fn>")) same(text("legacy-en-us-omit"), creditCanonical(value), "connected credit canonical");
  }
  // One deliberate difference: the replacer helpers returned undefined, not text, for a bare undefined, which no caller
  // could hash (hashing undefined throws). Every form now writes it as null.
  assert.equal(lifecycleCanonical(undefined), undefined);
  assert.equal(canonicalJson(undefined, "legacy-en-us-replacer"), "null");

  // ---- 3. The canonical form is item 13's fingerprint and the close review digest for everything the database returns ----
  for (const value of [...corpus, ...stored]) {
    same(canonicalJson(value), stableJson(value), "retry-decision fingerprint");
  }
  for (const value of stored) {
    same(canonicalJson(value), closeReviewCanonical(value), "close review digest of a stored record");
  }
  // Where they differ, canonical writes what the database will keep; the earlier helpers wrote text no stored value reproduces.
  const date = new Date(Date.UTC(2026, 8, 23, 7));
  assert.equal(canonicalJson({ at: date }), '{"at":"2026-09-23T07:00:00.000Z"}');
  assert.equal(stableJson({ at: date }), '{"at":{}}');
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(closeReviewCanonical({ a: undefined, b: 1 }), '{"a":null,"b":1}');
  assert.equal(canonicalJson([1, , 3]), "[1,null,3]");
  for (const value of exoticCorpus) {
    const back = readBack(value);
    if (back !== undefined) { checks += 1; assert.equal(canonicalJson(back), canonicalJson(value), "canonical text survives the database round trip"); }
    // It is the JSON value JSON.stringify writes, only with its keys sorted.
    checks += 1;
    assert.deepEqual(JSON.parse(canonicalJson(value)), JSON.parse(JSON.stringify(value) ?? "null"));
  }
  // Key order never matters, and code units, not a locale, decide it.
  assert.equal(canonicalJson({ b: 1, a: 2, B: 3, _: 4, "10": 5, "9": 6, é: 7 }), '{"10":5,"9":6,"B":3,"_":4,"a":2,"b":1,"é":7}');
  assert.equal(canonicalJson(JSON.parse('{"__proto__":1,"toJSON":2}')), '{"__proto__":1,"toJSON":2}');
  assert.ok(sameJson({ a: 1, b: [1, { c: 2, d: undefined }] }, { b: [1, { c: 2 }], a: 1 }));
  assert.ok(!sameJson({ a: null }, {}));
  // The historical bytes the store's guard test pinned.
  assert.equal(canonicalJson({ b: 2, a: 1 }, "legacy-en-us-null"), '{"a":1,"b":2}');

  // ---- 4. The digest module keeps the stored digests ----
  const body = { sequence: 1, actor: "System", action: "test", objectId: "workspace", summary: "Synthetic test", changeDigest: sha256Hex(storeCanonical({ Zeta: 1, ärende: [2, { B: 3, a: 4 }] })), previousHash: "GENESIS", timestamp: "2026-01-01T00:00:00.000Z" };
  const entry = auditEntryData({ ...body, changes: { Zeta: 1, ärende: [2, { B: 3, a: 4 }] } });
  assert.deepEqual(entry, { ...body, hash: sha256Hex(storeCanonical(body)) }, "the audit entry is the one the three builders wrote");
  assert.deepEqual(Object.keys(entry), ["sequence", "actor", "action", "objectId", "summary", "changeDigest", "previousHash", "timestamp", "hash"]);
  const request = { path: "/v1/actions", method: "POST", body: { action: "set_role", Zeta: 1, ärende: 2, _x: [3] }, actor: "Sandbox role switch" };
  assert.equal(requestFingerprint(request), sha256Hex(storeCanonical(request)), "a replay of a stored request fingerprint still matches");
  assert.equal(canonicalDigest(request, "legacy-en-us-replacer"), sha256Hex(lifecycleCanonical(request)));
  const second = auditEntryData({ sequence: 2, actor: "System", action: "next", objectId: "rec-2", summary: "Next", previousHash: entry.hash, timestamp: "2026-01-01T00:00:01.000Z" });
  assert.deepEqual(verifyAuditChain([{ data: readBack(second) as Record<string, unknown> }, { data: readBack(entry) as Record<string, unknown> }]), { valid: true, count: 2, headHash: second.hash });
  assert.equal(verifyAuditChain([{ data: { ...entry, summary: "Tampered" } }]).valid, false);
  // A sequence two entries claim (a fork: two writers each took the next one) breaks the chain before it: neither
  // entry is verified, so a check that goes on from the last verified place reads both again.
  const fork = auditEntryData({ sequence: 2, actor: "System", action: "fork", objectId: "rec-3", summary: "Fork", previousHash: entry.hash, timestamp: "2026-01-01T00:00:02.000Z" });
  for (const order of [[entry, second, fork], [fork, entry, second]]) assert.deepEqual(verifyAuditChain(order.map((data) => ({ data }))), { valid: false, count: 3, headHash: entry.hash }, "a fork breaks the chain before its sequence");
  assert.deepEqual(walkAuditChain([{ data: second }, { data: fork }], { sequence: 1, hash: entry.hash }).verified, { sequence: 1, hash: entry.hash }, "a walk from a verified place stays before the fork");
  {
    // An entry whose sequence is not a whole number from 1 (null, a word, a fraction, a missing key, text, zero) is
    // itself a break where the walk meets it: whole-number sequences go in order and every other entry after them,
    // whatever order the entries come in. So the walk stops at the place the damaged entry left in the chain, never
    // at entry 1, and never past a bad entry.
    const chain: Array<Record<string, any>> = [];
    for (let sequence = 1; sequence <= 7; sequence++) chain.push(auditEntryData({ sequence, actor: "System", action: "shape", objectId: `rec-${sequence}`, summary: "Shape", previousHash: chain.at(-1)?.hash, timestamp: `2026-01-01T00:00:0${sequence}.000Z` }));
    const orders = <T>(items: T[], damaged: T) => [items, [...items].reverse(), [damaged, ...items.filter((item) => item !== damaged)], [...items.filter((item) => item !== damaged), damaged], [...items.slice(2), ...items.slice(0, 2)]];
    const shapes: Array<[string, (sequence: number) => unknown]> = [["null", () => null], ["a word", () => "abc"], ["a fraction", (sequence) => sequence + 0.5], ["a missing key", () => undefined], ["text", (sequence) => String(sequence)], ["zero", () => 0], ["a negative number", (sequence) => -sequence]];
    for (const [label, value] of shapes) for (const place of [3, 7]) {
      const damaged: Record<string, any> = { ...chain[place - 1]!, sequence: value(place) };
      if (damaged.sequence === undefined) delete damaged.sequence;
      const entries = chain.map((data, index) => ({ data: index === place - 1 ? damaged : data }));
      for (const order of orders(entries, entries[place - 1]!)) {
        checks += 1;
        const walked = walkAuditChain(order);
        assert.deepEqual([walked.valid, walked.verified, walked.count], [false, { sequence: place - 1, hash: chain[place - 2]!.hash }, 7], `a sequence of ${label} at entry ${place} breaks the chain there`);
      }
    }
    // A damaged entry stored between two entries at one sequence (a fork) does not keep them apart: the walk from the
    // entry before them stops before the fork, as it does without the damaged entry.
    const forked = auditEntryData({ sequence: 6, actor: "System", action: "fork", objectId: "fork", summary: "Fork", previousHash: chain[4]!.hash, timestamp: "2026-01-01T00:00:09.000Z" });
    const word = { ...auditEntryData({ sequence: 0, actor: "Damaged", action: "damaged", objectId: "x", summary: "Damaged", previousHash: chain[5]!.hash, timestamp: "2026-01-01T00:00:08.000Z" }), sequence: "abc" };
    const window = [{ data: chain[5]! }, { data: word }, { data: forked }];
    for (const order of orders(window, window[1]!)) {
      checks += 1;
      assert.deepEqual(walkAuditChain(order, { sequence: 5, hash: chain[4]!.hash }).verified, { sequence: 5, hash: chain[4]!.hash }, "a damaged entry beside a fork does not hide it");
    }
    // Text that names a whole number is not that number: after a whole chain it is a break of its own, never a fork.
    const text = { ...auditEntryData({ sequence: 8, actor: "Damaged", action: "damaged", objectId: "y", summary: "Damaged", previousHash: chain[6]!.hash, timestamp: "2026-01-01T00:00:08.000Z" }), sequence: "7" };
    checks += 1;
    assert.deepEqual(walkAuditChain([text, ...chain].map((data) => ({ data }))).verified, { sequence: 7, hash: chain[6]!.hash }, "a whole chain followed by a damaged entry verifies to its end");
  }
  {
    // A chain written before this change verifies: a store-built entry, its keys in JSONB order.
    const state = seedMerchant("canonical-json");
    appendAudit(state, { actor: "System", role: "Admin", now: "2026-01-01T00:00:00.000Z" }, "test", "workspace", "Synthetic test", { Zeta: 1, ärende: 2 });
    const audit = state.records.filter((record) => record.kind === "audit").at(-1)!;
    const { hash, ...legacyBody } = audit.data;
    assert.equal(hash, sha256Hex(storeCanonical(legacyBody)));
    assert.equal(audit.data.changeDigest, sha256Hex(storeCanonical({ Zeta: 1, ärende: 2 })));
    audit.data = Object.fromEntries(Object.entries(audit.data).sort(([a], [b]) => a.length - b.length || codeUnitCompare(a, b)));
    assert.equal(verifyAudit(state).valid, true);
  }
}

// ---- 5. Every stored digest is the same under any host locale ----
/** The digests one host computes for fixed synthetic evidence whose keys other locales order differently. */
function report() {
  const evidence = { zeta: 1, ärende: 2, hash: 3, checksum: 4, b: 5, aabenraa: 6, tab: 7, zone: 8, j: 9, y: 10, I: 11, i: 12, ı: 13, nested: [{ Ä: 1, A: 2, Z: 3 }] };
  const state: DomainState = seedMerchant("canonical-json-locale");
  const at = "2026-09-01T07:00:00.000Z", now = "2026-09-23T07:00:00.000Z";
  state.records.push({ id: "batch-locale", merchantId: state.merchant.id, kind: "import-batches", name: "Locale batch", status: "committed", reference: "", amountKobo: 0, customerId: "", createdAt: at, updatedAt: at,
    data: { csv: "zeta,ärende\n1,2", committedAt: at, check: { preview: [{ row: 2, values: evidence }] } } });
  state.records.push({ id: "hold-locale", merchantId: state.merchant.id, kind: "retention-holds", name: "Hold", status: "recorded", reference: "", amountKobo: 0, customerId: "", createdAt: at, updatedAt: at,
    data: { kind: "raw_csv", sourceId: "batch-locale", held: true, reason: "Locale", actor: "Sandbox Admin", sequence: 1, ...evidence } });
  state.records.push({ id: "case-locale", merchantId: state.merchant.id, kind: "exceptions", name: "Locale case", status: "assigned", reference: "", amountKobo: 0, customerId: "", createdAt: at, updatedAt: at,
    data: { type: "unmatched_payment", case: { assignee: "Sandbox Operations", assigneeName: "Ops", nextAction: "Call", nextActionAt: now, evidenceIds: [], ...evidence } } });
  appendAudit(state, { actor: "System", role: "Admin", now }, "locale", "workspace", "Locale", evidence);
  const people = [{ actor: "Sandbox Operations", name: "Ops", role: "Operations" }];
  const ctx = { actor: "Sandbox Operations", role: "Operations", now };
  return {
    locale: new Intl.Collator().resolvedOptions().locale,
    module: Object.fromEntries(canonicalJsonForms.map((form) => [form, canonicalJson(evidence, form)])),
    sorted: [...Object.keys(evidence)].sort(legacyCollatedCompare),
    stored: {
      requestFingerprint: requestFingerprint({ path: "/v1/actions", method: "POST", body: evidence, actor: "Sandbox Admin" }),
      auditEntry: auditEntryData({ sequence: 1, actor: "System", action: "locale", objectId: "workspace", summary: "Locale", changes: evidence, timestamp: now }).hash,
      appendAudit: state.records.filter((record) => record.kind === "audit").at(-1)!.data.hash,
      cashEvidence: cashEvidenceHash(evidence),
      retentionPolicy: lifecyclePolicy(state).revision,
      retentionHolds: lifecycleHolds(state).revision,
      retentionCandidate: lifecycleCandidates(state)[0]?.digest,
      workItem: personalWorkItems(state, ctx, people).find((item) => item.sourceId === "case-locale")?.sourceDigest,
      sourceFile: sourceFileId("2026-09-23", { source: "ärende", kind: "zeta", sourceBatchId: "hash" }),
      retryDecision: decisionFingerprint({ dueItemId: "due-1", decision: "blocked", rule: "window", policyId: "policy-1", policyVersion: 1, inputs: evidence }),
    },
    legacy: { store: storeCanonical(evidence), replacer: lifecycleCanonical(evidence), cash: cashStable(evidence) },
  };
}
if (REPORT) {
  console.log(JSON.stringify(report()));
  process.exit(0);
}
const here = report();
assert.equal(here.locale, "en-US");
const hazards: string[] = [];
for (const locale of ["sv_SE.UTF-8", "cs_CZ.UTF-8", "da_DK.UTF-8", "et_EE.UTF-8", "lt_LT.UTF-8", "tr_TR.UTF-8"]) {
  const child = spawnSync(process.execPath, [tsx, import.meta.filename], { cwd: root, encoding: "utf8", env: { ...process.env, VALO_PAY_1_CANONICAL_JSON_REPORT: "1", LC_ALL: locale, LANG: locale } });
  assert.equal(child.status, 0, child.stderr);
  const there = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
  if (there.locale === "en-US") continue; // This Node has no data for the locale: nothing to compare.
  checks += 1;
  assert.deepEqual({ module: there.module, sorted: there.sorted, stored: there.stored }, { module: here.module, sorted: here.sorted, stored: here.stored }, `digests under ${locale}`);
  if (JSON.stringify(there.legacy) !== JSON.stringify(here.legacy)) hazards.push(there.locale);
}
// The hazard was real: under these locales the old helpers wrote different text.
assert.ok(hazards.length >= 3, `localeCompare helpers differed under ${hazards.join(", ") || "no locale"}`);

// ---- 6. No private helper comes back ----
const walk = (dir: string): string[] => readdirSync(path.join(root, dir)).flatMap((entry) => {
  const file = `${dir}/${entry}`;
  return statSync(path.join(root, file)).isDirectory() ? walk(file) : /\.(?:ts|tsx|mjs)$/.test(file) ? [file] : [];
});
const sources = ["artifacts/api-server/src", "artifacts/valo-pay-1/src", "lib/valo-pay-1-schema/src", "scripts/src"].flatMap(walk);
for (const file of sources) {
  if (file === "lib/valo-pay-1-schema/src/canonical-json.ts") continue;
  const text = readFileSync(path.join(root, file), "utf8");
  checks += 1;
  // The two shapes every earlier helper had: a sorted key list written with JSON.stringify(key), or a replacer rebuilding sorted objects.
  assert.doesNotMatch(text, /JSON\.stringify\((?:key|k|name)\)\s*\}?:\$\{|Object\.fromEntries\(\s*Object\.entries\([^)]*\)\s*\.sort\(/, `${file} has its own canonical JSON helper; use canonicalJson from @workspace/valo-pay-1-schema`);
}
console.log(`Canonical JSON passed: ${checks} checks; every legacy helper byte-identical over ${exoticCorpus.length} values; the same stored digests under every other locale tried (the old helpers differed under ${hazards.join(", ")}).`);
