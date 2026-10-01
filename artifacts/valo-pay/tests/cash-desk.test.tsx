import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { makeRecord } from "../../api-server/src/domain/records";
import { runCashAction } from "../../api-server/src/domain/connected-cash-service";
import type { Context, DomainState } from "../../api-server/src/domain/types";

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi({ role: "Operations", now: "2026-09-21T10:00:00Z" });
});
afterEach(() => api.uninstall());
const context = (role = "Operations"): Context => ({
  role,
  actor: `Sandbox ${role}`,
  now: api.now,
});
const action = (
  state: DomainState,
  name: string,
  role = "Operations",
  recordId?: string,
) =>
  runCashAction(state, context(role), {
    action: name,
    recordId,
    data: {},
    reason: "Prepare offline frontend test fixture",
  });
function setUp() {
  api.mutate((state) => {
    for (const purpose of [
      "merchant_account_read",
      "erp_draft",
      "payroll_prepare",
    ])
      makeRecord(state, "connected-consents", {
        status: "active",
        createdAt: api.now,
        data: {
          purpose,
          version: 1,
          subjectId: "sme",
          entityId: `${state.merchant.id}:sme`,
          expiresAt: "2026-10-21T10:00:00Z",
        },
      });
    action(state, "cash.initialize");
  });
}
async function confirm(
  user: ReturnType<typeof userEvent.setup>,
  action: string,
  note = "Confirm the sample evidence for this review",
) {
  const dialog = await screen.findByRole("dialog");
  await user.type(
    within(dialog).getByRole("textbox", { name: "Reason" }),
    note,
  );
  await user.click(
    within(dialog).getByRole("button", { name: action }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

describe("Cash Desk", () => {
  it("withdraws a stale accounting download and offers a maker refresh after permission changes", async () => {
    setUp();
    api.mutate((state) => {
      const record = action(state, "cash.erp.prepare").record!;
      action(state, "cash.erp.review", "Finance", record.id);
      action(state, "cash.erp.export", "Finance", record.id);
      state.records.find(
        (r) =>
          r.kind === "connected-consents" && r.data.purpose === "erp_draft",
      )!.data.version = 2;
    });
    const user = userEvent.setup();
    renderApp("/cash-desk");
    await user.click(await screen.findByRole("button", { name: "Accounting" }));
    expect(
      screen.queryByRole("button", { name: "Download export file" }),
    ).toBeNull();
    expect(
      screen.getByText(/Permissions changed since this review/),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Prepare export file",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await user.click(
      screen.getByRole("button", { name: "Refresh accounting review" }),
    );
    await confirm(user, "Refresh accounting review");
    expect(
      await screen.findByText(
        /Accounting review refreshed using current evidence/,
      ),
    ).toBeTruthy();
    const record = api
      .state()
      .records.find((r) => r.kind === "connected-cash-erp")!;
    expect(record.status).toBe("proposed");
    expect(record.data.draft.review).toBeUndefined();
    expect(record.data.revisions).toHaveLength(1);
    expect(record.data.manifest).toBeUndefined();
    expect(record.data.revisions[0].manifest.status).toBe("not_posted");
  });

  it("recovers a lost forecast response inside its locked review dialog without creating another version", async () => {
    setUp();
    const send = globalThis.fetch;
    let saved: Response | undefined;
    const submissions: Array<{ key: string; body: string }> = [];
    globalThis.fetch = async (input, options) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
      if (options?.method !== "POST" || !url.includes("/connected/actions"))
        return send(input, options);
      submissions.push({
        key: new Headers(options.headers).get("Idempotency-Key")!,
        body: String(options.body),
      });
      if (saved) return saved.clone();
      const response = await send(input, options);
      saved = response.clone();
      throw new TypeError("Response lost after commit");
    };
    const user = userEvent.setup();
    renderApp("/cash-desk");
    await user.click(
      await screen.findByRole("button", { name: /Save forecast/ }),
    );
    const dialog = await screen.findByRole("dialog");
    const reason = within(dialog).getByRole("textbox", { name: "Reason" });
    await user.type(reason, "Review this synthetic cash forecast");
    await user.click(
      within(dialog).getByRole("button", { name: "Save forecast" }),
    );
    const retry = await within(dialog).findByRole("button", {
      name: "Check original request",
    });
    expect((reason as HTMLTextAreaElement).disabled).toBe(true);
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Cancel",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.click(retry);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual(submissions[0]);
    expect(
      api.state().records.filter((r) => r.kind === "connected-cash-forecasts"),
    ).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain(
      "Original request confirmed",
    );
  });

  it("asks before switching lender with typed planning inputs, then clears them for the other lender's SME workspace", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderApp("/cash-desk");
    const buffer = await screen.findByLabelText("Planning buffer (₦)");
    await user.clear(buffer);
    await user.type(buffer, "1250000.99");
    await user.selectOptions(
      screen.getAllByLabelText("Active lender")[0]!,
      api.merchantIds[1]!,
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Planning buffer (₦)") as HTMLInputElement)
          .value,
      ).toBe("1500000"),
    );
    // The cleared inputs are the new lender's starting point, not a draft.
    await user.selectOptions(
      screen.getAllByLabelText("Active lender")[0]!,
      api.merchantIds[0]!,
    );
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("rejects fractional kobo and invalid planning assumptions before review, then saves exact amounts with confirmed feedback", async () => {
    setUp();
    const user = userEvent.setup();
    renderApp("/cash-desk");
    const buffer = await screen.findByLabelText("Planning buffer (₦)");
    await user.clear(buffer);
    await user.type(buffer, "1500000.005");
    await user.click(screen.getByRole("button", { name: /Save forecast/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(buffer.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(buffer);
    expect(
      api.calls.some(
        (c) =>
          c.method === "POST" &&
          (c.body as { action?: string }).action === "cash.forecast",
      ),
    ).toBe(false);
    await user.clear(buffer);
    await user.type(buffer, "1,500,000.29");
    await user.click(screen.getByRole("button", { name: /Save forecast/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Planning buffer: ₦1,500,000.29");
    const release = api.hold(/^\/v1\/connected\/actions$/);
    try {
      await user.type(
        within(dialog).getByRole("textbox", { name: "Reason" }),
        "Review the exact sample forecast buffer",
      );
      await user.click(
        within(dialog).getByRole("button", { name: "Save forecast" }),
      );
      expect(
        screen.queryByText(
          "New sample forecast saved. Your source balances and commitments are unchanged.",
        ),
      ).toBeNull();
    } finally {
      release();
    }
    await screen.findByText(
      "New sample forecast saved. Your source balances and commitments are unchanged.",
    );
    const request = api.calls.find(
      (c) =>
        c.method === "POST" &&
        (c.body as { action?: string }).action === "cash.forecast",
    );
    expect(request?.body).toMatchObject({ data: { bufferMinor: 150_000_029 } });
  });

  it("shows an honest sample preview without creating records or enabling preparation before permission", async () => {
    renderApp("/cash-desk");
    expect(
      await screen.findByRole("heading", { name: "Cash Desk" }),
    ).toBeTruthy();
    expect(screen.getByText("Sample business")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: /Set up Cash Desk/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen
        .getByRole("link", { name: "Open Permissions and readiness" })
        .getAttribute("href"),
    ).toBe("/connections");
    expect(
      screen.getByRole("table", {
        name: "Weekly expected and cautious cash balances",
      }),
    ).toBeTruthy();
    expect(
      api.state().records.some((r) => r.kind.startsWith("connected-cash-")),
    ).toBe(false);
  });

  it("saves a new forecast with the chosen downside, a visible review note and unchanged source balances", async () => {
    setUp();
    const user = userEvent.setup();
    renderApp("/cash-desk");
    const percent = await screen.findByRole("spinbutton", {
      name: /Share of expected receipts that arrive/,
    });
    await user.clear(percent);
    await user.type(percent, "55");
    const delay = screen.getByRole("spinbutton", { name: /Receipt delay/ });
    await user.clear(delay);
    await user.type(delay, "9");
    await user.click(screen.getByRole("button", { name: /Save forecast/ }));
    const dialog = await screen.findByRole("dialog");
    const reason = within(dialog).getByRole("textbox", { name: "Reason" });
    await user.type(reason, "Too few");
    await user.click(
      within(dialog).getByRole("button", { name: "Save forecast" }),
    );
    expect(
      within(dialog).getByText("Enter a reason (at least 8 characters)."),
    ).toBeTruthy();
    expect(reason.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(reason);
    expect(
      api.calls.some(
        (c) =>
          c.method === "POST" &&
          (c.body as { action?: string }).action === "cash.forecast",
      ),
    ).toBe(false);
    await user.clear(reason);
    await confirm(user, "Save forecast", "Stress test a slower customer payment week");
    const request = api.calls.find(
      (c) =>
        c.method === "POST" &&
        (c.body as { action?: string }).action === "cash.forecast",
    );
    expect(request?.body).toMatchObject({
      data: {
        downsideInflowBps: 5500,
        downsideDelayDays: 9,
        bufferMinor: 150000000,
      },
      reason: "Stress test a slower customer payment week",
    });
    expect(
      api.state().records.filter((r) => r.kind === "connected-cash-forecasts"),
    ).toHaveLength(1);
    expect(await screen.findByText(/Saved version 1/)).toBeTruthy();
  });

  it("lists a saved forecast and VAT schedule made under replaced permissions without their figures", async () => {
    setUp();
    api.mutate((state) => {
      action(state, "cash.forecast");
      action(state, "cash.vat.export", "Finance");
      // The permissions are granted again: they are no longer the grants the saved work was made under.
      for (const grant of state.records.filter((r) => r.kind === "connected-consents"))
        grant.data.version = 2;
    });
    api.role = "Finance";
    const user = userEvent.setup();
    renderApp("/cash-desk");
    expect(
      await screen.findByText(/The forecast saved on .* is hidden\. .* Save a new forecast to see current figures\./),
    ).toBeTruthy();
    expect(screen.queryByRole("img", { name: /Cash forecast comparison/ })).toBeNull();
    expect(screen.queryByText("Day 7")).toBeNull();
    await user.click(screen.getByRole("button", { name: "VAT evidence" }));
    expect(screen.getByText(/Saved by Sandbox Finance/)).toBeTruthy();
    expect(
      screen.getByText(/^This schedule’s figures are hidden\. .* Save the schedule again to see current figures\.$/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download saved VAT schedule" })).toBeNull();
    // A schedule saved under the current permissions can be downloaded.
    await user.click(screen.getByRole("button", { name: /Save VAT schedule/ }));
    await confirm(user, "Save VAT schedule");
    expect(
      await screen.findByRole("button", { name: "Download saved VAT schedule" }),
    ).toBeTruthy();
    expect(screen.getAllByText(/Saved by Sandbox Finance/)).toHaveLength(2);
  });

  it("says why an accounting draft is blocked, in the words the service gives", async () => {
    setUp();
    api.mutate((state) => {
      const record = action(state, "cash.erp.prepare").record!;
      record.status = "blocked";
      record.data.draft.status = "blocked";
      record.data.draft.reasons = ["The accounting period is closed."];
    });
    const user = userEvent.setup();
    renderApp("/cash-desk");
    await user.click(await screen.findByRole("button", { name: "Accounting" }));
    expect(await screen.findByText("Why it is blocked:")).toBeTruthy();
    expect(screen.getByText("The accounting period is closed.")).toBeTruthy();
  });

  it("lets a different Finance reviewer approve and export an accounting draft without claiming ERP posting", async () => {
    setUp();
    api.mutate((state) => action(state, "cash.erp.prepare"));
    api.role = "Finance";
    const user = userEvent.setup();
    renderApp("/cash-desk");
    await user.click(await screen.findByRole("button", { name: "Accounting" }));
    await user.click(screen.getByRole("button", { name: "Approve draft" }));
    await confirm(user, "Approve draft");
    expect(await screen.findByText(/Approved by Sandbox Finance/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Prepare export file" }));
    await confirm(user, "Prepare export file");
    expect(
      await screen.findByRole("button", { name: "Download export file" }),
    ).toBeTruthy();
    const posted = screen.getByText("Not posted to accounting software");
    expect(within(posted).getByText("Exported")).toBeTruthy();
    expect(
      api.state().records.find((r) => r.kind === "connected-cash-erp")?.data
        .manifest.status,
    ).toBe("not_posted");
  });

  it("holds an unknown payroll item for reconciliation and keeps the other items independently actionable", async () => {
    setUp();
    api.mutate((state) => {
      const plan = action(state, "cash.payroll.prepare").record!;
      action(state, "cash.payroll.approve", "Finance", plan.id);
      action(state, "cash.payroll.export", "Finance", plan.id);
    });
    api.role = "Finance";
    const user = userEvent.setup();
    renderApp("/cash-desk");
    await user.click(
      await screen.findByRole("button", { name: "Payroll funding" }),
    );
    await user.click(
      screen.getAllByRole("button", { name: "Simulate unknown outcome" })[1]!,
    );
    await confirm(user, "Simulate unknown outcome");
    expect(await screen.findByText("Outcome unknown")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Simulate unknown outcome" }),
    ).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: "Simulate confirmed payment" }),
    ).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    const plan = api
      .state()
      .records.find((r) => r.kind === "connected-cash-payroll")!.data.plan;
    expect(plan.items.map((i: { status: string }) => i.status)).toEqual([
      "exported",
      "unknown",
      "exported",
    ]);
    expect(
      (
        screen.getByRole("button", {
          name: "Refresh funding review",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("keeps a minimal Finance reconciliation route after preparation permissions are revoked", async () => {
    setUp();
    api.mutate((state) => {
      const plan = action(state, "cash.payroll.prepare").record!;
      action(state, "cash.payroll.approve", "Finance", plan.id);
      action(state, "cash.payroll.export", "Finance", plan.id);
      for (const record of state.records.filter(
        (r) =>
          r.kind === "connected-consents" &&
          ["merchant_account_read", "payroll_prepare"].includes(r.data.purpose),
      ))
        record.status = "revoked";
    });
    api.role = "Finance";
    const user = userEvent.setup();
    renderApp("/cash-desk");
    await user.click(
      await screen.findByRole("button", { name: "Payroll funding" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Record results for payroll items already exported",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/Sample employee · ••/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Prepare bank export file" }),
    ).toBeNull();
    await user.click(
      screen.getAllByRole("button", { name: "Simulate confirmed payment" })[0]!,
    );
    await confirm(user, "Simulate confirmed payment");
    expect(
      await screen.findByRole("button", { name: "Simulate reversal" }),
    ).toBeTruthy();
    const plan = api
      .state()
      .records.find((r) => r.kind === "connected-cash-payroll")!.data.plan;
    expect(plan.items[0].status).toBe("succeeded");
    expect(
      api
        .state()
        .records.filter(
          (r) =>
            r.kind === "connected-consents" &&
            ["merchant_account_read", "payroll_prepare"].includes(
              r.data.purpose,
            ),
        )
        .every((r) => r.status === "revoked"),
    ).toBe(true);
  });

  it("recovers a stale funding plan through a new maker version while invalidating old checker approval", async () => {
    setUp();
    api.mutate((state) => {
      const plan = action(state, "cash.payroll.prepare").record!;
      action(state, "cash.payroll.approve", "Finance", plan.id);
    });
    api.setNow("2026-09-21T12:00:00Z");
    const user = userEvent.setup();
    renderApp("/cash-desk");
    await user.click(
      await screen.findByRole("button", { name: "Refresh sample balances" }),
    );
    await confirm(user, "Refresh sample balances");
    await user.click(screen.getByRole("button", { name: "Payroll funding" }));
    await user.click(
      screen.getByRole("button", { name: "Refresh funding review" }),
    );
    await confirm(user, "Refresh funding review");
    const plan = api
      .state()
      .records.find((r) => r.kind === "connected-cash-payroll")!.data.plan;
    expect(plan.reviewVersion).toBe(2);
    expect(plan.approvalStatus).toBe("draft");
    expect(plan.checker).toBeUndefined();
    expect(
      (
        screen.getByRole("button", {
          name: "Prepare bank export file",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    // The maker is told why the Finance steps are closed to them.
    expect(
      screen.getByText(
        "Only Finance can approve the funding plan, prepare its bank export file or record payment results.",
      ),
    ).toBeTruthy();
  });
});
