// Loopback only: exercise real HTTP streaming, cancellation and quota release.
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import express from 'express';
import { createBoundedClerkProxy, clerkProxyLimits, CLERK_PROXY_LIMITS, CLERK_PROXY_PATH } from '../src/middlewares/clerkProxyMiddleware';

process.env.VALOPAY_APP_ORIGINS = 'https://pilot.example';
delete process.env.VALOPAY_STAFF_ACCESS;
let received = 0, cancelled = 0;
/** Sends `total` bytes, `size` at a time, one every `everyMs`: a slow download that keeps progressing. */
const trickle = (res: ServerResponse, total: number, size: number, everyMs: number) => {
  let sent = 0;
  const timer = setInterval(() => { const next = Math.min(size, total - sent); res.write('x'.repeat(next)); sent += next; if (sent >= total) { clearInterval(timer); res.end(); } }, everyMs);
  res.once('close', () => clearInterval(timer));
};
const MiB = 1024 * 1024, BULK = 24 * MiB, BUNDLE = 64 * 1024, HELD = 16 * MiB;
/** A body Clerk sends without its length, so the proxy buffers it: one allocation, whatever asks for it. */
const heldBody = Buffer.alloc(HELD, 121);
const upstream = createServer((req, res) => {
  received++;
  assert.equal(req.headers['clerk-secret-key'], 'synthetic-offline-key');
  assert.equal(req.headers.cookie, '__session=example');
  if (req.url === '/hang') { res.once('close', () => { cancelled++; }); return; }
  if (req.url === '/stream-hang') { res.writeHead(200, { 'content-length': '12' }); res.write('x'); return; }
  if (req.url === '/slow-known') { res.writeHead(200, { 'content-length': '2048' }); trickle(res, 2048, 128, 50); return; }
  if (req.url === '/slow-unknown') { res.writeHead(200); trickle(res, 48, 4, 50); return; }
  // Larger than loopback's socket buffers, so the proxy feels the pace at which the client takes it.
  if (req.url === '/bulk') { res.writeHead(200, { 'content-length': String(BULK) }); res.end(Buffer.alloc(BULK, 120)); return; }
  // A sign-in bundle over a poor connection: 4 KiB every 2 s, 32 s in all.
  if (req.url === '/bundle') { res.writeHead(200, { 'content-length': String(BUNDLE) }); trickle(res, BUNDLE, 4096, 2000); return; }
  if (req.url === '/bundle-unknown') { res.writeHead(200); trickle(res, BUNDLE, 4096, 2000); return; }
  if (req.url === '/held') { res.writeHead(200); res.end(heldBody); return; }
  if (req.url === '/large') { res.writeHead(200); res.write('x'.repeat(65)); res.end(); return; }
  if (req.url === '/large-known') { res.writeHead(200, { 'content-length': '129' }); res.end('x'.repeat(129)); return; }
  if (req.url === '/reset') { res.writeHead(200); res.write('x'); setImmediate(() => res.destroy()); return; }
  if (req.method === 'POST') { req.resume(); req.on('end', () => res.end('posted')); return; }
  if (req.method === 'HEAD') { res.writeHead(200, { 'content-length': '120' }); res.end(); return; }
  if (req.url === '/empty') { res.writeHead(204); res.end(); return; }
  if (req.url === '/known') { res.writeHead(200, { 'content-length': '5' }); res.end('asset'); return; }
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['a=b; Secure', 'c=d; Secure'] });
  res.write('{"ok":'); res.end('true}');
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const url = (server: Server) => `http://127.0.0.1:${(server.address() as {port:number}).port}`;
const headers = { Cookie: `__session=example; __Host-valopay_sandbox=${'a'.repeat(64)}; valopay_sandbox=${'b'.repeat(64)}; valo_sandbox=${'c'.repeat(64)}` };
const servers: Server[] = [];
async function serve(limits: Parameters<typeof createBoundedClerkProxy>[1] = {}) {
  const app = express(); app.set('trust proxy', 1);
  app.use(CLERK_PROXY_PATH, createBoundedClerkProxy('synthetic-offline-key', { target: url(upstream), ...limits }));
  const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening');
  return `${url(server)}${CLERK_PROXY_PATH}`;
}
const waitFor = async (condition:()=>boolean, tries = 100) => {
  for(let n=0;n<tries&&!condition();n++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(condition(), 'expected upstream lifecycle event');
};
/** A download through the proxy, and how long it took. */
const download = async (address: string) => {
  const started = Date.now();
  try {
    const reply = await fetch(address, { headers });
    const body = await reply.text();
    return { status: reply.status, length: body.length, ms: Date.now() - started, contentLength: reply.headers.get('content-length') };
  } catch { return { status: 0, length: 0, ms: Date.now() - started, contentLength: null }; }
};
// The memory buffers hold, once the garbage collector has run: gc() without a command-line flag.
v8.setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const retained = async () => { await new Promise((resolve) => setTimeout(resolve, 300)); gc(); gc(); return process.memoryUsage().arrayBuffers; };
/** A client that takes the answer's headers, then only as many bytes as it is told to: a slow client that stops. */
const heldClient = (address: string) => new Promise<{ length: string | undefined; take(bytes: number): Promise<void>; finish(): Promise<number> }>((resolve, reject) => {
  httpRequest(address, { headers }, (res) => {
    res.pause();
    let got = 0, wanted = 0, reached = () => {};
    res.on('data', (chunk: Buffer) => { got += chunk.length; if (got >= wanted) { res.pause(); reached(); } });
    res.on('error', () => {});
    const closed = new Promise<number>((done) => res.on('close', () => done(res.complete ? got : -got)));
    resolve({
      length: res.headers['content-length'],
      take: (bytes) => new Promise<void>((done) => { wanted = got + bytes; reached = done; res.resume(); }),
      finish: () => { wanted = Infinity; res.resume(); return closed; },
    });
  }).on('error', reject).end();
});
/** Takes /bulk as a client on a slow link does, pausing `pauseMs` after each MiB. */
const takeBulk = (base: string, pauseMs: number) => new Promise<{ bytes: number; complete: boolean; ms: number }>((resolve) => {
  const started = Date.now();
  httpRequest(`${base}/bulk`, { headers }, (res) => {
    let bytes = 0, mark = 0;
    res.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes - mark >= 1024 * 1024) { mark = bytes; res.pause(); setTimeout(() => res.resume(), pauseMs); }
    });
    res.on('error', () => {});
    res.on('close', () => resolve({ bytes, complete: res.complete, ms: Date.now() - started }));
  }).on('error', () => resolve({ bytes: 0, complete: false, ms: Date.now() - started })).end();
});
try {
  // The defaults (the review of PRs #61 to #67, finding L): until the response headers arrive the absolute deadline
  // stays 30 s; after them the body is cut off once the proxy has moved none of it for 30 s, within a generous overall
  // cap; and the process has room for eight client networks at their own limit.
  assert.deepEqual([CLERK_PROXY_LIMITS.headerDeadlineMs, CLERK_PROXY_LIMITS.bodyIdleMs, CLERK_PROXY_LIMITS.networkConcurrency, CLERK_PROXY_LIMITS.concurrency], [30_000, 30_000, 8, 64]);
  assert.ok(CLERK_PROXY_LIMITS.totalMs >= 5 * 60_000, 'the overall cap is generous');
  // A download that keeps progressing past 30 s finishes with the defaults. Started first and awaited last, it runs
  // beside the other checks.
  const defaults = await serve();
  const pastDeadline = Promise.all([download(`${defaults}/bundle`), download(`${defaults}/bundle-unknown`)]);

  const base = await serve({limits:{headerDeadlineMs:250,bodyIdleMs:250,bufferedBytes:64,responseBytes:128,requestBytes:12}});
  const dynamic = await fetch(`${base}/dynamic`, {headers});
  assert.equal(dynamic.status,200); assert.equal(dynamic.headers.get('content-length'),'11');
  assert.deepEqual(dynamic.headers.getSetCookie(),['a=b; Secure','c=d; Secure']);
  assert.equal(await dynamic.text(),'{"ok":true}');
  assert.equal(await (await fetch(`${base}/known`, {headers})).text(),'asset');
  assert.equal((await fetch(`${base}/empty`, {headers})).status,204);
  assert.equal(await (await fetch(`${base}/known`, {headers,method:'HEAD'})).text(),'');
  for(const path of ['/large','/large-known','/reset','/hang']) {
    const reply = await fetch(`${base}${path}`, {headers});
    assert.equal(reply.status,path==='/hang'?504:502,path);
    assert.doesNotMatch(await reply.text(),/synthetic-offline-key|__session|127\.0\.0\.1/);
  }
  const stalledAt = Date.now();
  const stalled = await fetch(`${base}/stream-hang`, {headers});
  await assert.rejects(stalled.text(),/terminated|aborted/i,'a body that sends nothing for the idle time is cut off');
  assert.ok(Date.now() - stalledAt >= 250, 'but not before');
  const before = received;
  const expectation = await new Promise<number>((resolve,reject)=>{
    const req = httpRequest(`${base}/upload`,{method:'POST',headers:{...headers,Expect:'100-continue','Clerk-Secret-Key':'untrusted-header'}},res=>{res.resume();resolve(res.statusCode!);});
    req.on('error',reject);req.end('123');
  });
  assert.equal(expectation,417); assert.equal(received,before,'Expect cannot bypass the proxyReq sanitisation hook');
  assert.equal((await fetch(`${base}/upload`,{headers,method:'POST',body:'x'.repeat(13)})).status,413);
  assert.equal(received,before,'known oversized requests never reach upstream');
  const chunked = await new Promise<number>((resolve,reject)=>{
    const req = httpRequest(`${base}/upload`,{method:'POST',headers},res=>{res.resume();resolve(res.statusCode!);});
    req.on('error',reject); req.write('12345678'); req.end('12345678');
  });
  assert.equal(chunked,413,'chunked requests have the same byte budget');

  // Slow downloads that keep progressing finish past the headers' deadline, streamed or buffered for their length;
  // the overall cap still ends one that takes too long. The idle time leaves room for a loaded machine's timers.
  const slow = await serve({limits:{headerDeadlineMs:250,bodyIdleMs:1_000,totalMs:5_000,bufferedBytes:64}});
  const known = await download(`${slow}/slow-known`);
  assert.deepEqual([known.status, known.length], [200, 2048], 'a streamed download sent over 800 ms is delivered whole');
  assert.ok(known.ms > 250, `it outlasted the headers' deadline (${known.ms} ms)`);
  const unknown = await download(`${slow}/slow-unknown`);
  assert.deepEqual([unknown.status, unknown.length, unknown.contentLength], [200, 48, '48'], 'a buffered one too, with its length');
  assert.ok(unknown.ms > 250, `it outlasted the headers' deadline (${unknown.ms} ms)`);
  const capped = await serve({limits:{headerDeadlineMs:250,bodyIdleMs:1_000,totalMs:400}});
  const tooLong = await download(`${capped}/slow-known`);
  assert.ok(tooLong.length < 2048, 'the overall cap ends a download that goes on too long');

  // A body sent without its length is held once, for its length, and each chunk is let go as it is sent: a flight holds
  // no more than the body it buffered, and less as its client takes it (the review of the fix for finding L).
  const holding = await serve({limits:{bufferedBytes:HELD,bodyIdleMs:60_000}});
  const baseline = await retained();
  const holders = await Promise.all([0, 1, 2].map(() => heldClient(`${holding}/held`)));
  assert.ok(holders.every((holder) => holder.length === String(HELD)), 'each is sent with its length');
  const bodyHeld = (await retained() - baseline) / holders.length;
  assert.ok(bodyHeld <= HELD * 1.15, `a flight sending ${HELD / MiB} MiB it buffered holds it once (${(bodyHeld / MiB).toFixed(1)} MiB)`);
  await Promise.all(holders.map((holder) => holder.take(HELD / 2)));
  // Taking half the body frees about as much of what the flight held (the kernel's buffers had already taken some).
  const halfway = (await retained() - baseline) / holders.length;
  assert.ok(halfway <= Math.max(0, bodyHeld - HELD / 2) + HELD * 0.2, `and lets go of what its client took (${(halfway / MiB).toFixed(1)} MiB of ${(bodyHeld / MiB).toFixed(1)} held once half of it was taken)`);
  assert.deepEqual(await Promise.all(holders.map((holder) => holder.finish())), holders.map(() => HELD), 'every client gets the whole body');

  // A client that takes a large body slowly but steadily gets it whole; one that stops taking it holds its network's
  // one slot only until the proxy has handed it nothing for the idle time.
  const bulk = await serve({limits:{headerDeadlineMs:250,bodyIdleMs:1_000,networkConcurrency:1}});
  const steady = await takeBulk(bulk, 20);
  assert.deepEqual([steady.bytes, steady.complete], [BULK, true], 'a client taking 24 MiB in paced steps gets all of it');
  assert.ok(steady.ms > 250, `past the headers' deadline (${steady.ms} ms)`);
  let taken = 0;
  const stall = httpRequest(`${bulk}/bulk`, { headers }, (res) => { res.on('data', (chunk: Buffer) => { taken += chunk.length; if (taken >= 2 * 1024 * 1024) res.pause(); }); res.on('error', () => {}); });
  stall.on('error', () => {}); stall.end();
  await waitFor(() => taken >= 2 * 1024 * 1024);
  const refusedWhileHeld = await fetch(`${bulk}/known`, {headers});
  assert.equal(refusedWhileHeld.status, 429, 'the stalled download holds the network\'s slot'); await refusedWhileHeld.text();
  let freed = 0;
  for (let tries = 0; tries < 50 && freed !== 200; tries += 1) { await new Promise((resolve) => setTimeout(resolve, 100)); const reply = await fetch(`${bulk}/known`, {headers}); freed = reply.status; await reply.text(); }
  assert.equal(freed, 200, 'a client that stops taking the body is cut off, and its slot freed');
  stall.destroy();

  const constrained = await serve({limits:{headerDeadlineMs:2000,concurrency:2,networkConcurrency:1}});
  const controller = new AbortController(), seen = received, closed = cancelled;
  const first = fetch(`${constrained}/hang`,{headers,signal:controller.signal}).catch(()=>undefined);
  await waitFor(()=>received>seen);
  const busy = await fetch(`${constrained}/dynamic`,{headers});
  assert.equal(busy.status,429); assert.equal(busy.headers.get('retry-after'),'60');await busy.text();
  assert.equal((await fetch(`${constrained}/dynamic`,{headers:{...headers,'X-Forwarded-For':'192.0.2.7'}})).status,200,'another network has its own slot');
  controller.abort();await first;await waitFor(()=>cancelled>closed);
  assert.equal((await fetch(`${constrained}/dynamic`,{headers})).status,200,'disconnect cancels upstream and releases concurrency');

  // With the default limits, eight networks at their own limit fit in the process at once; a ninth network, or a
  // network past its limit, is refused until they finish, and their disconnects release every slot.
  const crowd = await serve({limits:{headerDeadlineMs:10_000}});
  const networks = Array.from({ length: 8 }, (_, n) => `198.51.100.${n + 1}`);
  const crowding = new AbortController(), reached = received, released = cancelled;
  const held = networks.flatMap((address) => Array.from({ length: 8 }, () => fetch(`${crowd}/hang`, { headers: { ...headers, 'X-Forwarded-For': address }, signal: crowding.signal }).then((reply) => reply.status, () => 'aborted')));
  await waitFor(() => received - reached === 64, 500);
  const ninth = await fetch(`${crowd}/known`, { headers: { ...headers, 'X-Forwarded-For': '198.51.100.9' } });
  assert.equal(ninth.status, 429, 'a ninth network finds the process full'); await ninth.text();
  const past = await fetch(`${crowd}/known`, { headers: { ...headers, 'X-Forwarded-For': networks[0]! } });
  assert.equal(past.status, 429, 'a network past its own limit is refused'); await past.text();
  crowding.abort();
  assert.ok((await Promise.all(held)).every((status) => status === 'aborted'), 'none of the eight networks was refused');
  await waitFor(() => cancelled - released === 64, 500);
  assert.equal((await fetch(`${crowd}/known`, { headers: { ...headers, 'X-Forwarded-For': '198.51.100.9' } })).status, 200, 'their disconnects release every slot');

  // An operator may set the rate and the concurrency, by the start-up check's rule (startup-config.ts).
  const pick = ({ requestsPerMinute, networkConcurrency, concurrency }: typeof CLERK_PROXY_LIMITS) => ({ requestsPerMinute, networkConcurrency, concurrency });
  assert.deepEqual(pick(clerkProxyLimits()), { requestsPerMinute: 240, networkConcurrency: 8, concurrency: 64 });
  Object.assign(process.env, { VALOPAY_CLERK_PROXY_RATE: '600', VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY: '2' });
  assert.deepEqual(pick(clerkProxyLimits()), { requestsPerMinute: 600, networkConcurrency: 2, concurrency: 16 }, 'the process has room for eight networks at a limit an operator set');
  process.env.VALOPAY_CLERK_PROXY_CONCURRENCY = '12';
  assert.throws(() => clerkProxyLimits(), /VALOPAY_CLERK_PROXY_CONCURRENCY must be a whole number from 16/, 'a process too small for eight networks is refused');
  process.env.VALOPAY_CLERK_PROXY_CONCURRENCY = '20';
  const tuned = await serve({limits:{...clerkProxyLimits(),headerDeadlineMs:2000}});
  for (const key of ['VALOPAY_CLERK_PROXY_RATE', 'VALOPAY_CLERK_PROXY_NETWORK_CONCURRENCY', 'VALOPAY_CLERK_PROXY_CONCURRENCY']) delete process.env[key];
  const tunedAbort = new AbortController(), tunedSeen = received, tunedClosed = cancelled;
  const pair = [0, 1].map(() => fetch(`${tuned}/hang`, { headers, signal: tunedAbort.signal }).catch(() => undefined));
  await waitFor(() => received - tunedSeen === 2);
  assert.equal((await fetch(`${tuned}/known`, { headers })).status, 429, 'the network limit an operator set holds');
  tunedAbort.abort(); await Promise.all(pair); await waitFor(() => cancelled - tunedClosed === 2);

  const rate = await serve({limits:{requestsPerMinute:2}});
  for(let n=0;n<2;n++)assert.equal((await fetch(`${rate}/known`,{headers})).status,200);
  assert.equal((await fetch(`${rate}/known`,{headers})).status,429);
  assert.equal((await fetch(`${rate}/known`,{headers:{...headers,'X-Forwarded-For':'2001:db8:77::1'}})).status,200);
  assert.equal((await fetch(`${rate}/known`,{headers:{...headers,'X-Forwarded-For':'2001:db8:77::2'}})).status,200);
  assert.equal((await fetch(`${rate}/known`,{headers:{...headers,'X-Forwarded-For':'2001:db8:77::3'}})).status,429,'rotating IPv6 addresses in one /64 does not buy another quota');

  const [streamed, buffered] = await pastDeadline;
  assert.deepEqual([streamed.status, streamed.length], [200, BUNDLE], `a streamed download that keeps progressing for ${streamed.ms} ms finishes with the default limits`);
  assert.deepEqual([buffered.status, buffered.length], [200, BUNDLE], `so does one buffered for its length (${buffered.ms} ms)`);
  assert.ok(Math.min(streamed.ms, buffered.ms) > CLERK_PROXY_LIMITS.headerDeadlineMs, 'both outlasted the 30 s the headers are allowed');
  console.log('Clerk proxy budgets passed: faithful bodies/headers, bounded streaming and buffering (a buffered body held once and let go as it is sent), request caps, the headers\' deadline, slow but progressing downloads finishing past it (past 30 s with the defaults) while a stalled body or client is cut off within an overall cap, disconnect cancellation, quota release, eight networks at their limit at once, operator-set limits and IPv6 network rates.');
} finally {
  await Promise.all([...servers,upstream].map(server=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());})));
}
