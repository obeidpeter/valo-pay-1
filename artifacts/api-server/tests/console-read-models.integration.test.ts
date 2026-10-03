import { SANDBOX_COOKIE } from "../src/lib/sandbox-cookie";
import { pageCustomerHistory } from '../src/lib/customer-history';
import { customerTimeline } from '../src/domain/timeline';
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  pageReconciliation,
  pageCloseHistory,
  reconciliationQueues,
} from "../src/lib/console-read-models";
import { buildConsoleReports } from "../src/lib/valo-pay-1-close-views";
import { previousMonth } from "../src/domain/billing";
import type { ValopayRecord } from "../src/domain/types";
if (process.env.VALO_PAY_1_RUN_INTEGRATION !== "1") process.exit(0);
const { pool } = await import("@workspace/valo-pay-1-db");
const {
  inWorkspace,
  listMerchants,
  loadState,
  listReconciliation,
  listCloseHistory,
  getCloseDetail,
  getCustomerHistory,
  loadReportsView,
} = await import("../src/lib/valo-pay-1-store");
const tokens = [
  randomBytes(32).toString("hex"),
  randomBytes(32).toString("hex"),
];
const request = (token = tokens[0]) =>
  ({
    headers: { cookie: `${SANDBOX_COOKIE}=${token}` },
    secure: false,
    auth: Object.assign(() => ({ userId: null }), {
      [Symbol.for("@clerk/express.auth")]: true,
    }),
  }) as any;
const response = () => ({ cookie() {} }) as any;
try {
  const lenders = await inWorkspace(request(), response(), listMerchants),
    merchantId = lenders[0]!.id,
    otherId = lenders[1]!.id;
  const { state, now } = await inWorkspace(
    request(),
    response(),
    async (ctx) => ({
      state: await loadState(ctx, merchantId, "share"),
      now: ctx.now,
    }),
    "read",
  );
  const proposal = state.records.find(
    (r) => r.kind === "allocations" && r.status === "proposed",
  )!;
  const due = state.records.find((r) => r.id === proposal.data.dueItemId)!;
  const rows: ValopayRecord[] = [];
  const month = previousMonth(now);
  for (let i = 0; i < 450; i++) {
    rows.push({
      ...proposal,
      id: randomUUID(),
      reference: `READ-MATCH-${i}`,
      status: i < 60 ? "proposed" : i % 3 ? "confirmed" : "superseded",
      createdAt: `${month}-05T12:00:00.000Z`,
      data: {
        ...proposal.data,
        automatic: true,
        confidence: "certain",
        confirmedAt: `${month}-05T12:00:00Z`,
        ...(i % 2 ? { reviewed: i % 3 !== 0 } : {}),
      },
    });
    rows.push({
      ...due,
      id: randomUUID(),
      kind: "closes",
      reference: `READ-CLOSE-${i}`,
      status: "completed",
      createdAt: new Date(
        Date.UTC(2025, 0, 1, 22, 30) + i * 86400000,
      ).toISOString(),
      data: {
        synthetic: true,
        summary: `Close ${i}`,
        closedAt: new Date(
          Date.UTC(2025, 0, 1, 22, 30) + i * 86400000,
        ).toISOString(),
        report: {
          unallocated: { kobo: i * 100, olderThan24Hours: i % 2 },
          exceptions: { openAtClose: i, overdueAtClose: i % 3 },
          customerPositionsChanged: Array.from({ length: 50 }, (_, j) => ({
            customerId: `synthetic-${j}`,
            value: j,
          })),
        },
      },
    });
  }
  // Matches at the audit month's edges, which are midnight West Africa Time
  // (23:00 UTC the day before): at the month's first instant and half an hour
  // later (still the previous month in UTC), at its last millisecond, and at
  // the next month's first instant (still this month in UTC). One more has no
  // confirmedAt, so its creation time stands in, and one is a date only.
  const monthStart = Date.parse(`${month}-01T00:00:00.000Z`) - 3_600_000;
  const [year, monthNumber] = month.split("-").map(Number);
  const nextMonthStart = Date.UTC(year!, monthNumber!, 1) - 3_600_000;
  const edges = [
    { at: monthStart, stamped: true },
    { at: monthStart + 30 * 60_000, stamped: true },
    { at: nextMonthStart - 1, stamped: true },
    { at: nextMonthStart, stamped: true },
    { at: monthStart + 30 * 60_000, stamped: false },
  ];
  for (const [index, edge] of edges.entries()) {
    const at = new Date(edge.at).toISOString();
    const data: Record<string, unknown> = {
      ...proposal.data,
      automatic: true,
      confidence: "certain",
    };
    if (edge.stamped) data.confirmedAt = at;
    else delete data.confirmedAt;
    rows.push({
      ...proposal,
      id: randomUUID(),
      reference: `READ-WAT-${index}`,
      status: "confirmed",
      createdAt: at,
      data,
    });
  }
  rows.push({
    ...proposal,
    id: randomUUID(),
    reference: "READ-WAT-DATE",
    status: "confirmed",
    createdAt: `${month}-01T00:00:00.000Z`,
    data: {
      ...proposal.data,
      automatic: true,
      confidence: "certain",
      confirmedAt: `${month}-01`,
    },
  });
  // Customer credit in SQL reads refunds as paymentUnappliedKobo does: a refund
  // with its amount recorded returned that much, one recorded before the amount
  // was kept returned the whole payment, and a reversal returned everything.
  const paymentTemplate = state.records.find(
    (r) => r.id === proposal.data.paymentId,
  )!;
  for (const [reference, status, amountKobo, data] of [
    ["READ-REFUND-PART", "unallocated", 3_000_000, { allocatedKobo: 0, refundStatus: "refunded", refundedKobo: 500_000 }],
    ["READ-REFUND-APPLIED", "allocated", 3_000_000, { allocatedKobo: 2_500_000, refundStatus: "refunded", refundedKobo: 500_000 }],
    ["READ-REFUND-LEGACY", "returned", 1_000_000, { allocatedKobo: 0, refundStatus: "recorded_externally" }],
    ["READ-REFUND-WHOLE", "returned", 700_000, { allocatedKobo: 0, refundStatus: "refunded", refundedKobo: 700_000 }],
    ["READ-REVERSED", "returned", 900_000, { allocatedKobo: 0, reversalStatus: "reversed" }],
    // Finance's payments queue holds the unapplied rest of a partial or overpaid payment, and nothing once it is all applied or returned.
    ["READ-PARTIAL-REST", "partial", 3_000_000, { allocatedKobo: 1_000_000 }],
    ["READ-OVERPAID-REST", "overpaid", 3_000_000, { allocatedKobo: 2_500_000 }],
    ["READ-PARTIAL-SPENT", "partial", 3_000_000, { allocatedKobo: 2_500_000, refundStatus: "refunded", refundedKobo: 500_000 }],
    // The review of those fixes: money in another currency is no naira credit, whatever the spelling of its currency, and a payment with nothing unapplied waits for nobody.
    ["READ-USD", "unallocated", 100_000, { allocatedKobo: 0, currency: "USD" }],
    ["READ-USD-SPELLED", "unallocated", 50_000, { allocatedKobo: 0, currency: " usd " }],
    ["READ-NGN-SPELLED", "unallocated", 70_000, { allocatedKobo: 0, currency: " ngn " }],
    ["READ-ZERO", "unallocated", 0, { allocatedKobo: 0 }],
  ] as const) {
    const { proposedDueItemId: _due, proposedAmountKobo: _amount, ...kept } =
      paymentTemplate.data;
    rows.push({
      ...paymentTemplate,
      id: randomUUID(),
      reference,
      status,
      amountKobo,
      customerId: due.customerId,
      data: Object.assign({ ...kept, refundStatus: "none", reversalStatus: "none" }, data),
    });
  }
  await pool.query(
    `INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
    SELECT id,"merchantId",kind,name,status,reference,"amountKobo","customerId",data,"createdAt","updatedAt" FROM jsonb_to_recordset($1::jsonb) AS x(id text,"merchantId" text,kind text,name text,status text,reference text,"amountKobo" bigint,"customerId" text,data jsonb,"createdAt" timestamptz,"updatedAt" timestamptz)`,
    [JSON.stringify(rows)],
  );
  const normalise = (page: any) => ({
    ...page,
    related: page.related?.sort((a: any, b: any) => a.id.localeCompare(b.id)),
  });
  await inWorkspace(
    request(),
    response(),
    async (ctx) => {
      // The reference for every paged read model is the whole stored lender: a load has earlier closes as summaries and no audit chain.
      const full = { ...(await loadState(ctx, merchantId, "share")), records: (await pool.query("SELECT * FROM valopay_records WHERE merchant_id=$1 ORDER BY created_at,id", [merchantId])).rows.map((row): ValopayRecord => ({ id: row.id, merchantId: row.merchant_id, kind: row.kind, name: row.name, status: row.status, reference: row.reference, amountKobo: Number(row.amount_kobo), customerId: row.customer_id, data: row.data, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() })) };
      for (const queue of reconciliationQueues)
        for (const filters of [
          { limit: 25 },
          { limit: 25, offset: 25 },
          { limit: 100, offset: 99999 },
          { limit: 25, dueItem: due.id },
          { limit: 25, dueItem: "unavailable" },
          ...[due.reference, state.records.find(r=>r.id===proposal.data.paymentId)!.reference, 'CHIAMAKA', 'read-match-4', '%_', 'no-match'].map(q=>({limit:25,offset:25,q})),
        ]) {
          const actual = await listReconciliation(
            ctx,
            merchantId,
            queue,
            filters,
          );
          assert.deepEqual(
            normalise(actual),
            normalise(pageReconciliation(full, queue, filters, ctx.now)),
            `${queue} ${JSON.stringify(filters)}`,
          );
          assert.ok(actual.items.length <= filters.limit);
          assert.ok(actual.related.every((r) => r.merchantId === merchantId));
        }
      // The payments queue holds the money waiting for Finance, the unapplied rest of partial and overpaid payments included.
      const queued = (await listReconciliation(ctx, merchantId, "payments", { limit: 100 })).items.map((item) => item.reference);
      assert.ok(queued.includes("READ-PARTIAL-REST") && queued.includes("READ-OVERPAID-REST") && !queued.includes("READ-PARTIAL-SPENT"), `payments queue: ${queued.join(", ")}`);
      assert.ok(queued.includes("READ-USD") && !queued.includes("READ-ZERO"), `money in another currency still waits for Finance, and a payment with nothing unapplied does not: ${queued.join(", ")}`);
      // Customer credit in SQL is naira only: what the customer's position is without the payments in another currency.
      const naira = full.records.filter((r) => !["READ-USD", "READ-USD-SPELLED"].includes(r.reference));
      assert.equal((await getCustomerHistory(ctx, merchantId, due.customerId, {})).position.unallocatedKobo, customerTimeline({ ...full, records: naira }, due.customerId).position.unallocatedKobo, "customer credit leaves out money in another currency");
      // The third review of the audit fixes: that money is listed beside it by currency, whatever the spelling, in SQL as in the domain and the dispute pack.
      assert.deepEqual((await getCustomerHistory(ctx, merchantId, due.customerId, {})).position.unallocatedOtherCurrencies, { USD: { count: 2, amount: 150_000 } }, "the customer history lists the money in another currency beside the naira credit");
      assert.deepEqual(customerTimeline(full, due.customerId).position.unallocatedOtherCurrencies, { USD: { count: 2, amount: 150_000 } }, "and so does the customer timeline");
      // The audit month is the same WAT month in SQL and in the domain.
      const watMonth = (at: string) =>
        new Date(Date.parse(at) + 3_600_000).toISOString().slice(0, 7);
      const audited = full.records.filter(
        (r) =>
          r.kind === "allocations" &&
          ["confirmed", "superseded"].includes(r.status) &&
          r.data.automatic === true &&
          r.data.confidence === "certain" &&
          watMonth(String(r.data.confirmedAt || r.createdAt)) === month,
      );
      assert.ok(
        ["READ-WAT-0", "READ-WAT-1", "READ-WAT-2", "READ-WAT-4", "READ-WAT-DATE"]
          .every((reference) => audited.some((r) => r.reference === reference)) &&
          !audited.some((r) => r.reference === "READ-WAT-3"),
        "the edge rows fall where the WAT month says",
      );
      assert.equal(
        (await listReconciliation(ctx, merchantId, "audit", { limit: 25 }))
          .precision?.population,
        audited.length,
        "the audit population counts the WAT month",
      );
      const complete=customerTimeline(full,due.customerId);
      for(const historyQuery of [{},{eventsOffset:25,eventsLimit:25},{eventsOffset:99999,mandatesOffset:99999,dueItemsOffset:99999,paymentsOffset:99999},{eventsLimit:1,mandatesLimit:1,dueItemsLimit:1,paymentsLimit:1,record:complete.events.at(-1)!.id},{record:'not-this-customer'}]) {
        const result=await getCustomerHistory(ctx,merchantId,due.customerId,historyQuery);
        assert.deepEqual(result,pageCustomerHistory(full,due.customerId,historyQuery));
        assert.deepEqual(result.position,complete.position,'paging never changes the full monetary position');
        assert.ok(result.events.length<=(historyQuery.eventsLimit||25));
        assert.equal(result.totals.events,complete.events.length);
      }
      await assert.rejects(()=>getCustomerHistory(ctx,merchantId,'missing',{}),(e:any)=>e.status===404);
      for (const filters of [
        { limit: 25 },
        { limit: 25, offset: 25 },
        { limit: 100, offset: 99999 },
        { limit: 25, from: "2025-02-01", to: "2025-02-28" },
        { limit: 25, from: "2027-01-01" },
      ]) {
        const actual = await listCloseHistory(ctx, merchantId, filters);
        assert.deepEqual(actual, pageCloseHistory(full.records, filters));
        assert.ok(
          actual.items.every((r) => !r.data.report?.customerPositionsChanged),
          "page excludes full evidence",
        );
      }
      await assert.rejects(() =>
        listCloseHistory(ctx, merchantId, { from: "2025-02-30" }),
      );
      await assert.rejects(() =>
        listCloseHistory(ctx, merchantId, {
          from: "2025-03-01",
          to: "2025-02-01",
        }),
      );
      const detail = await getCloseDetail(ctx, merchantId, rows[1]!.id);
      assert.equal(detail.data.report.customerPositionsChanged.length, 50);
      const runtime = {
        state: "off" as const,
        intervalMs: null,
        lastTickAt: null,
        lastSuccessAt: null,
        lastErrorAt: null,
      };
      const thin = await loadReportsView(ctx, merchantId);
      assert.deepEqual(
        { ...buildConsoleReports(thin, ctx.now, runtime), closes: [] },
        { ...buildConsoleReports(full, ctx.now, runtime), closes: [] },
        "thinner report reads preserve every published metric and billing result",
      );
    },
    "read",
  );
  await inWorkspace(
    request(),
    response(),
    async (ctx) => {
      await assert.rejects(()=>getCustomerHistory(ctx,otherId,due.customerId,{}),(e:any)=>e.status===404);
      const result = await listReconciliation(ctx, otherId, "proposals", {
        dueItem: due.id,
      });
      assert.equal(result.total, 0);
      assert.equal(result.related.length, 0);
      await assert.rejects(
        () => getCloseDetail(ctx, otherId, rows[1]!.id),
        (e: any) => e.status === 404,
      );
    },
    "read",
  );
  await assert.rejects(
    () =>
      inWorkspace(
        request(tokens[1]),
        response(),
        (ctx) => listCloseHistory(ctx, merchantId, {}),
        "read",
      ),
    (e: any) => e.status === 404,
  );
  console.log(
    "Console read models passed: 918 additional records, all reconciliation queues, seeded audit parity, WAT history, lazy evidence, unchanged report measures and isolation.",
  );
} finally {
  const principals = tokens.map((token) =>
    createHash("sha256").update(`demo:${token}`).digest("hex"),
  );
  const scope =
    "SELECT id FROM valopay_merchants WHERE workspace_id IN (SELECT id FROM valopay_workspaces WHERE principal_hash=ANY($1::text[]))";
  await pool.query(
    `DELETE FROM valopay_idempotency WHERE merchant_id IN (${scope})`,
    [principals],
  );
  await pool.query(
    `DELETE FROM valopay_records WHERE merchant_id IN (${scope})`,
    [principals],
  );
  await pool.query(`DELETE FROM valopay_merchants WHERE id IN (${scope})`, [
    principals,
  ]);
  await pool.query(
    "DELETE FROM valopay_workspaces WHERE principal_hash=ANY($1::text[])",
    [principals],
  );
  await pool.end();
}
