import type { Request, Response } from "express";
import { sha256Hex } from "./digests";
import { deploymentEnvironment, RETAINED_ORIGIN } from "./product-identity";

/**
 * The anonymous sandbox's cookie holds a 32-byte random token; the sandbox is
 * found by its digest, never by the token. On a secure request the cookie is
 * `__Host-valo-pay-1_<environment>_sandbox`: Secure, Path=/ and no Domain, so no other host, a
 * sibling subdomain included, can set or shadow it. On a plain-HTTP request (a
 * local run) it uses the same versioned environment name without __Host-. Every answer renews it for its lifetime.
 */
export const SANDBOX_COOKIE = `valo-pay-1_${deploymentEnvironment()}_sandbox`;
export const HOST_SANDBOX_COOKIE = `__Host-${SANDBOX_COOKIE}`;
/** The oldest cookie name, retained only so it can be removed and never forwarded to a provider. */
export const LEGACY_SANDBOX_COOKIE = "valo_sandbox";
/** Exact former names are compatibility identifiers, never defaults for this generation. */
export const PREVIOUS_SANDBOX_COOKIE = "valopay_sandbox";
export const PREVIOUS_HOST_SANDBOX_COOKIE = "__Host-valopay_sandbox";
const TOKEN = /^[a-f0-9]{64}$/;

/** The principal an anonymous sandbox's token stands for. */
export const sandboxPrincipal = (token: string): string => sha256Hex(`demo:${token}`);

/** A secure request: TLS here, or at the host's edge, which says so in X-Forwarded-Proto. */
export const secureRequest = (req: Pick<Request, "secure" | "headers">): boolean => Boolean(req.secure) || req.headers["x-forwarded-proto"] === "https";

/** Every value the Cookie header carries under a name, in order. */
function cookieValues(header: string, name: string): string[] {
  return header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`)).map((part) => part.slice(name.length + 1));
}

/** Every name the sandbox's token is sent under: the current ones and the legacy one. */
const SANDBOX_COOKIE_NAMES: readonly string[] = [HOST_SANDBOX_COOKIE, SANDBOX_COOKIE, LEGACY_SANDBOX_COOKIE, PREVIOUS_SANDBOX_COOKIE, PREVIOUS_HOST_SANDBOX_COOKIE];
/**
 * A Cookie header without the sandbox's cookies, for a request this API passes
 * to another service (the Clerk proxy): the token is this API's bearer
 * credential and never another service's. Undefined when nothing else is left.
 */
export function withoutSandboxCookies(header: string): string | undefined {
  const nameOf = (part: string) => { const equals = part.indexOf("="); return (equals === -1 ? part : part.slice(0, equals)).trim(); };
  const kept = header.split(";").map((part) => part.trim()).filter((part) => {
    const name = nameOf(part);
    return part && !SANDBOX_COOKIE_NAMES.includes(name) && !/^(?:__Host-)?valo-pay-1_(?:development|test|staging|production)_sandbox$/.test(name);
  });
  return kept.length ? kept.join("; ") : undefined;
}

/** What a request's cookies say about its sandbox. */
export interface SandboxCookie {
  /** The cookie's name for this request. */
  name: string;
  /** The token that names the sandbox, when the request carries one. */
  token?: string;
  /** Older cookies the request carries, which the answer clears. */
  stale: string[];
}

/**
 * Which sandbox a request's cookies name. The current name decides when it
 * carries a token; on a secure request only this host can have set it, so a
 * cookie under an older name is ignored and cleared unless the explicit,
 * bounded transition below permits the former host-only secure cookie.
 * A plain old cookie cannot prove it came from this host and is never migrated.
 * Two different tokens under the name that decides are refused (400), not
 * guessed between: a cookie planted for a parent domain with a longer path is
 * sent first, and taking it would put the visitor in a sandbox someone else
 * can read. A value that is not a token names no sandbox and is ignored.
 */
export function readSandboxCookie(header: string | undefined, secure: boolean, requestOrigin?: string, env: Record<string, string | undefined> = process.env, now = Date.now()): SandboxCookie {
  const cookies = header ?? "";
  const name = secure ? HOST_SANDBOX_COOKIE : SANDBOX_COOKIE;
  const older = [...(secure ? [SANDBOX_COOKIE] : []), PREVIOUS_HOST_SANDBOX_COOKIE, PREVIOUS_SANDBOX_COOKIE, LEGACY_SANDBOX_COOKIE];
  const stale = older.filter((old) => cookieValues(cookies, old).length > 0);
  {
    const tokens = [...new Set(cookieValues(cookies, name).filter((value) => TOKEN.test(value)))];
    if (tokens.length > 1) throw Object.assign(new Error("This browser sent two different sandbox cookies, so it is not clear which sandbox is yours. Clear this site's cookies, then reload the page."), { status: 400 });
    if (tokens.length === 1) return { name, token: tokens[0], stale };
  }
  // Only a host-only secure bearer issued by this exact retained host can move, within the reviewed window.
  // The digest remains unchanged, retaining the existing workspace and audit history. The response expires the old name.
  // An old plain/Domain cookie is never evidence of ownership, and another host cannot opt into this transition.
  const deadline = Date.parse(env.VALO_PAY_1_LEGACY_COOKIE_UNTIL || "");
  if (secure && requestOrigin === RETAINED_ORIGIN && env.VALO_PAY_1_LEGACY_COOKIE_ORIGIN === RETAINED_ORIGIN && deadline > now && deadline - now <= 30 * 86400_000) {
    const tokens = [...new Set(cookieValues(cookies, PREVIOUS_HOST_SANDBOX_COOKIE).filter(value => TOKEN.test(value)))];
    if (tokens.length > 1) throw Object.assign(new Error("This browser sent two different legacy sandbox cookies. Clear this site's cookies, then reload the page."), { status: 400 });
    if (tokens.length === 1) return { name, token: tokens[0], stale };
  }
  return { name, stale };
}

/** A request may choose only its host, never an arbitrary origin for the legacy-cookie transition. */
export function sandboxRequestOrigin(req: Pick<Request, "secure" | "headers">): string | undefined {
  if (!secureRequest(req)) return undefined;
  const host = req.headers.host;
  try { return host && !/[\s,/@\\]/.test(host) ? new URL(`https://${host}`).origin : undefined; } catch { return undefined; }
}

/** The token a request's cookies name, or undefined when they name none or two; for the request limit, which never refuses on its own account. */
export function sandboxTokenOf(req: Pick<Request, "secure" | "headers">): string | undefined {
  try { return readSandboxCookie(req.headers.cookie, secureRequest(req), sandboxRequestOrigin(req)).token; } catch { return undefined; }
}

/** Renews the cookie for `maxAgeMs` and clears the older ones the request carried, the current one first, so a client that keeps only the first cookie keeps the right one. */
export function writeSandboxCookie(res: Pick<Response, "cookie">, cookie: SandboxCookie, token: string, secure: boolean, maxAgeMs: number): void {
  const options = { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
  res.cookie(cookie.name, token, { ...options, maxAge: maxAgeMs });
  for (const stale of cookie.stale) res.cookie(stale, "", { ...options, expires: new Date(0) });
}
