import { Router, type IRouter } from "express";
import { connectedActionResultFor, connectedViewSchema } from "@workspace/valo-pay-1-schema";
import {
  inWorkspace,
  loadState,
  saveState,
  settleChanges,
  appendAudit,
  auditObject,
  findIdempotency,
  findStoredAnswer,
  saveIdempotency,
  receiptOf,
  fail,
  completeOperation,
} from "../lib/valo-pay-1-store";
import { requestFingerprint } from "../lib/digests";
import { connectedActionDone } from "../lib/action-names";
import { contractAnswer, lenderQuery, replayedAnswer, requiredKey } from "../lib/contract";
import {
  connectedActionSchema,
  connectedView,
  runConnectedActionWithNote,
} from "../domain/connected";
import { withAuditNote } from "../domain/reconciliation";
import { ConnectedCashError } from "../domain/connected-cash";
import { CreditDomainError } from "../domain/connected-credit";
import { assertConnectedReplayAllowed } from "../domain/connected-replay";
import { routerOptions } from "./router-options";
const router: IRouter = Router(routerOptions);
router.get("/v1/connected", async (req, res) => {
  const { merchantId } = lenderQuery(req);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) =>
        contractAnswer(
          connectedViewSchema,
          connectedView(await loadState(ctx, merchantId, "share"), ctx),
        ),
      "read",
    ),
  );
});
router.post("/v1/connected/actions", async (req, res) => {
  const key = requiredKey(req),
    { merchantId } = lenderQuery(req),
    input = connectedActionSchema.parse(req.body);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => {
        const receipt = receiptOf(req, merchantId, key, "connected"),
          fingerprint = requestFingerprint({ input, actor: ctx.actor });
        // The one shape this action answers with, of this lender: an outcome never passes for a record.
        const answer = connectedActionResultFor(input.action, merchantId);
        const replay = async (prior: { request_hash: string; response: unknown }) => {
          if (prior.request_hash !== fingerprint)
            fail("This request was already sent with different details. Reload the page and try again.", 409);
          // The action was saved with this receipt: never answered as saving nothing, even when it no longer matches.
          const saved = replayedAnswer(req, answer, prior.response);
          if (input.action.startsWith("cash.") || input.action.startsWith("credit.")) {
            // Hold the current lender snapshot while checking permission and
            // frozen output validity. Replaying never executes the action.
            const current = await loadState(ctx, merchantId, "share");
            assertConnectedReplayAllowed(current, ctx, input.action, saved);
          }
          await completeOperation(ctx, saved);
          return saved;
        };
        // Locate a prior outcome first; sensitive connected responses also
        // require current authority before replay. The lookup is repeated once
        // the journal entry is held for a command that has not completed yet.
        const stored = await findStoredAnswer(ctx, merchantId, receipt.id, receipt.earlier);
        if (stored) return replay(stored);
        const state = await loadState(ctx, merchantId, "update");
        const prior = await findIdempotency(ctx, receipt.id, receipt.earlier);
        if (prior) return replay(prior);
        let outcome;
        try {
          outcome = runConnectedActionWithNote(state, ctx, input);
        } catch (error) {
          if (error instanceof CreditDomainError)
            fail(error.message, error.status);
          // A money refusal (MoneyArithmeticError) is not the Cash Desk's own refusal: it answers 422 with its code.
          if (error instanceof ConnectedCashError) fail(error.message, 400);
          throw error;
        }
        // Versions advance first, so the answer carries them; it is checked before anything is saved.
        const changes = settleChanges(ctx, state);
        const result = contractAnswer(answer, {
          message: `${connectedActionDone(input.action)}. Sample data only.`,
          record: outcome.result,
          mode: "synthetic",
          externalInstructionPerformed: false,
        });
        // The object is the record the action changed or answers with, never an unrelated one the body named. A
        // pay-by-bank step that closed exceptions whose condition cleared names them after the reason.
        appendAudit(
          state,
          ctx,
          input.action,
          auditObject(ctx, state, { body: input.recordId, answer: result }, "connected-workspace"),
          withAuditNote(input.reason, outcome.auditNote),
          {
            ...changes,
            mode: "synthetic",
            externalInstructionPerformed: false,
          },
        );
        await saveState(ctx, state);
        await saveIdempotency(ctx, receipt.id, fingerprint, result);
        return result;
      },
      "write",
    ),
  );
});
export default router;
