import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import express, { type Express, type Request, type Response } from "express";
import pinoHttp from "pino-http";
import router from "./routes";
import healthRouter from "./routes/health";
import { logger } from "./lib/logger";
import { clerkMiddleware } from "@clerk/express";
import { errorHandler } from "./lib/error-handler";
import { clerkOptions, signInEnabled, staffMode, staffPolicy } from './lib/staff-access';
import { CLERK_PROXY_PATH,clerkProxyMiddleware,getClerkProxyHost } from "./middlewares/clerkProxyMiddleware";
import { createPaystackIngress } from './routes/sources';
import { paystackIngress } from './lib/paystack-connection';
import { clientNetwork, createRequestLimits, createWindowCounter } from './lib/request-limits';

/** The deepest a request body may nest objects and arrays. */
export const MAX_BODY_DEPTH = 32;
/**
 * The most values a request body may hold, counting every object, list, text,
 * number, true, false and null in it, the body itself included. The largest
 * body the console sends, a Finance decision on a close review with its 500
 * source exceptions, holds about 2,000; an edit sends only the fields its dialog
 * shows, so a large settlement batch stays editable. An import's CSV travels as
 * one text.
 */
export const MAX_BODY_VALUES = 10_000;
/** Whether text holds a UTF-16 surrogate without its pair, which PostgreSQL JSON refuses and text silently replaces (a native check; es2022's types do not name it). */
const unpairedSurrogate = (text: string) => !(text as string & { isWellFormed(): boolean }).isWellFormed();
type BodyProblem = { field: string; problem: "depth" | "nul" | "surrogate" | "values" };
const QUOTE = 0x22, BACKSLASH = 0x5c, COMMA = 0x2c, OPEN_LIST = 0x5b, CLOSE_LIST = 0x5d, OPEN_OBJECT = 0x7b, CLOSE_OBJECT = 0x7d;
/**
 * Where the text whose opening quote is at `start` ends: its closing quote, or
 * the end of the bytes. Text without a backslash ends at the next quote, found
 * natively (a long text is searched for a backslash natively too, a short one
 * byte by byte); otherwise each backslash escapes the byte after it.
 */
function closingQuote(raw: Uint8Array, start: number): number {
  const quote = raw.indexOf(QUOTE, start + 1);
  if (quote === -1) return raw.length;
  let escaped = false;
  if (quote - start > 64) escaped = raw.subarray(start + 1, quote).indexOf(BACKSLASH) !== -1;
  else for (let at = start + 1; at < quote && !escaped; at++) escaped = raw[at] === BACKSLASH;
  if (!escaped) return quote;
  for (let at = start + 1; at < raw.length; at++) {
    const byte = raw[at];
    if (byte === BACKSLASH) at++;
    else if (byte === QUOTE) return at;
  }
  return raw.length;
}
/**
 * What a body's bytes show before JSON.parse reads them: objects and arrays
 * nested more than MAX_BODY_DEPTH levels deep, or more than MAX_BODY_VALUES
 * values. Parsing 2 MB of nested brackets takes about 300 ms, and 2 MB of field
 * names about 100 ms, before the walk (bodyProblem) could refuse them (the
 * review of 4edd897, finding 1), so the parser refuses both from the UTF-8
 * bytes first: one pass that skips text and stops at the first byte past either
 * limit. In UTF-8 no byte of a longer character is a quote, bracket or comma.
 * For valid JSON the count is the walk's: the body, and one value for each
 * comma and for each list or object that holds anything. The path of a body
 * nested too deep is the walk's too, from the index or key each open list or
 * object is at; those keys are decoded only then.
 */
export function rawBodyProblem(raw: Uint8Array): BodyProblem | undefined {
  // For each open list or object: whether it is a list, the index it is at, and where the key it is at starts and ends.
  const lists: boolean[] = [], indexes: number[] = [], keys: Array<[number, number] | undefined> = [];
  let depth = 0, values = 1, opened = false, keyNext = false;
  for (let at = 0; at < raw.length; at++) {
    const byte = raw[at]!;
    if (byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09) continue;
    // A list or object that holds anything holds one value more than its commas.
    if (opened) {
      opened = false;
      if (byte !== CLOSE_LIST && byte !== CLOSE_OBJECT && ++values > MAX_BODY_VALUES) return { field: "", problem: "values" };
    }
    if (byte === QUOTE) {
      const end = closingQuote(raw, at);
      if (keyNext) { keys[depth - 1] = [at, end]; keyNext = false; }
      at = end;
    } else if (byte === OPEN_LIST || byte === OPEN_OBJECT) {
      if (depth === MAX_BODY_DEPTH) return { field: nestingPath(raw, lists, indexes, keys), problem: "depth" };
      lists[depth] = byte === OPEN_LIST; indexes[depth] = 0; keys[depth] = undefined;
      depth++; opened = true; keyNext = byte === OPEN_OBJECT;
    } else if (byte === CLOSE_LIST || byte === CLOSE_OBJECT) {
      if (depth > 0) depth--;
      keyNext = false;
    } else if (byte === COMMA) {
      if (++values > MAX_BODY_VALUES) return { field: "", problem: "values" };
      if (depth > 0) { if (lists[depth - 1]) indexes[depth - 1]!++; else keyNext = true; }
    }
  }
  return undefined;
}
/** The dotted path of the list or object nested too deep: the index or key each open list or object is at, a key decoded as JSON.parse decodes it. */
function nestingPath(raw: Uint8Array, lists: boolean[], indexes: number[], keys: Array<[number, number] | undefined>): string {
  const text = new TextDecoder();
  return lists.slice(0, MAX_BODY_DEPTH).map((list, level) => {
    const span = keys[level];
    if (list || !span) return list ? String(indexes[level]) : "";
    const quoted = text.decode(raw.subarray(span[0], span[1] + 1));
    try { return String(JSON.parse(quoted)); } catch { return quoted.slice(1, -1); }
  }).join(".");
}
/**
 * The first thing in a parsed body that nothing may read: more than
 * MAX_BODY_VALUES values, objects and arrays nested more than MAX_BODY_DEPTH
 * levels deep (the checks and fingerprints that walk a body are recursive), a
 * NUL character (PostgreSQL text cannot hold it) or an unpaired surrogate, in a
 * string or a field name. A body's bytes were refused for the first two before
 * it was parsed (rawBodyProblem); the walk holds whatever reaches it to both
 * rules too. It stops at that depth and that count, so it can neither overflow
 * the stack nor run long itself: it reads a list by index and an object by its
 * own keys, and gathers the keys of the value it refuses on the way back, so
 * only that value's path is ever built. The field is its dotted path: "" for
 * the body itself or too many values, and the object holding it (or "a field
 * name") for a field name.
 */
export function bodyProblem(body: unknown): BodyProblem | undefined {
  let values = 0;
  const walk = (value: unknown, depth: number): { keys: string[]; problem: BodyProblem["problem"]; name?: true } | undefined => {
    if (++values > MAX_BODY_VALUES) return { keys: [], problem: "values" };
    if (typeof value === "string") return value.includes("\u0000") ? { keys: [], problem: "nul" } : unpairedSurrogate(value) ? { keys: [], problem: "surrogate" } : undefined;
    if (value === null || typeof value !== "object") return undefined;
    if (depth >= MAX_BODY_DEPTH) return { keys: [], problem: "depth" };
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const found = walk(value[index], depth + 1);
        if (found) { found.keys.push(String(index)); return found; }
      }
      return undefined;
    }
    const keys = Object.keys(value);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      if (key.includes("\u0000")) return { keys: [], problem: "nul", name: true };
      if (unpairedSurrogate(key)) return { keys: [], problem: "surrogate", name: true };
      const found = walk((value as Record<string, unknown>)[key], depth + 1);
      if (found) { found.keys.push(key); return found; }
    }
    return undefined;
  };
  const found = walk(body, 0);
  if (!found) return undefined;
  const field = found.problem === "values" ? "" : found.keys.reverse().join(".");
  return { field: found.name && !field ? "a field name" : field, problem: found.problem };
}
/** What a person reads about a body problem, naming the field (at most 100 characters of it). */
function bodyRefusal({ field, problem }: BodyProblem): string {
  if (problem === "values") return `The request body holds more than ${MAX_BODY_VALUES.toLocaleString("en-GB")} values. Send a smaller request.`;
  const where = field ? (field.length > 100 ? `${field.slice(0, 100)}…` : field) : "the request";
  return problem === "depth" ? `The request body is nested more than ${MAX_BODY_DEPTH} levels deep, at ${where}. Send a flatter body.`
    : problem === "nul" ? `Text cannot contain the NUL character (\\u0000). Remove it from ${where} and try again.`
    : `Text must be valid Unicode: ${where} holds an unpaired surrogate (\\ud800 to \\udfff). Remove it and try again.`;
}

const app: Express = express();
app.set("trust proxy",1);
app.disable("x-powered-by");

/**
 * Every request has an id: a short random one, or, on a host whose edge sets
 * X-Request-Id on every request (VALOPAY_EDGE_REQUEST_ID=on), the edge's own
 * when it is a plain token, so the two logs line up. A client's header is
 * never trusted otherwise: it could reuse the reference someone else quoted.
 * The id is on every log line of the request, on the answer as X-Request-Id,
 * and in every error body as requestId, so the reference a person quotes finds
 * the lines.
 */
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
export function requestIdFor(req: { headers: IncomingHttpHeaders }, edgeSetsId = process.env.VALOPAY_EDGE_REQUEST_ID === "on"): string {
  const given = edgeSetsId ? req.headers["x-request-id"] : undefined;
  const first = Array.isArray(given) ? given[0] : given;
  return first && REQUEST_ID.test(first) ? first : randomBytes(8).toString("hex");
}

app.use(
  pinoHttp({
    logger,
    genReqId: (req) => requestIdFor(req),
    // A failed answer is an error line; a 503 that says when to retry (a busy lender, a database limit) is a
    // warning, so a busy moment does not page anyone; every other request is one info line with its status and time.
    customLogLevel: (_req, res, error) => (error ? "error" : res.statusCode === 503 && res.getHeader("Retry-After") ? "warn" : res.statusCode >= 500 ? "error" : "info"),
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use((req,res,next)=>{res.setHeader("X-Request-Id",String(req.id));next();});
app.use(CLERK_PROXY_PATH,clerkProxyMiddleware());
// Liveness and readiness answer before anything else reads the request: no sign-in, no body, their own per-network limit.
app.use("/api", healthRouter);
// Paystack test deliveries: 120 a minute per client network here, and 60 per connection once signed (paystack-connection.ts).
const deliveries=createWindowCounter({limit:120,windowMs:60_000});
app.use('/api/v1/providers/paystack',(req,res,next)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(!deliveries.take(clientNetwork(req.ip))){res.setHeader('Retry-After','60');res.status(429).json({error:'Test event delivery limit reached.',requestId:req.id});return;}
  next();
});
// The Paystack test ingress reads its own raw body and checks its signature before it touches a lender.
app.use('/api',createPaystackIngress(paystackIngress));
// Every other address the API answers is under /api/v1, matched as the mounts below match it: a whole segment, in
// either letter case. Any other address under /api is unknown, answered here before a session is checked, a limit
// counts it or a body is read, so asking for one costs nothing.
const unknownResource=(req:Request,res:Response)=>{res.status(404).json({error:"Unknown resource.",requestId:req.id});};
app.use("/api",(req,res,next)=>{if(/^\/v1(?:\/|$)/i.test(req.path))next();else unknownResource(req,res);});
// Under /api/v1 the response headers, the origin rule, sign-in and the request
// limits come before the body is read, so a malformed or oversized body is
// answered with the same headers as any other request, and a refused client
// never has its body parsed.
const requestLimits=createRequestLimits();
const clerk=clerkMiddleware((req)=>clerkOptions(req));
app.use("/api/v1",(req,res,next)=>{
  res.setHeader("Cache-Control","private, no-store");
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("Referrer-Policy","no-referrer");
  // API answers are for the console on this origin: never framed, never readable from another origin.
  res.setHeader("X-Frame-Options","DENY");
  res.setHeader("Cross-Origin-Resource-Policy","same-origin");
  const origin=req.get("Origin"),host=getClerkProxyHost(req);
  if (staffMode() && !['GET','HEAD','OPTIONS'].includes(req.method) && (!origin || !staffPolicy().authorisedParties.includes(origin))) { res.status(403).json({error:'Open Valo Pay from your pilot’s usual address to make changes.',requestId:req.id}); return; }
  if(origin){
    try{if(new URL(origin).host!==host){req.log.warn({event:"request.refused",reason:"origin"},"Cross-origin request refused");res.status(403).json({error:"Cross-origin requests are not permitted.",requestId:req.id});return;}}
    catch{req.log.warn({event:"request.refused",reason:"origin_malformed"},"Malformed request origin refused");res.status(403).json({error:"Invalid request origin.",requestId:req.id});return;}
  }
  // A client network's ceiling, before a session is checked: it also bounds what checking forged sessions costs.
  requestLimits.network(req,res,next);
});
// Sign-in: Clerk checks the session where this host can (signInEnabled); otherwise every request is anonymous.
// A staff host refuses anonymous requests, and does not start without Clerk (index.ts).
app.use("/api/v1",(req,res,next)=>{
  if(signInEnabled())return clerk(req,res,next);
  if(staffMode())return next(Object.assign(new Error("Team member sign-in is not set up at this address. Contact the Valo Pay team."),{status:503}));
  return next();
});
// Each principal's own quota: a signed-in person, a sandbox this process has served, otherwise the network.
app.use("/api/v1",(req,res,next)=>requestLimits.principal(req,res,next));
// A body is JSON in UTF-8, sent uncompressed, and only a write's is read: a read's body is ignored (never parsed,
// checked or fingerprinted), and a write's body in any other format, a form's included, or compressed, is refused
// (415). The parser never inflates a body, and it refuses one nested too deep or holding too many values from its
// bytes, before it parses them (rawBodyProblem); a charset other than UTF-8 is refused, since the bytes are read as
// UTF-8.
const json=express.json({limit:"2mb",inflate:false,verify:(_req,_res,raw,charset)=>{
  if(charset!=="utf-8")throw Object.assign(new Error("The request body's character set is not supported."),{status:415,type:"charset.unsupported"});
  const found=rawBodyProblem(raw);
  if(found)throw Object.assign(new Error(bodyRefusal(found)),{status:found.problem==="values"?413:400,bodyProblem:found});
}});
/** Refuses a body problem, naming the field, before anything is fingerprinted, journaled or saved; too many values is a 413. */
function refuseBody(req:Request,res:Response,found:BodyProblem):void{
  const status=found.problem==="values"?413:400;
  req.log.info({event:"request.rejected",status,reason:found.problem==="values"?"too_many_values":found.problem==="depth"?"nesting_depth":found.problem==="nul"?"nul_character":"unpaired_surrogate"},"Request body refused");
  res.status(status).json({error:bodyRefusal(found),requestId:req.id});
}
app.use("/api/v1",(req,res,next)=>{
  if(req.method==="GET"||req.method==="HEAD"){next();return;}
  const sent=req.headers["transfer-encoding"]!==undefined||Number(req.headers["content-length"]??0)>0;
  if(sent&&!req.is("application/json")){req.log.info({event:"request.rejected",status:415,reason:"content_type"},"Request body refused");res.status(415).json({error:"Send the request body as JSON, with the Content-Type application/json.",requestId:req.id});return;}
  // A few kilobytes of gzip can hold megabytes to parse: a compressed body is refused before it is read, naming the
  // one coding accepted (RFC 9110, Accept-Encoding).
  if((req.headers["content-encoding"]||"identity").toLowerCase()!=="identity"){res.setHeader("Accept-Encoding","identity");req.log.info({event:"request.rejected",status:415,reason:"content_encoding"},"Request body refused");res.status(415).json({error:"Send the request body uncompressed, without a Content-Encoding.",requestId:req.id});return;}
  json(req,res,(error?:unknown)=>{const found=(error as {bodyProblem?:BodyProblem}|undefined)?.bodyProblem;if(found)refuseBody(req,res,found);else next(error);});
});
app.use("/api/v1",(req,res,next)=>{
  const found=bodyProblem(req.body);
  if(found){refuseBody(req,res,found);return;}
  next();
});
app.use("/api", router);
// An address under /api/v1 that no route answers is a JSON answer with the request id, not the framework's HTML page.
app.use("/api",(req,res)=>unknownResource(req,res));
app.use(errorHandler);

export default app;
