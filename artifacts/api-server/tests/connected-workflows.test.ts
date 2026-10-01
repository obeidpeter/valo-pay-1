import assert from "node:assert/strict";
import { seedMerchant } from "../src/lib/valopay-seed";
import {
  connectedView,
  connectedRevision,
  runConnectedAction,
  connectedActionSchema,
} from "../src/domain/connected";
import { makeRecord } from "../src/domain/records";
import { evaluateRetry } from "../src/domain/policy-engine";
import { reconcile } from "../src/domain/reconciliation";
import { runDailyClose } from "../src/domain/actions";
import { pauseIdleSandboxClose } from "../src/domain/close";
import type { Context, DomainState, ValopayRecord } from "../src/domain/types";
import { workflowFixture } from "./workflow-fixture";
process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
const { assertFinalState, appendAudit } = await import("../src/lib/valopay-store");
const ctx: Context = {
  now: "2026-09-21T10:00:00.000Z",
  role: "Admin",
  actor: "Sandbox Admin",
};
const finance: Context = { ...ctx, role: "Finance", actor: "Sandbox Finance" };
let checks = 0;
const check = (fn: () => void) => {
  fn();
  checks++;
};
const fresh = () => seedMerchant("tenant-a");
function run(
  state: DomainState,
  action: string,
  data: Record<string, unknown> = {},
  recordId?: string,
  context = ctx,
): ValopayRecord {
  const before = structuredClone(state);
  const result = runConnectedAction(
    state,
    context,
    connectedActionSchema.parse({
      action,
      data,
      recordId,
      reason: "Testing the sample workflow",
      expectedRevision: connectedRevision(state),
    }),
  );
  assertFinalState(before, state, state.merchant.id);
  return result as ValopayRecord;
}
const openDue = (state: DomainState) =>
  state.records.find(
    (r) => r.kind === "due-items" && r.reference === "DEMO-LOAN-1005",
  )!;
const checkout = (state: DomainState, amount?: number) => {
  const due = openDue(state);
  return run(state, "payment.create", {
    dueItemId: due.id,
    amountKobo: amount ?? due.amountKobo,
  });
};
check(() => {
  const s = fresh();
  assert.equal(connectedView(s, ctx).mode, "synthetic");
  assert.equal(
    connectedView(s, ctx).gates.some((g) => g.liveEnabled),
    false,
  );
  assert.equal(
    s.records.filter((r) => r.kind.startsWith("connected-")).length,
    0,
  );
});
check(() => {
  const s = fresh();
  s.settings.environment = "production";
  assert.throws(() => checkout(s), /works only with sample data/);
});
check(() => {
  const s = fresh();
  assert.throws(
    () =>
      run(
        s,
        "payment.create",
        { dueItemId: openDue(s).id, amountKobo: 1 },
        undefined,
        { ...ctx, role: "Read-only" },
      ),
    /Only Admin, Operations, Finance or Compliance reviewer can make changes in connected banking\. Change your demo role in Settings\.$/,
  );
});
check(() => {
  const s = fresh();
  assert.throws(
    () =>
      run(s, "payment.create", {
        dueItemId: openDue(fresh()).id,
        amountKobo: 1,
      }),
    /not found/,
  );
});
check(() => {
  const s = fresh();
  assert.throws(() => checkout(s, 0), /Enter more than 0/);
  assert.throws(() => checkout(s, openDue(s).amountKobo + 1), /outstanding/);
  assert.throws(() => checkout(s, 1.5), /Enter a whole number/);
});
check(() => {
  const s = fresh();
  const i = checkout(s);
  assert.throws(() => checkout(s), /open checkout/);
  run(s, "payment.cancel", {}, i.id);
  assert.doesNotThrow(() => checkout(s));
});
check(() => {
  const s = fresh();
  const i = checkout(s);
  assert.throws(
    () => run(s, "payment.outcome", { outcome: "confirmed" }, i.id),
    /waiting/,
  );
  assert.equal(
    s.records.filter((r) => r.data.connectedIntentId === i.id).length,
    0,
  );
});
check(() => {
  const s = fresh();
  const i = checkout(s);
  const late = { ...ctx, now: "2026-09-21T10:16:00.000Z" };
  assert.throws(() => run(s, "payment.authorise", {}, i.id, late), /expired/);
});
check(() => {
  const s = fresh(),
    due = openDue(s);
  const attempt = makeRecord(s, "attempts", {
    name: "Scheduled",
    status: "scheduled",
    customerId: due.customerId,
    amountKobo: due.amountKobo,
    createdAt: ctx.now,
    data: { dueItemId: due.id, source: "valo" },
  });
  const i = checkout(s);
  run(s, "payment.authorise", {}, i.id);
  assert.equal(attempt.status, "cancelled");
  assert.equal(
    s.records.filter((r) => r.kind === "connected-consents").length,
    1,
  );
});
check(() => {
  const s = fresh(),
    due = openDue(s);
  makeRecord(s, "attempts", {
    status: "unknown",
    customerId: due.customerId,
    amountKobo: due.amountKobo,
    createdAt: ctx.now,
    data: { dueItemId: due.id },
  });
  assert.throws(() => checkout(s), /pending|unknown/);
});
check(() => {
  const s = fresh(),
    i = checkout(s),
    due = openDue(s);
  makeRecord(s, "attempts", {
    status: "sent",
    customerId: due.customerId,
    amountKobo: due.amountKobo,
    createdAt: ctx.now,
    data: { dueItemId: due.id },
  });
  assert.throws(() => run(s, "payment.authorise", {}, i.id), /scheduled or in progress/);
});
check(() => {
  const s = fresh(),
    i = checkout(s);
  s.merchant.killSwitch = true;
  assert.throws(() => run(s, "payment.authorise", {}, i.id), /emergency/);
});
check(() => {
  const s = fresh(),
    i = checkout(s);
  run(s, "payment.authorise", {}, i.id);
  run(s, "payment.return", {}, i.id);
  assert.equal(i.status, "pending");
  assert.equal(
    s.records.filter((r) => r.data.connectedIntentId === i.id).length,
    0,
  );
});
check(() => {
  const s = fresh(),
    i = checkout(s);
  run(s, "payment.authorise", {}, i.id);
  run(s, "payment.outcome", { outcome: "unknown" }, i.id);
  assert.throws(() => checkout(s), /pending|unknown/);
  assert.throws(() => run(s, "payment.cancel", {}, i.id), /only before it is authorised/);
  const due = openDue(s);
  const decision = evaluateRetry(
    s,
    ctx,
    due as any,
    s.records.find((r) => r.kind === "policies") as any,
  );
  assert.equal(decision.rule, "in_flight");
});
check(() => {
  const s = fresh(),
    i = checkout(s);
  run(s, "payment.authorise", {}, i.id);
  run(s, "payment.outcome", { outcome: "failed" }, i.id);
  assert.doesNotThrow(() => checkout(s));
});
check(() => {
  const s = fresh(),
    i = checkout(s, 1_000_000),
    due = openDue(s);
  run(s, "payment.authorise", {}, i.id);
  run(s, "payment.outcome", { outcome: "confirmed" }, i.id);
  assert.equal(due.data.outstandingKobo, 1_500_000);
  assert.equal(due.status, "partially_paid");
  const count = s.records.length;
  run(s, "payment.outcome", { outcome: "confirmed" }, i.id);
  assert.equal(s.records.length, count);
  const p = s.records.find((r) => r.id === i.data.paymentId)!;
  assert.equal(p.data.channel, "transfer");
  assert.equal(p.data.paymentMethod, "pay_by_bank");
  assert.equal(p.data.allocatedKobo, 1_000_000);
});
check(() => {
  const s = fresh(),
    i = checkout(s),
    due = openDue(s);
  run(s, "payment.authorise", {}, i.id);
  const grant = s.records.find((r) => r.id === i.data.consentId)!;
  run(s, "consent.revoke", {}, grant.id);
  run(s, "payment.outcome", { outcome: "confirmed" }, i.id, {
    ...ctx,
    now: "2026-09-22T10:00:00.000Z",
  });
  assert.equal(due.status, "paid");
  assert.equal(i.status, "confirmed");
});
check(() => {
  const s = fresh(),
    i = checkout(s),
    due = openDue(s);
  run(s, "payment.authorise", {}, i.id);
  due.amountKobo = 1_500_000;
  due.data.outstandingKobo = 1_500_000;
  run(s, "payment.outcome", { outcome: "confirmed" }, i.id);
  assert.equal(due.data.outstandingKobo, 0);
  assert.ok(
    s.records.some(
      (r) =>
        r.kind === "exceptions" && r.data.linkedRecordId === i.data.paymentId,
    ),
  );
});
check(() => {
  const s = fresh(),
    i = checkout(s);
  run(s, "payment.authorise", {}, i.id);
  run(s, "payment.outcome", { outcome: "confirmed" }, i.id);
  assert.throws(
    () => run(s, "payment.refund_confirm", {}, i.id, finance),
    /Someone other than you must request the refund/,
  );
  run(s, "payment.refund_request", {}, i.id);
  assert.throws(() => run(s, "payment.refund_confirm", {}, i.id), /Finance/);
  run(s, "payment.refund_confirm", {}, i.id, finance);
  assert.equal(i.status, "refunded");
  // A refund reopens the instalment by its balance, not in dispute; only a reversal puts it in dispute.
  assert.equal(openDue(s).status, "scheduled");
  assert.equal(openDue(s).data.outstandingKobo, openDue(s).amountKobo);
  // The refunded money left the allocation queues and is no customer credit.
  const refunded = s.records.find((r) => r.id === i.data.paymentId)!;
  assert.equal(refunded.status, "returned");
  // The whole receipt went back, after its allocations were taken off the instalments.
  assert.deepEqual(
    [
      refunded.data.refundStatus,
      refunded.data.refundedKobo,
      refunded.data.allocatedKobo,
    ],
    ["refunded", refunded.amountKobo, 0],
  );
  assert.throws(
    () => run(s, "payment.refund_confirm", {}, i.id, finance),
    /confirmed/,
  );
});
check(() => {
  const s = fresh(),
    i = checkout(s);
  run(s, "payment.authorise", {}, i.id);
  run(s, "payment.outcome", { outcome: "confirmed" }, i.id);
  run(s, "payment.reverse", {}, i.id, finance);
  assert.equal(
    s.records.find((r) => r.id === i.data.paymentId)!.data.reversalStatus,
    "reversed",
  );
  assert.equal(s.records.find((r) => r.id === i.data.paymentId)!.status, "returned");
  assert.equal(openDue(s).status, "in_dispute");
});
check(() => {
  const s = fresh(),
    c = s.records.find((r) => r.kind === "customers")!;
  const grant = run(s, "consent.grant", {
    purpose: "account_read",
    subjectId: c.id,
    days: 7,
  });
  const count = s.records.length;
  run(s, "consent.grant", {
    purpose: "account_read",
    subjectId: c.id,
    days: 7,
  });
  assert.equal(s.records.length, count);
  assert.equal(
    connectedView(s, { ...ctx, now: "2026-10-01T10:00:00.000Z" }).consents[0]!
      .effectiveStatus,
    "expired",
  );
  run(s, "consent.revoke", {}, grant.id);
  assert.equal(connectedView(s, ctx).consents[0]!.effectiveStatus, "revoked");
});
check(() => {
  const s = fresh();
  assert.throws(
    () =>
      run(s, "consent.grant", {
        purpose: "account_read",
        subjectId: "foreign",
      }),
    /Choose a customer of this lender, or the sample business/,
  );
  assert.throws(
    () =>
      run(s, "consent.grant", {
        purpose: "payroll_prepare",
        subjectId: openDue(s).customerId,
      }),
    /Choose a customer of this lender, or the sample business/,
  );
});
check(() => {
  const s = fresh(),
    revision = connectedRevision(s);
  checkout(s);
  assert.throws(
    () =>
      runConnectedAction(s, ctx, {
        action: "consent.grant",
        reason: "Test stale form",
        data: {},
        expectedRevision: revision,
      }),
    /changed/,
  );
});
check(() => {
  const s = fresh(),
    i = checkout(s);
  run(s, "payment.authorise", {}, i.id);
  const before = structuredClone(s),
    due = openDue(s);
  makeRecord(s, "attempts", {
    status: "scheduled",
    customerId: due.customerId,
    amountKobo: due.amountKobo,
    createdAt: ctx.now,
    data: { dueItemId: due.id },
  });
  assert.throws(
    () => assertFinalState(before, s, s.merchant.id),
    /Pay by Bank checkout and another collection in progress at the same time/,
  );
});
check(() => {
  const s = fresh();
  makeRecord(s, "connected-credit-assessments", {
    status: "complete",
    createdAt: ctx.now,
    data: { result: { score: 50 } },
  });
  const before = structuredClone(s);
  s.records.at(-1)!.data.result.score = 99;
  assert.throws(() => assertFinalState(before, s, s.merchant.id), /Saved evidence cannot be changed\. Reload the page and try again\./);
});
check(() => {
  const s = fresh(),
    i = checkout(s);
  run(s, "payment.authorise", {}, i.id);
  while (
    s.records.filter((record) => record.kind.startsWith("connected-")).length <
    1500
  )
    makeRecord(s, "connected-cap-fixture", {
      name: "Synthetic quota fixture",
      createdAt: ctx.now,
    });
  assert.throws(
    () => run(s, "credit.assess", { customerId: i.customerId }),
    /limit for connected banking records/,
  );
  assert.throws(() => run(s, "cash.vat.export"), /limit for connected banking records/);
  assert.doesNotThrow(() =>
    run(s, "consent.revoke", {}, String(i.data.consentId)),
  );
  assert.doesNotThrow(() =>
    run(s, "payment.outcome", { outcome: "confirmed" }, i.id),
  );
  assert.equal(i.status, "confirmed");
  assert.equal(
    s.records.find((record) => record.id === i.data.consentId)!.status,
    "revoked",
  );
});
check(() => {
  // The revision covers what the workspace shows and what its actions read, and
  // nothing else (the 23 September audit): history elsewhere in the lender no
  // longer makes a reviewed form stale, and a write, which loads older closes as
  // summaries, computes the revision the read computed.
  const s = fresh(),
    revision = connectedRevision(s);
  makeRecord(s, "audit", { status: "recorded", createdAt: ctx.now, data: { action: "elsewhere" } });
  const close = makeRecord(s, "closes" as string, {
    status: "completed",
    createdAt: ctx.now,
    data: { report: { unallocated: { count: 1 } }, operational: { rows: [1, 2, 3] } },
  });
  makeRecord(s, "exports", { status: "queued", createdAt: ctx.now, data: { kind: "payments" } });
  s.records.find((r) => r.kind === "payments")!.data.narration = "Edited elsewhere";
  // A settled instalment and its collected attempt are history too.
  const settled = s.records.find((r) => r.kind === "due-items" && r.status === "paid")!;
  settled.name = "Renamed settled instalment";
  s.records.find((r) => r.kind === "attempts" && r.data.dueItemId === settled.id)!.data.note = "Checked";
  assert.equal(connectedRevision(s), revision, "history outside the workspace keeps its revision");
  delete close.data.operational;
  assert.equal(connectedRevision(s), revision, "a close loaded as a summary keeps it too");
  const receipt = (t: DomainState) => {
    const i = checkout(t);
    run(t, "payment.authorise", {}, i.id);
    run(t, "payment.outcome", { outcome: "confirmed" }, i.id);
    return t.records.find((r) => r.id === i.data.paymentId)!;
  };
  const changes: [string, (t: DomainState) => void][] = [
    ["a customer's name", (t) => { t.records.find((r) => r.kind === "customers")!.name = "Renamed applicant"; }],
    ["a customer removed", (t) => { t.records = t.records.filter((r) => r !== t.records.find((x) => x.kind === "customers")); }],
    ["an instalment's balance", (t) => { openDue(t).data.outstandingKobo = 1; }],
    ["an attempt's status", (t) => { t.records.find((r) => r.kind === "attempts" && r.status === "failed")!.status = "unknown"; }],
    ["an instalment settled", (t) => { const due = openDue(t); due.status = "paid"; due.data.outstandingKobo = 0; }],
    ["a new attempt", (t) => { makeRecord(t, "attempts", { status: "sent", customerId: openDue(t).customerId, createdAt: ctx.now, data: { dueItemId: openDue(t).id } }); }],
    ["a connected record", (t) => { makeRecord(t, "connected-cash-forecasts", { createdAt: ctx.now, data: { entityId: "elsewhere" } }); }],
    ["a pay-by-bank receipt", (t) => { const payment = receipt(t), before = connectedRevision(t); payment.data.refundStatus = "refunded"; assert.notEqual(connectedRevision(t), before); }],
    ["a receipt's allocation", (t) => { const payment = receipt(t), before = connectedRevision(t); t.records.find((r) => r.kind === "allocations" && r.data.paymentId === payment.id)!.status = "superseded"; assert.notEqual(connectedRevision(t), before); }],
    ["a lender setting", (t) => { t.settings.environment = "production"; }],
    ["the lender", (t) => { t.merchant.killSwitch = true; }],
  ];
  for (const [label, change] of changes) {
    const t = fresh(),
      before = connectedRevision(t);
    change(t);
    assert.notEqual(connectedRevision(t), before, `${label} changes the revision`);
  }
});
check(() => {
  // The review of those fixes: of the lender's settings, the revision covers only
  // the ones the workspace and its actions read (the environment), so the
  // scheduler's bookkeeping, an unrelated audited write and a scheduled close
  // that changes nothing the workspace shows keep a reviewed form current.
  const unrelated: [string, (t: DomainState) => void][] = [
    ["the next scheduled close", (t) => { t.settings.nextCloseAt = "2026-09-22T06:00:00.000Z"; }],
    ["a failed scheduled close's retry", (t) => { t.settings.closeRetry = { cursor: t.settings.nextCloseAt, failures: 1, retryAt: "2026-09-21T10:02:00.000Z", lastFailedAt: ctx.now }; }],
    ["a pause for an idle sandbox", (t) => { pauseIdleSandboxClose(t, ctx.now); }],
    ["the close time", (t) => { t.settings.closeTime = "08:00"; }],
    ["the audit chain's head", (t) => { t.settings.auditChain = { sequence: 1, hash: "a".repeat(64) }; }],
    ["an audited write elsewhere", (t) => { appendAudit(t, ctx, "elsewhere", "workspace", "An unrelated audited write."); }],
  ];
  for (const [label, change] of unrelated) {
    const t = fresh(),
      before = connectedRevision(t);
    change(t);
    assert.equal(connectedRevision(t), before, `${label} keeps the revision`);
  }
  const t = fresh();
  t.settings.nextCloseAt = "2026-09-21T06:00:00.000Z";
  reconcile(t, { ...finance, now: "2026-09-21T06:00:00.000Z" });
  const before = connectedRevision(t);
  runDailyClose(t, { ...ctx, now: "2026-09-21T06:01:00.000Z", actor: "system:scheduled close" }, "scheduled");
  assert.notEqual(t.settings.nextCloseAt, "2026-09-21T06:00:00.000Z", "the close moved the scheduler's cursor");
  assert.equal(connectedRevision(t), before, "a scheduled close that changes nothing the workspace shows keeps the revision");
});
check(() => {
  // The view's work grows with the records, not with the customers or the open
  // instalments times the records, and the customers are listed once (the
  // 23 September audit).
  const s = workflowFixture(200);
  const customers = s.records.filter((r) => r.kind === "customers");
  customers.forEach((customer, index) => {
    if (index % 4) return;
    for (const purpose of index % 8 ? ["account_read"] : ["account_read", "credit_assessment"])
      run(s, "consent.grant", { purpose, subjectId: customer.id });
  });
  const assessed = customers.filter((_, index) => index % 8 === 0).slice(0, 3);
  for (const customer of assessed) run(s, "credit.assess", { customerId: customer.id, scenario: "ready" });
  const dues = s.records.filter((r) => r.kind === "due-items" && r.status === "scheduled");
  dues.forEach((due, index) => {
    if (index % 10 === 0) makeRecord(s, "attempts", { status: "sent", customerId: due.customerId, createdAt: ctx.now, data: { dueItemId: due.id } });
  });
  let visits = 0;
  for (const name of ["filter", "find", "some"] as const) {
    const original = Array.prototype[name] as (...args: any[]) => any;
    Object.defineProperty(s.records, name, { configurable: true, value(this: ValopayRecord[], ...args: any[]) { visits += this.length; return original.apply(this, args); } });
  }
  const view = connectedView(s, ctx);
  for (const name of ["filter", "find", "some"]) delete (s.records as any)[name];
  assert.ok(visits < s.records.length * 40, `the view visited ${visits} records scanning a list of ${s.records.length}`);
  assert.equal(view.customers.length, 200);
  assert.equal("customers" in view.credit, false, "the customer list is not sent twice");
  assert.deepEqual(
    view.credit.permissions,
    customers.filter((_, index) => index % 4 === 0).map((customer, index) => ({ customerId: customer.id, accountRead: true, creditAssessment: index % 2 === 0 })),
    "only applicants holding a permission are listed, with both of theirs",
  );
  assert.deepEqual(view.credit.assessments.map((item) => [item.customerId, item.customerName, item.permissionRestricted]).sort(), assessed.map((customer) => [customer.id, customer.name, false]).sort());
  assert.equal(view.payments.dues.length, dues.length);
  assert.deepEqual(view.payments.dues.filter((due) => due.blocked).map((due) => due.id), dues.filter((_, index) => index % 10 === 0).map((due) => due.id));
  assert.ok(view.payments.dues.every((due) => due.customerName === customers.find((customer) => customer.id === due.customerId)!.name));
});
console.log(
  `${checks} connected workflow, authority, race and persistence checks passed.`,
);
