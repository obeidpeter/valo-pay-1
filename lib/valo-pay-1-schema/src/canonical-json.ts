/**
 * One canonical JSON for every digest and comparison the platform makes.
 *
 * The canonical form is the text `JSON.stringify` writes with the keys of
 * every object sorted by UTF-16 code unit (the key order of RFC 8785): an
 * undefined, function or symbol object value is left out and becomes null in
 * an array, `toJSON` is honoured (a Date is its ISO string), and a number is
 * written as `JSON.stringify` writes it. That is exactly what PostgreSQL keeps
 * of a value, so a value and the same value read back from the database give
 * the same text, and the order depends on no locale, library or host.
 *
 * Before this module, thirteen private helpers in five variants wrote this
 * JSON. Four of those forms are kept, by name, only because digests computed
 * with them are stored and computed again later (the audit chain, request
 * fingerprints, retention, import-correction, work and connected-banking
 * evidence, source completeness): changing the text would make that stored
 * evidence stop matching. Three of the forms ordered keys with
 * `localeCompare`, so their text followed the host's locale. They now use one
 * fixed collation, en-US, which reproduces what every earlier build computed:
 * Node's default ICU locale is en-US when no locale is set, when `LANG` is C,
 * POSIX or C.UTF-8, and for en_US.UTF-8 (checked with Node 22, ICU 78.2 and
 * CLDR 48; the deployment's `.replit` sets no locale). ICU still defines that
 * collation, so an ICU upgrade could in principle reorder keys made of
 * characters new to Unicode; keys of ASCII and common Latin letters are not
 * affected. New digests use `canonical`, which has no such dependency.
 *
 * | Form | Keys | Undefined object value | toJSON | Used for |
 * |---|---|---|---|---|
 * | `canonical` | code units | left out | honoured | retry-decision fingerprints, close review digests, every comparison |
 * | `legacy-en-us-null` | en-US collation | `null` | ignored | audit entries, request fingerprints |
 * | `legacy-code-unit-null` | code units | `null` | ignored | source completeness |
 * | `legacy-en-us-omit` | en-US collation | left out | ignored | connected cash and credit evidence |
 * | `legacy-en-us-replacer` | integer-like keys first, then en-US collation | left out | honoured | retention, import corrections, work items, import rows |
 */

/** The locale whose collation ordered keys (with `localeCompare`) in the legacy forms: Node's default ICU locale on every host earlier builds ran on. */
export const LEGACY_COLLATION_LOCALE = "en-US";

const legacyCollator = new Intl.Collator(LEGACY_COLLATION_LOCALE);

/**
 * Orders two strings as `a.localeCompare(b)` did on a host whose default
 * locale is en-US, whatever this host's locale: the legacy forms' key order,
 * and the order of the record lists some stored digests cover.
 */
export function legacyCollatedCompare(a: string, b: string): number {
  return legacyCollator.compare(a, b);
}

/** Orders two strings by UTF-16 code unit, as `Array.prototype.sort` does by default: the canonical key order. */
export function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The forms canonical JSON is written in: `canonical`, and the legacy forms stored digests were first computed with. */
export const canonicalJsonForms = ["canonical", "legacy-en-us-null", "legacy-code-unit-null", "legacy-en-us-omit", "legacy-en-us-replacer"] as const;
/** A form canonical JSON is written in; see `canonicalJsonForms` and the table at the top of this module. */
export type CanonicalJsonForm = (typeof canonicalJsonForms)[number];

type Compare = (a: string, b: string) => number;

/** The canonical form: JSON.stringify's value rules, keys by code unit. Undefined for a value JSON.stringify leaves out. */
function canonical(input: unknown, key: string): string | undefined {
  let value = input;
  if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") value = (value as { toJSON: (key: string) => unknown }).toJSON(key);
  if (value instanceof Number || value instanceof String || value instanceof Boolean) value = value.valueOf();
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined": case "function": case "symbol": return undefined;
    case "object": {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let index = 0; index < value.length; index += 1) items.push(canonical(value[index], String(index)) ?? "null");
        return `[${items.join(",")}]`;
      }
      const object = value as Record<string, unknown>, members: string[] = [];
      for (const name of Object.keys(object).sort()) {
        const text = canonical(object[name], name);
        if (text !== undefined) members.push(`${JSON.stringify(name)}:${text}`);
      }
      return `{${members.join(",")}}`;
    }
    default: return JSON.stringify(value);
  }
}

/**
 * The repository's form (`legacy-en-us-null`, and with code units the source
 * completeness form): an undefined object value is written as null, a Date or
 * other object is its own enumerable keys, an array keeps its holes.
 */
function undefinedAsNull(value: unknown, compare: Compare): string {
  if (Array.isArray(value)) return `[${value.map((item) => undefinedAsNull(item, compare)).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${undefinedAsNull(item, compare)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Connected banking's form (`legacy-en-us-omit`): an undefined object value is left out, anything else as `undefinedAsNull`. */
function undefinedOmitted(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(undefinedOmitted).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => legacyCollatedCompare(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${undefinedOmitted(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The pilot evidence form (`legacy-en-us-replacer`): JSON.stringify with a
 * replacer that rebuilds every object with its entries sorted. The rebuilt
 * object still lists integer-like keys first, in numeric order, as every
 * JavaScript object does.
 */
const sortedEntries = (_key: string, item: unknown): unknown =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => legacyCollatedCompare(a, b))) : item;

/**
 * Writes a value as canonical JSON in the named form (`canonical` unless a
 * stored digest needs a legacy form; see the table at the top of this
 * module). A value JSON cannot hold at the top level (undefined, a function)
 * is written as `null`.
 */
export function canonicalJson(value: unknown, form: CanonicalJsonForm = "canonical"): string {
  switch (form) {
    case "canonical": return canonical(value, "") ?? "null";
    case "legacy-en-us-null": return undefinedAsNull(value, legacyCollatedCompare);
    case "legacy-code-unit-null": return undefinedAsNull(value, codeUnitCompare);
    case "legacy-en-us-omit": return undefinedOmitted(value);
    case "legacy-en-us-replacer": return JSON.stringify(value, sortedEntries) ?? "null";
  }
}

/** Whether two values are the same JSON, whatever the order of their keys: equal canonical forms. */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
