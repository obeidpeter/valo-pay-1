import { randomUUID } from "node:crypto";
import { notFoundText, recordTypeLabel, recordTypeTitle } from "@workspace/valopay-schema";
import type { DomainState, RecordInput, RecordOf, ValopayRecord } from "./types";

/** Keys that name a raw financial identifier, matched on snake_case word boundaries so "accountableUser" is not an account number. */
const forbiddenBankKey = /(^|_)(account_?(number|no|num)|bank_?account|nuban|iban|bvn|card_?(number|no|num)|pan)(_|$)/;
const digitRun = /\d[\d -]{6,}\d/;
/** Keys with a financial word, singular or plural, on the same word boundaries: "companyId" and "cardinality" are not financial. */
const financialKey = /(^|_)(bank|account|card|iban|bvn|nuban|pan)s?(_|$)/;
/** Record IDs are UUIDs; their hyphenated digit groups are not account or card numbers. */
const recordId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const snakeCase = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** Rejecting raw financial identifiers keeps this synthetic sandbox non-sensitive. */
export function assertNoRealBankDetails(value: unknown, key = ""): void {
  if (typeof value === "string") {
    const name = snakeCase(key);
    if (name.includes("masked")) return;
    if (forbiddenBankKey.test(name)) {
      throw new Error("Do not enter a full bank account number. Enter a masked number, for example •••• 1234.");
    }
    // Separators do not matter ("Account ID" is account_id), and record IDs are set aside before looking for a number.
    if (financialKey.test(name.replace(/[^a-z0-9]+/g, "_")) && digitRun.test(value.replace(recordId, "#"))) {
      throw new Error("Do not enter full account, card or BVN numbers. Mask them, for example •••• 1234.");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoRealBankDetails(item, key));
  } else if (value && typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => {
      assertNoRealBankDetails(child, childKey);
    });
  }
}

/**
 * A record by id, typed when the kind is a known literal; a kind given as a
 * string yields the stored shape. A record a request names that the lender
 * does not have is a 404, whether the path, an action's recordId or a linked
 * id in the body names it.
 */
export function findRecord<K extends string = string>(state: DomainState, id: string, kind?: K): RecordOf<K> {
  const record = state.records.find((item) => item.id === id && (!kind || item.kind === kind));
  if (!record) throw Object.assign(new Error(notFoundText(recordTypeLabel(kind))), { status: 404 });
  return record as RecordOf<K>;
}

/** Every record of a kind, typed when the kind is a known literal. */
export function recordsOf<K extends string>(state: DomainState, kind: K): RecordOf<K>[] {
  return state.records.filter((item) => item.kind === kind) as RecordOf<K>[];
}

export function touch(record: ValopayRecord, now: string): ValopayRecord {
  record.updatedAt = now;
  return record;
}

/** Creates and stores a record; for a known kind the data literal is checked against that kind's schema types and the result is typed. */
export function makeRecord<K extends string>(state: DomainState, kind: K, input: RecordInput<K>): RecordOf<K> {
  assertNoRealBankDetails(input);
  const timestamp = input.createdAt || new Date().toISOString();
  const record: ValopayRecord = {
    id: input.id || randomUUID(),
    merchantId: state.merchant.id,
    kind,
    name: input.name || recordTypeTitle(kind),
    status: input.status || "draft",
    reference: input.reference || `SYN-${kind}-${randomUUID().slice(0, 8)}`,
    amountKobo: Number.isInteger(input.amountKobo) ? Number(input.amountKobo) : 0,
    customerId: input.customerId || "",
    createdAt: timestamp,
    updatedAt: input.updatedAt || timestamp,
    data: { ...(input.data || {}), synthetic: true },
  };
  if (record.amountKobo < 0) throw new Error("Enter an amount of ₦0 or more.");
  state.records.push(record);
  return record as RecordOf<K>;
}

export function masked(value: unknown): boolean {
  return typeof value === "string" && (/[*xX•]/.test(value) || value.length <= 4);
}

/** A payload still sealed as stored (the store's envelope); the domain never opens one itself. */
export const isSealedPayload = (value: unknown): boolean => !!value && typeof value === "object" && "protectedPayload" in value;
/**
 * The store opens an import batch's protected source rows only for the views
 * that show or use them. A view that needs them and finds them sealed is a
 * route that forgot to open them: a server fault, never an empty or
 * "unavailable" answer a person might act on.
 */
export function assertSourceOpened(batch: ValopayRecord, fields: readonly string[]): void {
  if (fields.some((field) => isSealedPayload(batch.data[field]))) throw Object.assign(new Error("Protected source rows were not opened for this request."), { status: 500 });
}
