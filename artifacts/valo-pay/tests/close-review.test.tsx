import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { executeAction } from "../../api-server/src/domain/actions";
import { closeReviewIssues, prepareCloseReview, decideCloseReview } from "../../api-server/src/domain/close-review";
import { makeRecord } from "../../api-server/src/domain/records";
import { queryClient } from "@/App";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => { api.uninstall(); vi.restoreAllMocks(); });
const emptyClose = () => api.mutate((state, ctx) => { state.records = []; return executeAction(state, ctx, { action: "daily_close" }); });
const twoCloses = () => {
  emptyClose();
  const earlier = api.state().records.find(record => record.kind === "closes")!;
  api.setNow(new Date(Date.parse(api.now) + 60_000).toISOString());
  api.mutate((state, ctx) => executeAction(state, ctx, { action: "daily_close" }));
  return { earlier, latest: api.state().records.find(record => record.kind === "closes" && record.id !== earlier.id)! };
};
const preparedCloses = () => {
  const closes = twoCloses();
  api.mutate((state, ctx) => prepareCloseReview(state, ctx, {
    closeId: closes.latest.id, expectedUpdatedAt: closes.latest.updatedAt, reviewer: "Sandbox Finance",
    preparationNote: "Checked the synthetic report and recorded each source limitation.",
    discrepancyResponses: closeReviewIssues(closes.latest).map(issue => ({ issueId: issue.id, explanation: "The source delivery still needs independent Finance review." })),
    unresolvedAcceptance: "Finance will assess the synthetic evidence and its recorded limitations.",
  }, [{ actor: "Sandbox Finance", role: "Finance" }]));
  api.role = "Finance";
  api.principalId = "synthetic-independent-reviewer";
  return closes;
};

it("keeps preparation notes and the selected snapshot when discarding is cancelled, and switches only after confirmation", async () => {
  const { earlier, latest } = twoCloses(), user = userEvent.setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  renderApp(`/close-review?close=${latest.id}`);
  await user.selectOptions(await screen.findByLabelText("Finance reviewer"), "Sandbox Finance");
  await user.type(screen.getByLabelText("Preparation summary"), "These checks still need the provider statement.");
  await user.type(screen.getByLabelText(/Expected source files have not been declared/), "The source delivery is still being checked.");
  await user.type(screen.getByLabelText(/Why the unresolved items may remain open/), "Finance will inspect the final statement tomorrow.");
  const olderLink = screen.getByRole("link", { name: /Earlier close/ });
  await user.click(olderLink);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(window.location.search).toBe(`?close=${latest.id}`);
  expect(screen.getByLabelText("Preparation summary")).toHaveProperty("value", "These checks still need the provider statement.");
  expect(screen.getByLabelText("Finance reviewer")).toHaveProperty("value", "Sandbox Finance");
  expect(screen.getByLabelText(/Expected source files have not been declared/)).toHaveProperty("value", "The source delivery is still being checked.");
  expect(screen.getByLabelText(/Why the unresolved items may remain open/)).toHaveProperty("value", "Finance will inspect the final statement tomorrow.");
  confirm.mockReturnValue(true);
  await user.click(olderLink);
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(window.location.search).toBe(`?close=${earlier.id}`);
  expect(screen.queryByLabelText("Preparation summary")).toBeNull();
});

it("protects a reviewer-only draft without warning for the current snapshot or opening a snapshot elsewhere", async () => {
  const { earlier, latest } = twoCloses(), user = userEvent.setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  renderApp(`/close-review?close=${latest.id}`);
  const reviewer = await screen.findByLabelText("Finance reviewer");
  await user.selectOptions(reviewer, "Sandbox Finance");
  const olderLink = screen.getByRole("link", { name: /Earlier close/ });
  await user.click(screen.getByRole("link", { name: /Latest close/ }));
  // jsdom cannot open another document. Observe the app handler before cancelling the native browser fallback.
  const preventDocumentNavigation = (event: MouseEvent) => event.preventDefault();
  document.addEventListener("click", preventDocumentNavigation);
  try {
    for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) fireEvent.click(olderLink, { [modifier]: true });
    fireEvent.click(olderLink, { button: 1 });
  } finally { document.removeEventListener("click", preventDocumentNavigation); }
  expect(confirm).not.toHaveBeenCalled();
  expect(window.location.search).toBe(`?close=${latest.id}`);
  await user.click(olderLink);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(window.location.search).toBe(`?close=${latest.id}`);
  expect(reviewer).toHaveProperty("value", "Sandbox Finance");
  await user.selectOptions(reviewer, "");
  await user.click(olderLink);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(window.location.search).toBe(`?close=${earlier.id}`);
});

it("preserves the Finance note, acceptance reason and evidence when a snapshot change is cancelled", async () => {
  const { earlier, latest } = preparedCloses(), user = userEvent.setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  renderApp(`/close-review?close=${latest.id}`);
  await user.type(await screen.findByLabelText("Review note"), "Waiting for the final independent evidence check.");
  await user.type(screen.getByLabelText(/Finance acceptance reason/), "This limited source coverage is acceptable for the rehearsal.");
  await user.type(screen.getByLabelText(/Finance supporting evidence/), "Synthetic case FIN-48.");
  await user.click(screen.getByRole("checkbox", { name: /I checked this daily close/ }));
  const olderLink = screen.getByRole("link", { name: /Earlier close/ });
  await user.click(olderLink);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(window.location.search).toBe(`?close=${latest.id}`);
  expect(screen.getByLabelText("Review note")).toHaveProperty("value", "Waiting for the final independent evidence check.");
  expect(screen.getByLabelText(/Finance acceptance reason/)).toHaveProperty("value", "This limited source coverage is acceptable for the rehearsal.");
  expect(screen.getByLabelText(/Finance supporting evidence/)).toHaveProperty("value", "Synthetic case FIN-48.");
  expect(screen.getByRole("checkbox", { name: /I checked this daily close/ })).toHaveProperty("checked", true);
  confirm.mockReturnValue(true);
  await user.click(olderLink);
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(window.location.search).toBe(`?close=${earlier.id}`);
  expect(screen.queryByLabelText("Review note")).toBeNull();
});

it("tracks Finance decision and acknowledgement changes as drafts and releases the guard when both are reset", async () => {
  const { earlier, latest } = preparedCloses(), user = userEvent.setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  renderApp(`/close-review?close=${latest.id}`);
  const decision = await screen.findByLabelText("Decision"), olderLink = screen.getByRole("link", { name: /Earlier close/ });
  await user.selectOptions(decision, "return");
  await user.click(olderLink);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(decision).toHaveProperty("value", "return");
  expect(window.location.search).toBe(`?close=${latest.id}`);
  await user.selectOptions(decision, "approve");
  const acknowledgement = screen.getByRole("checkbox", { name: /I checked this daily close/ });
  await user.click(acknowledgement);
  await user.click(olderLink);
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(acknowledgement).toHaveProperty("checked", true);
  expect(window.location.search).toBe(`?close=${latest.id}`);
  await user.click(acknowledgement);
  await user.click(olderLink);
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(window.location.search).toBe(`?close=${earlier.id}`);
});

it("clears a saved Finance draft before a slow refresh without leaving later edits unprotected", async () => {
  const { earlier, latest } = preparedCloses(), user = userEvent.setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  renderApp(`/close-review?close=${latest.id}`);
  await user.type(await screen.findByLabelText("Review note"), "Independently accepted this synthetic source limitation.");
  await user.type(screen.getByLabelText(/Finance acceptance reason/), "The synthetic rehearsal may proceed with limited source coverage.");
  await user.type(screen.getByLabelText(/Finance supporting evidence/), "Synthetic case FIN-49.");
  await user.click(screen.getByRole("checkbox", { name: /I checked this daily close/ }));
  const release = api.hold(/^\/v1\/pilot\/close-reviews(?:\/[^/]+)?$/);
  try {
    await user.click(screen.getByRole("button", { name: "Approve close" }));
    await waitFor(() => expect(api.state().records.find(record => record.kind === "close-reviews")!.status).toBe("approved"));
    await waitFor(() => expect(screen.getByLabelText("Review note")).toHaveProperty("value", ""));
    expect(screen.getByLabelText(/Finance acceptance reason/)).toHaveProperty("value", "");
    expect(screen.getByLabelText(/Finance supporting evidence/)).toHaveProperty("value", "");
    expect(screen.getByRole("checkbox", { name: /I checked this daily close/ })).toHaveProperty("checked", false);
    await user.type(screen.getByLabelText("Review note"), "An additional note before the refresh arrives.");
    await user.click(screen.getByRole("link", { name: /Earlier close/ }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe(`?close=${latest.id}`);
    await user.clear(screen.getByLabelText("Review note"));
    await user.click(screen.getByRole("link", { name: /Earlier close/ }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe(`?close=${earlier.id}`);
  } finally { release(); }
});

it("shows evidence-led journey states instead of treating a payment or close as completed work", async () => {
  emptyClose();
  api.mutate(state => makeRecord(state, "payments", { status: "unallocated", amountKobo: 500000 }));
  renderApp("/pilot");
  const reconcile = await screen.findByRole("link", { name: /Reconcile payments/ });
  expect(within(reconcile).getByText(/In progress/)).toBeTruthy();
  const closing = screen.getByRole("link", { name: /Review the close/ });
  expect(within(closing).getByText(/Blocked/)).toBeTruthy();
  expect(screen.getByText(/Records changed after this close/)).toBeTruthy();
  const exceptions = screen.getByRole("link", { name: /Resolve exceptions/ });
  expect(within(exceptions).getByText(/Not started/)).toBeTruthy();
  expect(screen.getByText(/Real staff access is not enabled/)).toBeTruthy();
});

it("prepares an exact close snapshot and prevents approving it by switching demo roles", async () => {
  const { earlier } = twoCloses(), user = userEvent.setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  renderApp("/close-review");
  await user.selectOptions(await screen.findByLabelText("Finance reviewer"), "Sandbox Finance");
  await user.type(screen.getByLabelText("Preparation summary"), "Checked the source records and synthetic zero-activity close.");
  await user.type(screen.getByLabelText(/Expected source files have not been declared/),"This synthetic rehearsal has no external delivery set yet.");
  await user.type(screen.getByLabelText(/Why the unresolved items may remain open/),"Finance must confirm the limited synthetic source scope.");
  await user.click(screen.getByRole("button", { name: "Submit for Finance review" }));
  await screen.findByText(/Waiting for the named Finance reviewer/);
  const review = api.state().records.find(record => record.kind === "close-reviews")!;
  expect(review.status).toBe("awaiting_review");
  expect(review.data.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
  const snapshot = JSON.stringify(review.data.snapshot);
  await user.click(screen.getByRole("link", { name: /Earlier close/ }));
  expect(confirm).not.toHaveBeenCalled();
  expect(window.location.search).toBe(`?close=${earlier.id}`);
  cleanup(); queryClient.clear(); api.role = "Finance"; renderApp("/close-review");
  await screen.findByText(/You prepared this close/);
  expect(screen.queryByRole("button", { name: "Approve close" })).toBeNull();
  expect(JSON.stringify(api.state().records.find(record => record.id === review.id)!.data.snapshot)).toBe(snapshot);
});

it("requires an independent reviewer acknowledgement and preserves the recorded snapshot", async () => {
  emptyClose(); const user = userEvent.setup(); renderApp("/close-review");
  await user.selectOptions(await screen.findByLabelText("Finance reviewer"), "Sandbox Finance");
  await user.type(screen.getByLabelText("Preparation summary"), "Checked the complete synthetic closing report.");
  await user.type(screen.getByLabelText(/Expected source files have not been declared/),"This synthetic rehearsal has no external delivery set yet.");
  await user.type(screen.getByLabelText(/Why the unresolved items may remain open/),"Finance must confirm the limited synthetic source scope.");
  await user.click(screen.getByRole("button", { name: "Submit for Finance review" }));
  await screen.findByText(/Waiting for the named Finance reviewer/);
  cleanup(); queryClient.clear(); api.role = "Finance"; api.principalId = "synthetic-independent-reviewer"; renderApp("/close-review");
  await user.type(await screen.findByLabelText("Review note"), "Independently checked this exact close snapshot and accepted it.");
  const button = screen.getByRole("button", { name: "Approve close" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  await user.click(screen.getByRole("checkbox", { name: /I checked this daily close/ }));
  await user.type(screen.getByLabelText(/Finance acceptance reason/),"I accept the missing declaration only for this synthetic rehearsal.");
  await user.type(screen.getByLabelText(/Finance supporting evidence/),"Synthetic acceptance case FIN-22.");
  await user.click(button);
  await within(screen.getByRole("heading", { name: "Finance review" }).closest("section")!).findByText("Approved");
  expect(api.state().records.find(record => record.kind === "close-reviews")!.status).toBe("approved");
});

it("opens a historical Finance decision directly beyond 25 closes and searches its history", async () => {
  emptyClose();
  const older = api.state().records.find(record => record.kind === "closes")!;
  api.mutate((state, ctx) => {
    const review = prepareCloseReview(state, ctx, { closeId: older.id, expectedUpdatedAt: older.updatedAt, reviewer: "Sandbox Finance", preparationNote: "Original historical preparation retained for Finance.", discrepancyResponses: closeReviewIssues(older).map(issue => ({ issueId: issue.id, explanation: "The source delivery still needs independent Finance review." })), unresolvedAcceptance: "Finance will check all synthetic source limitations." }, [{ actor: "Sandbox Finance", role: "Finance" }]);
    decideCloseReview(state, { ...ctx, actor: "Sandbox Finance", role: "Finance", principalId: "another-person" }, review.id, { expectedUpdatedAt: review.updatedAt, action: "return", note: "Historical decision: await the provider statement." });
  });
  for (let index = 0; index < 26; index++) { api.setNow(new Date(Date.parse(api.now) + 86_400_000).toISOString()); api.mutate((state, ctx) => executeAction(state, ctx, { action: "daily_close" })); }
  const user = userEvent.setup(); renderApp(`/close-review?close=${older.id}`);
  await screen.findByText("Historical decision: await the provider statement.");
  expect(screen.getByRole("region", { name: "Recorded close statement" })).toBeTruthy();
  expect(screen.queryByText("This close is not in the recent list")).toBeNull();
  expect(within(screen.getByRole("navigation", { name: "Daily closes" })).getAllByRole("link")).toHaveLength(25);
  await user.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText(/27 matching closes · page 2/);
  expect(screen.getByText("Historical decision: await the provider statement.")).toBeTruthy();
  await user.type(screen.getByLabelText("Search close history"), "Sandbox Finance");
  await user.click(screen.getByRole("button", { name: "Search history" }));
  await screen.findByText(/1 matching close · page 1/);
  expect(within(screen.getByRole("navigation", { name: "Daily closes" })).getAllByRole("link")).toHaveLength(1);
});

it("shows recorded amounts and supporting links without presenting technical JSON as the statement", async () => {
  api.mutate((state, ctx) => executeAction(state, ctx, { action: "daily_close" }));
  const close = api.state().records.find(record => record.kind === "closes")!, report = close.data.report;
  renderApp(`/close-review?close=${close.id}`);
  const statement = await screen.findByRole("region", { name: "Recorded close statement" });
  expect(within(statement).getByText("Payments and matching")).toBeTruthy();
  expect(within(statement).getByText("Payment evidence received").nextElementSibling?.textContent).toBe(String(report.observations.received));
  expect(within(statement).getByText("Confirmed allocations").nextElementSibling?.textContent).toContain(`${report.allocated.count} items`);
  expect(within(statement).getByRole("link", { name: "Open Reconciliation" }).getAttribute("href")).toBe("/reconciliation");
  expect(within(statement).getByText("Technical details (JSON)").closest("details")!.open).toBe(false);
  expect(screen.queryByText("Inspect the complete recorded report")).toBeNull();
});

it("does not show another lender's directly requested close", async () => {
  emptyClose(); renderApp("/close-review?close=other-lender-record");
  await screen.findByText("Close not found in this lender.");
  expect(screen.queryByRole("region", { name: "Recorded close statement" })).toBeNull();
});

it("keeps foreign currency amounts separate and explains unavailable fee comparisons", async () => {
  emptyClose();
  const close = api.state().records.find(record => record.kind === "closes")!;
  // The close is a recorded fixture, not a current money mutation.
  close.data.report.unallocated = { count: 2, kobo: 10000, olderThan24Hours: 1, otherCurrencies: { USD: { count: 1, amount: 2500 } } };
  close.data.report.variances = { count: 1, feeVarianceKobo: 0, otherCurrencies: { USD: { count: 1, amount: 2500 } }, batches: [{ batchId: "usd-batch", reference: "USD-SETTLEMENT", currency: "USD", feeVarianceKobo: 0, netKobo: 2500, statementNetKobo: null, explanation: "The USD statement is still missing." }] };
  renderApp(`/close-review?close=${close.id}`);
  const statement = await screen.findByRole("region", { name: "Recorded close statement" });
  const unmatched = within(statement).getByText("Unallocated at close").nextElementSibling!;
  expect(unmatched.textContent).toContain("₦100.00");
  expect(unmatched.textContent).toMatch(/USD\s*25\.00/);
  expect(within(statement).getByText("Not checked: no USD fee schedule")).toBeTruthy();
  expect(within(statement).getByRole("link", { name: "USD-SETTLEMENT" }).getAttribute("href")).toContain("q=USD-SETTLEMENT");
});
