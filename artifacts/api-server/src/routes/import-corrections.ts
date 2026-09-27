import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  importCorrectionPreviewInputSchema,
  importCorrectionProposalInputSchema,
  importCorrectionDecisionInputSchema,
  importCorrectionRecoveryInputSchema,
  importCorrectionPreviewSchema,
  importCorrectionViewSchema,
  importCorrectionsResponseSchema,
  pathId,
} from "@workspace/valopay-schema";
import { withState } from "./valopay";
import { lenderQuery, requiredKey } from "../lib/contract";
import { caseAssignees } from "../lib/valopay-store";
import {
  listImportCorrections,
  previewImportCorrection,
  proposeImportCorrection,
  decideImportCorrection,
  reassignImportCorrection,
} from "../domain/import-corrections";
import { routerOptions } from "./router-options";
const router: IRouter = Router(routerOptions);
router.get("/v1/pilot/import-corrections", async (req, res) => {
  lenderQuery(req);
  const { batchId } = z.object({ batchId: z.string().min(1).max(100) }).parse(req.query);
  res.json(
    await withState(
      req,
      res,
      async (state, ctx) => ({
        ...listImportCorrections(state, ctx, batchId),
        reviewers: (await caseAssignees(ctx)).filter(
          (person) => person.role === "Finance",
        ),
      }),
      false,
      importCorrectionsResponseSchema,
    ),
  );
});
router.post("/v1/pilot/import-corrections/preview", async (req, res) => {
  lenderQuery(req);
  const input = importCorrectionPreviewInputSchema.parse(req.body);
  res.json(
    await withState(
      req,
      res,
      (state, ctx) => previewImportCorrection(state, ctx, input),
      false,
      importCorrectionPreviewSchema,
    ),
  );
});
router.post("/v1/pilot/import-corrections", async (req, res) => {
  requiredKey(req);
  const input = importCorrectionProposalInputSchema.parse(req.body);
  res.json(
    await withState(
      req,
      res,
      async (state, ctx) =>
        proposeImportCorrection(state, ctx, input, await caseAssignees(ctx)),
      true,
      importCorrectionViewSchema,
      { reason: input.reason },
    ),
  );
});
router.post("/v1/pilot/import-corrections/:id/decision", async (req, res) => {
  requiredKey(req);
  const id = pathId(req.params.id),
    input = importCorrectionDecisionInputSchema.parse(req.body);
  res.json(
    await withState(
      req,
      res,
      async (state, ctx) =>
        decideImportCorrection(state, ctx, id, input, await caseAssignees(ctx)),
      true,
      importCorrectionViewSchema,
      { reason: input.reason },
    ),
  );
});
router.post("/v1/pilot/import-corrections/:id/recovery", async (req, res) => {
  requiredKey(req);
  const id = pathId(req.params.id), input = importCorrectionRecoveryInputSchema.parse(req.body);
  res.json(await withState(req, res,
    async (state, ctx) => reassignImportCorrection(state, ctx, id, input, await caseAssignees(ctx)),
    true, importCorrectionViewSchema, { reason: input.reason },
  ));
});
export default router;
