// Words and figures the audit of 23 September found slipping (item 9): counts
// through the formatters, no total where none applies, plain labels instead of
// machine words, no browser error text, and a title on every page.
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeRecord } from "../../api-server/src/domain/records";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

it("counts a batch's rows with their nouns and shows no total for customers", async () => {
  const user = userEvent.setup();
  renderApp("/imports");
  await user.click(await screen.findByRole("button", { name: "Use sample" }));
  await user.click(screen.getByRole("button", { name: "Save and check batch" }));
  const quality = (await screen.findByRole("heading", { name: "Source quality checks" })).parentElement!;
  const lines = [...quality.querySelectorAll("p")].map((line) => line.textContent);
  expect(lines).toContain("1 source row");
  expect(lines).toContain("0 newly imported rows");
  // Customers carry no amounts, so the batch has no source total to show.
  expect(quality.textContent).not.toMatch(/source total|newly imported total|₦/);
});

it("lists saved exports in plain words", async () => {
  api.mutate((state, ctx) => {
    const customer = state.records.find((record) => record.kind === "customers")!;
    makeRecord(state, "exports", { status: "ready", name: "dispute-pack · JSON", customerId: customer.id, createdAt: ctx.now, data: { kind: "dispute-pack", format: "json", checksum: "a".repeat(64), generatedAt: ctx.now } });
    makeRecord(state, "exports", { status: "failed", name: "billing · CSV", createdAt: ctx.now, data: { kind: "billing", format: "csv" } });
  });
  renderApp("/exports");
  const history = await screen.findByRole("region", { name: "Export history" }).catch(() => screen.findByText("Export history").then((heading) => heading.closest("section")!));
  await within(history as HTMLElement).findByText("Dispute pack (JSON)");
  expect(within(history as HTMLElement).getByText("Billing statement (CSV)")).toBeTruthy();
  expect(history.textContent).toMatch(/· Ready to download/);
  expect(history.textContent).toMatch(/· Failed/);
  expect(history.textContent).not.toMatch(/dispute-pack|· ready|· failed/);
});

it("says in plain words that no answer arrived, never the browser's own error", async () => {
  const user = userEvent.setup();
  renderApp("/customers");
  await screen.findByText("Ada Okonkwo");
  await user.click(screen.getByRole("button", { name: "Add customer" }));
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByLabelText(/^Full name/), "No answer customer");
  await user.type(within(dialog).getByLabelText(/^Loan software reference/), "NO-ANSWER-1");
  await user.type(within(dialog).getByLabelText(/^Consent source or reference/), "Synthetic signed form NO-ANSWER-1");
  api.failNext(/^\/v1\/records\/customers$/, "offline", "POST");
  await user.click(within(dialog).getByRole("button", { name: "Add customer" }));
  const notice = (await within(dialog).findByText("Request not confirmed")).closest('[role="alert"]') as HTMLElement;
  expect(notice.textContent).toContain("No answer came back from Valo Pay.");
  expect(notice.textContent).not.toMatch(/Failed to fetch/);
});

it("names the invitation page in the browser's title", async () => {
  renderApp("/team-invite");
  await screen.findByRole("heading", { level: 1, name: "Accept your invitation" });
  await waitFor(() => expect(document.title).toBe("Accept your invitation · Valo Pay"));
});
