import { seedMerchant } from "../src/lib/valo-pay-1-seed";
import type { DomainState, ValopayRecord } from "../src/domain/types";

export const WORKFLOW_NOW = "2027-07-01T06:00:00.000Z";
/** Six settled instalments per customer, full evidence history, and one fresh
 * provider observation for every fifth customer. All names and references are synthetic. */
export function workflowFixture(customers = 1_000): DomainState {
  const state = seedMerchant("workflow-benchmark");
  state.records = [];
  const add = (kind: string, id: string, customerId: string, status: string, amountKobo: number, data: Record<string, any>, at = "2027-06-01T06:00:00.000Z"): ValopayRecord => {
    const record = { id, merchantId: state.merchant.id, kind, name: `Synthetic ${id}`, reference: `SYN-${id}`, customerId, status, amountKobo, data: { ...data, synthetic: true }, createdAt: at, updatedAt: at };
    state.records.push(record); return record;
  };
  for (let c = 0; c < customers; c++) {
    const customerId = `customer-${c}`;
    add("customers", customerId, "", "active", 0, { bankName: "Synthetic bank", accountMasked: "****0000" });
    for (let month = 1; month <= 6; month++) {
      const at = `2027-0${month}-01T06:00:00.000Z`, dueId = `due-${c}-${month}`, paymentId = `payment-${c}-${month}`;
      add("due-items", dueId, customerId, "paid", 1_000_000, { dueDate: at, outstandingKobo: 0, owner: "lms" }, at);
      add("payments", paymentId, customerId, "allocated", 1_000_000, { allocatedKobo: 1_000_000, settlementStatus: "settled", collectionStatus: "succeeded", reversalStatus: "none", refundStatus: "none", channel: "transfer", observedAt: at, settledAt: at }, at);
      add("allocations", `allocation-${c}-${month}`, customerId, "confirmed", 1_000_000, { dueItemId: dueId, paymentId, rule: "R1", confidence: "certain", automatic: true, reviewed: true }, at);
      add("observations", `history-${c}-${month}`, customerId, "resolved", 1_000_000, { paymentId, source: "transfer" }, at);
    }
    if (c % 5 === 0) {
      const due = add("due-items", `new-due-${c}`, customerId, "scheduled", 1_000_000, { dueDate: WORKFLOW_NOW, outstandingKobo: 1_000_000, owner: "lms" }, WORKFLOW_NOW);
      add("observations", `new-observation-${c}`, customerId, "unresolved", 1_000_000, { dueItemId: due.id, source: "webhook", provider: state.merchant.provider, occurredAt: WORKFLOW_NOW }, WORKFLOW_NOW);
    }
  }
  return state;
}
