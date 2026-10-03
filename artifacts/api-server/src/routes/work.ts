import { Router, type IRouter, type RequestHandler } from 'express';
import { z } from 'zod';
import { personalWorkQuerySchema, personalWorkViewSchema, workReceiptInputSchema, workReceiptSchema } from '@workspace/valo-pay-1-schema';
import { inWorkspace, loadState, caseAssignees } from '../lib/valo-pay-1-store';
import { withState } from './valo-pay-1';
import { contractAnswer, lenderQuery, requiredKey } from '../lib/contract';
import { derivePersonalWork, recordWorkReceipt } from '../domain/personal-work';
import { routerOptions } from './router-options';

const router: IRouter = Router(routerOptions);
router.get('/v1/work', async (req, res) => {
  lenderQuery(req);
  const query = personalWorkQuerySchema.parse(req.query);
  res.json(await inWorkspace(req, res, async ctx => {
    const state = await loadState(ctx, query.merchantId, 'share');
    return contractAnswer(personalWorkViewSchema, derivePersonalWork(state, ctx, await caseAssignees(ctx), query));
  }, 'read'));
});
// Each receipt route is registered with its literal path, so the contract check can read it.
const receipt = (action: 'read' | 'acknowledge'): RequestHandler => async (req, res) => {
  requiredKey(req);
  const input = workReceiptInputSchema.parse(req.body);
  res.json(await withState(req, res, async (state, ctx) => recordWorkReceipt(state, ctx, await caseAssignees(ctx), action, input), true, workReceiptSchema));
};
router.post('/v1/work/notifications/read', receipt('read'));
router.post('/v1/work/handovers/acknowledge', receipt('acknowledge'));
export default router;
