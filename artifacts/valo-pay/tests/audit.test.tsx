import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("audit", () => {
  it("says in its introduction how to find an entry that was changed", async () => {
    renderApp("/audit");
    expect(await screen.findByText("A permanent record of every change for this lender. Each entry is linked to the one before it. Select Check audit log to find any entry that was changed.")).toBeTruthy();
  });

  it("names each entry's action in words, with the summary saved with it on a second line", async () => {
    renderApp("/audit");
    const summary = await screen.findByText("Created a sample lender. Sample data only.");
    const cell = summary.closest("td")!;
    // The service names the stored action ("sandbox.created") in words; the summary does not replace it.
    expect(within(cell).getByText("Sample lender created")).toBeTruthy();
    expect(within(cell).getByText("Sample lender created")).not.toBe(summary);
  });

  it("finds an entry by the action name it shows, and still by its stored code", async () => {
    const user = userEvent.setup();
    renderApp("/audit");
    await screen.findByText("Created a sample lender. Sample data only.");
    const search = screen.getByLabelText("Search the audit log");
    for (const term of ["Sample lender created", "sandbox.created"]) {
      await user.clear(search);
      await user.type(search, term);
      await waitFor(() => expect(api.calls.some(call => call.path === "/v1/records/audit" && call.query.search === term)).toBe(true));
      const cell = (await screen.findByText("Created a sample lender. Sample data only.")).closest("td")!;
      expect(within(cell).getByText("Sample lender created")).toBeTruthy();
      expect(screen.queryByText(/No entries match/)).toBeNull();
    }
  });

  it("verifies the chain and shows the result on the page", async () => {
    const user = userEvent.setup();
    renderApp("/audit");
    await user.click(await screen.findByRole("button", { name: /Check audit log/ }));
    // The toast is a live region too, so the result box is found by its text.
    const status = (await screen.findByText("Audit log verified: all entries are intact")).closest('[role="status"]')!;
    expect(status.textContent).toMatch(/Checked .+ · 1 entry checked/);
    // The hash of the latest entry is kept in closed Technical details, with what it is for.
    const head = within(status as HTMLElement).getByText(/^Hash of the latest entry: [0-9a-f]{64}$/).closest('details')!;
    expect(head.open).toBe(false);
    expect(head.textContent).toContain('A hash is a code worked out from an entry and the one before it.');
    // So is each entry's own hash in the table.
    const hashes = within(await screen.findByRole('table')).getAllByText(/^Hash: [0-9a-f]{64}$/);
    expect(hashes.length).toBeGreaterThan(0);
    for (const hash of hashes) expect(hash.closest('details')!.open).toBe(false);
    expect(status.textContent).toContain(`${api.state().merchant.name} · Checked`);
    expect(status.textContent).toContain('Check again after new actions are recorded.');
    expect(api.calls.find((call) => call.path === "/v1/actions")?.body).toMatchObject({ action: "verify_audit" });
  });

  it('clears a completed check when switching lenders, including switching back', async () => {
    const user = userEvent.setup();
    renderApp('/audit');
    await user.click(await screen.findByRole('button', { name: 'Check audit log' }));
    await screen.findByText('Audit log verified: all entries are intact');
    await user.selectOptions(screen.getAllByLabelText('Active lender')[0]!, api.merchantIds[1]!);
    expect(screen.queryByText('Audit log verified: all entries are intact')).toBeNull();
    await user.selectOptions(screen.getAllByLabelText('Active lender')[0]!, api.merchantIds[0]!);
    expect(screen.queryByText('Audit log verified: all entries are intact')).toBeNull();
  });

  it('ignores a check that finishes after leaving and returning to its lender', async () => {
    const user = userEvent.setup();
    const release = api.hold(/^\/v1\/actions$/);
    renderApp('/audit');
    await user.click(await screen.findByRole('button', { name: 'Check audit log' }));
    await screen.findByRole('button', { name: 'Checking audit log…' });
    await user.selectOptions(screen.getAllByLabelText('Active lender')[0]!, api.merchantIds[1]!);
    await user.selectOptions(screen.getAllByLabelText('Active lender')[0]!, api.merchantIds[0]!);
    release();
    await waitFor(() => expect(api.calls.some(call => (call.body as { action?: string })?.action === 'verify_audit')).toBe(true));
    expect(screen.queryByText('Audit log verified: all entries are intact')).toBeNull();
  });

  it('shows a retryable request failure instead of an empty audit log', async () => {
    api.failNext(/^\/v1\/records\/audit$/, { status: 503, error: 'Audit service temporarily unavailable.' });
    const user = userEvent.setup();
    renderApp('/audit');
    const failure = (await screen.findByText('We could not load the audit log')).closest('[role="alert"]')!;
    expect(screen.queryByText('No entries yet')).toBeNull();
    await user.click(within(failure as HTMLElement).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('table');
    expect(screen.queryByText('We could not load the audit log')).toBeNull();
  });

  it('requests bounded pages for a large audit log and resets pagination on search', async () => {
    api.mutate(state => {
      const source = state.records.find(record => record.kind === 'audit')!;
      for (let index = 0; index < 1000; index++) state.records.push({ ...structuredClone(source), id: `extra-audit-${index}`, name: `Sample event ${index}`, data: { ...source.data, summary: `Sample event ${index}` } });
    });
    const user = userEvent.setup();
    renderApp('/audit');
    await screen.findByRole('table');
    expect(screen.getAllByRole('row')).toHaveLength(26);
    await user.click(screen.getByRole('button', { name: 'Next page of audit entries' }));
    await waitFor(() => expect(api.calls.some(call => call.path === '/v1/records/audit' && call.query.offset === '25')).toBe(true));
    await user.type(screen.getByLabelText('Search the audit log'), 'Sample event 999');
    await screen.findByText('Sample event 999');
    await waitFor(() => {
      const calls = api.calls.filter(call => call.path === '/v1/records/audit' && call.query.search);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.query).toMatchObject({ search: 'Sample event 999', offset: '0', limit: '25' });
    });
  });
});
