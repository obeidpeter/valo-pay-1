import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { EvidenceDisclosure } from "@/components/evidence-disclosure";
import { PaymentProgress, paymentProgress } from "@/features/pay-by-bank/payment-progress";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("connected task navigation", () => {
  it("restores a Cash Desk section directly, preserves other URL state and follows browser Back without a mutation", async () => {
    const user = userEvent.setup();
    renderApp("/cash-desk?view=accounting&marker=keep");
    await screen.findByRole("heading", { name: "Accounting" });
    expect(screen.getByRole("button", { name: "Accounting" }).getAttribute("aria-current")).toBe("page");
    await user.click(screen.getByRole("button", { name: "Payroll funding" }));
    expect(new URLSearchParams(window.location.search).get("view")).toBe("payroll");
    expect(new URLSearchParams(window.location.search).get("marker")).toBe("keep");
    expect(screen.getByRole("heading", { name: "Payroll funding" })).toBeTruthy();
    window.history.back();
    await waitFor(() => expect(screen.getByRole("button", { name: "Accounting" }).getAttribute("aria-current")).toBe("page"));
    expect(screen.getByRole("heading", { name: "Accounting" })).toBeTruthy();
    expect(api.calls.filter(call => call.method === "POST" && call.path.includes("/connected/actions"))).toHaveLength(0);
  });

  it("keeps a forecast draft when moving between sections and protects it when leaving the page", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderApp("/cash-desk?view=unsupported");
    const buffer = await screen.findByLabelText("Planning buffer (₦)");
    await user.clear(buffer);
    await user.type(buffer, "245000.25");
    await user.click(screen.getByRole("button", { name: "Accounting" }));
    await user.click(screen.getByRole("button", { name: "Cash and forecast" }));
    expect((screen.getByLabelText("Planning buffer (₦)") as HTMLInputElement).value).toBe("245000.25");
    expect(confirm).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).has("view")).toBe(false);
    await user.click(screen.getAllByRole("link", { name: "Audit log" })[0]);
    expect(confirm).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe("/cash-desk");
    expect(api.calls.filter(call => call.method === "POST" && call.path.includes("/connected/actions"))).toHaveLength(0);
  });

  it("associates an unavailable sample setup with the role and next step", async () => {
    api.role = "Finance";
    renderApp("/cash-desk");
    const action = await screen.findByRole("button", { name: "Set up Cash Desk" });
    expect((action as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById(action.getAttribute("aria-describedby")!)?.textContent).toContain("Only Admin or Operations can set up Cash Desk. Your role is Finance.");
  });
});

describe("evidence disclosure", () => {
  it("opens all supporting evidence for printing and restores each prior state after repeated beforeprint events", async () => {
    const user = userEvent.setup();
    render(<><EvidenceDisclosure title="Evidence fingerprint"><p>Saved immutable fingerprint</p></EvidenceDisclosure><EvidenceDisclosure title="Excluded observations"><p>Retained reasons</p></EvidenceDisclosure></>);
    const first = screen.getByText("Evidence fingerprint").closest("details")!;
    const second = screen.getByText("Excluded observations").closest("details")!;
    await user.click(first.querySelector("summary")!);
    expect(first.open).toBe(true);
    expect(second.open).toBe(false);
    window.dispatchEvent(new Event("beforeprint"));
    window.dispatchEvent(new Event("beforeprint"));
    expect([first.open, second.open]).toEqual([true, true]);
    window.dispatchEvent(new Event("afterprint"));
    expect([first.open, second.open]).toEqual([true, false]);
  });
});

describe("payment evidence progress", () => {
  it.each(["authorised", "pending", "unknown"])("never presents %s as a confirmed payment", status => {
    render(<PaymentProgress status={status} expired={false} held={false} refundRequested={false} />);
    const progress = screen.getByRole("list", { name: "Checkout steps" });
    const receipt = within(progress).getByText("3. Payment confirmed").closest("li")!;
    expect(receipt.textContent).not.toContain("Completed");
    expect(receipt.getAttribute("aria-current")).toBe("step");
    if (status === "unknown") expect(screen.getByText(/Do not start another payment for this instalment while the outcome is unknown/)).toBeTruthy();
    else expect(screen.getByText(/a return from the bank do not prove payment/)).toBeTruthy();
  });

  it.each([
    ["created", "Check the details before authorisation"], ["cancelled", "Checkout cancelled before authorisation"],
    ["failed", "Payment failed"], ["confirmed", "Payment confirmed"],
    ["refunded", "Refund recorded"], ["reversed", "Reversal recorded"],
  ])("gives a safe next step for %s with no actionable controls", (status, title) => {
    render(<PaymentProgress status={status} expired={false} held={false} refundRequested={false} />);
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    if (["refunded", "reversed"].includes(status)) expect(screen.getByText(/original payment stays in the timeline/)).toBeTruthy();
  });

  it("keeps expiry, reversal review and refund approval distinct", () => {
    expect(paymentProgress("created", { expired: true }).title).toBe("Checkout expired");
    expect(paymentProgress("created", { held: true }).title).toBe("Finish the reversal review first");
    expect(paymentProgress("confirmed", { refundRequested: true }).title).toBe("Refund waiting for a Finance reviewer");
    expect(paymentProgress("unknown", { expired: true }).title).toBe("Resolve the unknown outcome");
  });
});
