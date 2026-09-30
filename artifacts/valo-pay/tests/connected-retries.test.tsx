import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor } from "./harness";
import { connectedRevision } from "../../api-server/src/domain/connected";
import { queryClient } from "@/App";
import type { ConnectedView } from "@/lib/connected";
import { cancelInterrupted, unreceivedRecovery } from './unreceived-recovery';

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi({ now: "2026-09-21T10:00:00.000Z" });
  unreceivedRecovery(api);
});
afterEach(() => api.uninstall());
/** Another user's change to something the workspace shows (a customer's name), so a form reviewed before it is stale. */
const changeWorkspace = () =>
  api.mutate((state) => {
    const customer = state.records.filter((record) => record.kind === "customers").at(-1)!;
    customer.name = `${customer.name} (renamed)`;
  });

it.each(["malformed JSON", "unexpected shape", "timeout"])(
  "retains the original request after a committed action returns %s",
  async (failureMode) => {
    const send = globalThis.fetch;
    let saved: Response | undefined;
    const submissions: Array<{ key: string; body: string }> = [];
    globalThis.fetch = async (input, options) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
      if (options?.method !== "POST" || !url.includes("/connected/actions"))
        return send(input, options);
      submissions.push({
        key: new Headers(options.headers).get("Idempotency-Key")!,
        body: String(options.body),
      });
      if (saved) return saved.clone();
      const response = await send(input, options);
      saved = response.clone();
      if (failureMode === "timeout")
        return new Response(
          JSON.stringify({ error: "The gateway timed out." }),
          { status: 408, headers: { "Content-Type": "application/json" } },
        );
      return new Response(failureMode === "malformed JSON" ? "broken" : "{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const user = userEvent.setup();
    renderApp("/credit-desk");
    await screen.findByRole("heading", { name: "Credit Desk", level: 1 });
    await user.type(
      screen.getByLabelText("Reason for this assessment"),
      "Review a synthetic application for response recovery",
    );
    await user.click(
      screen.getByRole("button", { name: /Run assessment/ }),
    );
    await screen.findByText("Request not confirmed");
    await user.click(
      screen.getByRole("button", { name: "Check original request" }),
    );
    await screen.findByText(/Original request confirmed/);
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual(submissions[0]);
    expect(
      api
        .state()
        .records.filter((r) => r.kind === "connected-credit-assessments"),
    ).toHaveLength(1);
  },
);

it.each(["Meridian Credit", "Cedar Cooperative"])(
  "retries the original committed request after a lost response and automatic revision refresh in %s",
  async (lenderName) => {
    // Seed ids are random. Exercise each lender explicitly rather than letting
    // UUID ordering decide which workspace this regression covers.
    const merchantId = api.merchantIds.find(
      (id) => api.state(id).merchant.name === lenderName,
    )!;
    api.merchantIds = [
      merchantId,
      ...api.merchantIds.filter((id) => id !== merchantId),
    ];
    const applicant = api
      .state(merchantId)
      .records.find(
        (record) =>
          record.kind === "customers" && record.reference === "DEMO-C1001",
      )!;
    const originalFetch = globalThis.fetch;
    const committed = new Map<string, Response>();
    const submissions: { key: string; body: string }[] = [];
    let loseResponse = true;
    let rejectRecovery = true;
    globalThis.fetch = async (input, options) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
      if (options?.method !== "POST" || !url.includes("/connected/actions"))
        return originalFetch(input, options);
      const key = new Headers(options.headers).get("Idempotency-Key")!;
      submissions.push({ key, body: String(options.body) });
      if (committed.has(key)) {
        if (rejectRecovery) {
          rejectRecovery = false;
          return new Response(
            JSON.stringify({
              error:
                "Restore your session before recovering the original request.",
            }),
            { status: 403, headers: { "Content-Type": "application/json" } },
          );
        }
        return committed.get(key)!.clone();
      }
      const response = await originalFetch(input, options);
      if (response.ok) committed.set(key, response.clone());
      if (response.ok && loseResponse) {
        loseResponse = false;
        throw new TypeError("Connection lost after the server committed");
      }
      return response;
    };
    const user = userEvent.setup();
    renderApp("/credit-desk");
    await screen.findByRole("heading", { name: "Credit Desk", level: 1 });
    await user.selectOptions(screen.getByLabelText("Applicant"), applicant.id);
    await user.type(
      screen.getByLabelText("Reason for this assessment"),
      "Check the synthetic evidence before reviewer handoff",
    );
    await user.click(
      screen.getByRole("button", { name: /Run assessment/ }),
    );
    await screen.findByText("Request not confirmed");
    // Synchronize on the regression's actual precondition: React Query has
    // applied the automatic refetch and its new revision before the retry.
    // The score's display copy is unrelated to retry/idempotency semantics.
    await waitFor(() => {
      const refreshed = queryClient.getQueryData<ConnectedView>([
        "connected",
        merchantId,
      ]);
      expect(refreshed?.revision).toBe(
        connectedRevision(api.state(merchantId)),
      );
      expect(refreshed?.revision).not.toBe(
        JSON.parse(submissions[0]!.body).expectedRevision,
      );
      expect(refreshed?.credit.assessments).toHaveLength(1);
    });
    await screen.findByRole("combobox", { name: "Assessment version" });
    expect(
      api
        .state()
        .records.filter(
          (record) => record.kind === "connected-credit-assessments",
        ),
    ).toHaveLength(1);
    expect(connectedRevision(api.state())).not.toBe(
      JSON.parse(submissions[0]!.body).expectedRevision,
    );
    await user.click(
      screen.getByRole("button", { name: "Check original request" }),
    );
    await waitFor(() => expect(submissions).toHaveLength(2));
    await screen.findByText(
      "Restore your session before recovering the original request.",
    );
    expect(
      screen.getByLabelText("Reason for this assessment").closest("fieldset")
        ?.disabled,
    ).toBe(true);
    await user.click(
      screen.getByRole("button", { name: "Check original request" }),
    );
    await waitFor(() => expect(submissions).toHaveLength(3));
    expect(submissions[1]).toEqual(submissions[0]);
    expect(submissions[2]).toEqual(submissions[0]);
    expect(
      api
        .state()
        .records.filter(
          (record) => record.kind === "connected-credit-assessments",
        ),
    ).toHaveLength(1);
    await screen.findByText(/Original request confirmed/);
  },
);

it("a definite stale-version rejection releases the old revision for an explicitly retried action", async () => {
  const originalFetch = globalThis.fetch;
  const submissions: { key: string; body: string }[] = [];
  let rejectFirst = true;
  globalThis.fetch = async (input, options) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
    if (options?.method !== "POST" || !url.includes("/connected/actions"))
      return originalFetch(input, options);
    submissions.push({
      key: new Headers(options.headers).get("Idempotency-Key")!,
      body: String(options.body),
    });
    if (rejectFirst) {
      rejectFirst = false;
      changeWorkspace();
      return new Response(
        JSON.stringify({
          error:
            "The workspace changed. Refresh and review before trying again.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
    return originalFetch(input, options);
  };
  const user = userEvent.setup();
  renderApp("/credit-desk");
  await screen.findByRole("heading", { name: "Credit Desk", level: 1 });
  await user.type(
    screen.getByLabelText("Reason for this assessment"),
    "Check the current synthetic application evidence",
  );
  await user.click(
    screen.getByRole("button", { name: /Run assessment/ }),
  );
  await screen.findByRole("alert");
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: /Run assessment/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await user.click(
    screen.getByRole("button", { name: /Run assessment/ }),
  );
  await screen.findByText(
    /Sample assessment saved as a new version/,
  );
  expect(submissions).toHaveLength(2);
  expect(submissions[1]!.key).not.toBe(submissions[0]!.key);
  expect(JSON.parse(submissions[1]!.body).expectedRevision).not.toBe(
    JSON.parse(submissions[0]!.body).expectedRevision,
  );
  expect(
    api
      .state()
      .records.filter(
        (record) => record.kind === "connected-credit-assessments",
      ),
  ).toHaveLength(1);
});

/** Drops the first connected action before it reaches the fake API; later ones pass through, optionally reshaped. */
function loseFirstAction(reshape?: (response: Response) => Promise<Response>) {
  const send = globalThis.fetch;
  const submissions: Array<{ key: string; body: string; status: number | "lost" }> = [];
  globalThis.fetch = async (input, options) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
    if (options?.method !== "POST" || !url.includes("/connected/actions"))
      return send(input, options);
    const key = new Headers(options.headers).get("Idempotency-Key")!;
    if (!submissions.length) {
      submissions.push({ key, body: String(options.body), status: "lost" });
      throw new TypeError("Failed to fetch");
    }
    const response = await send(input, options);
    submissions.push({ key, body: String(options.body), status: response.status });
    return reshape ? reshape(response) : response;
  };
  return submissions;
}

async function startAssessment(user: ReturnType<typeof userEvent.setup>) {
  renderApp("/credit-desk");
  await screen.findByRole("heading", { name: "Credit Desk", level: 1 });
  await user.type(
    screen.getByLabelText("Reason for this assessment"),
    "Check the synthetic evidence before reviewer handoff",
  );
  await user.click(
    screen.getByRole("button", { name: /Run assessment/ }),
  );
  await screen.findByText("Request not confirmed");
}

it("a retry refused because the saved answer is withheld ends the held action and reloads the workspace", async () => {
  // The first request was saved and its answer lost. By the retry, the permission it was made under changed, so the
  // service refuses to give the saved answer and says the request completed (operation completed): retrying again
  // cannot recover it, so the page is released, shows the service's words and loads the workspace again.
  const withheld =
    "This request already completed, but its saved response is no longer available under the current permissions or review. Permission was revoked, expired or replaced. Obtain current authority and prepare a new assessment. The action has not been run again.";
  const send = globalThis.fetch;
  const submissions: Array<{ key: string; body: string }> = [];
  let reads = 0;
  globalThis.fetch = async (input, options) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
    if (options?.method !== "POST" || !url.includes("/connected/actions")) {
      if (url.includes("/api/v1/connected?")) reads++;
      return send(input, options);
    }
    submissions.push({
      key: new Headers(options.headers).get("Idempotency-Key")!,
      body: String(options.body),
    });
    if (submissions.length === 1) {
      await send(input, options);
      throw new TypeError("Failed to fetch");
    }
    if (submissions.length === 2)
      return new Response(
        JSON.stringify({ error: withheld, operation: "completed", requestId: "synthetic-request" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    return send(input, options);
  };
  const user = userEvent.setup();
  await startAssessment(user);
  const readsBefore = reads;
  await user.click(
    screen.getByRole("button", { name: "Check original request" }),
  );
  expect((await screen.findByText(withheld)).getAttribute("role")).toBe("alert");
  expect(screen.queryByText("Request not confirmed")).toBeNull();
  expect(
    screen.getByLabelText("Reason for this assessment").closest("fieldset")
      ?.disabled,
  ).toBe(false);
  await waitFor(() => expect(reads).toBeGreaterThan(readsBefore));
  expect(submissions[1]).toEqual(submissions[0]);
  // The request is over: the next action is a new one, with a new key.
  await user.click(
    screen.getByRole("button", { name: /Run assessment/ }),
  );
  await screen.findByText(/Sample assessment saved as a new version/);
  expect(submissions).toHaveLength(3);
  expect(submissions[2]!.key).not.toBe(submissions[0]!.key);
  expect(
    api
      .state()
      .records.filter((r) => r.kind === "connected-credit-assessments"),
  ).toHaveLength(2);
});

it("a refusal the service marks as cancelled releases the held action", async () => {
  // The service cancels the key of a request it refuses and says so, so a
  // retried request that met a changed workspace is known not to have saved.
  const submissions = loseFirstAction(async (response) => {
    if (response.status !== 409) return response;
    const body = await response.json();
    return new Response(JSON.stringify({ ...body, operation: "cancelled" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  });
  const user = userEvent.setup();
  await startAssessment(user);
  changeWorkspace();
  await user.click(
    screen.getByRole("button", { name: "Check original request" }),
  );
  await screen.findByText(
    /^The original request was not saved\. The workspace changed/,
  );
  expect(screen.queryByText("Request not confirmed")).toBeNull();
  // The page's own error from the lost attempt does not come back once the request is released.
  expect(screen.queryByText("Failed to fetch")).toBeNull();
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  const reason = screen.getByLabelText("Reason for this assessment");
  expect(reason.closest("fieldset")?.disabled).toBe(false);
  expect(submissions.map((s) => s.status)).toEqual(["lost", 409]);
  expect(submissions[1]!.key).toBe(submissions[0]!.key);
  await user.click(
    screen.getByRole("button", { name: /Run assessment/ }),
  );
  await screen.findByText(/Sample assessment saved as a new version/);
  expect(submissions).toHaveLength(3);
  expect(submissions[2]!.key).not.toBe(submissions[0]!.key);
  expect(JSON.parse(submissions[2]!.body).expectedRevision).not.toBe(
    JSON.parse(submissions[0]!.body).expectedRevision,
  );
  expect(
    api
      .state()
      .records.filter((r) => r.kind === "connected-credit-assessments"),
  ).toHaveLength(1);
});

it("offers a deliberate discard of the form, retaining its request until the server cancels it", async () => {
  const submissions = loseFirstAction();
  const user = userEvent.setup();
  await startAssessment(user);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await user.click(
    screen.getByRole("button", { name: "Discard original request" }),
  );
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Check Operations"));
  expect(screen.getByText("Request not confirmed")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "Open Request history" }).getAttribute("href"),
  ).toBe("/operations");
  confirm.mockReturnValue(true);
  await user.click(
    screen.getByRole("button", { name: "Discard original request" }),
  );
  await waitFor(() =>
    expect(screen.queryByText("Request not confirmed")).toBeNull(),
  );
  expect(
    screen.getByLabelText("Reason for this assessment").closest("fieldset")
      ?.disabled,
  ).toBe(false);
  await cancelInterrupted(user);
  await user.click(
    screen.getByRole("button", { name: /Run assessment/ }),
  );
  await screen.findByText(/Sample assessment saved as a new version/);
  expect(submissions).toHaveLength(2);
  expect(submissions[1]!.key).not.toBe(submissions[0]!.key);
});

it.each([
  [401, "Sign in again to continue."],
  [429, "Too many requests. Wait a minute, then try again."],
])(
  "a %i keeps the action's key, so the identical next attempt is the same request",
  async (status, error) => {
    // A 401 or 429 is not final: any journal entry it left stays pending until the same key settles it.
    const send = globalThis.fetch;
    const submissions: Array<{ key: string; body: string }> = [];
    globalThis.fetch = async (input, options) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
      if (options?.method !== "POST" || !url.includes("/connected/actions"))
        return send(input, options);
      submissions.push({
        key: new Headers(options.headers).get("Idempotency-Key")!,
        body: String(options.body),
      });
      if (submissions.length === 1)
        return new Response(JSON.stringify({ error }), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      return send(input, options);
    };
    const user = userEvent.setup();
    renderApp("/credit-desk");
    await screen.findByRole("heading", { name: "Credit Desk", level: 1 });
    await user.type(
      screen.getByLabelText("Reason for this assessment"),
      "Check the synthetic evidence after a refusal to wait",
    );
    await user.click(
      screen.getByRole("button", { name: /Run assessment/ }),
    );
    await screen.findByText(error);
    expect(screen.queryByText("Request not confirmed")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: /Run assessment/ }),
    );
    await screen.findByText(
      /Sample assessment saved as a new version/,
    );
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual(submissions[0]);
  },
);
