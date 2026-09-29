import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import { reverificationErrorResponse } from "@clerk/shared/authorization-errors";
import { staffMode } from "../lib/staff-access";
import {
  acceptInvitationInputSchema,
  batchInputSchema,
  batchVersionInputSchema,
  caseDetailSchema,
  caseInputSchema,
  importBatchDetailSchema,
  importBatchListSchema,
  invitationCreatedSchema,
  invitationInputSchema,
  lenderInputSchema,
  membershipInputSchema,
  merchantSchema,
  messageSchema,
  operationListSchema,
  operationLookupInputSchema,
  operationLookupSchema,
  pathId,
  pendingOperationsSchema,
  pilotJourneySchema,
  staffChangeResultSchema,
  staffDirectorySchema,
  valopayRecordSchema,
} from "@workspace/valopay-schema";
import {
  inWorkspace,
  loadState,
  listOperations,
  countPendingOperations,
  cancelOperation,
  lookupOwnOperation,
  cancelOwnOperation,
  caseAssignees,
  staffDirectory,
  inviteStaff,
  updateStaff,
  revokeInvitation,
  approveInvitation,
  approveStaffChange,
  declineStaffChange,
  acceptStaffInvitation,
  createPilotLender,
  revealImportPayloads,
  fail,
} from "../lib/valopay-store";
import { withState } from "./valopay";
import { contractAnswer, lenderPage, lenderQuery, replayedAnswer, requiredKey } from "../lib/contract";
import {
  batchView,
  saveImportBatch,
  commitImportBatch,
  coordinateCase,
} from "../domain/pilot-workflow";
import { routerOptions } from "./router-options";
import { onlyRoles } from "../lib/refusal-words";

const router: IRouter = Router(routerOptions);
const idOf = pathId;
router.post("/v1/team/verify", async (req, res) => {
  if (!staffMode()) fail("Staff access is not enabled on this host.", 403);
  const auth = getAuth(req, { acceptsToken: "session_token" });
  if (!auth.userId) fail("Sign in to verify your identity.", 401);
  if (!auth.factorVerificationAge || auth.factorVerificationAge[1] < 0)
    fail(
      "Enrol and verify a second authentication factor in Account security first.",
      403,
    );
  if (!auth.has({ reverification: "strict_mfa" })) {
    const response = reverificationErrorResponse("strict_mfa");
    res.status(response.status).json(await response.json());
    return;
  }
  res.json(contractAnswer(messageSchema, { message: "Identity verified." }));
});
router.get("/v1/operations", async (req, res) => {
  const q = lenderPage(req);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) =>
        contractAnswer(
          operationListSchema,
          await listOperations(ctx, q.merchantId, q.offset),
        ),
      "read",
    ),
  );
});
router.get("/v1/operations/pending", async (req, res) => {
  const q = lenderQuery(req);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) =>
        contractAnswer(pendingOperationsSchema, await countPendingOperations(ctx, q.merchantId)),
      "read",
    ),
  );
});
// POST keeps the opaque original key out of URLs and access logs. This route only reads the caller's own journal.
router.post('/v1/operations/lookup', async (req, res) => {
  const q = lenderQuery(req), input = operationLookupInputSchema.parse(req.body);
  res.json(await inWorkspace(req, res, async ctx => contractAnswer(operationLookupSchema, await lookupOwnOperation(ctx, q.merchantId, input)), 'read'));
});
router.post('/v1/operations/cancel-unreceived', async (req, res) => {
  const q = lenderQuery(req), input = operationLookupInputSchema.parse(req.body);
  res.json(await inWorkspace(req, res, async ctx => contractAnswer(messageSchema, await cancelOwnOperation(ctx, q.merchantId, input))));
});
router.post("/v1/operations/:id/cancel", async (req, res) => {
  const q = lenderQuery(req),
    id = idOf(req.params.id);
  res.json(
    await inWorkspace(req, res, async (ctx) =>
      contractAnswer(messageSchema, await cancelOperation(ctx, q.merchantId, id)),
    ),
  );
});
router.get("/v1/pilot/journey", async (req, res) => {
  const q = lenderQuery(req);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => {
        const state = await loadState(ctx, q.merchantId, "share");
        const count = (kind: string, statuses?: string[]) =>
          state.records.filter(
            (r) =>
              r.kind === kind && (!statuses || statuses.includes(r.status)),
          ).length;
        return contractAnswer(pilotJourneySchema, {
          lender: state.merchant,
          accessMode: ctx.accessMode,
          actor: ctx.actor,
          syntheticOnly: true,
          counts: {
            customers: count("customers"),
            batches: count("import-batches", ["committed"]),
            receipts: count("payments"),
            openCases: state.records.filter(
              (r) =>
                r.kind === "exceptions" &&
                !["closed", "resolved"].includes(r.status),
            ).length,
            unassignedCases: state.records.filter(
              (r) =>
                r.kind === "exceptions" &&
                !["closed", "resolved"].includes(r.status) &&
                !r.data.case?.assignee,
            ).length,
            closes: count("closes"),
            exports: count("exports", ["ready"]),
          },
        });
      },
      "read",
    ),
  );
});
router.post("/v1/pilot/lenders", async (req, res) => {
  const key = requiredKey(req),
    input = lenderInputSchema.parse(req.body);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => {
        const { lender, repeated } = await createPilotLender(ctx, input, key);
        // A repeat answers the lender its key created earlier: that request was saved, whatever this answer's check finds.
        return repeated
          ? replayedAnswer(req, merchantSchema, lender)
          : contractAnswer(merchantSchema, lender);
      },
      "team",
    ),
  );
});
router.get("/v1/pilot/batches", async (req, res) => {
  const q = lenderPage(req);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => {
        const state = await loadState(ctx, q.merchantId, "share");
        const all = state.records
          .filter((r) => r.kind === "import-batches")
          .sort(
            (a, b) =>
              b.createdAt.localeCompare(a.createdAt) ||
              b.id.localeCompare(a.id),
          );
        const page = all.slice(q.offset, q.offset + 25),
          onPage = new Set(page.map((batch) => batch.id));
        // The list's counts come from each batch's stored check summary; only
        // batches saved before the summary existed open their check. When the
        // key service cannot open them, they are listed without counts rather
        // than failing the whole list.
        const opened = await revealImportPayloads(
          ctx,
          state,
          (r) => onPage.has(r.id) && !r.data.checkSummary,
          ["check"],
        ).then(
          () => true,
          (error: { status?: unknown }) => {
            if (error?.status !== 503) throw error;
            req.log.warn(
              { event: "imports.check_unavailable", err: error },
              "Batches saved before check summaries were listed without counts: the key service could not open their checks",
            );
            return false;
          },
        );
        return contractAnswer(importBatchListSchema, {
          items: page.map((batch) =>
            batchView(batch, false, opened ? "refuse" : "omit"),
          ),
          total: all.length,
          offset: q.offset,
        });
      },
      "read",
    ),
  );
});
router.get("/v1/pilot/batches/:id", async (req, res) => {
  const q = lenderQuery(req),
    id = idOf(req.params.id);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => {
        const state = await loadState(ctx, q.merchantId, "share");
        if (!["Admin", "Operations", "Finance"].includes(ctx.role))
          fail(onlyRoles(["Admin", "Operations", "Finance"], "open the rows of an import batch", ctx.accessMode), 403);
        const batch = state.records.find(
          (r) => r.kind === "import-batches" && r.id === id,
        );
        if (!batch) fail("Import batch not found.", 404);
        await revealImportPayloads(ctx, state, (r) => r.id === id);
        return contractAnswer(importBatchDetailSchema, {
          batch,
          revisions: state.records.filter(
            (r) => r.kind === "import-revisions" && r.data.batchId === id,
          ),
        });
      },
      "read",
    ),
  );
});
router.post("/v1/pilot/batches", async (req, res) => {
  const input = batchInputSchema.parse(req.body);
  res.json(
    await withState(
      req,
      res,
      (state, ctx) => saveImportBatch(state, ctx, input),
      true,
      valopayRecordSchema,
    ),
  );
});
router.post("/v1/pilot/batches/:id/save", async (req, res) => {
  const id = idOf(req.params.id),
    input = batchInputSchema.parse(req.body);
  res.json(
    await withState(
      req,
      res,
      (state, ctx) => saveImportBatch(state, ctx, input, id),
      true,
      valopayRecordSchema,
    ),
  );
});
router.post("/v1/pilot/batches/:id/commit", async (req, res) => {
  const id = idOf(req.params.id),
    input = batchVersionInputSchema.parse(req.body);
  res.json(
    await withState(
      req,
      res,
      async (state, ctx) => {
        // The commit imports the batch's source rows; a role that cannot commit costs no key-service call.
        if (["Admin", "Operations", "Finance"].includes(ctx.role))
          await revealImportPayloads(ctx, state, (r) => r.id === id);
        return commitImportBatch(state, ctx, id, input.expectedUpdatedAt);
      },
      true,
      valopayRecordSchema,
    ),
  );
});
router.get("/v1/pilot/cases/:id", async (req, res) => {
  const q = lenderQuery(req),
    id = idOf(req.params.id);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => {
        const state = await loadState(ctx, q.merchantId, "share"),
          record = state.records.find(
            (r) => r.kind === "exceptions" && r.id === id,
          );
        if (!record) fail("Exception not found.", 404);
        return contractAnswer(caseDetailSchema, {
          record,
          assignees: await caseAssignees(ctx),
          events: state.records.filter(
            (r) => r.kind === "case-events" && r.data.exceptionId === id,
          ),
          evidence: state.records
            .filter(
              (r) =>
                [
                  "customers",
                  "mandates",
                  "due-items",
                  "attempts",
                  "payments",
                  "observations",
                  "allocations",
                  "settlement-batches",
                  "evidence",
                  "closes",
                  "exports",
                  "policies",
                  "notifications",
                ].includes(r.kind) &&
                (!record.customerId || (r.kind === 'customers'
                  ? r.id === record.customerId
                  : !r.customerId || r.customerId === record.customerId)),
            )
            .map((r) => ({
              id: r.id,
              name: r.name,
              reference: r.reference,
              kind: r.kind,
            })),
        });
      },
      "read",
    ),
  );
});
router.post("/v1/pilot/cases/:id", async (req, res) => {
  const id = idOf(req.params.id),
    input = caseInputSchema.parse(req.body);
  res.json(
    await withState(
      req,
      res,
      async (state, ctx) =>
        coordinateCase(state, ctx, id, input, await caseAssignees(ctx)),
      true,
      valopayRecordSchema,
    ),
  );
});
router.get("/v1/team", async (req, res) =>
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => contractAnswer(staffDirectorySchema, await staffDirectory(ctx)),
      "read",
    ),
  ),
);
router.post("/v1/team/invitations", async (req, res) => {
  const input = invitationInputSchema.parse(req.body);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) =>
        contractAnswer(
          invitationCreatedSchema,
          await inviteStaff(ctx, input.email, input.role),
        ),
      "team",
    ),
  );
});
router.post("/v1/team/invitations/:id/revoke", async (req, res) => {
  const id = idOf(req.params.id);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => contractAnswer(messageSchema, await revokeInvitation(ctx, id)),
      "team",
    ),
  );
});
router.post("/v1/team/invitations/:id/approve", async (req, res) => {
  const id = idOf(req.params.id);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => contractAnswer(messageSchema, await approveInvitation(ctx, id)),
      "team",
    ),
  );
});
router.patch("/v1/team/members/:id", async (req, res) => {
  const id = idOf(req.params.id),
    input = membershipInputSchema.parse(req.body);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => contractAnswer(staffChangeResultSchema, await updateStaff(ctx, id, input)),
      "team",
    ),
  );
});
router.post("/v1/team/changes/:id/approve", async (req, res) => {
  const id = idOf(req.params.id);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => contractAnswer(staffChangeResultSchema, await approveStaffChange(ctx, id)),
      "team",
    ),
  );
});
router.post("/v1/team/changes/:id/decline", async (req, res) => {
  const id = idOf(req.params.id);
  res.json(
    await inWorkspace(
      req,
      res,
      async (ctx) => contractAnswer(messageSchema, await declineStaffChange(ctx, id)),
      "team",
    ),
  );
});
router.post("/v1/team/accept", async (req, res) => {
  const input = acceptInvitationInputSchema.parse(req.body);
  // The answer is checked against its schema inside the acceptance's own transaction.
  res.json(await acceptStaffInvitation(req, input.token));
});
export default router;
