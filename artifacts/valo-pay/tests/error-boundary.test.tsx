import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { installFakeApi, type FakeApi } from "./fake-api";
import { screen, userEvent, waitFor, within } from "./harness";
import { queryClient } from "@/App";
import { ErrorBoundary } from "@/components/error-boundary";
import { Layout } from "@/components/layout";
import { PresentationProvider } from "@/components/presentation-guide";
import { WorkspaceProvider } from "@/lib/workspace-context";

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi();
  // The boundary logs what it caught, and React reports the thrown render; neither is the subject here.
  vi.spyOn(console, "error").mockImplementation(() => { /* silenced */ });
});
afterEach(() => api.uninstall());

/** Throws until repaired, so "Try again" can be seen to work. */
function Brittle({ broken }: { broken: boolean }) {
  if (broken) throw new Error("Rendering failed: an internal detail");
  return <p>The page is back.</p>;
}

function Harness() {
  const [broken, setBroken] = useState(true);
  return (
    <>
      <button onClick={() => setBroken(false)}>Repair</button>
      <ErrorBoundary><Brittle broken={broken} /></ErrorBoundary>
    </>
  );
}

describe("error boundary", () => {
  it("says the page stopped working in plain words, with the time and the address, and recovers on Try again", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/reports");
    document.title = "Reports · Valo Pay";
    render(<Harness />);

    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("heading", { level: 1, name: "We could not display this page" })).toBeTruthy();
    expect(within(alert).getByText("/reports")).toBeTruthy();
    expect(within(alert).getByText(/before repeating it/)).toBeTruthy();
    expect(within(alert).getByRole("link", { name: "audit log" }).getAttribute("href")).toBe("/audit");
    expect(within(alert).getByRole("link", { name: "Go to overview" }).getAttribute("href")).toBe("/overview");
    // The message is kept for development, folded away, never in the sentence a lender's staff read.
    const details = alert.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(within(alert).getByText("Technical details (development only)")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to home" }).getAttribute("href")).toBe("/");
    await waitFor(() => expect(document.title).toBe("Page error · Valo Pay"));

    await user.click(screen.getByRole("button", { name: "Repair" }));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("The page is back.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(document.title).toBe("Reports · Valo Pay"));
  });

  it("keeps the sidebar and the lender selector around a page that stopped working", async () => {
    window.history.replaceState({}, "", "/reports");
    render(
      <Router>
        <QueryClientProvider client={queryClient}>
          <WorkspaceProvider>
            <PresentationProvider><Layout><Brittle broken /></Layout></PresentationProvider>
          </WorkspaceProvider>
        </QueryClientProvider>
      </Router>,
    );
    expect(await screen.findByRole("heading", { level: 1, name: "We could not display this page" })).toBeTruthy();
    expect(await screen.findByRole("link", { name: /Audit log/ })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Sidebar" }).textContent).toContain("Sandbox");
    expect(screen.getByText("Sample data only. Valo Pay never holds money. Live payments and bank connections are switched off.")).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Page error · Valo Pay"));
  });
});
