import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { LazyPage, QUERY_STALE_MS, loadPage, queryClient, queryDefaults } from "@/App";
import { QUERY_RETRIES, retryQuery } from "@/lib/query-retry";
import { pilotRequest } from "@/lib/pilot";
import { pilotJourneySchema } from "@workspace/valopay-schema";
import { installFakeApi } from "./fake-api";
import { renderApp, screen } from "./harness";
import { ErrorBoundary } from "@/components/error-boundary";
import { ScrollFrame } from "@/components/scroll-frame";

const packageFile = (...parts: string[]) => [join(process.cwd(), ...parts), join(process.cwd(), "artifacts", "valo-pay", ...parts)].find((candidate) => existsSync(candidate))!;

// The measurements behind these are in the design rationale (Performance); the tests pin what was changed.
describe("performance", () => {
  it("shows data fetched in the last thirty seconds at once instead of refetching it", () => {
    expect(QUERY_STALE_MS).toBe(30_000);
    expect(queryClient.getDefaultOptions().queries?.staleTime).toBe(QUERY_STALE_MS);
  });

  it("repeats a read only after a network failure or a service failure, at most twice", () => {
    expect(queryDefaults.queries.retry).toBe(retryQuery);
    expect(QUERY_RETRIES).toBe(2);
    for (const status of [400, 401, 403, 404, 409, 410, 422, 429]) expect(retryQuery(0, { status, data: { error: "Refused" } })).toBe(false);
    for (const error of [new TypeError("Failed to fetch"), new DOMException("The operation timed out.", "TimeoutError"), { status: 500 }, { status: 502, data: "<html>Bad gateway</html>" }, { status: 503 }, { status: 408 }]) expect(retryQuery(0, error)).toBe(true);
    expect(retryQuery(1, { status: 503 })).toBe(true);
    expect(retryQuery(2, { status: 503 })).toBe(false);
    expect(retryQuery(2, new TypeError("Failed to fetch"))).toBe(false);
    // An answer that arrived but could not be read, or a local check that failed, is not repeated.
    for (const error of [new Error("The saved export status could not be verified."), { status: 200 }, null, new DOMException("Aborted", "AbortError")]) expect(retryQuery(0, error)).toBe(false);
  });

  it("recovers a read that met a passing service failure without showing an error", async () => {
    const api = installFakeApi();
    const testDefaults = queryClient.getDefaultOptions();
    queryClient.setDefaultOptions({ queries: { ...queryDefaults.queries, retryDelay: 0 } });
    try {
      const ada = api.state().records.find((record) => record.kind === "customers" && record.name === "Ada Okonkwo")!;
      api.failNext(/\/history$/, { status: 503, error: "Valo Pay is busy. Try again in a moment." });
      renderApp(`/customers/${ada.id}`);
      expect(await screen.findByRole("heading", { name: "Ada Okonkwo" })).toBeTruthy();
      expect(api.calls.filter((call) => call.path.endsWith("/history")).map((call) => call.status)).toEqual([503, 200]);
    } finally {
      queryClient.setDefaultOptions(testDefaults);
      api.uninstall();
    }
  });

  const gatewayPage = () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "Content-Type": "text/html" } });

  it("keeps the status of a pilot answer that is not JSON, so a proxy's 502 is repeated", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(gatewayPage());
    const failure = await pilotRequest("/pilot/journey", pilotJourneySchema).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 502, data: {}, message: "The request could not be completed." });
    expect(retryQuery(0, failure)).toBe(true);
  });

  it("repeats a connected read that met a proxy's HTML error page", async () => {
    const api = installFakeApi();
    const testDefaults = queryClient.getDefaultOptions();
    queryClient.setDefaultOptions({ queries: { ...queryDefaults.queries, retryDelay: 0 } });
    const send = globalThis.fetch, reads: number[] = [];
    globalThis.fetch = async (input, options) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (!url.startsWith("/api/v1/connected?")) return send(input, options);
      const answer = reads.length ? await send(input, options) : gatewayPage();
      reads.push(answer.status);
      return answer;
    };
    try {
      renderApp("/credit-desk");
      expect(await screen.findByLabelText("Reason for this assessment")).toBeTruthy();
      expect(reads).toEqual([502, 200]);
    } finally {
      queryClient.setDefaultOptions(testDefaults);
      api.uninstall();
    }
  });

  it("serves the two typefaces itself, with the stylesheet, and asks Google for nothing", () => {
    const shell = readFileSync(packageFile("index.html"), "utf8");
    const css = readFileSync(packageFile("src", "index.css"), "utf8");
    const fonts = readFileSync(packageFile("src", "fonts.css"), "utf8");
    expect(readFileSync(packageFile("src", "main.tsx"), "utf8")).toContain("import './fonts.css';");
    for (const text of [shell, css, fonts]) expect(text).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    expect(shell).not.toContain("family=Inter");
    const faces = [...fonts.matchAll(/@font-face \{([^}]*)\}/g)].map(([, rule]) => rule);
    // The families, weights and subsets Google served: four subsets of Plus Jakarta Sans at 400 to 800, two of Spline Sans Mono at 400 to 600.
    expect(faces.filter((rule) => rule.includes("font-family: 'Plus Jakarta Sans'") && rule.includes("font-weight: 400 800"))).toHaveLength(4);
    expect(faces.filter((rule) => rule.includes("font-family: 'Spline Sans Mono'") && rule.includes("font-weight: 400 600"))).toHaveLength(2);
    for (const rule of faces) {
      expect(rule).toContain("font-display: swap;");
      expect(rule).toMatch(/unicode-range: U\+/);
      const file = /url\('([^']+\.woff2)'\) format\('woff2'\)/.exec(rule)?.[1];
      expect(file, rule).toMatch(/^@fontsource-variable\//);
      expect(existsSync(packageFile("node_modules", file!)), file).toBe(true);
    }
  });

  it("loads the console pages on demand and keeps the landing page in the shell", () => {
    const app = readFileSync(packageFile("src", "App.tsx"), "utf8");
    expect(app).toContain("import LandingPage from '@/pages/landing';");
    for (const page of ["overview", "customers/index", "customers/[id]", "reconciliation", "exceptions", "policies", "mandates", "collections", "reports", "evidence", "audit", "settings", "sign-in"]) {
      expect(app).toContain(`import('@/pages/${page}')`);
    }
  });

  it("fetches a page's code once and renders it at once on a later visit", async () => {
    const load = vi.fn(async () => ({ default: () => <p>The page</p> }));
    const first = render(<LazyPage load={load} />);
    expect(first.getByRole("status").textContent).toBe("Loading the page…");
    expect(await first.findByText("The page")).toBeTruthy();
    first.unmount();
    // Fetched ahead of time or visited before: no loading line, no second fetch.
    await loadPage(load);
    const second = render(<LazyPage load={load} />);
    expect(second.queryByRole("status")).toBeNull();
    expect(second.getByText("The page")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shows the page-error notice when a page's code cannot be fetched", async () => {
    const load = vi.fn(async () => { throw new Error("chunk failed to load"); });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const view = render(<ErrorBoundary><LazyPage load={load} /></ErrorBoundary>);
      expect(await view.findByRole("alert")).toBeTruthy();
      expect(view.getByRole("alert").textContent).toContain("We could not display this page");
    } finally {
      spy.mockRestore();
    }
  });

  it("observes a scroll frame once, however often it renders", () => {
    const created = vi.fn();
    class CountingObserver { constructor() { created(); } observe() { /* not measured in tests */ } unobserve() { /* not measured */ } disconnect() { /* not measured */ } }
    const original = globalThis.ResizeObserver;
    vi.stubGlobal("ResizeObserver", CountingObserver);
    try {
      const view = render(<ScrollFrame label="Rows"><table><tbody><tr><td>one</td></tr></tbody></table></ScrollFrame>);
      view.rerender(<ScrollFrame label="Rows"><table><tbody><tr><td>one</td></tr><tr><td>two</td></tr></tbody></table></ScrollFrame>);
      view.rerender(<ScrollFrame label="Rows"><table><tbody><tr><td>three</td></tr></tbody></table></ScrollFrame>);
      expect(created).toHaveBeenCalledTimes(1);
    } finally {
      vi.stubGlobal("ResizeObserver", original);
    }
  });
});
afterEach(() => vi.unstubAllGlobals());
