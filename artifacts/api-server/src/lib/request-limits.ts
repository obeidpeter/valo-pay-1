import { isIP } from "node:net";
import type { Request, RequestHandler, Response } from "express";
import { signedInUser } from "./staff-access";
import { sandboxPrincipal, sandboxTokenOf } from "./sandbox-cookie";

/**
 * The API's abuse limits: fixed windows counted in this process. A host that
 * runs several instances multiplies every limit by the instances a client's
 * requests reach, and a restart or a scale to zero starts every window
 * afresh. A shared store would cost a database write per request, so these
 * bound what one client can cost one instance, not the fleet (see
 * docs/security-review.md). Every map is bounded: a timer, unreferenced so it
 * never keeps the process alive, drops the windows that have ended, and a full
 * map forgets its oldest window instead of growing, so no request scans one.
 */

/** Requests a minute for one principal: a signed-in person, an anonymous sandbox this process has served, or, for a request that names neither, its client network. One open console tab makes about twelve. */
export const PRINCIPAL_REQUEST_LIMIT = 300;
/** Requests a minute from one client network, whoever sends them: four principals' worth, so rotating cookies or accounts cannot escape the limit. */
export const NETWORK_REQUEST_LIMIT = 4 * PRINCIPAL_REQUEST_LIMIT;
/** The window of the request limits, and what a refused client is told to wait. */
export const REQUEST_WINDOW_MS = 60_000;

/** The eight 16-bit groups of an IPv6 address (an embedded IPv4 tail as the last two), or undefined for anything else. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (isIP(text) !== 6) return undefined;
  const embedded = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (embedded) {
    const [a, b, c, d] = embedded.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, embedded.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const groups = (part: string) => (part ? part.split(":").map((group) => parseInt(group, 16)) : []);
  const left = groups(head), right = tail === undefined ? [] : groups(tail);
  const all = tail === undefined ? left : [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
  return all.length === 8 ? all : undefined;
}

/**
 * The network a client address is counted as: an IPv4 address is itself; an
 * IPv6 address is its first `prefix` bits, since one subscriber or site holds
 * a whole /64 and can pick a new address in it for every request (a /48 is a
 * site's usual allocation); an IPv4-mapped IPv6 address is its IPv4 address.
 * Every value that is not an address shares one key: the host's edge writes
 * addresses, so another value never buys a quota of its own.
 */
export function clientNetwork(address: string | undefined, prefix: 48 | 64 = 64): string {
  const text = (address ?? "").trim();
  if (!text) return "unknown";
  if (isIP(text) === 4) return text;
  const groups = ipv6Groups(text);
  if (!groups) return "invalid";
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) return [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255].join(".");
  return `${groups.slice(0, prefix / 16).map((group) => group.toString(16)).join(":")}::/${prefix}`;
}

/** Fixed-window counts per key, in this process. */
export interface WindowCounter {
  /** Takes one slot of the key's current window; false, taking nothing, when the window is full. */
  take(key: string, nowMs?: number): boolean;
  /** The slots the key has left in its current window. */
  remaining(key: string, nowMs?: number): number;
  /** Refusals of the key in its current window: 1 at the first, so a refusal is logged once per window. */
  refusals(key: string): number;
  /** Drops the windows that have ended. The timer calls it; a request never does. */
  sweep(nowMs?: number): void;
  /** Keys held. */
  readonly size: number;
}

/**
 * A counter bounded twice: a timer drops ended windows (at most once a
 * minute), and past `maxKeys` a new key replaces the key whose window started
 * first. The map is kept in the order windows started, so a sweep stops at the
 * first window still running and a replacement never searches.
 */
export function createWindowCounter(options: { limit: number; windowMs: number; maxKeys?: number }): WindowCounter {
  const { limit, windowMs, maxKeys = 10_000 } = options;
  const windows = new Map<string, { count: number; refused: number; reset: number }>();
  const current = (key: string, nowMs: number) => {
    const running = windows.get(key);
    if (running && running.reset > nowMs) return running;
    if (running) windows.delete(key);
    else if (windows.size >= maxKeys) windows.delete(windows.keys().next().value!);
    const fresh = { count: 0, refused: 0, reset: nowMs + windowMs };
    windows.set(key, fresh);
    return fresh;
  };
  const counter: WindowCounter = {
    take(key, nowMs = Date.now()) {
      const window = current(key, nowMs);
      if (window.count >= limit) { window.refused += 1; return false; }
      window.count += 1;
      return true;
    },
    remaining(key, nowMs = Date.now()) {
      const window = windows.get(key);
      return window && window.reset > nowMs ? Math.max(0, limit - window.count) : limit;
    },
    refusals(key) { return windows.get(key)?.refused ?? 0; },
    sweep(nowMs = Date.now()) {
      for (const [key, window] of windows) {
        if (window.reset > nowMs) break;
        windows.delete(key);
      }
    },
    get size() { return windows.size; },
  };
  setInterval(() => counter.sweep(), Math.min(windowMs, 60_000)).unref();
  return counter;
}

/** Keys seen recently, each forgotten an idle period after it was last seen; bounded like the counters. */
export interface RecentSet {
  add(key: string, nowMs?: number): void;
  has(key: string, nowMs?: number): boolean;
  sweep(nowMs?: number): void;
  readonly size: number;
}
export function createRecentSet(options: { idleMs: number; maxKeys?: number }): RecentSet {
  const { idleMs, maxKeys = 20_000 } = options;
  const seen = new Map<string, number>();
  const set: RecentSet = {
    add(key, nowMs = Date.now()) {
      if (!seen.delete(key) && seen.size >= maxKeys) seen.delete(seen.keys().next().value!);
      seen.set(key, nowMs);
    },
    has(key, nowMs = Date.now()) {
      const at = seen.get(key);
      return at !== undefined && nowMs - at < idleMs;
    },
    sweep(nowMs = Date.now()) {
      for (const [key, at] of seen) {
        if (nowMs - at < idleMs) break;
        seen.delete(key);
      }
    },
    get size() { return seen.size; },
  };
  setInterval(() => set.sweep(), Math.min(idleMs, 5 * 60_000)).unref();
  return set;
}

/**
 * The anonymous sandboxes this process has served, by principal, for an hour
 * after their last request. A cookie is only a claim: until a request with it
 * has found or created its sandbox, it is counted as its network, so inventing
 * cookies buys no quota.
 */
const servedSandboxes = createRecentSet({ idleMs: 60 * 60_000 });
/** Called when a request's transaction for an anonymous sandbox has committed. */
export function rememberSandbox(principal: string): void { servedSandboxes.add(principal); }

/**
 * Answers a refused request: one warning per key and window, not per refusal,
 * so a flood does not double its own log. The request is typed by what it
 * reads, since some programs that compile this module (scripts/) lack
 * pino-http's request fields.
 */
export function refuseRequest(req: Pick<Request, "headers"> & { id?: unknown; log?: { warn(fields: object, message: string): void } }, res: Response, counter: WindowCounter, key: string, limit: "network" | "principal" | "health", error: string): void {
  if (counter.refusals(key) === 1) req.log?.warn({ event: "request.refused", reason: "rate_limit", limit }, "Request limit reached for a client");
  res.setHeader("Retry-After", String(REQUEST_WINDOW_MS / 1000));
  res.status(429).json({ error, requestId: req.id });
}

/**
 * The request limits of /api/v1. `network` runs before sign-in is checked and
 * before the body is read: every request from a client network counts
 * towards its ceiling, which also bounds what checking forged sessions costs.
 * `principal` runs after sign-in: a signed-in person, and an anonymous sandbox
 * this process has served, each have their own quota, so colleagues behind
 * one office or carrier address do not share one; any other request counts as
 * its network.
 */
export function createRequestLimits(options: { principalLimit?: number; networkLimit?: number; windowMs?: number; sandboxes?: RecentSet } = {}): { network: RequestHandler; principal: RequestHandler } {
  const { principalLimit = PRINCIPAL_REQUEST_LIMIT, networkLimit = NETWORK_REQUEST_LIMIT, windowMs = REQUEST_WINDOW_MS, sandboxes = servedSandboxes } = options;
  const networks = createWindowCounter({ limit: networkLimit, windowMs, maxKeys: 20_000 });
  const principals = createWindowCounter({ limit: principalLimit, windowMs, maxKeys: 50_000 });
  const error = "Too many requests. Try again in one minute.";
  return {
    network(req, res, next) {
      const key = clientNetwork(req.ip);
      if (!networks.take(key)) return refuseRequest(req, res, networks, key, "network", error);
      next();
    },
    principal(req, res, next) {
      const person = signedInUser(req), token = person ? undefined : sandboxTokenOf(req), sandbox = token && sandboxPrincipal(token);
      const key = person ? `person:${person}` : sandbox && sandboxes.has(sandbox) ? `sandbox:${sandbox}` : `network:${clientNetwork(req.ip)}`;
      if (!principals.take(key)) return refuseRequest(req, res, principals, key, "principal", error);
      next();
    },
  };
}
