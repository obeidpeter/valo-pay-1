/** Clerk-compatible JWT public-key parsing shared by startup validation and identity fingerprints. */
import { createPublicKey, type KeyObject } from "node:crypto";

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
export function jwtKeyProblem(value: string): string | undefined {
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


export function clerkPublicKey(value: string): KeyObject {
  const problem = jwtKeyProblem(value);
  if (problem) throw new Error(problem);
  return rsaKey(clerkModulus(value))!;
}
