import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, waitFor } from "./harness";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { useUrlPagination } from "@/lib/use-url-pagination";

function Pager() {
  const pagination = useUrlPagination("lender-1");
  return <button onClick={() => pagination.setPage(1)}>Next from {pagination.page + 1}</button>;
}

describe("url pagination under a base path", () => {
  it("navigates relative to the router base instead of repeating it", () => {
    const location = memoryLocation({ path: "/app/mandates", record: true });
    render(
      <Router base="/app" hook={location.hook} searchHook={location.searchHook}>
        <Pager />
      </Router>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next from 1" }));
    expect(location.history.at(-1)).toBe("/app/mandates?page=2&size=25&lender=lender-1");
    expect(screen.getByRole("button", { name: "Next from 2" })).toBeTruthy();
  });
});

describe("out-of-range page correction", () => {
  let api: FakeApi;
  beforeEach(() => { api = installFakeApi(); });
  afterEach(() => api.uninstall());

  // Arriving at a page past the end replaces the address, so Back leaves the list instead of returning to the bad page.
  it.each([
    ["collections", (lender: string) => `/collections?page=40&size=25&lender=${lender}`, "page"],
    ["reconciliation proposals", (lender: string) => `/reconciliation?proposals-page=40&proposals-size=25&lender=${lender}`, "proposals-page"],
    ["customers", (lender: string) => `/customers?page=40&lender=${lender}`, "page"],
    ["close history", (lender: string) => `/reports?view=operations&close-page=40&close-size=25&lender=${lender}`, "close-page"],
  ] as const)("corrects %s in place", async (_name, address, key) => {
    const path = address(api.merchantIds[0]!);
    window.history.replaceState({}, "", "/overview");
    window.history.pushState({}, "", path);
    const arrived = window.history.length;
    renderApp(path);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get(key)).toBe("1"), { timeout: 8000 });
    expect(window.history.length).toBe(arrived);
  });
});
