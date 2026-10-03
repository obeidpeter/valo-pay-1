import { Router, type IRouter } from "express";
import healthRouter from "./health";
import valoPay1Router from "./valo-pay-1";
import connectedRouter from './connected';
import { recoveryMiddleware } from '../lib/operation-recovery';
import pilotRouter from './pilot';
import closeReviewRouter from './close-review';
import sourcesRouter from './sources';
import workRouter from './work';
import staffLenderRouter from './staff-lender-access';
import accessReadinessRouter from './access-readiness';
import lifecycleRouter from './lifecycle';
import importCorrectionsRouter from './import-corrections';
import { routerOptions } from './router-options';

const router: IRouter = Router(routerOptions);

// A path whose percent-encoding cannot be decoded is refused (400) before anything runs or is journaled: the
// router refuses such a path parameter the same way (a URIError it marks 400), which the error handler answers.
router.use((req, _res, next) => {
  try { decodeURIComponent(req.path); next(); }
  catch { next(Object.assign(new URIError("The path's percent-encoding cannot be decoded."), { status: 400 })); }
});
router.use(healthRouter);
router.use(recoveryMiddleware);
router.use(valoPay1Router);
router.use(connectedRouter);
router.use(pilotRouter);
router.use(closeReviewRouter);
router.use(sourcesRouter);
router.use(workRouter);
router.use(staffLenderRouter);
router.use(accessReadinessRouter);
router.use(lifecycleRouter);
router.use(importCorrectionsRouter);

export default router;
