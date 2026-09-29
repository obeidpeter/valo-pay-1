import assert from "node:assert/strict";
import type { ConnectedActionResult } from "@workspace/valopay-schema";
import { assertConnectedReplayAllowed } from "../src/domain/connected-replay.js";
import { cashView, runCashAction } from "../src/domain/connected-cash-service.js";
import { runCreditAction } from "../src/domain/connected-credit-service.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";
import type { Context } from "../src/domain/types.js";

const now = "2026-09-26T10:00:00.000Z";
const operations: Context = { actor: "Sandbox Operations", role: "Operations", now };
const finance: Context = { actor: "Sandbox Finance", role: "Finance", now };
const reason = "Verify receipt access under current authority";
const response = (record: unknown) => structuredClone({ message: "Sample workspace updated.", record, mode: "synthetic", externalInstructionPerformed: false }) as ConnectedActionResult;
let checks = 0;
const denied = (fn: () => void, status: number) => {
  assert.throws(fn, (error: any) => error.status === status && /already completed/.test(error.message) && /not been run again/.test(error.message));
  checks++;
};
function fixture() {
  const state = seedMerchant("replay-authority-fixture");
  const customerId = recordsOf(state, "customers")[0]!.id;
  const grant = (purpose: string, sme = true) => makeRecord(state, "connected-consents", {
    name: `Synthetic ${purpose}`, status: "active", createdAt: now,
    data: { purpose, subjectId: sme ? "sme" : customerId, entityId: sme ? `${state.merchant.id}:sme` : state.merchant.id, version: 1, expiresAt: "2026-10-26T10:00:00.000Z" },
  });
  const cashGrants = Object.fromEntries(["merchant_account_read", "erp_draft", "payroll_prepare"].map((purpose) => [purpose, grant(purpose)]));
  const cash = (action: string, ctx = operations, recordId?: string, data: Record<string, unknown> = {}) =>
    runCashAction(state, ctx, { action, recordId, data, reason });
  const erpExport = () => {
    cash("cash.initialize");
    const prepared = cash("cash.erp.prepare").record!;
    cash("cash.erp.review", finance, prepared.id);
    return response(cash("cash.erp.export", finance, prepared.id));
  };
  const payrollExport = () => {
    cash("cash.initialize");
    const prepared = cash("cash.payroll.prepare").record!;
    cash("cash.payroll.approve", finance, prepared.id);
    return response(cash("cash.payroll.export", finance, prepared.id));
  };
  const credit = () => response(runCreditAction(state, operations, { action: "credit.assess", data: { customerId, scenario: "ready" }, reason }));
  return { state, customerId, grant, cashGrants, cash, erpExport, payrollExport, credit };
}
{
  const f = fixture(), saved = f.erpExport(), before = structuredClone(f.state);
  assertConnectedReplayAllowed(f.state, finance, "cash.erp.export", saved);
  assert.deepEqual(f.state, before, "replay guard is read-only and never re-executes export");
  checks += 2;
  f.cashGrants.erp_draft!.status = "revoked";
  denied(() => assertConnectedReplayAllowed(f.state, finance, "cash.erp.export", saved), 403);
  f.grant("erp_draft");
  denied(() => assertConnectedReplayAllowed(f.state, finance, "cash.erp.export", saved), 409);
}
for (const change of ["mapping", "closed_period", "recorded_receipt"] as const) {
  const f = fixture(), saved = f.erpExport();
  const input = f.state.records.find((record) => record.kind === "connected-cash-workspace")!.data.workspace.erpInput;
  if (change === "mapping") input.mapping.version = "changed-mapping";
  else if (change === "closed_period") input.closedThrough = input.postingDate;
  else input.alreadyRecordedReceiptIds = [input.canonicalReceiptId];
  denied(() => assertConnectedReplayAllowed(f.state, finance, "cash.erp.export", saved), 409);
}
{
  const f = fixture(), saved = f.payrollExport();
  assertConnectedReplayAllowed(f.state, finance, "cash.payroll.export", saved);
  checks++;
  denied(() => assertConnectedReplayAllowed(f.state, { ...finance, now: "2026-09-26T12:00:00.000Z" }, "cash.payroll.export", saved), 409);
  const record = (saved.record as any).record;
  f.cash("cash.payroll.reconcile", finance, record.id, { itemId: "payroll-one", status: "unknown" });
  denied(() => assertConnectedReplayAllowed(f.state, finance, "cash.payroll.export", saved), 409);
}
{
  const f = fixture(), saved = f.payrollExport();
  f.cashGrants.payroll_prepare!.data.version = 2;
  denied(() => assertConnectedReplayAllowed(f.state, finance, "cash.payroll.export", saved), 409);
  denied(() => assertConnectedReplayAllowed(f.state, operations, "cash.payroll.export", saved), 403);
}
{
  const f = fixture();
  f.grant("account_read", false);
  const creditGrant = f.grant("credit_assessment", false);
  const saved = f.credit();
  assert.ok((saved.record as any).data.result.score);
  assertConnectedReplayAllowed(f.state, operations, "credit.assess", saved);
  checks += 2;
  creditGrant.status = "revoked";
  denied(() => assertConnectedReplayAllowed(f.state, operations, "credit.assess", saved), 403);
  f.grant("credit_assessment", false);
  denied(() => assertConnectedReplayAllowed(f.state, operations, "credit.assess", saved), 403);
}
{
  const f = fixture(), saved = f.credit();
  const result = (saved.record as any).data.result;
  assert.deepEqual([result.state, result.score, result.features, result.affordability], ["blocked", null, null, null]);
  assertConnectedReplayAllowed(f.state, operations, "credit.assess", saved);
  checks += 2;
  denied(() => assertConnectedReplayAllowed(f.state, { ...operations, role: "Read-only" }, "credit.assess", saved), 403);
}
{
  const f = fixture();
  f.grant("account_read", false);
  const grant = f.grant("credit_assessment", false);
  const saved = f.credit();
  const before = structuredClone(saved);
  grant.data.validFrom = "2026-09-27T10:00:00.000Z";
  denied(() => assertConnectedReplayAllowed(f.state, operations, "credit.assess", saved), 403);
  assert.deepEqual(saved, before, "withholding a receipt preserves its immutable original result");
  checks++;
}
for (const action of ["cash.initialize", "cash.forecast", "cash.vat.export"]) {
  const f = fixture();
  if (action !== "cash.initialize") f.cash("cash.initialize");
  const ctx = action === "cash.vat.export" ? finance : operations;
  const saved = response(f.cash(action, ctx));
  assertConnectedReplayAllowed(f.state, ctx, action, saved);
  checks++;
  const original = (saved.record as any).record;
  const legacy = structuredClone(saved), legacyState = structuredClone(f.state);
  delete (legacy.record as any).record.data.replayAuthority;
  delete legacyState.records.find((r) => r.id === original.id)!.data.replayAuthority;
  denied(() => assertConnectedReplayAllowed(legacyState, ctx, action, legacy), 409);
  f.cashGrants.merchant_account_read!.status = "revoked";
  denied(() => assertConnectedReplayAllowed(f.state, ctx, action, saved), 403);
  f.grant("merchant_account_read");
  denied(() => assertConnectedReplayAllowed(f.state, ctx, action, saved), 409);
}
// A signed-in staff member retries their own lost answer as a sandbox visitor does: what is checked is the lender
// (a synthetic sandbox), never the actor's name. The key is the sender's own (the route's fingerprint names the
// actor, and the journal entry its owner), so every other check stays: role, grants and the saved record.
{
  const f = fixture();
  const staff: Context = { actor: "Clerk:user_synthetic_operations", role: "Operations", now, accessMode: "staff" };
  const staffFinance: Context = { actor: "Clerk:user_synthetic_finance", role: "Finance", now, accessMode: "staff" };
  f.cash("cash.initialize", staff);
  const forecast = response(f.cash("cash.forecast", staff));
  assertConnectedReplayAllowed(f.state, staff, "cash.forecast", forecast);
  const vat = response(f.cash("cash.vat.export", staffFinance));
  assertConnectedReplayAllowed(f.state, staffFinance, "cash.vat.export", vat);
  const prepared = f.cash("cash.erp.prepare", staff).record!;
  f.cash("cash.erp.review", staffFinance, prepared.id);
  const exported = response(f.cash("cash.erp.export", staffFinance, prepared.id));
  assertConnectedReplayAllowed(f.state, staffFinance, "cash.erp.export", exported);
  checks += 3;
  denied(() => assertConnectedReplayAllowed(f.state, { ...staff, role: "Read-only" }, "cash.forecast", forecast), 403);
  denied(() => assertConnectedReplayAllowed(f.state, { ...staffFinance, role: "Operations" }, "cash.erp.export", exported), 403);
  // A lender that is not a synthetic sandbox answers no retry, whoever sent it.
  const live = structuredClone(f.state);
  live.settings.environment = "production";
  for (const ctx of [staff, operations]) denied(() => assertConnectedReplayAllowed(live, ctx, "cash.forecast", forecast), 403);
}
// The desk discloses a saved forecast or VAT schedule only while it is bound to the current grants and was made from
// the evidence the desk holds now. Otherwise it stays listed, to be prepared again, without its figures, and its
// replay is refused. A revoked grant hides the list, as it hides ERP drafts and payroll plans.
{
  const f = fixture();
  f.cash("cash.initialize");
  const forecast = f.cash("cash.forecast").record!;
  const vat = f.cash("cash.vat.export", finance).record!;
  const view = () => cashView(f.state, finance);
  const listed = () => view().vatExports.map((item) => [item.id, item.state, item.schedule === undefined ? "withheld" : "shown"]);
  assert.deepEqual(view().forecast, forecast.data.forecast);
  assert.deepEqual(view().savedForecast, { id: forecast.id, createdAt: forecast.createdAt, state: "current" });
  assert.deepEqual(listed(), [[vat.id, "current", "shown"]]);
  checks += 3;
  // Revocation: the ERP grant ends, and the saved schedules are not listed at all; the forecast needs only account read.
  f.cashGrants.erp_draft!.status = "revoked";
  assert.deepEqual(view().vatExports, []);
  assert.equal(view().savedForecast?.state, "current");
  // Regrant: a new grant is not the one the schedule was saved under.
  f.grant("erp_draft");
  assert.deepEqual(listed(), [[vat.id, "prepare_again", "withheld"]]);
  checks += 3;
  const vatAnswer = response(f.cash("cash.vat.export", finance));
  assert.deepEqual(listed(), [[vat.id, "prepare_again", "withheld"], [(vatAnswer.record as any).record.id, "current", "shown"]]);
  assertConnectedReplayAllowed(f.state, finance, "cash.vat.export", vatAnswer);
  checks += 2;
  // The same for the forecast and its account-read grant.
  f.cashGrants.merchant_account_read!.status = "revoked";
  assert.deepEqual([view().forecast, view().savedForecast], [null, null]);
  f.grant("merchant_account_read");
  assert.deepEqual([view().forecast, view().savedForecast], [null, { id: forecast.id, createdAt: forecast.createdAt, state: "prepare_again" }]);
  checks += 2;
  // A changed source: the grants are current, but the evidence is not what the figures were made from.
  const fresh = response(f.cash("cash.forecast"));
  const freshVat = response(f.cash("cash.vat.export", finance));
  const [freshId, freshVatId] = [fresh, freshVat].map((saved) => (saved.record as any).record.id);
  assert.equal(view().savedForecast?.state, "current");
  const workspace = f.state.records.find((record) => record.kind === "connected-cash-workspace")!.data.workspace;
  workspace.commitments[0].amountMinor += 100;
  workspace.vatInvoices[0].vatMinor += 100;
  assert.deepEqual([view().forecast, view().savedForecast?.state], [null, "prepare_again"]);
  assert.deepEqual(listed().at(-1), [freshVatId, "prepare_again", "withheld"]);
  denied(() => assertConnectedReplayAllowed(f.state, operations, "cash.forecast", fresh), 409);
  denied(() => assertConnectedReplayAllowed(f.state, finance, "cash.vat.export", freshVat), 409);
  checks += 2;
  // Refreshing the sample's timestamps later changes no figure a forecast was made from.
  workspace.commitments[0].amountMinor -= 100;
  workspace.vatInvoices[0].vatMinor -= 100;
  const [refreshedAt, readAt] = ["2026-09-26T11:30:00.000Z", "2026-09-26T11:45:00.000Z"];
  f.cash("cash.refresh_sample", { ...operations, now: refreshedAt });
  const accounts = f.state.records.find((record) => record.kind === "connected-cash-workspace")!.data.workspace.accounts as { balanceAsOf: string; fetchedAt: string }[];
  assert.ok(accounts.length > 0 && accounts.every((account) => account.balanceAsOf === refreshedAt && account.fetchedAt === refreshedAt), "the refresh moved the sample's balance timestamps");
  const afterRefresh = cashView(f.state, { ...finance, now: readAt });
  assert.deepEqual([afterRefresh.savedForecast?.state, afterRefresh.forecast], ["current", (fresh.record as any).record.data.forecast]);
  assertConnectedReplayAllowed(f.state, { ...operations, now: readAt }, "cash.forecast", fresh);
  checks += 2;
  // Saved before its authority, or its source, was bound: it cannot show what it was made under, so it is withheld.
  delete f.state.records.find((record) => record.id === freshVatId)!.data.replayAuthority;
  assert.deepEqual(listed().at(-1), [freshVatId, "prepare_again", "withheld"]);
  delete f.state.records.find((record) => record.id === freshId)!.data.sourceHash;
  assert.deepEqual([view().forecast, view().savedForecast?.state], [null, "prepare_again"]);
  checks += 2;
}
console.log(`Connected receipt replay: ${checks} checks passed for current authority, frozen output, stale files, role changes, staff retries, safely redacted blocked assessments and withheld saved schedules and forecasts.`);
