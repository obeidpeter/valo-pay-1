import { describe, expect, it, vi } from "vitest";

// The helper's contract is what it hands the toast store: how each kind is announced and how long it stays.
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn(() => ({ id: "1", dismiss: () => {}, update: () => {} })) }));
// The shared setup imports the whole console first, so the helper is re-evaluated here against the mocked store.
vi.resetModules();
const { toast } = await import("@/hooks/use-toast");
const { DONE_DURATION_MS, notifyDone, notifyProblem, saidBy } = await import("@/lib/notify");

describe("notify", () => {
  it("lets a done notice go away on its own and announces it politely", () => {
    notifyDone("Settings saved", "Recorded in the audit log.");
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Settings saved", description: "Recorded in the audit log.", type: "background", duration: DONE_DURATION_MS }));
    expect(DONE_DURATION_MS).toBeGreaterThanOrEqual(5000);
  });

  it("keeps a problem notice until it is dismissed and announces it at once", () => {
    notifyProblem("The kill switch was not changed", "Only an Admin can do that.");
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "The kill switch was not changed", variant: "destructive", type: "foreground", duration: Infinity }));
  });

  it("passes on the server's words and never an HTTP status line", () => {
    expect(saidBy({ data: { error: "Packs are limited to five a day." }, message: "HTTP 400 Bad Request" }, "fallback")).toBe("Packs are limited to five a day.");
    expect(saidBy(new TypeError("Failed to fetch"), "The service could not be reached.")).toBe("The service could not be reached.");
  });
});
