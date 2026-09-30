import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("forms", () => {
  it("names each missing value at its field, focuses the first, and asks the server for nothing", async () => {
    const user = userEvent.setup();
    renderApp("/customers");
    await screen.findByText("Ada Okonkwo");
    await user.click(screen.getByRole("button", { name: "Add customer" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Add customer" }));
    expect(screen.getByRole("alert").textContent).toMatch(/highlighted fields before saving/);
    expect(screen.getByText("Full name is required.")).toBeTruthy();
    expect(screen.getByText("Loan software reference is required.")).toBeTruthy();
    const name = screen.getByLabelText(/Full name/);
    expect(document.activeElement).toBe(name);
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe("record-name-error");
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
    // Correcting a field drops its message at once.
    await user.type(name, "Bola Adeyemi");
    expect(screen.queryByText("Full name is required.")).toBeNull();
    expect(name.getAttribute("aria-invalid")).toBeNull();
  });

  it("puts what the server refuses under the field it names, and the rest in the alert", async () => {
    const user = userEvent.setup();
    api.failNext(/^\/v1\/records\/customers$/, { status: 400, error: "Validation failed.", details: [{ field: "reference", message: "This reference is already used by another customer." }] }, "POST");
    renderApp("/customers");
    await screen.findByText("Ada Okonkwo");
    await user.click(screen.getByRole("button", { name: "Add customer" }));
    await user.type(await screen.findByLabelText(/Full name/), "Bola Adeyemi");
    const reference = screen.getByLabelText(/Loan software reference/);
    await user.type(reference, "DEMO-C1001");
    await user.type(screen.getByLabelText(/Consent source or reference/), "Signed sample form CONSENT-001");
    const status = screen.getByLabelText(/Status/) as HTMLSelectElement;
    if (!status.value) await user.selectOptions(status, status.options[1]!.value);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add customer" }));
    await waitFor(() => expect(reference.getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByText("This reference is already used by another customer.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/Check the highlighted field before saving/);
    expect(document.activeElement).toBe(reference);
    // A refusal that names no field is the alert itself.
    api.failNext(/^\/v1\/records\/customers$/, { status: 403, error: "Only an Admin can add customers." }, "POST");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add customer" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Only an Admin can add customers."));
    expect(reference.getAttribute("aria-invalid")).toBeNull();
  });

  it("does the same for the mandate form", async () => {
    const user = userEvent.setup();
    renderApp("/mandates");
    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "Add mandate" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Add mandate" }));
    expect(screen.getByText("Mandate name is required.")).toBeTruthy();
    expect(screen.getByText("Customer is required. Choose an option.")).toBeTruthy();
    const name = screen.getByLabelText(/Mandate name/);
    expect(document.activeElement).toBe(name);
    expect(name.getAttribute("aria-describedby")).toBe("mandate-name-error");
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("shows an ordinary failure reason while submitting the unchanged canonical code", async () => {
    const user = userEvent.setup();
    const due = api.state().records.find((record) => record.kind === "due-items" && record.status === "scheduled" && !api.state().records.some((attempt) => attempt.kind === "attempts" && attempt.data.dueItemId === record.id && ["scheduled", "sent", "unknown"].includes(attempt.status)))!;
    renderApp("/collections");
    const row = (await screen.findByText(due.reference)).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Simulate failed collection" }));
    const dialog = await screen.findByRole("dialog", { name: "Simulate failed collection" });
    const reason = within(dialog).getByLabelText(/Failure reason/) as HTMLSelectElement;
    const option = within(reason).getByRole("option", { name: "Insufficient funds" }) as HTMLOptionElement;
    expect(option.value).toBe("INSUFFICIENT_FUNDS");
    await user.selectOptions(reason, option);
    await user.type(within(dialog).getByLabelText(/^Reason/), "Check the sample retry policy.");
    await user.click(within(dialog).getByRole("button", { name: "Simulate failed collection" }));
    await waitFor(() => {
      const action = api.calls.find((call) => (call.body as { action?: string })?.action === "simulate_failure");
      expect(action?.body).toMatchObject({ action: "simulate_failure", recordId: due.id, data: { failureCode: "INSUFFICIENT_FUNDS" } });
      expect(action?.status).toBe(200);
    });
  });

  it("clears an emptied optional field on an edit instead of keeping the old value", async () => {
    const user = userEvent.setup();
    const exception = api.state().records.find((record) => record.kind === "exceptions" && record.data.owner && record.data.severity && !record.data.case && record.status === "open")!;
    renderApp(`/exceptions?record=${exception.id}`);
    await user.click(await screen.findByRole("button", { name: "Edit exception" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit exception" });
    const owner = within(dialog).getByLabelText("Team") as HTMLInputElement;
    expect(owner.value).toBe(exception.data.owner);
    await user.clear(owner);
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Sent as null, which the service reads as "remove this field"; the other fields are unchanged, and the
    // severity, which an exception always has, is not a field an edit can empty (tests/exceptions.test.tsx).
    const sent = api.calls.find((call) => call.method === "PATCH")!;
    expect(sent.status).toBe(200);
    expect((sent.body as { data: Record<string, unknown> }).data).toMatchObject({ owner: null, severity: exception.data.severity, notes: exception.data.notes });
    // With the version the edit was made on, which the service requires.
    expect((sent.body as { expectedUpdatedAt?: string }).expectedUpdatedAt).toBe(exception.updatedAt);
    const saved = api.state().records.find((record) => record.id === exception.id)!;
    expect(saved.data.owner).toBeUndefined();
    expect(saved.data.severity).toBe(exception.data.severity);
    expect(saved.data.notes).toBe(exception.data.notes);
  });
});
