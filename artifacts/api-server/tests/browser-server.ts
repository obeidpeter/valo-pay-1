import { SANDBOX_COOKIE } from "../src/lib/sandbox-cookie";
/** Test-only HTTP host. Production imports neither this file nor its fixture route. */
import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { customerTimeline } from "../src/domain/timeline";
import type { ValopayRecord } from "../src/domain/types";

const database = new URL(process.env.DATABASE_URL || "http://invalid");
if (
  process.env.VALO_PAY_1_RUN_INTEGRATION !== "1" ||
  process.env.VALO_PAY_1_BROWSER_DATABASE_TEST !== "1" ||
  process.env.NODE_ENV === "production" ||
  database.hostname !== "127.0.0.1" ||
  database.pathname !== "/valo_pay_1_browser_test"
) {
  throw new Error(
    "Browser database tests require an explicitly enabled, disposable loopback valo_pay_1_browser_test database.",
  );
}
// Real Clerk middleware computes a signed-out session locally; no authentication bypass in runtime code.
process.env.CLERK_SECRET_KEY = "sk_test_placeholder";
process.env.CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from("clerk.example.test$").toString("base64")}`;
process.env.LOG_LEVEL = "silent";
const { pool } = await import("@workspace/valo-pay-1-db");
const { inWorkspace, listMerchants, loadState } =
  await import("../src/lib/valo-pay-1-store");
const { default: app } = await import("../src/app");

app.post("/__test/session", async (req, res) => {
  try {
    const token = randomBytes(32).toString("hex");
    req.headers.cookie = `${SANDBOX_COOKIE}=${token}`;
    const merchants = await inWorkspace(req, res, listMerchants);
    const merchantId = merchants[0]!.id;
    const state = await inWorkspace(
      req,
      res,
      (ctx) => loadState(ctx, merchantId, "share"),
      "read",
    );
    const proposal = state.records.find(
      (r) => r.kind === "allocations" && r.status === "proposed",
    )!;
    const customerId = proposal.customerId;
    const due = state.records.find((r) => r.id === proposal.data.dueItemId)!;
    const payment = state.records.find(
      (r) => r.id === proposal.data.paymentId,
    )!;
    const mandate = state.records.find(
      (r) => r.kind === "mandates" && r.customerId === customerId,
    )!;
    const rows: ValopayRecord[] = [];
    for (let i = 0; i < 30; i++) {
      const createdAt = new Date(Date.UTC(2024, 0, i + 1)).toISOString();
      const dueId = randomUUID(),
        paymentId = randomUUID(),
        mandateId = randomUUID();
      for (const [base, prefix] of [
        [due, "DUE"],
        [payment, "PAY"],
        [mandate, "MND"],
        [proposal, "MATCH"],
      ] as const) {
        const id =
          prefix === "DUE"
            ? dueId
            : prefix === "PAY"
              ? paymentId
              : prefix === "MND"
                ? mandateId
                : randomUUID();
        const data = {
          ...base.data,
          ...(prefix === "MATCH"
            ? { paymentId, dueItemId: dueId }
            : prefix === "DUE"
              ? { mandateId }
              : prefix === "PAY"
              ? { proposedDueItemId: dueId, dueItemId: dueId }
                : {}),
        };
        rows.push({
          ...base,
          id,
          data,
          reference: `DB-${prefix}-${String(i).padStart(2, "0")}`,
          createdAt,
          updatedAt: createdAt,
        });
      }
    }
    await pool.query(
      `INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
      SELECT id,"merchantId",kind,name,status,reference,"amountKobo","customerId",data,"createdAt","updatedAt" FROM jsonb_to_recordset($1::jsonb)
      AS x(id text,"merchantId" text,kind text,name text,status text,reference text,"amountKobo" bigint,"customerId" text,data jsonb,"createdAt" timestamptz,"updatedAt" timestamptz)`,
      [JSON.stringify(rows)],
    );
    state.records.push(...rows);
    const history = customerTimeline(state, customerId);
    res.cookie(SANDBOX_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    res.json({
      merchantId,
      otherMerchantId: merchants[1]!.id,
      customerId,
      customerName: history.customer.name,
      oldRecordId: rows[0]!.id,
      position: history.position,
      eventCount: history.events.length,
      paymentReference: payment.reference,
      proposalId: proposal.id,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Synthetic browser fixture failed." });
  }
});
const root = path.resolve(import.meta.dirname, "../../valo-pay-1/dist/public");
// Replit serves console documents separately from the API. Keep real API
// middleware intact, without sending static documents into Clerk's handshake.
const host = express();
host.use((req, res, next) => {
  if (req.path === '/api' || req.path.startsWith('/api/') || req.path.startsWith('/__test/')) app(req, res, next);
  else next();
});
host.use(express.static(root));
host.get("/{*path}", (_req, res) => res.sendFile(path.join(root, "index.html")));
const server = host.listen(4175, "127.0.0.1");
const stop = () =>
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
