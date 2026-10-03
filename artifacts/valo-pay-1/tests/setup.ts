// Runs before every console test file: browser APIs jsdom lacks, and a clean
// query cache and DOM between tests so one page's data never leaks into the next.
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";
import { queryClient } from "@/App";
import { watchFormSubmitters } from "./form-submitters";

// Cold lazy-page transforms can exceed Testing Library's 1s default when the
// whole jsdom suite runs together. Wait for the asserted state, never a sleep;
// keep this bounded well below the 20s per-test timeout.
configure({ asyncUtilTimeout: 5_000 });

// Replit injects managed Clerk configuration into Vitest too. Keep these
// offline localhost tests on the anonymous adapter they are specified for,
// without changing or contacting the managed Clerk runtime.
vi.mock("@/lib/auth", () => ({
  authEnabled: false,
  useSessionUser: () => ({ userId: null, isLoaded: true }),
  useSignOut: () => () => {},
  AuthShow: () => null,
  AuthProvider: ({ children }: { children: unknown }) => children,
  ClerkSlot: () => null,
  ClerkSignIn: () => null,
  ClerkSignUp: () => null,
  VerifiedSession: () => null,
}));

class ResizeObserverStub {
  observe(): void { /* layout is not measured in tests */ }
  unobserve(): void { /* layout is not measured in tests */ }
  disconnect(): void { /* layout is not measured in tests */ }
}
if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addListener() { /* legacy */ }, removeListener() { /* legacy */ },
    addEventListener() { /* no media changes in tests */ }, removeEventListener() { /* no media changes in tests */ },
    dispatchEvent: () => false,
  });
}
if (typeof Element.prototype.scrollIntoView !== "function") Element.prototype.scrollIntoView = () => { /* no scrolling in tests */ };
// Radix's swipe-to-dismiss on a notice asks for pointer capture, which jsdom does not implement.
if (typeof Element.prototype.hasPointerCapture !== "function") Element.prototype.hasPointerCapture = () => false;
if (typeof Element.prototype.setPointerCapture !== "function") Element.prototype.setPointerCapture = () => { /* no pointer capture in tests */ };
if (typeof Element.prototype.releasePointerCapture !== "function") Element.prototype.releasePointerCapture = () => { /* no pointer capture in tests */ };

// The app repeats a failed read only after a network failure or a 5xx; a test asserting an error state must see it at once.
// Everything else (the thirty-second staleness) stays as production configures it.
queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });

// Every form a test renders is checked: a control inside it that can submit it without being its submit button
// (type="submit"), such as a pager or a retry left without type="button", fails the test (tests/form-submitters.ts).
const submitters = watchFormSubmitters();
beforeEach(() => submitters.start());

afterEach(() => {
  const implicit = submitters.take();
  cleanup();
  queryClient.clear();
  // A theme chosen in one test is this browser's, not the next test's.
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  if (implicit.length) throw new Error(`A control inside a form submits it without being its submit button: ${implicit.join("; ")}. Give it type="button", or type="submit" if it is the form's submit button.`);
});
