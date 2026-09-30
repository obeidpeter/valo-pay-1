import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { queryClient } from "@/App";
import { cancelInterrupted, unreceivedRecovery } from './unreceived-recovery';

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi();
  unreceivedRecovery(api);
});
afterEach(() => api.uninstall());

/** Simulate the API's idempotency replay and a lost response after committing. */
function loseFirstResponse(path: string, method: string) {
  const send = globalThis.fetch;
  const replies = new Map<string, Response>();
  const requests: Array<{ key: string; body: string }> = [];
  globalThis.fetch = async (input, options) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
    if (!url.includes(path) || options?.method !== method)
      return send(input, options);
    const key = new Headers(options.headers).get("Idempotency-Key")!;
    requests.push({ key, body: String(options.body) });
    if (replies.has(key)) return replies.get(key)!.clone();
    const response = await send(input, options);
    replies.set(key, response.clone());
    throw new TypeError("Response lost after request reached server");
  };
  return requests;
}

it("freezes an unconfirmed settings draft and recovers the original revision and key", async () => {
  const user = userEvent.setup();
  renderApp("/settings");
  await screen.findByText("07:00 WAT");
  await user.click(screen.getByRole("button", { name: "Edit" }));
  const amount = screen.getByLabelText(
    "Notification cost alert (₦ per collection)",
  );
  await user.clear(amount);
  await user.type(amount, "10.29");
  const requests = loseFirstResponse("/v1/settings", "PATCH");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Settings outcome unconfirmed");
  expect(api.state().settings.notificationCostAlertKobo).toBe(1029);
  expect(amount.closest("fieldset")?.disabled).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.click(
    screen.getByRole("button", { name: "Retry original settings request" }),
  );
  await screen.findByText("Settings saved");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

it("retries an emergency-stop outcome without toggling the changed server state back", async () => {
  const user = userEvent.setup();
  renderApp("/settings");
  await screen.findByText("07:00 WAT");
  const reason = screen.getByLabelText(
    "Reason for changing the emergency stop",
  );
  await user.type(reason, "Stop sample operations for a review");
  const requests = loseFirstResponse("/v1/actions", "POST");
  await user.click(
    screen.getByRole("button", { name: "Activate emergency stop" }),
  );
  const retry = await screen.findByRole("button", {
    name: "Retry original emergency-stop request",
  });
  expect(api.state().merchant.killSwitch).toBe(true);
  await queryClient.invalidateQueries();
  expect((reason as HTMLInputElement).disabled).toBe(true);
  await user.click(retry);
  await screen.findByText("Lender emergency stop is on. No collection instruction was sent.");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(api.state().merchant.killSwitch).toBe(true);
});

it("keeps a lost demo-role request recoverable even after the server changed roles", async () => {
  const user = userEvent.setup();
  renderApp("/settings");
  await screen.findByText("07:00 WAT");
  const select = screen.getByLabelText("Demo role");
  await user.selectOptions(select, "Finance");
  const requests = loseFirstResponse("/v1/actions", "POST");
  await user.click(screen.getByRole("button", { name: "Switch role" }));
  const retry = await screen.findByRole("button", {
    name: "Retry original role request",
  });
  expect(api.role).toBe("Finance");
  expect((select as HTMLSelectElement).disabled).toBe(true);
  await queryClient.invalidateQueries();
  await user.click(retry);
  await screen.findByText("Demo role changed");
  expect(requests[1]).toEqual(requests[0]);
});

it("locks a mandate draft after a lost create response, then recovers one mandate and the original key", async () => {
  const user = userEvent.setup();
  renderApp("/mandates");
  await user.click(
    await screen.findByRole("button", { name: "Add mandate" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Add mandate",
  });
  await user.type(
    within(dialog).getByLabelText(/Mandate name/),
    "Recovery sample mandate",
  );
  const customer = api.state().records.find((r) => r.kind === "customers")!;
  const policy = api.state().records.find((r) => r.kind === "policies")!;
  await user.selectOptions(
    within(dialog).getByLabelText(/Customer/),
    customer.id,
  );
  await user.type(within(dialog).getByLabelText(/Debit limit/), "2000.29");
  await user.type(
    within(dialog).getByLabelText(/Provider reference/),
    "SYN-RECOVER-MANDATE",
  );
  await user.type(
    within(dialog).getByLabelText(/Consent evidence reference/),
    "SYN-CONSENT-RECOVERY",
  );
  await user.selectOptions(within(dialog).getByLabelText(/^Retry policy/), policy.id);
  const requests = loseFirstResponse("/v1/records/mandates", "POST");
  await user.click(
    within(dialog).getByRole("button", { name: "Add mandate" }),
  );
  await screen.findByText("Request not confirmed");
  expect(
    within(dialog)
      .getByLabelText(/Mandate name/)
      .closest("fieldset")?.disabled,
  ).toBe(true);
  expect(
    (
      within(dialog).getByRole("button", {
        name: "Cancel",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeTruthy();
  await user.click(
    within(dialog).getByRole("button", {
      name: "Check original request",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(
    api.state().records.filter((r) => r.reference === "SYN-RECOVER-MANDATE"),
  ).toHaveLength(1);
});

/** Loses the first settings save before it reaches the API; the retry is refused as stale, with or without the cancelled marker. */
function staleSettingsRetry(marked: boolean) {
  const send = globalThis.fetch;
  const patches: string[] = [];
  let reads = 0;
  globalThis.fetch = async (input, options) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
    if (url.includes("/v1/settings") && (!options?.method || options.method === "GET"))
      reads += 1;
    if (options?.method === "PATCH" && url.includes("/v1/settings")) {
      patches.push(new Headers(options.headers).get("Idempotency-Key")!);
      if (patches.length === 1) throw new TypeError("Failed to fetch");
      return new Response(
        JSON.stringify({
          error:
            "These settings changed after you opened them. Your changes have not been saved. Refresh the settings, review the latest version, and try again.",
          requestId: "r",
          ...(marked ? { operation: "cancelled" } : {}),
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    return send(input, options);
  };
  return { patches, reads: () => reads };
}

async function loseSettingsSave(user: ReturnType<typeof userEvent.setup>) {
  renderApp("/settings");
  await screen.findByText("07:00 WAT");
  await user.click(screen.getByRole("button", { name: "Edit" }));
  const amount = screen.getByLabelText(
    "Notification cost alert (₦ per collection)",
  );
  await user.clear(amount);
  await user.type(amount, "10.29");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Settings outcome unconfirmed");
}

it("a settings retry refused as cancelled is a known failure, and Discard draft and refresh works", async () => {
  const user = userEvent.setup();
  const traffic = staleSettingsRetry(true);
  await loseSettingsSave(user);
  await user.click(
    screen.getByRole("button", { name: "Retry original settings request" }),
  );
  await screen.findByText("Settings not saved");
  expect(screen.queryByText("Settings outcome unconfirmed")).toBeNull();
  expect(traffic.patches[1]).toBe(traffic.patches[0]);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const reads = traffic.reads();
  await user.click(
    screen.getByRole("button", { name: "Discard draft and refresh" }),
  );
  await screen.findByRole("button", { name: "Edit" });
  expect(traffic.reads()).toBeGreaterThan(reads);
  expect(confirm).toHaveBeenCalled();
});

it("Discard draft and refresh keeps an interrupted identity until the server cancels it", async () => {
  const user = userEvent.setup();
  const traffic = staleSettingsRetry(false);
  await loseSettingsSave(user);
  await user.click(
    screen.getByRole("button", { name: "Retry original settings request" }),
  );
  const refresh = await screen.findByRole("button", {
    name: "Discard draft and refresh",
  });
  expect(screen.getByText("Settings outcome unconfirmed")).toBeTruthy();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const reads = traffic.reads();
  await user.click(refresh);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("may already have been saved"));
  expect(traffic.reads()).toBe(reads);
  expect(screen.getByText("Settings outcome unconfirmed")).toBeTruthy();
  confirm.mockReturnValue(true);
  await user.click(refresh);
  await screen.findByRole("button", { name: "Edit" });
  expect(traffic.reads()).toBeGreaterThan(reads);
  // Discarding the local form is not proof the first request failed. Obtain cancellation before a new write.
  await cancelInterrupted(user);
  await user.click(screen.getByRole("button", { name: "Edit" }));
  const amount = screen.getByLabelText(
    "Notification cost alert (₦ per collection)",
  );
  await user.clear(amount);
  await user.type(amount, "10.31");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(traffic.patches).toHaveLength(3));
  expect(traffic.patches[2]).not.toBe(traffic.patches[0]);
});

it("a lost mandate create can be discarded deliberately, which unlocks the dialog", async () => {
  const user = userEvent.setup();
  renderApp("/mandates");
  await user.click(
    await screen.findByRole("button", { name: "Add mandate" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Add mandate",
  });
  await user.type(
    within(dialog).getByLabelText(/Mandate name/),
    "Discarded sample mandate",
  );
  await user.selectOptions(
    within(dialog).getByLabelText(/Customer/),
    api.state().records.find((r) => r.kind === "customers")!.id,
  );
  await user.type(within(dialog).getByLabelText(/Debit limit/), "2000.29");
  await user.type(
    within(dialog).getByLabelText(/Provider reference/),
    "SYN-DISCARD-MANDATE",
  );
  await user.type(
    within(dialog).getByLabelText(/Consent evidence reference/),
    "SYN-CONSENT-DISCARD",
  );
  await user.selectOptions(
    within(dialog).getByLabelText(/^Retry policy/),
    api.state().records.find((r) => r.kind === "policies")!.id,
  );
  api.failNext(/^\/v1\/records\/mandates$/, "offline", "POST");
  await user.click(
    within(dialog).getByRole("button", { name: "Add mandate" }),
  );
  await screen.findByText("Request not confirmed");
  const cancel = within(dialog).getByRole("button", {
    name: "Cancel",
  }) as HTMLButtonElement;
  expect(cancel.disabled).toBe(true);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  await user.click(
    within(dialog).getByRole("button", { name: "Discard original request" }),
  );
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Check Operations"));
  await waitFor(() => expect(cancel.disabled).toBe(false));
  expect(screen.queryByText("Request not confirmed")).toBeNull();
  // The notice went with its button: focus is on the form's own button again, not on the page or the dialog's top.
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Add mandate" })));
  expect(
    within(dialog).getByLabelText(/Mandate name/).closest("fieldset")?.disabled,
  ).toBe(false);
  await user.click(cancel);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

/** Records the idempotency key of every matching request and passes it on. */
function recordKeys(path: string, method: string) {
  const send = globalThis.fetch;
  const keys: string[] = [];
  globalThis.fetch = async (input, options) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();
    if (url.includes(path) && options?.method === method)
      keys.push(new Headers(options.headers).get("Idempotency-Key")!);
    return send(input, options);
  };
  return keys;
}

it("the unconfirmed settings notice discards its form, and a server cancellation permits a new save", async () => {
  const user = userEvent.setup();
  const keys = recordKeys("/v1/settings", "PATCH");
  api.failNext(/^\/v1\/settings$/, "offline", "PATCH");
  await loseSettingsSave(user);
  const alert = screen.getByText("Settings outcome unconfirmed").closest("[role=alert]") as HTMLElement;
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await user.click(
    within(alert).getByRole("button", { name: "Discard original request" }),
  );
  await waitFor(() =>
    expect(screen.queryByText("Settings outcome unconfirmed")).toBeNull(),
  );
  const amount = screen.getByLabelText(
    "Notification cost alert (₦ per collection)",
  );
  expect(amount.closest("fieldset")?.disabled).toBe(false);
  await cancelInterrupted(user);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Settings saved");
  expect(api.state().settings.notificationCostAlertKobo).toBe(1029);
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(keys[0]);
});

it("the emergency-stop notice discards its form, and a confirmed cancellation permits a new request", async () => {
  const user = userEvent.setup();
  renderApp("/settings");
  await screen.findByText("07:00 WAT");
  const reason = screen.getByLabelText(
    "Reason for changing the emergency stop",
  ) as HTMLInputElement;
  await user.type(reason, "Stop sample operations for a review");
  const keys = recordKeys("/v1/actions", "POST");
  api.failNext(/^\/v1\/actions$/, "offline", "POST");
  await user.click(
    screen.getByRole("button", { name: "Activate emergency stop" }),
  );
  const notice = (
    await screen.findByText(/The emergency-stop response is unconfirmed/)
  ).closest("[role=alert]") as HTMLElement;
  expect(reason.disabled).toBe(true);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await user.click(
    within(notice).getByRole("button", { name: "Discard original request" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByText(/The emergency-stop response is unconfirmed/),
    ).toBeNull(),
  );
  expect(reason.disabled).toBe(false);
  expect(api.state().merchant.killSwitch).toBe(false);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Activate emergency stop" })));
  await cancelInterrupted(user);
  await user.click(
    screen.getByRole("button", { name: "Activate emergency stop" }),
  );
  await screen.findByText("Lender emergency stop is on. No collection instruction was sent.");
  expect(api.state().merchant.killSwitch).toBe(true);
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(keys[0]);
});

/** Signs the console in as a staff administrator while another administrator's request to lift the lender's stop waits. */
function staffWithWaitingRelease() {
  const send = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const response = await send(input, options);
    if (new URL(String(input instanceof Request ? input.url : input), "http://localhost").pathname !== "/api/v1/workspace") return response;
    return new Response(JSON.stringify({ ...(await response.json()), accessMode: "staff", actor: "Clerk:user_a" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  api.mutate((state) => { state.merchant.killSwitch = true; state.settings.emergencyStopReleases = { lender: { requestedBy: "Clerk:user_b", requestedAt: api.now, reason: "The incident is closed.", policyId: null } }; });
}

it("offers the retry of a lost emergency-stop answer while a request to lift the stop waits, and holds back its opposite", async () => {
  const user = userEvent.setup();
  staffWithWaitingRelease();
  renderApp("/settings");
  await screen.findByText(/Clerk:user_b asked to turn the emergency stop off/);
  const reason = screen.getByLabelText("Reason for changing the emergency stop") as HTMLInputElement;
  await user.type(reason, "Keep it on until the provider confirms");
  api.failNext(/^\/v1\/actions$/, "offline", "POST");
  await user.click(screen.getByRole("button", { name: "Keep the stop on" }));
  // The answer was lost, so the stop may already be kept on and the request settled: only the original is retried.
  const retry = await screen.findByRole("button", { name: "Retry original emergency-stop request" });
  expect(screen.getByText(/The emergency-stop response is unconfirmed/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Approve turning it off" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Keep the stop on" }) as HTMLButtonElement).disabled).toBe(true);
  expect(reason.disabled).toBe(true);
  await user.click(retry);
  expect(await screen.findByText("Lender emergency stop is on. No collection instruction was sent.")).toBeTruthy();
  expect(api.state().merchant.killSwitch).toBe(true);
  expect(api.state().settings.emergencyStopReleases).toBeUndefined();
  await waitFor(() => expect(screen.queryByText(/asked to turn the emergency stop off/)).toBeNull());
});

it("moves focus back to Approve turning it off when its lost answer is discarded", async () => {
  // Second review of the audit fixes, the older focus patterns: Discard original request left focus on the page body.
  const user = userEvent.setup();
  staffWithWaitingRelease();
  renderApp("/settings");
  await screen.findByText(/Clerk:user_b asked to turn the emergency stop off/);
  await user.type(screen.getByLabelText("Reason for changing the emergency stop"), "Checked the incident notes with Operations.");
  // The approval never reached the service: the request still waits.
  api.failNext(/^\/v1\/actions$/, "offline", "POST");
  await user.click(screen.getByRole("button", { name: "Approve turning it off" }));
  const notice = (await screen.findByText(/The approval's response is unconfirmed/)).closest("[role=alert]") as HTMLElement;
  vi.spyOn(window, "confirm").mockReturnValue(true);
  within(notice).getByRole("button", { name: "Discard original request" }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByText(/The approval's response is unconfirmed/)).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Approve turning it off" })));
});

it("keeps a lost approval's notice and its retry when a refetch takes the waiting request away", async () => {
  const user = userEvent.setup();
  staffWithWaitingRelease();
  renderApp("/settings");
  await screen.findByText(/Clerk:user_b asked to turn the emergency stop off/);
  await user.type(screen.getByLabelText("Reason for changing the emergency stop"), "Checked the incident notes with Operations.");
  const requests = loseFirstResponse("/v1/actions", "POST");
  await user.click(screen.getByRole("button", { name: "Approve turning it off" }));
  await screen.findByText(/The approval's response is unconfirmed/);
  expect((screen.getByRole("button", { name: "Keep the stop on" }) as HTMLButtonElement).disabled).toBe(true);
  // The approval did reach the service: read again, the settings show the stop off and no request waiting.
  expect(api.state().merchant.killSwitch).toBe(false);
  await queryClient.invalidateQueries();
  await waitFor(() => expect(screen.queryByText(/asked to turn the emergency stop off/)).toBeNull());
  const notice = screen.getByText(/The approval's response is unconfirmed/).closest("[role=alert]") as HTMLElement;
  // Nothing that would reverse it is offered while its outcome is unconfirmed.
  expect((screen.getByRole("button", { name: "Activate emergency stop" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(within(notice).getByRole("button", { name: "Retry original approval" }));
  expect(await screen.findByText("Lender emergency stop is off. No collection instruction was sent.")).toBeTruthy();
  expect(screen.queryByText(/The approval's response is unconfirmed/)).toBeNull();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect((screen.getByRole("button", { name: "Activate emergency stop" }) as HTMLButtonElement).disabled).toBe(true);
});
