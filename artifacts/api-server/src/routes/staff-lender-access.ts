import { Router, type IRouter } from "express";
import { pathId, staffLenderAccessInputSchema, staffLenderAccessSchema } from "@workspace/valo-pay-1-schema";
import { inWorkspace, updateStaffLenders } from "../lib/valo-pay-1-store";
import { contractAnswer } from "../lib/contract";
import { routerOptions } from "./router-options";

const router: IRouter = Router(routerOptions);
router.patch("/v1/team/members/:id/lenders", async (req, res) => {
  const id = pathId(req.params.id), input = staffLenderAccessInputSchema.parse(req.body);
  res.json(await inWorkspace(req, res, async ctx => contractAnswer(staffLenderAccessSchema, await updateStaffLenders(ctx, id, input)), "team"));
});
export default router;
