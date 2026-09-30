import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { queryClient } from "@/App";
import {
  saveImportBatch,
  commitImportBatch,
} from "../../api-server/src/domain/pilot-workflow";
import { makeRecord } from "../../api-server/src/domain/records";
import { saveSourceManifest } from "../../api-server/src/domain/source-completeness";
import { previewImportCorrection, proposeImportCorrection } from "../../api-server/src/domain/import-corrections";
let api: FakeApi;
beforeEach(() => {
  api = installFakeApi();
});
afterEach(() => api.uninstall());
function arrange(kind: "customers" | "due-items" = "customers") {
  return api.mutate((s, c) => {
    const batch = saveImportBatch(s, c, {
      name: "Correction sample",
      source: "pilot-lms",
      sourceBatchId: `correct-${kind}`,
      kind,
      csv:
        kind === "customers"
          ? "source_row_id,name,reference,consentProvenance\nc-1,Original sample customer,COR-C-1,Synthetic consent"
          : `source_row_id,name,reference,customerId,amount,dueDate,owner\nd-1,Original sample instalment,COR-D-1,${s.records.find((r) => r.kind === "customers")!.reference},25000,2028-12-01,lms`,
      mapping: {},
      amountUnit: "naira",
      identityColumn: "source_row_id",
      syntheticOnly: true,
    });
    commitImportBatch(s, c, batch.id, batch.updatedAt);
    return {
      batchId: batch.id,
      targetId: s.records.find(
        (r) => r.data.importIdentity?.batchId === batch.id,
      )!.id,
    };
  });
}
async function propose(batchId: string, targetId: string, wait = true) {
  const user = userEvent.setup();
  renderApp(`/imports?batch=${batchId}`);
  await user.selectOptions(
    await screen.findByLabelText("Imported record"),
    targetId,
  );
  await user.clear(screen.getByLabelText("Corrected customer name"));
  await user.type(
    screen.getByLabelText("Corrected customer name"),
    "Corrected sample customer",
  );
  await user.click(screen.getByRole("button", { name: "Preview correction" }));
  await user.type(
    await screen.findByLabelText("Reason for correction"),
    "Correct spelling against the source file",
  );
  await user.type(
    screen.getByLabelText("Evidence reference"),
    "SOURCE-CORRECT-001",
  );
  await user.selectOptions(
    screen.getByLabelText("Independent Finance reviewer"),
    "Sandbox Finance",
  );
  await user.click(screen.getByRole("button", { name: "Propose correction" }));
  if (wait) await screen.findByRole("heading", { name: "Awaiting review" });
  return user;
}
it("preserves the original batch, shows before/after, and requires a different person to apply a correction", async () => {
  const { batchId, targetId } = arrange();
  const original = JSON.stringify(
    api.state().records.find((r) => r.id === batchId),
  );
  const user = await propose(batchId, targetId);
  expect(api.state().records.find((r) => r.id === targetId)!.name).toBe(
    "Original sample customer",
  );
  expect(
    screen.queryByRole("button", { name: "Approve and apply correction" }),
  ).toBeNull();
  cleanup();
  queryClient.clear();
  api.role = "Finance";
  renderApp(`/imports?batch=${batchId}`);
  await screen.findByRole("heading", { name: "Awaiting review" });
  expect(
    screen.queryByRole("button", { name: "Approve and apply correction" }),
  ).toBeNull();
  expect(screen.getByText(/You proposed this correction/)).toBeTruthy();
  cleanup();
  queryClient.clear();
  api.principalId = "independent-synthetic-finance";
  renderApp(`/imports?batch=${batchId}`);
  await user.type(
    await screen.findByLabelText("Decision reason"),
    "Independently checked source evidence",
  );
  await user.click(
    screen.getByRole("button", { name: "Approve and apply correction" }),
  );
  await screen.findByRole("heading", { name: "Approved" });
  expect(api.state().records.find((r) => r.id === targetId)!.name).toBe(
    "Corrected sample customer",
  );
  expect(
    JSON.stringify(api.state().records.find((r) => r.id === batchId)),
  ).toBe(original);
  expect(
    api.state().records.filter((r) => r.kind === "import-correction-events"),
  ).toHaveLength(1);
});
it('opens the exact linked correction and lets an administrator recover its reviewer without changing the source', async () => {
  const { batchId, targetId } = arrange();
  const proposal = api.mutate((state, ctx) => {
    const target = state.records.find(record => record.id === targetId)!;
    const input = { batchId, targetId, expectedUpdatedAt: target.updatedAt, changes: { name: 'Corrected sample customer' }, syntheticOnly: true as const };
    const preview = previewImportCorrection(state, ctx, input);
    return proposeImportCorrection(state, ctx, { ...input, previewDigest: preview.previewDigest, reviewer: 'Departed Finance', reason: 'Correct spelling against the source file', evidence: 'SOURCE-CORRECT-RECOVERY' }, [{ actor: 'Departed Finance', role: 'Finance' }]);
  });
  const original = JSON.stringify(api.state().records.find(record => record.id === proposal.id));
  api.staff = [{ actor: 'Clerk:replacement-finance', name: 'Replacement Finance reviewer', role: 'Finance' }];
  const user = userEvent.setup();
  renderApp(`/imports?batch=${batchId}&correction=${proposal.id}`);
  const card = await screen.findByRole('article', { name: 'Correction c-1' });
  await waitFor(() => expect(document.activeElement).toBe(card));
  await user.click(screen.getByText('Recover reviewer assignment'));
  // A demo persona is the same browser person as the proposer and could never decide, so it is not offered (review of PR #71).
  expect(within(screen.getByLabelText('Replacement Finance reviewer')).getAllByRole('option').map(option => option.textContent)).toEqual(['Choose an independent reviewer', 'Replacement Finance reviewer']);
  await user.selectOptions(screen.getByLabelText('Replacement Finance reviewer'), 'Clerk:replacement-finance');
  expect((screen.getByRole('button', { name: 'Reassign correction reviewer' }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(screen.getByLabelText('Reassignment reason'), 'The named reviewer no longer has access to this lender.');
  await user.click(screen.getByRole('button', { name: 'Reassign correction reviewer' }));
  await screen.findByText('Reviewer assignment history');
  expect(screen.getByRole('heading', { name: 'Awaiting review' })).toBeTruthy();
  expect(api.state().records.find(record => record.id === targetId)!.name).toBe('Original sample customer');
  expect(JSON.stringify(api.state().records.find(record => record.id === proposal.id))).toBe(original);
  expect(api.state().records.filter(record => record.kind === 'import-correction-events').map(record => record.data.action)).toEqual(['reassign']);
  cleanup(); queryClient.clear(); api.role = 'Finance'; api.actor = 'Clerk:replacement-finance'; api.principalId = 'independent-replacement-person';
  renderApp(`/imports?batch=${batchId}&correction=${proposal.id}`);
  expect(await screen.findByRole('button', { name: 'Approve and apply correction' })).toBeTruthy();
  expect(screen.queryByText('Recover reviewer assignment')).toBeNull();
  await user.type(screen.getByLabelText('Decision reason'), 'Independently checked the unchanged source comparison.');
  await user.click(screen.getByRole('button', { name: 'Approve and apply correction' }));
  await screen.findByRole('heading', { name: 'Approved' });
  expect(api.state().records.find(record => record.id === targetId)!.name).toBe('Corrected sample customer');
});
it("names the compared fields as the mapping on the same page does", async () => {
  const { batchId, targetId } = arrange();
  const user = userEvent.setup();
  renderApp(`/imports?batch=${batchId}`);
  await user.selectOptions(
    await screen.findByLabelText("Imported record"),
    targetId,
  );
  await user.clear(screen.getByLabelText("Corrected customer name"));
  await user.type(
    screen.getByLabelText("Corrected customer name"),
    "Corrected sample customer",
  );
  await user.type(
    screen.getByLabelText(/^Corrected masked phone/),
    "+234 ••• ••99",
  );
  await user.click(screen.getByRole("button", { name: "Preview correction" }));
  await screen.findByRole("heading", { name: "Before and after" });
  const table = screen.getByRole("columnheader", { name: "Proposed value" })
    .closest("table")!;
  expect(
    within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.firstElementChild!.textContent),
  ).toEqual(["Full name", "Masked phone number"]);
});
it("makes stale proposal recovery explicit and lets its proposer withdraw it", async () => {
  const { batchId, targetId } = arrange();
  const user = await propose(batchId, targetId);
  api.mutate((s) => {
    s.records.find((r) => r.id === targetId)!.data.testDependency = "changed";
  });
  cleanup();
  queryClient.clear();
  renderApp(`/imports?batch=${batchId}`);
  await screen.findByText(/The record or its related evidence changed/);
  await user.type(
    screen.getByLabelText("Decision reason"),
    "Withdraw stale comparison and prepare fresh evidence",
  );
  await user.click(screen.getByRole("button", { name: "Withdraw correction" }));
  await screen.findByRole("heading", { name: "Withdrawn" });
  expect(api.state().records.find((r) => r.id === targetId)!.name).toBe(
    "Original sample customer",
  );
});
it("shows payment blockers and real investigation routes instead of proposing an unsafe instalment change", async () => {
  const { batchId, targetId } = arrange("due-items");
  api.mutate((s) => {
    const t = s.records.find((r) => r.id === targetId)!;
    makeRecord(s, "payments", {
      customerId: t.customerId,
      name: "Payment evidence requiring review",
      amountKobo: 2500000,
    });
  });
  const user = userEvent.setup();
  renderApp(`/imports?batch=${batchId}`);
  await user.selectOptions(
    await screen.findByLabelText("Imported record"),
    targetId,
  );
  await user.clear(screen.getByLabelText("Corrected instalment amount (₦)"));
  await user.type(
    screen.getByLabelText("Corrected instalment amount (₦)"),
    "30000",
  );
  await user.click(screen.getByRole("button", { name: "Preview correction" }));
  await screen.findByText("This correction cannot proceed");
  expect(
    screen.queryByRole("button", { name: "Propose correction" }),
  ).toBeNull();
  expect(screen.getByText("Payment evidence requiring review")).toBeTruthy();
  expect(
    screen
      .getAllByRole("link", { name: "Reconciliation" })
      .some((link) => link.getAttribute("href") === "/reconciliation"),
  ).toBe(true);
  expect(
    screen
      .getAllByRole("link", { name: "Exceptions" })
      .some((link) => link.getAttribute("href") === "/exceptions"),
  ).toBe(true);
  expect(api.state().records.find((r) => r.id === targetId)!.amountKobo).toBe(
    2500000,
  );
});
it("uses the declared WAT business date and exact expected file when opening Imports from Sources", async () => {
  const date = "2026-09-20";
  const file = api.mutate((s, c) =>
    saveSourceManifest(s, c, {
      businessDate: date,
      files: [
        {
          source: "Pilot sample",
          sourceBatchId: "customers-001",
          kind: "customers",
          expectedRows: 1,
          expectedAmountKobo: 0,
        },
      ],
      noFilesExpected: false,
      reason: "Declare the one expected customer file",
      evidence: "DAILY-SOURCE-001",
      syntheticOnly: true,
    }),
  ).data.files![0]!;
  const user = userEvent.setup();
  renderApp(`/imports?businessDate=${date}&expectation=${file.id}`);
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Source batch ID") as HTMLInputElement).value,
    ).toBe("customers-001"),
  );
  expect(
    (screen.getByLabelText(/Business date \(WAT\)/) as HTMLInputElement).value,
  ).toBe(date);
  await user.click(screen.getByRole("button", { name: "Use sample" }));
  await user.click(
    screen.getByRole("button", { name: "Save and check batch" }),
  );
  await screen.findByRole("heading", { name: "Saved check results" });
  const batch = api.state().records.find((r) => r.kind === "import-batches")!;
  expect(batch.data.businessDate).toBe(date);
  expect(batch.data.sourceExpectationId).toBe(file.id);
});
it.each(["lost", "malformed"] as const)(
  "rechecks a %s proposal response using its original body and key",
  async (mode) => {
    const { batchId, targetId } = arrange(),
      base = globalThis.fetch,
      requests: Array<{
        key: string | null;
        body: BodyInit | null | undefined;
      }> = [];
    let receipt: Response | null = null;
    globalThis.fetch = (async (input, init) => {
      if (
        String(input).includes("/pilot/import-corrections?") &&
        init?.method === "POST"
      ) {
        requests.push({
          key: new Headers(init.headers).get("Idempotency-Key"),
          body: init.body,
        });
        if (receipt) return receipt.clone();
        const response = await base(input, init);
        if (response.ok) {
          receipt = response.clone();
          if (mode === "lost")
            throw new TypeError("Response lost after commit");
          return new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return response;
      }
      return base(input, init);
    }) as typeof fetch;
    const user = await propose(batchId, targetId, false);
    await screen.findByText("Request not confirmed");
    expect(
      api.state().records.filter((r) => r.kind === "import-corrections"),
    ).toHaveLength(1);
    await user.click(
      screen.getByRole("button", { name: "Check original request" }),
    );
    await screen.findByRole("heading", { name: "Awaiting review" });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]!.key).toBeTruthy();
    expect(
      api.state().records.filter((r) => r.kind === "import-corrections"),
    ).toHaveLength(1);
    expect(api.state().records.find((r) => r.id === targetId)!.name).toBe(
      "Original sample customer",
    );
  },
);
