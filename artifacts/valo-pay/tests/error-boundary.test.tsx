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
    // Outside the console (the router's and the root's boundary), in the public frame.
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/reports");
    document.title = "Reports · Valo Pay";
    render(<Harness />);

    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("heading", { level: 1, name: "We could not display this page" })).toBeTruthy();
    expect(within(alert).getByText("/reports")).toBeTruthy();
    // A visitor made no change here and may have no workspace: only Try again and Back to home, no sentence about saved changes.
    expect(within(alert).queryByText(/saved a change|before you send it again/)).toBeNull();
    expect(within(alert).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([["Back to home", "/"]]);
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
    // The message is kept for development, folded away, never in the sentence a lender's staff read.
    const details = alert.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(within(alert).getByText("Technical details (development only)")).toBeTruthy();
    // The public frame's own way back, and the notice's.
    expect(screen.getAllByRole("link", { name: "Back to home" }).map((link) => link.getAttribute("href"))).toEqual(["/", "/"]);
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
    const notice = (await screen.findByRole("heading", { level: 1, name: "We could not display this page" })).closest('[role="alert"]') as HTMLElement;
    // Inside the console a change just saved may have reached Valo Pay: Request history (the /operations page) says whether it did.
    expect(within(notice).getByText(/^If you had just saved a change, check/).textContent).toBe("If you had just saved a change, check Request history before you send it again.");
    expect(within(notice).getByRole("link", { name: "Request history" }).getAttribute("href")).toBe("/operations");
    expect(within(notice).getByRole("link", { name: "Open Overview" }).getAttribute("href")).toBe("/overview");
    expect(within(notice).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(notice).queryByRole("link", { name: "Back to home" })).toBeNull();
    expect(await screen.findByRole("link", { name: /Audit log/ })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Sidebar" }).textContent).toContain("Sandbox");
    expect(screen.getByText("Sample data only. Valo Pay never holds money. Live payments and bank connections are switched off.")).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Page error · Valo Pay"));
  });
});
