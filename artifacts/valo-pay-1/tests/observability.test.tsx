// What the console gives a person to report: the request's reference beside
// the time when the service itself failed, and nothing extra when a rule
// refused the request in its own words.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor } from "./harness";
import { referenceOf, saidBy } from "@/lib/notify";

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => api.uninstall());

describe("observability", () => {
  it("reads the request's reference from the body, or from the answer's header when the body has none", () => {
    expect(referenceOf({ status: 500, data: { error: "x", requestId: "ab12cd34ef56ab78" } })).toBe("ab12cd34ef56ab78");
    expect(referenceOf({ status: 500, data: { error: "x" }, headers: new Headers({ "x-request-id": "edge-0123456789" }) })).toBe("edge-0123456789");
    expect(referenceOf({ status: 500, data: { error: "x" } })).toBeUndefined();
    expect(referenceOf(new TypeError("Failed to fetch"))).toBeUndefined();
  });

  it("adds the reference to the service's words only when the service failed", () => {
    const general = "The operation could not be completed. No partial change has been committed.";
    expect(saidBy({ status: 500, data: { error: general, requestId: "ab12cd34ef56ab78" } }, "fallback")).toBe(`${general} Support reference: ab12cd34ef56ab78.`);
    expect(saidBy({ status: 400, data: { error: "Reason for changing the emergency stop is required.", requestId: "ab12cd34ef56ab78" } }, "fallback")).toBe("Reason for changing the emergency stop is required.");
    expect(saidBy({ status: 503, data: null, headers: new Headers({ "x-request-id": "edge-0123456789" }) }, "The service is not available.")).toBe("The service is not available. Support reference: edge-0123456789.");
    expect(saidBy(new TypeError("Failed to fetch"), "Could not connect to Valo Pay 1.")).toBe("Could not connect to Valo Pay 1.");
  });

  it("quotes the reference in a problem notice for a failed action", async () => {
    const user = userEvent.setup();
    api.failNext(/^\/v1\/actions$/, { status: 500, error: "The operation could not be completed. No partial change has been committed." }, "POST");
    renderApp("/audit");
    await user.click(await screen.findByRole("button", { name: /Check audit log/ }));
    const notice = await screen.findAllByText(/Support reference: fake-[0-9a-f]{4}\./);
    expect(notice.length).toBeGreaterThan(0);
    // The notice store outlives a render, so the notice is dismissed here rather than left for the next case.
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText(/Support reference: fake-/)).toBeNull());
  });

  it("keeps a refusal's notice to the rule's own words", async () => {
    const user = userEvent.setup();
    api.failNext(/^\/v1\/actions$/, { status: 403, error: "Verification requires the Compliance reviewer role." }, "POST");
    renderApp("/audit");
    await user.click(await screen.findByRole("button", { name: /Check audit log/ }));
    const words = await screen.findAllByText(/Verification requires the Compliance reviewer role\./);
    for (const element of words) expect(element.textContent).not.toMatch(/Support reference:/);
    expect(screen.queryByText(/Support reference: fake-/)).toBeNull();
  });
});
