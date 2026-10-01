import { Router, type IRouter } from 'express';
import { lifecycleViewSchema, lifecycleRunViewSchema, retentionPolicyInputSchema, retentionHoldInputSchema, lifecyclePreviewInputSchema, lifecycleApproveInputSchema, lifecycleExecuteInputSchema, pathId } from '@workspace/valopay-schema';
import { contractAnswer, lenderPage, lenderQuery, requiredKey } from '../lib/contract';
import { inWorkspace, loadState, lifecycleInventory, executeLifecycleRun, revealImportPayloads, fail, type StoreContext } from '../lib/valopay-store';
import { withState } from './valopay';
import { lifecycleView, lifecycleRunView, saveLifecyclePolicy, setLifecycleHold, lifecyclePreview, approveLifecycleRun } from '../domain/lifecycle';
import type { DomainState } from '../domain/types';
import { routerOptions } from './router-options';
import { onlyRoles } from '../lib/refusal-words';

const router: IRouter = Router(routerOptions);
const idOf = pathId;
/** The raw-CSV inventory digests each committed batch's source rows, so an administrator's retention screens open them first; before the domain changes anything in a write. */
const openRawSources = (ctx: StoreContext, state: DomainState) => ctx.role === 'Admin' ? revealImportPayloads(ctx, state, record => record.status === 'committed' && record.data.csv !== undefined) : Promise.resolve(0);
/** A page of the retention view, the journal read as far as the page needs; after a change, so its counts include it. */
const viewOf = async (ctx: StoreContext, state: DomainState, offset = 0) => { const { external, journal } = await lifecycleInventory(ctx, state, { page: offset }); return lifecycleView(state, ctx, external, offset, journal); };
router.get('/v1/lifecycle', async (req, res) => {
  const input = lenderPage(req);
  res.json(await inWorkspace(req, res, async ctx => { if (ctx.role !== 'Admin') fail(onlyRoles(['Admin'], 'view data retention', ctx.accessMode), 403); const state = await loadState(ctx, input.merchantId, 'share'); await openRawSources(ctx, state); return contractAnswer(lifecycleViewSchema, await viewOf(ctx, state, input.offset)); }, 'read'));
});
router.get('/v1/lifecycle/runs/:id', async (req, res) => {
  const input = lenderQuery(req), id = idOf(req.params.id);
  res.json(await inWorkspace(req, res, async ctx => { if (ctx.role !== 'Admin') fail(onlyRoles(['Admin'], 'view data retention', ctx.accessMode), 403); const state = await loadState(ctx, input.merchantId, 'share'), run = state.records.find(record => record.merchantId === state.merchant.id && record.kind === 'retention-runs' && record.id === id); if (!run) fail('Deletion run not found. It may belong to another lender.', 404); return contractAnswer(lifecycleRunViewSchema, lifecycleRunView(state, run)); }, 'read'));
});
router.post('/v1/lifecycle/policy', async (req, res) => {
  requiredKey(req); const input = retentionPolicyInputSchema.parse(req.body);
  res.json(await withState(req, res, async (state, ctx) => { await openRawSources(ctx, state); saveLifecyclePolicy(state, ctx, input); return viewOf(ctx, state); }, true, lifecycleViewSchema, { reason: input.reason }));
});
router.post('/v1/lifecycle/holds', async (req, res) => {
  requiredKey(req); const input = retentionHoldInputSchema.parse(req.body);
  res.json(await withState(req, res, async (state, ctx) => { await openRawSources(ctx, state); setLifecycleHold(state, ctx, input, (await lifecycleInventory(ctx, state, { source: input.sourceId })).external); return viewOf(ctx, state); }, true, lifecycleViewSchema, { reason: input.reason }));
});
router.post('/v1/lifecycle/runs', async (req, res) => {
  requiredKey(req); const input = lifecyclePreviewInputSchema.parse(req.body);
  res.json(await withState(req, res, async (state, ctx) => { await openRawSources(ctx, state); const { external, journal } = await lifecycleInventory(ctx, state, { preview: true }); return lifecyclePreview(state, ctx, input, external, journal); }, true, lifecycleRunViewSchema));
});
router.post('/v1/lifecycle/runs/:id/approve', async (req, res) => {
  requiredKey(req); const id = idOf(req.params.id), input = lifecycleApproveInputSchema.parse(req.body);
  res.json(await withState(req, res, async (state, ctx) => { await openRawSources(ctx, state); return approveLifecycleRun(state, ctx, id, input, (await lifecycleInventory(ctx, state, { run: id })).external); }, true, lifecycleRunViewSchema, { reason: input.reason }));
});
router.post('/v1/lifecycle/runs/:id/execute', async (req, res) => {
  requiredKey(req); const id = idOf(req.params.id), input = lifecycleExecuteInputSchema.parse(req.body);
  res.json(await withState(req, res, async (state, ctx) => { if (ctx.role !== 'Admin') fail(onlyRoles(['Admin'], 'carry out a deletion run', ctx.accessMode), 403); await openRawSources(ctx, state); const run = state.records.find(record => record.kind === 'retention-runs' && record.id === id && record.merchantId === state.merchant.id); if (!run) fail('Deletion run not found. It may belong to another lender.', 404); if (run.data.previewDigest !== input.previewDigest) fail('This deletion run changed after you opened it. Reload the page and try again.', 409); return executeLifecycleRun(ctx, state, id); }, true, lifecycleRunViewSchema));
});
export default router;
