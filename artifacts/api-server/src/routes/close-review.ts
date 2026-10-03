import { Router, type IRouter } from "express";
import { prepareCloseReviewSchema, decideCloseReviewSchema, reassignCloseReviewSchema, closeReviewHistoryQuerySchema, closeReviewHistorySchema, closeReviewDetailSchema, pilotProgressSchema, valopayRecordSchema, pathId } from "@workspace/valo-pay-1-schema";
import { caseAssignees, getCloseDetail } from "../lib/valo-pay-1-store";
import { requiredKey } from "../lib/contract";
import { withState } from "./valo-pay-1";
import { closeReviewHistory, closeReviewDetail, pilotProgress, prepareCloseReview, decideCloseReview, reassignCloseReview } from "../domain/close-review";
import { routerOptions } from "./router-options";

const router: IRouter = Router(routerOptions);
router.get("/v1/pilot/progress", async (req, res) => {
  res.json(await withState(req, res, (state, ctx) => pilotProgress(state, ctx.accessMode), false, pilotProgressSchema));
});
router.get("/v1/pilot/close-reviews", async (req, res) => {
  const query = closeReviewHistoryQuerySchema.parse(req.query);
  res.json(await withState(req, res, state => closeReviewHistory(state, query), false, closeReviewHistorySchema));
});
router.get("/v1/pilot/close-reviews/:id", async (req, res) => {
  const id = pathId(req.params.id);
  res.json(await withState(req, res, async (state, ctx) => {
    // The scoped detail and state use the same transaction snapshot. Only this requested
    // close is expanded; a year's full reports are never loaded to follow an older link.
    const close = await getCloseDetail(ctx, state.merchant.id, id);
    state.records = state.records.map(record => record.kind === "closes" && record.id === id ? close : record);
    return { ...closeReviewDetail(state, id), actor: ctx.actor, reviewers: (await caseAssignees(ctx)).filter(person => person.role === "Finance"), accessMode: ctx.accessMode, ownPrincipal: ctx.principalId };
  }, false, closeReviewDetailSchema));
});
router.post("/v1/pilot/close-reviews/prepare", async (req, res) => {
  requiredKey(req);
  const input = prepareCloseReviewSchema.parse(req.body);
  res.json(await withState(req, res, async (state, ctx) => prepareCloseReview(state, ctx, input, await caseAssignees(ctx)), true, valopayRecordSchema, {}, { wholeCloseIds: [input.closeId] }));
});
router.post("/v1/pilot/close-reviews/:id/decision", async (req, res) => {
  requiredKey(req);
  const id = pathId(req.params.id), input = decideCloseReviewSchema.parse(req.body);
  res.json(await withState(req, res, (state, ctx) => decideCloseReview(state, ctx, id, input), true, valopayRecordSchema, {}, { closeReviewIds: [id] }));
});
router.post("/v1/pilot/close-reviews/:id/reassign", async (req, res) => {
  requiredKey(req);
  const id = pathId(req.params.id), input = reassignCloseReviewSchema.parse(req.body);
  res.json(await withState(req, res, async (state, ctx) => reassignCloseReview(state, ctx, id, input, await caseAssignees(ctx)), true, valopayRecordSchema, { reason: input.reason }));
});
export default router;
