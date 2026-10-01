import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { cleanup } from "@testing-library/react";
import { renderApp, screen, userEvent, waitFor } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

const ada = () => api.state().records.find((record) => record.kind === "customers" && record.name === "Ada Okonkwo")!;

describe("notices", () => {
  it("keeps a problem on screen with the server's words until it is dismissed", async () => {
    const user = userEvent.setup();
    api.failNext(/^\/v1\/exports$/, { status: 400, error: "Packs are limited to five a day for this customer." }, "POST");
    renderApp(`/customers/${ada().id}`);
    await user.click(await screen.findByRole("button", { name: "Export dispute pack (PDF)" }));
    // A notice is also announced through a copy that lives for a second, so a text may be found twice.
    expect(await screen.findAllByText("Dispute pack not started")).toBeTruthy();
    expect(screen.getAllByText(/Packs are limited to five a day for this customer\. Check saved exports before you start another request\./)).toBeTruthy();
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    expect(dismiss).toBeTruthy();
    await user.click(dismiss);
    await waitFor(() => expect(screen.queryByText("Dispute pack not started")).toBeNull());
  });

  it("says where a generated pack went and offers to open it again", async () => {
    const user = userEvent.setup();
    const opened = vi.fn(() => null);
    window.open = opened as unknown as typeof window.open;
    renderApp(`/customers/${ada().id}`);
    await user.click(await screen.findByRole("button", { name: "CSV" }));
    expect(await screen.findAllByText("Dispute pack ready")).toBeTruthy();
    expect(screen.getAllByText(/Your browser blocked the new tab\. Select Open to view the file\./)).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: "Open" })[0]!);
    const record = api.state().records.find((item) => item.kind === "exports")!;
    expect(opened).toHaveBeenCalledTimes(2);
    expect(opened).toHaveBeenLastCalledWith(`/api/v1/exports/${record.id}/download?merchantId=${api.merchantIds[0]}`, "_blank");
  });

  it("names a ready export in its notice as its link does: a pack by its name, any other the saved export", async () => {
    const user = userEvent.setup();
    window.open = vi.fn(() => null) as unknown as typeof window.open;
    const alternatives = () => [...document.querySelectorAll("[data-radix-toast-announce-alt]")].map((item) => item.getAttribute("data-radix-toast-announce-alt"));
    renderApp(`/customers/${ada().id}`);
    await user.click(await screen.findByRole("button", { name: "CSV" }));
    expect(await screen.findAllByText("Dispute pack ready")).toBeTruthy();
    expect(alternatives()).toContain("Open the dispute pack in a new tab");
    cleanup();
    renderApp("/reports");
    await user.click(await screen.findByRole("button", { name: "Export daily closes (JSON)" }));
    expect(await screen.findAllByText("Saved export ready")).toBeTruthy();
    expect(alternatives()).toContain("Open the saved export in a new tab");
    expect(screen.queryByText("Daily closes ready")).toBeNull();
  });

  it("raises no notice for a result the page shows itself", async () => {
    const user = userEvent.setup();
    renderApp("/audit");
    await user.click(await screen.findByRole("button", { name: /Check audit log/ }));
    expect(await screen.findByText("Audit log verified: all entries are intact")).toBeTruthy();
    expect(screen.queryByText("Audit chain verified")).toBeNull();
  });
});
