import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { queryClient } from "@/App";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { raiseException, reconcile } from "../../api-server/src/domain/reconciliation";
import { connectedRevision, runConnectedAction } from "../../api-server/src/domain/connected";

// Leaving a dispute and settling a pay-by-bank outcome that stayed unknown
// (23 September audit, items 3 and 10): Finance releases an instalment from
// dispute on Collections, and records a checkout's outcome with its evidence
// through the exception the daily close raised, which Pay-by-bank and the
// overview point to.
let api: FakeApi;
beforeEach(() => { api = installFakeApi({ now: "2026-09-21T10:00:00.000Z" }); });
afterEach(() => api.uninstall());

const record = (id: string) => api.state().records.find((item) => item.id === id)!;
const instalment = () => api.state().records.find((item) => item.reference === "DEMO-LOAN-1005")!;

/** Another persona in the same browser: the console starts again with nothing cached. */
function switchTo(role: string, path: string) {
  cleanup(); queryClient.clear(); api.role = role;
  return renderApp(path);
}

/** A reversal left DEMO-LOAN-1005 in dispute, with the exception reconciliation raises for it. */
function disputed() {
  return api.mutate((state, ctx) => {
    const due = state.records.find((item) => item.reference === "DEMO-LOAN-1005")!;
    due.status = "in_dispute";
    return raiseException(state, ctx, "customer_dispute", { linkedRecordId: due.id, customerId: due.customerId, amountKobo: due.amountKobo, notes: "Payment PSK-REV-1 was reversed: the provider reported it." });
  });
}

/** A checkout for DEMO-LOAN-1005 whose outcome has been unknown for 25 hours, and the close that raised its exception. */
function unknownCheckout() {
  return api.mutate((state, ctx) => {
    const earlier = { ...ctx, role: "Operations", actor: "Sandbox Operations", now: "2026-09-20T09:00:00.000Z" };
    const due = state.records.find((item) => item.reference === "DEMO-LOAN-1005")!;
    const step = (action: string, recordId?: string, data: Record<string, unknown> = {}) =>
      runConnectedAction(state, earlier, { action, recordId, reason: "Arranged by a console test", expectedRevision: connectedRevision(state), data } as any) as { id: string };
    const intent = step("payment.create", undefined, { dueItemId: due.id, amountKobo: due.amountKobo });
    step("payment.authorise", intent.id);
    step("payment.outcome", intent.id, { outcome: "unknown" });
    reconcile(state, ctx);
    const exception = state.records.find((item) => item.kind === "exceptions" && item.data.linkedRecordId === intent.id)!;
    return { intentId: intent.id, exceptionId: exception.id };
  });
}

it("lets Finance release an instalment from dispute on Collections, with a reason", async () => {
  const user = userEvent.setup();
  const dispute = disputed();
  switchTo("Operations", "/collections");
  let row = (await screen.findByText("DEMO-LOAN-1005")).closest("tr")!;
  const refused = within(row).getByRole("button", { name: "Release from dispute" });
  expect(refused.getAttribute("aria-disabled")).toBe("true");
  expect(document.getElementById(refused.getAttribute("aria-describedby")!.split(" ").at(-1)!)!.textContent).toBe("Requires Admin or Finance.");

  switchTo("Finance", "/collections");
  row = (await screen.findByText("DEMO-LOAN-1005")).closest("tr")!;
  await user.click(within(row).getByRole("button", { name: "Release from dispute" }));
  const dialog = await screen.findByRole("dialog", { name: "Release instalment from dispute" });
  expect(within(dialog).getByRole("region", { name: "Release context" }).textContent).toContain("Its status then follows its balance");
  await user.type(within(dialog).getByLabelText(/Reason/), "The provider withdrew the chargeback.");
  await user.click(within(dialog).getByRole("button", { name: "Release from dispute" }));
  await waitFor(() => expect(instalment().status).toBe("scheduled"));
  expect(await screen.findByText("Released from dispute")).toBeTruthy();
  expect(screen.getAllByText(/Instalment DEMO-LOAN-1005 is out of dispute and is now scheduled/).length).toBeGreaterThan(0);
  expect(instalment().data.disputeRelease).toMatchObject({ via: "finance_release", releasedBy: "Sandbox Finance", reason: "The provider withdrew the chargeback." });
  expect([record(dispute.id).status, record(dispute.id).data.resolutionCode]).toEqual(["closed", "condition_cleared"]);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("explains what a dispute's resolution does to its instalment", async () => {
  const user = userEvent.setup();
  disputed();
  renderApp("/exceptions?type=customer_dispute");
  const table = await screen.findByRole("table");
  await user.click(within(table).getByRole("button", { name: "Resolve" }));
  const dialog = await screen.findByRole("dialog", { name: "Resolve exception" });
  expect(within(dialog).getByRole("region", { name: "Exception context" }).textContent).toContain("Not upheld takes the instalment out of dispute");
});

it("has Finance record a pay-by-bank outcome that stayed unknown, with its evidence", async () => {
  const user = userEvent.setup();
  const { intentId, exceptionId } = unknownCheckout();
  expect(record(exceptionId).data).toMatchObject({ type: "unknown_outcome", owner: "Finance", linkedKind: "connected-intents" });
  switchTo("Operations", "/exceptions?type=unknown_outcome");
  const refused = within(await screen.findByRole("table")).getByRole("button", { name: "Resolve" });
  expect(document.getElementById(refused.getAttribute("aria-describedby")!.split(" ").at(-1)!)!.textContent).toBe("Requires Admin or Finance: the outcome of a pay-by-bank payment is Finance’s to record.");

  switchTo("Finance", "/exceptions?type=unknown_outcome");
  await user.click(within(await screen.findByRole("table")).getByRole("button", { name: "Resolve" }));
  const dialog = await screen.findByRole("dialog", { name: "Resolve exception" });
  const context = within(dialog).getByRole("region", { name: "Exception context" });
  expect(context.textContent).toContain("Confirmed successful records the pay-by-bank payment as received");
  expect(within(context).getByRole("link", { name: "Review the pay-by-bank checkout" }).getAttribute("href")).toContain("/pay-by-bank");
  expect(within(dialog).queryByLabelText("Failure code the provider confirmed")).toBeNull();
  await user.selectOptions(within(dialog).getByLabelText(/How was this resolved/), "resolved_succeeded");
  await user.type(within(dialog).getByLabelText(/Reason/), "The bank statement shows the payment.");
  await user.click(within(dialog).getByRole("button", { name: "Resolve exception" }));
  expect(await within(dialog).findByText("Enter the masked reference of the evidence that the payment arrived.")).toBeTruthy();
  expect(record(intentId).status).toBe("unknown");
  await user.type(within(dialog).getByLabelText("Evidence reference"), "STMT-***4411");
  await user.click(within(dialog).getByRole("button", { name: "Resolve exception" }));
  await waitFor(() => expect(record(intentId).status).toBe("confirmed"));
  expect(record(intentId).data.outcomeResolution).toMatchObject({ outcome: "confirmed", evidenceReference: "STMT-***4411", resolvedBy: "Sandbox Finance" });
  expect([instalment().status, instalment().data.outstandingKobo]).toEqual(["paid", 0]);
});

it("points from Pay by Bank and the overview to an outcome that stayed unknown", async () => {
  const { exceptionId } = unknownCheckout();
  renderApp("/pay-by-bank");
  const link = await screen.findByRole("link", { name: "Open the exception for this checkout" });
  expect(new URLSearchParams(link.getAttribute("href")!.split("?")[1]).get("record")).toBe(exceptionId);
  expect(link.closest("p")!.textContent).toContain("the daily close creates an exception for Finance");
  switchTo("Admin", "/overview");
  const alert = (await screen.findByRole("heading", { name: "Pay-by-bank outcomes unknown for over 24 hours" })).closest("li")!;
  expect(within(alert).getByRole("link", { name: /Review pay-by-bank checkouts/ }).getAttribute("href")).toBe("/pay-by-bank");
});
