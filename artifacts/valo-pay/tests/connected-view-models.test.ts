import {
  connectedViewSchema,
  type ConnectedView,
} from "@workspace/valopay-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAnswer } from "@/lib/answers";
import { consoleConnectedViewSchema } from "@/lib/connected-view";
import { installFakeApi, type FakeApi } from "./fake-api";

let api: FakeApi;
let view: ConnectedView;

beforeEach(async () => {
  api = installFakeApi({ now: "2026-09-29T10:00:00.000Z" });
  view = connectedViewSchema.parse(
    await (
      await fetch(`/api/v1/connected?merchantId=${api.merchantIds[0]}`)
    ).json(),
  );
});
afterEach(() => api.uninstall());

function record(
  kind: "connected-consents" | "connected-intents",
  data: Record<string, unknown>,
) {
  return {
    id: `sample-${kind}`,
    merchantId: api.merchantIds[0]!,
    kind,
    name: "Saved sample",
    status: kind === "connected-consents" ? "active" : "created",
    reference: "SYN-1",
    amountKobo: 1800000,
    customerId: "sample-customer",
    createdAt: api.now,
    updatedAt: api.now,
    data,
  };
}

function answer(
  consentData: Record<string, unknown>,
  paymentData: Record<string, unknown>,
) {
  return {
    ...view,
    consents: [
      {
        ...record("connected-consents", consentData),
        effectiveStatus: "active",
      },
    ],
    payments: {
      ...view.payments,
      intents: [record("connected-intents", paymentData)],
    },
  };
}

describe("typed connected consent and checkout views", () => {
  it("accepts old records without optional fields and preserves additions from a newer service", () => {
    const legacy = answer({}, {});
    const parsedLegacy = readAnswer(consoleConnectedViewSchema, legacy);
    expect(parsedLegacy?.consents[0]?.data.subjectId).toBeUndefined();
    expect(parsedLegacy?.payments.intents[0]?.data.events).toBeUndefined();
    expect(parsedLegacy).toBeDefined();

    const extended = {
      ...answer(
        {
          subjectId: "sme",
          grantedBy: "Sandbox Operations",
          expiresAt: "2026-10-29T10:00:00.000Z",
          providerMetadata: { version: 2 },
        },
        {
          beneficiary: "Sample lender",
          events: [
            {
              at: api.now,
              status: "created",
              detail: "Checkout created.",
              source: "sample",
            },
          ],
          providerMetadata: { version: 2 },
        },
      ),
      serviceVersion: "next",
    };
    const parsed = readAnswer(consoleConnectedViewSchema, extended);
    expect(parsed?.consents[0]?.data.grantedBy).toBe("Sandbox Operations");
    expect(parsed?.consents[0]?.data.providerMetadata).toEqual({ version: 2 });
    expect(parsed?.payments.intents[0]?.data.events?.[0]?.detail).toBe(
      "Checkout created.",
    );
    expect(parsed?.payments.intents[0]?.data.events?.[0]?.source).toBe(
      "sample",
    );
    expect(parsed?.payments.intents[0]?.data.providerMetadata).toEqual({
      version: 2,
    });
  });

  it.each([
    ["consent subject", { subjectId: { id: "sme" } }, {}],
    ["consent grantor", { grantedBy: ["Sandbox Operations"] }, {}],
    ["consent expiry", { expiresAt: 123 }, {}],
    ["checkout beneficiary", {}, { beneficiary: { name: "Sample lender" } }],
    ["checkout event list", {}, { events: "created" }],
    [
      "checkout event text",
      {},
      {
        events: [
          {
            at: "2026-09-29T10:00:00.000Z",
            status: "created",
            detail: { message: "Created" },
          },
        ],
      },
    ],
    ["checkout expiry", {}, { expiresAt: 123 }],
    [
      "refund maker",
      {},
      {
        refundRequest: {
          maker: { id: "staff-1" },
          reason: "Sample reversal",
          at: "2026-09-29T10:00:00.000Z",
        },
      },
    ],
  ] satisfies Array<
    [string, Record<string, unknown>, Record<string, unknown>]
  >)(
    "refuses malformed %s instead of exposing it to page rendering",
    (_field, consent, payment) => {
      const malformed = answer(consent, payment);
      // The transport record envelope alone allowed these fields; the page's typed model must inspect them.
      expect(readAnswer(connectedViewSchema, malformed)).toBeDefined();
      expect(readAnswer(consoleConnectedViewSchema, malformed)).toBeUndefined();
    },
  );
});
