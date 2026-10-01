import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

// axe-core over the rendered pages, as a regression check for the audit in the design rationale
// (Accessibility audit). jsdom lays nothing out, so the rules that need geometry or colour (contrast,
// target size, scrollable regions) are left to the browser audit; everything about names, roles,
// labels, headings, landmarks and ARIA runs here.
const ada = () => api.state().records.find((record) => record.kind === "customers" && record.name === "Ada Okonkwo")!;
async function violations(): Promise<string[]> {
  const result = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false }, "target-size": { enabled: false }, "scrollable-region-focusable": { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")})`);
}

describe("accessibility", () => {
  it.each([
    ["/", "Collections, credit and cash. One clear view."],
    ["/sign-in", "Sign in"],
    ["/no-such-page", "Page not found"],
    ["/overview", "Overview"],
    ["/customers", "Customers"],
    ["/mandates", "Mandates"],
    ["/reconciliation", "Reconciliation"],
    ["/exceptions", "Exceptions"],
    ["/policies", "Policies and templates"],
    ["/reports", "Reports"],
    ["/evidence", "Go-live evidence"],
    ["/audit", "Audit log"],
    ["/settings", "Settings"],
    ["/pay-by-bank", "Pay by Bank"],
    ["/credit-desk", "Credit Desk"],
    ["/cash-desk", "Cash Desk"],
    ["/cash-desk?view=accounting", "Cash Desk"],
    ["/cash-desk?view=vat", "Cash Desk"],
    ["/cash-desk?view=payroll", "Cash Desk"],
    ["/connections", "Permissions and readiness"],
  ])("finds no violation on %s", async (path, heading) => {
    renderApp(path);
    await screen.findByRole("heading", { name: heading });
    if (path !== "/" && path !== "/sign-in" && path !== "/no-such-page") await screen.findByRole("navigation", { name: "Pages" });
    expect(await violations()).toEqual([]);
  });

  it("finds no violation on the customer timeline", async () => {
    renderApp(`/customers/${ada().id}`);
    await screen.findByRole("heading", { name: "Ada Okonkwo" });
    expect(await violations()).toEqual([]);
  });

  it("finds no violation with the record dialog open", async () => {
    const user = userEvent.setup();
    renderApp("/customers");
    await screen.findByText("Ada Okonkwo");
    await user.click(screen.getByRole("button", { name: /Add customer/ }));
    await screen.findByRole("dialog");
    expect(await violations()).toEqual([]);
  });

  it("finds no violation with the settings form open", async () => {
    const user = userEvent.setup();
    renderApp("/settings");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByRole("button", { name: "Save" });
    expect(await violations()).toEqual([]);
  });
});
