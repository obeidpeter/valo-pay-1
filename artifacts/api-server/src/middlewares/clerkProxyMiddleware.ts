/**
 * Clerk Frontend API Proxy Middleware
 *
 * Proxies Clerk Frontend API requests through your domain, enabling Clerk
 * authentication on custom domains and .replit.app deployments without
 * requiring CNAME DNS configuration.
 *
 * AUTH CONFIGURATION: To manage users, enable/disable login providers
 * (Google, GitHub, etc.), change app branding, or configure OAuth credentials,
 * use the Auth pane in the workspace toolbar. There is no external Clerk
 * dashboard — all auth configuration is done through the Auth pane.
 *
 * IMPORTANT:
 * - Only active in production (Clerk proxying doesn't work for dev instances)
 * - Must be mounted BEFORE express.json() middleware
 * - What it tells Clerk comes from configuration and the trusted hop, never
 *   from a client's headers: the proxy URL and forwarded host are a
 *   configured application origin's (signInOrigins in lib/staff-access.ts),
 *   and the client address is the one the host's edge saw (req.ip). With no
 *   origin configured it answers 503.
 * - The anonymous sandbox's cookies are this API's bearer token: the Cookie
 *   header Clerk gets carries Clerk's own cookies and never those.
 *
 * Usage in app.ts:
 *   import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "./middlewares/clerkProxyMiddleware";
 *   app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
 */

import type { IncomingHttpHeaders, ClientRequest, IncomingMessage } from 'http';
import { Readable } from 'node:stream';
import type { Request, RequestHandler } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { originFor } from '../lib/staff-access';
import { withoutSandboxCookies } from '../lib/sandbox-cookie';
import { clientNetwork, createWindowCounter } from '../lib/request-limits';
import { clerkProxyTuning } from '../lib/startup-config';

const CLERK_FAPI = 'https://frontend-api.clerk.dev';
export const CLERK_PROXY_PATH = '/api/__clerk';
/**
 * SEC-02's budgets. A request has headerDeadlineMs until its response headers
 * arrive (504 after), and no request outlives totalMs. In between, its body is
 * cut off once the proxy has moved none of it for bodyIdleMs: while it
 * collects a body Clerk sent without a length, none arrived from Clerk;
 * otherwise, none was handed to the client's connection, which takes more
 * only as the client acknowledges earlier bytes. The timer cannot see bytes
 * reach the client: the kernel's buffers sit between, so a client slower than
 * a few KiB a second may be cut off while bytes still reach it. A stalled
 * download frees its slot. The byte limits bound what one request sends,
 * streams and buffers; a buffered body is held once, and let go as it is sent.
 * The rate and concurrency count per client network (an IPv4 address or an
 * IPv6 /64) and per process, which has room for eight networks at their
 * limit; an operator may set those three (clerkProxyLimits).
 */
export const CLERK_PROXY_LIMITS = {
  headerDeadlineMs: 30_000, bodyIdleMs: 30_000, totalMs: 10 * 60_000,
  requestBytes: 16 * 1024 * 1024, bufferedBytes: 4 * 1024 * 1024, responseBytes: 32 * 1024 * 1024,
  ...clerkProxyTuning({}).limits,
};
/** A buffered body goes to the client's connection a slice of at most this size at a time. */
const SLICE_BYTES = 16 * 1024;

/**
 * The limits with the rate and concurrency an operator set
 * (VALOPAY_CLERK_PROXY_RATE, VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY and
 * VALOPAY_CLERK_PROXY_CONCURRENCY), read by the start-up check's rule, which
 * has already refused a value outside it (startup-config.ts).
 */
export function clerkProxyLimits(): typeof CLERK_PROXY_LIMITS {
  const tuned = clerkProxyTuning({ rate: process.env.VALOPAY_CLERK_PROXY_RATE, networkConcurrency: process.env.VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY, concurrency: process.env.VALOPAY_CLERK_PROXY_CONCURRENCY });
  if (tuned.problems.length) throw new Error(tuned.problems.join(' '));
  return { ...CLERK_PROXY_LIMITS, ...tuned.limits };
}

/**
 * Returns the first effective public hostname for the given request,
 * preferring x-forwarded-host over the Host header so callers behind a
 * proxy see the original client-facing host.
 *
 * x-forwarded-host can take three shapes:
 *   - undefined (no proxy involved)
 *   - a single string (one proxy hop)
 *   - a comma-delimited string when an upstream appended rather than
 *     replaced the header (Node folds duplicate headers this way), or a
 *     string[] in some Express typings
 * In the multi-value case, the leftmost value is the original client-
 * facing host. Take that one in all forms. app.ts's origin rule compares a
 * request's Origin with it. A client can choose it, so nothing sent to Clerk
 * is built from it: see originFor in lib/staff-access.ts.
 */
export function getClerkProxyHost(req: {
  headers: IncomingHttpHeaders;
}): string | undefined {
  const forwarded = req.headers['x-forwarded-host'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const firstHop = raw?.split(',')[0]?.trim();
  return firstHop || req.headers.host?.trim() || undefined;
}

export function clerkProxyMiddleware(): RequestHandler {
  // Only run proxy in production — Clerk proxying doesn't work for dev instances
  if (process.env.NODE_ENV !== 'production') {
    return (_req, _res, next) => next();
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    return (_req, _res, next) => next();
  }
  return createBoundedClerkProxy(secretKey, { limits: clerkProxyLimits() });
}

/**
 * A buffered body sent from its chunk list itself, a slice of at most
 * SLICE_BYTES at a time, each chunk taken off the list as it goes: the flight
 * holds one copy of the body at most, and only what is still to be sent.
 */
function* sendOnce(chunks: Buffer[]): Generator<Buffer> {
  for (let chunk = chunks.shift(); chunk; chunk = chunks.shift()) {
    for (let at = 0; at < chunk.length; at += SLICE_BYTES) yield chunk.subarray(at, at + SLICE_BYTES);
  }
}

/** Options are injection points for offline tests, never request or environment input. */
export function createBoundedClerkProxy(secretKey: string, options: { target?: string; limits?: Partial<typeof CLERK_PROXY_LIMITS> } = {}): RequestHandler {
  const limits = { ...CLERK_PROXY_LIMITS, ...options.limits };
  const windows = createWindowCounter({ limit: limits.requestsPerMinute, windowMs: 60_000, maxKeys: 5_000 });
  let active = 0;
  const networks = new Map<string, number>();
  /**
   * One request in flight: `progress` marks the body moving (the first call, the response's headers), and `buffered`
   * holds a body Clerk sent without its length until it is sent, or the flight ends.
   */
  type Flight = { closed: boolean; upstream?: ClientRequest; response?: IncomingMessage; buffered?: Buffer[]; fail(status: number): void; progress(): void };
  const flights = new WeakMap<IncomingMessage, Flight>();

  const proxy = createProxyMiddleware<Request>({
    target: options.target ?? CLERK_FAPI,
    changeOrigin: true,
    // No proxyTimeout: each flight's own timers bound every phase, and a socket timeout would cut a slow download off.
    // Take over the response so it can be re-sent with a Content-Length (see
    // proxyRes); the deployment edge rejects chunked proxied responses.
    selfHandleResponse: true,
    pathRewrite: (path: string) =>
      path.replace(new RegExp(`^${CLERK_PROXY_PATH}`), ''),
    on: {
      proxyReq: (proxyReq, req) => {
        const flight = flights.get(req);
        if (!flight || flight.closed) { proxyReq.destroy(); return; }
        flight.upstream = proxyReq;
        let received = 0;
        req.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > limits.requestBytes) flight.fail(413);
        });
        // The configured origin the request's host names, else the first; checked to exist before proxying.
        const origin = originFor(req)!;
        proxyReq.setHeader('Clerk-Proxy-Url', `${origin.origin}${CLERK_PROXY_PATH}`);
        proxyReq.setHeader('Clerk-Secret-Key', secretKey);
        proxyReq.setHeader('X-Forwarded-Host', origin.host);
        proxyReq.setHeader('X-Forwarded-Proto', origin.protocol.slice(0, -1));

        // The client address the host's edge saw (one trusted hop), not the
        // leftmost forwarded-for entry, which the client writes itself.
        const clientIp = (req as Request).ip || req.socket?.remoteAddress;
        if (clientIp) proxyReq.setHeader('X-Forwarded-For', clientIp);
        else proxyReq.removeHeader('X-Forwarded-For');
        for (const header of ['forwarded', 'x-real-ip', 'cf-connecting-ip']) proxyReq.removeHeader(header);

        // The sandbox's token is this API's bearer credential: Clerk gets the other cookies, its own among them.
        const cookie = proxyReq.getHeader('cookie');
        if (cookie !== undefined) {
          const kept = withoutSandboxCookies(Array.isArray(cookie) ? cookie.join('; ') : String(cookie));
          if (kept) proxyReq.setHeader('Cookie', kept);
          else proxyReq.removeHeader('Cookie');
        }
      },
      // Clerk's dynamic Frontend API responses (/v1/environment, /v1/client,
      // JWKS, ...) arrive without a Content-Length, so relaying them would use
      // Transfer-Encoding: chunked — which the deployment edge (Cloud Run)
      // rejects, turning the app's 200 into a 500. Buffer only those so they can
      // be re-sent with a Content-Length; the body is forwarded untouched so
      // Content-Encoding is preserved. Length-known responses (e.g. /npm/*
      // assets) and body-less responses stream through without buffering.
      proxyRes: (proxyRes, req, res) => {
        const flight = flights.get(req);
        if (!flight || flight.closed) { proxyRes.destroy(); return; }
        flight.response = proxyRes;
        // The headers arrived in time: from here the body is timed by its progress.
        flight.progress();
        const headers = { ...proxyRes.headers };
        // Transfer-Encoding/Connection are hop-by-hop (RFC 7230 §6.1).
        delete headers['transfer-encoding'];
        delete headers['connection'];
        delete headers['keep-alive'];

        const status = proxyRes.statusCode ?? 502;
        // Content-Length is forbidden on 1xx/204; HEAD/304 may keep theirs.
        if (status < 200 || status === 204) {
          delete headers['content-length'];
        }

        const bodyless =
          req.method === 'HEAD' ||
          status < 200 ||
          status === 204 ||
          status === 304;
        const length = headers['content-length'];
        if (!bodyless && length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > limits.responseBytes)) {
          flight.fail(502); return;
        }
        proxyRes.on('error', () => flight.fail(502));
        proxyRes.on('aborted', () => flight.fail(502));
        if (headers['content-length'] !== undefined || bodyless) {
          res.writeHead(status, headers);
          // Headers are already sent, so abort the response if the upstream
          // stream errors mid-pipe (e.g. ECONNRESET) rather than leaving an
          // unhandled 'error' or a hung client. The pipe reads a chunk only once
          // the client's connection has taken the last, so each one is progress.
          proxyRes.pipe(res);
          proxyRes.on('data', flight.progress);
          return;
        }

        const chunks: Buffer[] = flight.buffered = [];
        let bytes = 0;
        proxyRes.on('data', (chunk: Buffer) => {
          if (flight.closed) return;
          flight.progress();
          bytes += chunk.length;
          if (bytes > limits.bufferedBytes) { flight.fail(502); return; }
          chunks.push(chunk);
        });
        proxyRes.on('end', () => {
          if (flight.closed) return;
          headers['content-length'] = String(bytes);
          res.writeHead(status, headers);
          // Sent from the list itself, never joined into a second copy; the pipe takes each slice as the connection
          // takes the last, so each one is progress.
          const replay = Readable.from(sendOnce(chunks), { objectMode: false });
          replay.pipe(res);
          replay.on('data', flight.progress);
        });
      },
      // Fixed error responses never disclose request URLs, cookies or upstream credentials.
      error: (_error, req) => { flights.get(req)?.fail(502); },
    },
  }) as RequestHandler;
  return (req, res, next) => {
    if (!originFor(req)) {
      res.status(503).json({ error: 'Sign-in is not available on this host.', requestId: req.id });
      return;
    }
    // httpxy skips its proxyReq event for Expect requests. That would bypass
    // header sanitisation, cookie stripping and body accounting, so refuse
    // this unsupported handshake before any upstream request exists.
    if (req.headers.expect !== undefined) {
      res.setHeader('Connection', 'close');
      res.status(417).json({ error: 'This sign-in request uses an unsupported handshake.', requestId: req.id });
      return;
    }
    const network = clientNetwork(req.ip ?? req.socket.remoteAddress);
    if (!windows.take(network) || active >= limits.concurrency || (networks.get(network) ?? 0) >= limits.networkConcurrency) {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ error: 'Sign-in is busy. Wait a minute, then try again.', requestId: req.id });
      return;
    }
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limits.requestBytes)) {
      res.setHeader('Connection', 'close');
      res.status(413).json({ error: 'The sign-in request is too large.', requestId: req.id });
      return;
    }
    active++; networks.set(network, (networks.get(network) ?? 0) + 1);
    const cleanup = () => {
      if (flight.closed) return;
      flight.closed = true; clearTimeout(timer); clearTimeout(cap);
      // What a buffered body had still to send is let go at once.
      if (flight.buffered) flight.buffered.length = 0;
      active--; const count = (networks.get(network) ?? 1) - 1;
      if (count) networks.set(network, count); else networks.delete(network);
      req.unpipe(flight.upstream); flight.upstream?.destroy(); flight.response?.destroy();
      req.off('aborted', cleanup);
    };
    // One absolute deadline until the response headers arrive, then the body's idle time, renewed each time the body
    // moves (see CLERK_PROXY_LIMITS); the overall cap holds throughout. After the headers were sent a timeout ends the
    // connection.
    let timer = setTimeout(() => flight.fail(504), limits.headerDeadlineMs), streaming = false;
    const cap = setTimeout(() => flight.fail(504), limits.totalMs);
    timer.unref(); cap.unref();
    const flight: Flight = { closed: false, fail(status) {
      if (flight.closed) return;
      cleanup();
      if (res.headersSent) { res.destroy(); return; }
      if (!req.complete) res.setHeader('Connection', 'close');
      res.status(status).json({ error: status === 413 ? 'The sign-in request is too large.' : 'Sign-in could not connect. Try again shortly.', requestId: req.id });
    }, progress() {
      if (flight.closed) return;
      if (streaming) { timer.refresh(); return; }
      streaming = true; clearTimeout(timer);
      timer = setTimeout(() => flight.fail(504), limits.bodyIdleMs);
      timer.unref();
    } };
    flights.set(req, flight);
    req.once('aborted', cleanup);
    res.once('close', cleanup); res.once('finish', cleanup);
    // Cancel the upstream even if the client disconnects before headers arrive.
    return proxy(req, res, (error?: unknown) => { if (error) flight.fail(502); else { cleanup(); next(); } });
  };
}
