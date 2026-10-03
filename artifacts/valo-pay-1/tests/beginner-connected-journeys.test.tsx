import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryClient } from "@/App";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi({ role: "Operations", now: "2026-09-21T10:00:00Z" });
});
afterEach(() => api.uninstall());
type User = ReturnType<typeof userEvent.setup>;

async function go(user: User, name: string, title = name) {
  await user.click(screen.getAllByRole("link", { name })[0]!);
  await screen.findByRole("heading", { name: title, level: 1 });
}

async function grant(user: User, purpose: string, subject?: string) {
  const before = api
    .state()
    .records.filter((record) => record.kind === "connected-consents").length;
  await user.selectOptions(
    screen.getByLabelText("Purpose", { exact: true }),
    purpose,
  );
  if (subject)
    await user.selectOptions(
      screen.getByLabelText("Who it covers", { exact: true }),
      subject,
    );
  await user.type(
    screen.getByLabelText("Reason for granting permission"),
    "Authorise this purpose for the synthetic journey",
  );
  await user.click(
    screen.getByRole("button", { name: "Grant permission" }),
  );
  await waitFor(() =>
    expect(
      api
        .state()
        .records.filter((record) => record.kind === "connected-consents"),
    ).toHaveLength(before + 1),
  );
  await screen.findByText("Sample permission granted. The pages that need it can use it now.");
}

/** A second synthetic identity in the test service, not a real authentication or MFA rehearsal. */
function returnAsFinance(path: string) {
  cleanup();
  queryClient.clear();
  api.role = "Finance";
  api.principalId = "synthetic-console-person-2";
  renderApp(path);
}

async function confirmCash(user: User, action: string, note: string) {
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByLabelText("Reason"), note);
  await user.click(
    within(dialog).getByRole("button", { name: action }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

describe("complete synthetic connected journeys through the real app", () => {
  it("grants separate credit permissions, assesses through the UI and records a different sample reviewer without changing the assessment", async () => {
    const user = userEvent.setup();
    renderApp("/credit-desk");
    await screen.findByRole("heading", { name: "Credit Desk", level: 1 });
    const applicantId = (
      screen.getByLabelText("Applicant") as HTMLSelectElement
    ).value;
    expect(screen.getByText("Read applicant accounts: Not active")).toBeTruthy();
    expect(screen.getByText("Assess an application: Not active")).toBeTruthy();
    await user.click(
      screen.getByRole("link", { name: /Open Permissions and readiness/ }),
    );
    await screen.findByRole("heading", {
      name: "Permissions and readiness",
      level: 1,
    });
    await grant(user, "account_read", applicantId);
    await grant(user, "credit_assessment", applicantId);
    await go(user, "Credit Desk");
    await user.selectOptions(screen.getByLabelText("Applicant"), applicantId);
    expect(screen.getByText("Read applicant accounts: Active")).toBeTruthy();
    expect(screen.getByText("Assess an application: Active")).toBeTruthy();
    await user.type(
      screen.getByLabelText("Reason for this assessment"),
      "Review permitted sample income and the proposed repayment schedule",
    );
    await user.click(
      screen.getByRole("button", { name: /Run assessment/ }),
    );
    await screen.findByText(
      "Sample assessment saved as a new version. It cannot be changed. Check its evidence and explanations below.",
    );
    const assessment = api
      .state()
      .records.find(
        (record) => record.kind === "connected-credit-assessments",
      )!;
    const original = JSON.stringify(assessment.data.result);
    expect(assessment.data.result.createdBy).toBe("Sandbox Operations");
    expect(screen.getByText(/Not a prediction of whether the applicant will repay\./)).toBeTruthy();
    expect(screen.getByText(/Not a lending decision\./)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Record review",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await user.click(
      screen.getByRole("tab", { name: "Evidence" }),
    );
    expect(screen.getByText("Reviewed essential costs")).toBeTruthy();

    returnAsFinance("/credit-desk");
    const outcome = await screen.findByLabelText("Reviewer outcome");
    await user.selectOptions(outcome, "approve");
    await user.type(
      screen.getByLabelText("What did you review?"),
      "Checked the sample income cycles, current commitments and the proposed repayment schedule.",
    );
    await user.type(
      screen.getByLabelText("Explanation for the applicant"),
      "The sample evidence supports the proposed repayments. This rehearsal does not approve a real loan.",
    );
    await user.click(
      screen.getByRole("button", { name: "Record review" }),
    );
    await screen.findByText(
      "Sample review recorded. The assessment and its score have not changed.",
    );
    expect(
      screen.getByRole("heading", { name: "Sample approval recorded" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Reviewer sign-in is simulated in the sandbox\. This is not a real lending decision/,
      ),
    ).toBeTruthy();
    expect(
      JSON.stringify(
        api.state().records.find((record) => record.id === assessment.id)!.data
          .result,
      ),
    ).toBe(original);
    expect(
      api
        .state()
        .records.filter((record) => record.kind === "connected-credit-reviews"),
    ).toHaveLength(1);

    returnAsFinance("/credit-desk");
    await user.click(
      await screen.findByRole("tab", { name: "Review history" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Sample approval recorded" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Record review" }),
    ).toBeNull();
    const writes = api.calls.filter(
      (call) => call.method === "POST" && call.path === "/v1/connected/actions",
    );
    expect(
      writes.map((call) => (call.body as { action: string }).action),
    ).toEqual([
      "consent.grant",
      "consent.grant",
      "credit.assess",
      "credit.review",
    ]);
  });

  it("prepares payroll through the UI, requires the sample Finance role and exports without claiming salaries were paid", async () => {
    const user = userEvent.setup();
    renderApp("/connections");
    await screen.findByRole("heading", {
      name: "Permissions and readiness",
      level: 1,
    });
    await grant(user, "merchant_account_read");
    await grant(user, "payroll_prepare");
    await go(user, "Cash Desk");
    await user.click(
      screen.getByRole("button", { name: "Set up Cash Desk" }),
    );
    await confirmCash(
      user,
      "Set up Cash Desk",
      "Create the sample accounts and approved net-pay run for this rehearsal",
    );
    await screen.findByText(
      "Sample Cash Desk set up. Review the account timestamps and planning assumptions before preparing work.",
    );
    await user.click(
      screen.getByRole("button", { name: "Payroll funding" }),
    );
    expect(
      screen.getByText(/Exporting does not pay employees or set money aside/),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Prepare funding plan" }),
    );
    await confirmCash(
      user,
      "Prepare funding plan",
      "Check the approved sample run, source balance and funding assumptions",
    );
    await screen.findByText(
      "Sample funding plan prepared. A different Finance reviewer must approve it before export. No one has been paid.",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Approve funding plan",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Prepare bank export file",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    const prepared = api
      .state()
      .records.find((record) => record.kind === "connected-cash-payroll")!;
    expect(prepared.data.plan.maker).toBe("Sandbox Operations");

    returnAsFinance("/cash-desk?view=payroll");
    await user.click(
      await screen.findByRole("button", { name: "Approve funding plan" }),
    );
    await confirmCash(
      user,
      "Approve funding plan",
      "Independently check the sample beneficiaries, amounts, source balance and payment date",
    );
    await screen.findByText(
      "Sample funding plan approved. You can prepare the bank export file while the balances are current. No one has been paid.",
    );
    await user.click(
      screen.getByRole("button", { name: "Prepare bank export file" }),
    );
    await confirmCash(
      user,
      "Prepare bank export file",
      "Prepare only the reviewed unsent sample items; no salary instruction is executed",
    );
    await screen.findByText(
      "Sample payroll export file prepared. Download it below. No one has been paid.",
    );
    expect(
      screen.getByRole("button", { name: "Download payroll export file" }),
    ).toBeTruthy();
    const exported = api
      .state()
      .records.find((record) => record.id === prepared.id)!;
    expect(exported.data.plan.checker).toBe("Sandbox Finance");
    expect(
      exported.data.plan.items.every(
        (item: { status: string }) => item.status === "exported",
      ),
    ).toBe(true);
    expect(exported.data.manifest).toBeTruthy();

    returnAsFinance("/cash-desk?view=payroll");
    expect(
      await screen.findByRole("button", { name: "Download payroll export file" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Approving the plan and exporting the file do not pay anyone/),
    ).toBeTruthy();
    expect(
      api
        .state()
        .records.filter((record) => record.kind === "connected-cash-payroll"),
    ).toHaveLength(1);
    const writes = api.calls.filter(
      (call) => call.method === "POST" && call.path === "/v1/connected/actions",
    );
    expect(
      writes.map((call) => (call.body as { action: string }).action),
    ).toEqual([
      "consent.grant",
      "consent.grant",
      "cash.initialize",
      "cash.payroll.prepare",
      "cash.payroll.approve",
      "cash.payroll.export",
    ]);
  });
});
