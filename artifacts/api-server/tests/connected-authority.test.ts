import assert from "node:assert/strict";
import {
  cashView,
  runCashAction,
} from "../src/domain/connected-cash-service.js";
import {
  connectedRevision,
  consentActive,
  runConnectedAction,
} from "../src/domain/connected.js";
import { makeRecord } from "../src/domain/records.js";
import type {
  Context,
  DomainState,
  ValopayRecord,
} from "../src/domain/types.js";

const now = "2026-09-26T10:00:00.000Z";
const operations: Context = {
  actor: "Sandbox Operations",
  role: "Operations",
  now,
};
const finance: Context = { actor: "Sandbox Finance", role: "Finance", now };
const purposes = [
  "merchant_account_read",
  "erp_draft",
  "payroll_prepare",
] as const;
function fixture() {
  const state: DomainState = {
    merchant: {
      id: "authority-lender",
      name: "Authority fixture",
      shortName: "AF",
      segment: "cooperative",
      mode: "observation",
      status: "active",
      provider: "synthetic",
      monthlyVolume: 0,
      killSwitch: false,
      preDataReady: false,
      preLiveReady: false,
    },
    records: [],
    settings: { environment: "sandbox" },
  };
  const grant = (purpose: (typeof purposes)[number]) =>
    makeRecord(state, "connected-consents", {
      status: "active",
      createdAt: now,
      data: {
        purpose,
        subjectId: "sme",
        entityId: "authority-lender:sme",
        version: 1,
        expiresAt: "2026-10-26T10:00:00.000Z",
      },
    });
  const grants = Object.fromEntries(
    purposes.map((purpose) => [purpose, grant(purpose)]),
  ) as Record<(typeof purposes)[number], ValopayRecord>;
  const act = (
    action: string,
    context = operations,
    recordId?: string,
    data: Record<string, unknown> = {},
  ) =>
    runCashAction(state, context, {
      action,
      recordId,
      data,
      reason: "Verify current scoped authority and retained evidence",
    });
  const initialise = () => act("cash.initialize");
  const erp = () => {
    initialise();
    return act("cash.erp.prepare").record!;
  };
  const payroll = () => {
    initialise();
    return act("cash.payroll.prepare").record!;
  };
  return { state, grants, grant, act, initialise, erp, payroll };
}
let checks = 0;
const check = (run: () => void) => {
  run();
  checks++;
};

check(() => {
  const f = fixture();
  f.grants.merchant_account_read.data.validFrom = "2026-09-27T10:00:00.000Z";
  assert.equal(consentActive(f.grants.merchant_account_read, now), false);
  assert.equal(cashView(f.state, operations).permissions.read, false);
  assert.throws(f.initialise, /permission/i);
});
check(() => {
  const f = fixture();
  f.grants.merchant_account_read.data.version = 0;
  assert.throws(f.initialise, /permission/i);
  f.grants.merchant_account_read.data.version = 1;
  f.grant("merchant_account_read");
  assert.throws(
    f.initialise,
    /permission/i,
    "overlapping current grants cannot become ambiguous review authority",
  );
});
check(() => {
  const f = fixture();
  f.grants.merchant_account_read.data.entityId = "other:sme";
  assert.throws(f.initialise, /permission/i);
});
check(() => {
  const f = fixture(),
    record = f.erp();
  f.grants.erp_draft.status = "revoked";
  const replacement = f.grant("erp_draft");
  assert.throws(
    () => f.act("cash.erp.review", finance, record.id),
    /permission used for this review changed/i,
  );
  assert.equal(
    cashView(f.state, finance).erpDrafts[0]!.status,
    "review_required",
  );
  const stableIdentity = record.data.draft.idempotencyKey;
  f.act("cash.erp.refresh", operations, record.id);
  assert.equal(record.data.draft.idempotencyKey, stableIdentity);
  assert.equal(record.data.revisions.length, 1);
  f.act("cash.erp.review", finance, record.id);
  f.act("cash.erp.export", finance, record.id);
  assert.equal(record.data.reviewAuthority[1].id, replacement.id);
  assert.equal(record.data.manifest.status, "not_posted");
});
check(() => {
  const f = fixture(),
    record = f.erp();
  f.act("cash.erp.review", finance, record.id);
  f.act("cash.erp.export", finance, record.id);
  // Changing scope content without incrementing a version also invalidates it.
  f.grants.erp_draft.data.expiresAt = "2026-11-26T10:00:00.000Z";
  assert.throws(
    () => f.act("cash.erp.export", finance, record.id),
    /permission used for this review changed/i,
  );
  assert.equal(cashView(f.state, finance).erpDrafts[0]!.manifest, undefined);
  assert.ok(record.data.manifest, "the historical export stays retained");
});
for (const changed of [
  "closed_period",
  "already_recorded",
  "invoice_changed",
] as const)
  check(() => {
    const f = fixture(),
      record = f.erp();
    f.act("cash.erp.review", finance, record.id);
    f.act("cash.erp.export", finance, record.id);
    const input = f.state.records.find(
      (r) => r.kind === "connected-cash-workspace",
    )!.data.workspace.erpInput;
    if (changed === "closed_period") input.closedThrough = input.postingDate;
    else if (changed === "already_recorded")
      input.alreadyRecordedReceiptIds = [input.canonicalReceiptId];
    else input.invoices[0].version = "changed-after-review";
    assert.throws(
      () => f.act("cash.erp.export", finance, record.id),
      /closed|already recorded|changed/i,
    );
    assert.equal(cashView(f.state, finance).erpDrafts[0]!.manifest, undefined);
  });
check(() => {
  const f = fixture(),
    record = f.erp();
  const input = f.state.records.find(
    (r) => r.kind === "connected-cash-workspace",
  )!.data.workspace.erpInput;
  input.closedThrough = input.postingDate;
  const before = structuredClone(record);
  assert.throws(() => f.act("cash.erp.review", finance, record.id), /closed/i);
  assert.deepEqual(
    record,
    before,
    "failed fresh-state review must not write an approval",
  );
});
check(() => {
  const f = fixture(),
    record = f.payroll();
  f.act("cash.payroll.approve", finance, record.id);
  f.act("cash.payroll.export", finance, record.id);
  f.act("cash.payroll.reconcile", finance, record.id, {
    itemId: "payroll-one",
    status: "unknown",
  });
  f.grants.payroll_prepare.data.version = 2;
  assert.throws(
    () => f.act("cash.payroll.export", finance, record.id),
    /permission used for this review changed/i,
  );
  const restricted = cashView(f.state, finance).payrollPlans[0]!;
  assert.equal(restricted.status, "review_required");
  assert.equal(restricted.plan.approvalStatus, "draft");
  assert.equal(restricted.manifest, undefined);
  f.act("cash.payroll.refresh", operations, record.id);
  f.act("cash.payroll.approve", finance, record.id);
  const manifest = f.act("cash.payroll.export", finance, record.id).data
    .manifest as { items: Array<{ id: string }> };
  assert.equal(
    manifest.items.some((item) => item.id === "payroll-one"),
    false,
  );
  assert.equal(record.data.plan.items[0].status, "unknown");
  // Outcome investigation retains its independent item identity after permission revocation.
  f.grants.payroll_prepare.status = "revoked";
  f.grants.merchant_account_read.status = "revoked";
  f.act("cash.payroll.reconcile", finance, record.id, {
    itemId: "payroll-one",
    status: "succeeded",
  });
  assert.equal(record.data.plan.items[0].status, "succeeded");
  assert.equal(cashView(f.state, operations).payrollReconciliation.length, 0);
});
check(() => {
  const f = fixture(),
    record = f.payroll();
  f.act("cash.payroll.approve", finance, record.id);
  f.act("cash.payroll.export", finance, record.id);
  const future = { ...finance, now: "2026-09-26T12:00:00.000Z" };
  assert.equal(cashView(f.state, future).payrollPlans[0]!.manifest, undefined);
  assert.throws(
    () => f.act("cash.payroll.export", future, record.id),
    /out of date or have changed/i,
  );
});
check(() => {
  const f = fixture(),
    record = f.erp();
  f.act("cash.erp.review", finance, record.id);
  delete record.data.preparationAuthority;
  delete record.data.reviewAuthority;
  assert.throws(
    () => f.act("cash.erp.export", finance, record.id),
    /permission used for this review changed/i,
  );
  f.act("cash.erp.refresh", operations, record.id);
  f.act("cash.erp.review", finance, record.id);
  assert.equal(
    f.act("cash.erp.export", finance, record.id).data
      .externalInstructionPerformed,
    false,
  );
});
check(() => {
  const f = fixture();
  const input = {
    action: "consent.revoke",
    recordId: f.grants.erp_draft.id,
    reason: "Withdraw the previously approved accounting permission",
    data: {},
    expectedRevision: connectedRevision(f.state),
  };
  runConnectedAction(f.state, operations, input);
  assert.equal(f.grants.erp_draft.data.version, 2);
  assert.equal(f.grants.erp_draft.data.revokedAt, now);
  runConnectedAction(f.state, operations, {
    ...input,
    expectedRevision: connectedRevision(f.state),
  });
  assert.equal(
    f.grants.erp_draft.data.version,
    2,
    "repeated revocation preserves the first decision",
  );
});

console.log(
  `Connected authority: ${checks} grant binding, revocation, stale state, retained outcomes and recovery checks passed.`,
);
