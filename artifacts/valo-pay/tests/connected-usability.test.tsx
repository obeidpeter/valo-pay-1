import { afterEach, beforeEach, expect, it } from "vitest";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor } from "./harness";
import { makeRecord } from "../../api-server/src/domain/records";

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi({ now: "2026-09-21T10:00:00.000Z" });
});
afterEach(() => api.uninstall());

it("requires an explicit applicant before granting authority", async () => {
  const user = userEvent.setup();
  renderApp("/connections");
  const subject = await screen.findByLabelText("Who it covers");
  expect((subject as HTMLSelectElement).value).toBe("");
  await user.type(
    screen.getByLabelText("Reason for granting permission"),
    "Review the sample applicant permission",
  );
  await user.click(
    screen.getByRole("button", { name: "Grant permission" }),
  );
  expect(
    api.calls.filter(
      (c) => c.method === "POST" && c.path.includes("/connected/actions"),
    ),
  ).toHaveLength(0);
  expect(
    api.state().records.filter((r) => r.kind === "connected-consents"),
  ).toHaveLength(0);
  // The page says what is missing in its own words, beside the field.
  expect(screen.getByText("Choose who the permission covers.")).toBeTruthy();
  expect(subject.getAttribute("aria-invalid")).toBe("true");
});

it("shows a Finance viewer why granting and withdrawing permissions are unavailable", async () => {
  api.role = "Finance";
  renderApp("/connections");
  const grant = await screen.findByRole("button", {
    name: "Grant permission",
  });
  expect((grant as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Your role is Finance\./).textContent).toContain(
    "Compliance reviewer can withdraw one",
  );
});

it("allows Compliance to review revocation while keeping permission grants unavailable; cancellation returns focus and clears the revocation note", async () => {
  api.role = "Compliance reviewer";
  api.mutate((state) =>
    makeRecord(state, "connected-consents", {
      name: "Read business accounts",
      status: "active",
      createdAt: api.now,
      data: {
        purpose: "merchant_account_read",
        version: 1,
        subjectId: "sme",
        entityId: `${state.merchant.id}:sme`,
        expiresAt: "2026-10-21T10:00:00Z",
        authority: "simulated",
      },
    }),
  );
  const user = userEvent.setup();
  renderApp("/connections");
  const trigger = await screen.findByRole("button", {
    name: "Withdraw Read business accounts for Sample business",
  });
  expect((trigger as HTMLButtonElement).disabled).toBe(false);
  expect(
    (
      screen.getByRole("button", {
        name: "Grant permission",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.click(trigger);
  expect(
    screen.getByRole("region", { name: "Permission to withdraw" }).textContent,
  ).toContain("Sample business (separate from the lender)");
  await user.type(
    screen.getByLabelText("Reason for withdrawing permission"),
    "Do not reuse this as a grant reason",
  );
  await user.click(screen.getByRole("button", { name: "Keep permission" }));
  expect(document.activeElement).toBe(trigger);
  expect(
    (
      screen.getByLabelText(
        "Reason for granting permission",
      ) as HTMLTextAreaElement
    ).value,
  ).toBe("");
  expect(
    api.state().records.find((r) => r.kind === "connected-consents")!.status,
  ).toBe("active");
});

it("does not offer a Compliance viewer payment actions rejected by the server", async () => {
  api.role = "Compliance reviewer";
  renderApp("/pay-by-bank");
  expect(
    (
      (await screen.findByRole("button", {
        name: /Create checkout/,
      })) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    screen.getByText(/^Only Admin, Operations or Finance can create or change a checkout\. Your role is Compliance reviewer\./),
  ).toBeTruthy();
});

it("lets an operator clear and correct a checkout amount without restoring the full debt or rounding it", async () => {
  const user = userEvent.setup();
  renderApp("/pay-by-bank");
  await screen.findByRole("heading", { name: "Pay by Bank", level: 1 });
  const due = api
    .state()
    .records.find((r) => r.reference === "DEMO-LOAN-1005")!;
  await user.selectOptions(
    screen.getByLabelText("Customer and instalment"),
    due.id,
  );
  const amount = screen.getByLabelText("Amount (₦)");
  await user.clear(amount);
  expect((amount as HTMLInputElement).value).toBe("");
  await user.type(amount, "125.005");
  await user.click(
    screen.getByRole("button", { name: /Create checkout/ }),
  );
  expect(amount.getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(amount);
  expect(api.state().records.some((r) => r.kind === "connected-intents")).toBe(
    false,
  );
  await user.clear(amount);
  await user.type(amount, "125.29");
  await user.click(
    screen.getByRole("button", { name: /Create checkout/ }),
  );
  await waitFor(() =>
    expect(
      api.state().records.find((r) => r.kind === "connected-intents")
        ?.amountKobo,
    ).toBe(12_529),
  );
  expect(screen.getByRole("status").textContent).toContain(
    "Sample checkout created",
  );
});
