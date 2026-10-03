// How the console reads a service answer (lib/answers.ts, audit item 24 and its
// review): a field a newer service added is accepted, but only within the shape
// the schema chose. zod reports only the unrecognised keys of the first union
// alternative that fails by nothing else, so a malformed record could pass as a
// Cash Desk outcome that carries extra keys; and a bare outcome is a valid answer
// for no action but a Cash Desk one. A connected confirmation is read in the one
// shape its action gives (connectedActionResultFor), of the lender it was sent for.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { connectedActionResultFor, connectedActionResultSchema } from "@workspace/valo-pay-1-schema";
import { readAnswer } from "@/lib/answers";

const lender = "lender-1";
const record = (overrides: Record<string, unknown> = {}) => ({ id: "record-1", merchantId: lender, kind: "connected-credit-assessments", name: "Sample assessment", status: "review_pending", reference: "SYN-1", amountKobo: 0, customerId: "customer-1", createdAt: "2026-09-21T10:00:00.000Z", updatedAt: "2026-09-21T10:00:00.000Z", data: { synthetic: true }, ...overrides });
const answer = (inner: unknown) => ({ message: "Sample workspace updated.", record: inner, mode: "synthetic", externalInstructionPerformed: false });
const cashRecord = record({ kind: "connected-cash-forecasts", status: "planning_estimate" });

describe("connected confirmations", () => {
  it("refuses a malformed record that passes as an outcome carrying extra keys, however the schema is chosen", () => {
    // The review's case: no id, lender or kind, but a message and a data object with synthetic: true.
    const malformed = answer({ message: "x", data: { synthetic: true, consent: "anything" }, status: "active" });
    expect(connectedActionResultSchema.safeParse(malformed).success).toBe(false);
    expect(readAnswer(connectedActionResultSchema, malformed)).toBeUndefined();
    expect(readAnswer(connectedActionResultFor("credit.assess", lender), malformed)).toBeUndefined();
    expect(readAnswer(connectedActionResultFor("cash.forecast", lender), malformed)).toBeUndefined();
  });

  it("refuses a bare outcome for any action but a Cash Desk set-up that was already done", () => {
    const bare = answer({ message: "Done.", data: { synthetic: true } });
    expect(connectedActionResultSchema.safeParse(bare).success).toBe(true);
    for (const action of ["consent.grant", "consent.revoke", "payment.create", "payment.authorise", "credit.assess", "credit.review", "cash.forecast", "cash.erp.export"]) {
      expect(readAnswer(connectedActionResultFor(action, lender), bare), action).toBeUndefined();
    }
    expect(readAnswer(connectedActionResultFor("cash.initialize", lender), bare)).toEqual(bare);
  });

  it("refuses a record of another lender or of another kind than the action gives", () => {
    expect(readAnswer(connectedActionResultFor("credit.assess", lender), answer(record()))).toBeDefined();
    expect(readAnswer(connectedActionResultFor("credit.assess", lender), answer(record({ merchantId: "lender-2" })))).toBeUndefined();
    expect(readAnswer(connectedActionResultFor("credit.assess", lender), answer(record({ merchantId: "lender-2", addedLater: true })))).toBeUndefined();
    expect(readAnswer(connectedActionResultFor("consent.grant", lender), answer(record()))).toBeUndefined();
    expect(readAnswer(connectedActionResultFor("cash.forecast", lender), answer(record()))).toBeUndefined();
  });

  it("accepts fields a newer service added within the shape the action gives", () => {
    const withAdditions = answer(record({ addedLater: "ignored" }));
    expect(readAnswer(connectedActionResultFor("credit.assess", lender), withAdditions)).toEqual(withAdditions);
    const outcome = answer({ message: "Forecast saved.", record: { ...cashRecord, addedLater: 1 }, data: { synthetic: true, externalInstructionPerformed: false, addedLater: true }, addedLater: [] });
    expect(readAnswer(connectedActionResultFor("cash.forecast", lender), outcome)).toEqual(outcome);
  });
});

describe("fields a newer service added", () => {
  const first = z.object({ kind: z.literal("first"), value: z.number() }).strict();
  const second = z.object({ kind: z.literal("second"), label: z.string() }).strict();
  const itemA = z.object({ id: z.string(), amount: z.number() }).strict();
  const itemB = z.object({ note: z.string() }).strict();

  it("counts only within a shape the schema chose, never in a union alternative the answer might match by accident", () => {
    // An item meant as itemA lost its amount, but carries itemB's one field: zod reports only itemB's unrecognised key.
    const schema = z.object({ item: z.union([itemA, itemB]) }).strict();
    expect(readAnswer(schema, { item: { id: "a-1", note: "kept" } })).toBeUndefined();
    expect(readAnswer(schema, { item: { id: "a-1", amount: 3, addedLater: true } })).toBeUndefined();
    expect(readAnswer(schema, { item: { id: "a-1", amount: 3 } })).toEqual({ item: { id: "a-1", amount: 3 } });
  });

  it("counts within a discriminated union's option, chosen by its discriminator", () => {
    const schema = z.object({ items: z.array(z.discriminatedUnion("kind", [first, second])) }).strict();
    const value = { items: [{ kind: "first", value: 1, addedLater: true }, { kind: "second", label: "b", addedLater: "x" }], addedLater: 2 };
    expect(readAnswer(schema, value)).toEqual(value);
    expect(readAnswer(schema, { items: [{ kind: "first", label: "b" }] })).toBeUndefined();
  });

  it("counts within the only alternative that could hold keys, and through optional, nullable and refined shapes", () => {
    const schema = z.object({ source: z.union([z.string(), z.object({ sealed: z.literal(1) }).strict()]), extra: itemA.nullable().optional(), checked: itemA.refine((item) => item.amount >= 0) }).strict();
    const value = { source: { sealed: 1, addedLater: true }, extra: { id: "e", amount: 1, addedLater: true }, checked: { id: "c", amount: 2, addedLater: true } };
    expect(readAnswer(schema, value)).toEqual(value);
    expect(readAnswer(schema, { ...value, checked: { id: "c", amount: -1, addedLater: true } })).toBeUndefined();
  });

  it("never excuses a missing, mistyped or impossible field", () => {
    const schema = z.object({ value: z.number(), nested: z.object({ label: z.string() }).strict() }).strict();
    expect(readAnswer(schema, { value: "1", nested: { label: "a" }, addedLater: true })).toBeUndefined();
    expect(readAnswer(schema, { value: 1, nested: {}, addedLater: true })).toBeUndefined();
    expect(readAnswer(schema, { value: 1, nested: { label: "a", addedLater: true } })).toEqual({ value: 1, nested: { label: "a", addedLater: true } });
  });
});
