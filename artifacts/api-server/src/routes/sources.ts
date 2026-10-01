import { Router, raw, type IRouter } from "express";
import { z } from "zod";
import { ReceivePaystackTestEventResponse } from "@workspace/api-zod";
import { sourceProfileInputSchema, paystackFixtureInputSchema, providerReplayInputSchema, sourceManifestInputSchema, businessDateSchema, sourcesViewSchema, paystackFixtureResultSchema, providerEventViewSchema, valopayRecordSchema, pathId } from "@workspace/valopay-schema";
import { withState } from "./valopay";
import { contractAnswer, lenderQuery, requiredKey } from "../lib/contract";
import { revealImportPayloads } from "../lib/valopay-store";
import { saveSourceProfile, sourceQuality } from "../domain/source-quality";
import { saveSourceManifest } from "../domain/source-completeness";
import { providerEventView, receivePaystackEvent, replayProviderEvent, runPaystackFixture } from "../providers/paystack-inbox";
import { parsePaystackTestWebhook, PaystackError, type PaystackWebhook } from "../providers/paystack";
import type { DomainState, Context } from "../domain/types";
import { routerOptions } from "./router-options";

const router: IRouter = Router(routerOptions);
router.get("/v1/sources", async (req, res) => {
  lenderQuery(req);
  const { businessDate } = z.object({ businessDate: businessDateSchema.optional() }).parse({ businessDate: req.query.businessDate });
  const result = await withState(req, res, async (state, ctx) => {
    // Quality is checked against the source rows of batches not yet committed, and of older committed batches with no stored quality.
    await revealImportPayloads(ctx, state, r => !(r.status === "committed" && r.data.sourceQuality));
    const events = state.records.filter(r => r.kind === "provider-events").sort((a,b) => b.createdAt.localeCompare(a.createdAt));
    return { ...sourceQuality(state, ctx.now, businessDate), paystack: { mode: "test_only", externalConnectionVerified: false, canRunFixtures: ["Admin", "Operations", "Finance"].includes(ctx.role), state: "configuration_required", message: "An external test needs a Paystack account, test keys and a connection set up by the Valo Pay team. Practice messages on this page do not check a real Paystack connection.", events: events.slice(0,50).map(providerEventView), total: events.length, quarantined: events.filter(e => e.status === "quarantined").length, duplicates: events.reduce((sum,e) => sum + Math.max(0, Number(e.data.deliveryCount || 0) - 1), 0) } };
  }, false, sourcesViewSchema);
  res.json(result);
});
router.post("/v1/sources/profiles", async (req, res) => {
  const input = sourceProfileInputSchema.parse(req.body);
  res.json(await withState(req, res, (state, ctx) => saveSourceProfile(state, ctx, input), true, valopayRecordSchema));
});
router.post("/v1/sources/manifests", async (req, res) => {
  requiredKey(req);
  const input = sourceManifestInputSchema.parse(req.body);
  res.json(await withState(req, res, (state, ctx) => saveSourceManifest(state, ctx, input), true, valopayRecordSchema, { reason: input.reason }));
});
router.post("/v1/sources/profiles/:id/save", async (req, res) => {
  const id = pathId(req.params.id), input = sourceProfileInputSchema.parse(req.body);
  res.json(await withState(req, res, (state, ctx) => saveSourceProfile(state, ctx, input, id), true, valopayRecordSchema));
});
router.post("/v1/sources/paystack/fixtures", async (req, res) => {
  const input = paystackFixtureInputSchema.parse(req.body);
  res.json(await withState(req, res, (state, ctx) => { const result = runPaystackFixture(state, ctx, input.scenario); return { ...result, event: providerEventView(result.event) }; }, true, paystackFixtureResultSchema));
});
router.post("/v1/sources/events/:id/replay", async (req, res) => {
  const id = pathId(req.params.id), input = providerReplayInputSchema.parse(req.body);
  res.json(await withState(req, res, (state, ctx) => providerEventView(replayProviderEvent(state, ctx, id, input.expectedUpdatedAt, input.reason)), true, providerEventViewSchema, { reason: input.reason }));
});
export default router;

/** Server-only resolver: locks, loads and saves the mapped lender. Called only with a verified event; never resolves a browser workspace or query-string merchant. */
export type PaystackConnectionTransaction = <T>(connectionId: string, apply: (connection: { state: DomainState; context: Context }) => T | Promise<T>) => Promise<T>;
/**
 * What the ingress needs from the server. `secretKey` reads the process environment only, never the
 * database, and throws a 503 while the ingress is off or misconfigured; `transact` opens the lender.
 */
export type PaystackIngress = { secretKey: () => string; transact: PaystackConnectionTransaction };
const paystackRefusal = (error: unknown) => error instanceof PaystackError ? Object.assign(new Error(error.message), { status: error.code === "invalid_signature" ? 401 : error.code === "configuration" ? 503 : 400 }) : error;
/**
 * Mount before JSON parsing. The exact raw bytes are authenticated before any lender is locked, read or
 * decrypted, so a forged delivery costs one HMAC and learns nothing about the connection or its lender.
 */
export function createPaystackIngress({ secretKey, transact }: PaystackIngress): IRouter {
  const ingress = Router(routerOptions);
  ingress.post("/v1/providers/paystack/:connectionId/events", raw({ type: "application/json", limit: "256kb" }), async (req, res) => {
    const connectionId = z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.connectionId, { path: ["connectionId"] });
    if (!Buffer.isBuffer(req.body)) throw Object.assign(new Error("A signed JSON body is required."), { status: 400 });
    let event: PaystackWebhook;
    try { event = parsePaystackTestWebhook(req.body, req.header("x-paystack-signature"), secretKey()); } catch (error) { throw paystackRefusal(error); }
    // The receipt is checked inside the lender's transaction, so an invalid one saves nothing.
    const result = await transact(connectionId, ({ state, context }) => contractAnswer(ReceivePaystackTestEventResponse, { accepted: true, duplicate: receivePaystackEvent(state, context, event, { connectionId, mode: "test" }).duplicate }));
    res.status(200).json(result);
  });
  return ingress;
}
