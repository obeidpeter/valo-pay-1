import type { RecordDataOf, RecordKind } from "@workspace/valo-pay-1-schema";

/** A stored record; `data` is untyped here, and typed through TypedRecord once the kind is known. */
export interface ValopayRecord {
  id: string;
  merchantId: string;
  kind: string;
  name: string;
  status: string;
  reference: string;
  amountKobo: number;
  customerId: string;
  createdAt: string;
  updatedAt: string;
  data: Record<string, any>;
}

/**
 * A record read through a kind-aware helper (recordsOf, findRecord,
 * makeRecord): its data carries the fields the shared schema declares for
 * that kind, typed, and anything else reads as unknown.  Assignable to
 * ValopayRecord, so storage and generic code are unchanged.
 */
export type TypedRecord<K extends RecordKind> = Omit<ValopayRecord, "kind" | "data"> & { kind: K; data: RecordDataOf<K> };
/** The record type a kind argument yields: typed for a known kind, the stored shape for a kind only known as a string. */
export type RecordOf<K extends string> = K extends RecordKind ? TypedRecord<K> : ValopayRecord;
/** What makeRecord accepts: any stored field, and for a known kind that kind's data fields, all optional at creation. */
export type RecordInput<K extends string> = Partial<Omit<ValopayRecord, "kind" | "data">> & { data?: K extends RecordKind ? Partial<RecordDataOf<K>> : Record<string, any> };

/** A lender as the API returns it. */
export interface Merchant {
  id: string;
  name: string;
  shortName: string;
  segment: string;
  mode: string;
  status: string;
  provider: string;
  monthlyVolume: number;
  killSwitch: boolean;
  preDataReady: boolean;
  preLiveReady: boolean;
}

/** A lender's complete state as loaded for one transaction: the merchant, its settings and every record. */
export interface DomainState {
  merchant: Merchant;
  records: ValopayRecord[];
  settings: Record<string, any>;
}

/** Who is acting, in which role, and when (the database clock at the start of the transaction). */
export interface Context {
  actor: string;
  principalId?: string;
  role: string;
  now: string;
  /** A provisioned staff member ('staff'), or the anonymous sandbox's one person playing every role ('sandbox' or absent): second-person rules are enforced only for staff. */
  accessMode?: 'sandbox' | 'staff';
}

/** A named measurement for the overview and the reports. */
export interface Metric {
  key: string;
  label: string;
  value: number;
  unit: string;
  detail: string;
}

/** The reports answer: metrics, billing, the experiment, operational measurement and the closes. */
export interface Report {
  metrics: Metric[];
  billing: Record<string, any>;
  experiment: Record<string, any>;
  operational: Record<string, any>;
  closes: ValopayRecord[];
}

/** An action request: the action, the record it applies to, the reason and its data. */
export interface ActionInput {
  action: string;
  recordId?: string;
  reason?: string;
  data?: Record<string, any>;
}

/** What an action returns: a message, the record it produced or changed, and data. */
export interface ActionResult {
  message: string;
  record?: ValopayRecord;
  data: Record<string, any>;
}
