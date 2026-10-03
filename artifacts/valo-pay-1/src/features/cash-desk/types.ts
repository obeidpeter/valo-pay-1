import type { ConnectedView } from "@workspace/valo-pay-1-schema";

export type CashView = ConnectedView["cash"];
export type ForecastPoint = NonNullable<
  CashView["forecast"]
>["scenarios"][number]["points"][number];
/**
 * A Cash Desk action waiting in its dialog: the question it asks, what will
 * happen, and the button that does it, which says the same as the button
 * that opened the dialog.
 */
export type PendingAction = {
  action: string;
  title: string;
  detail: string;
  confirm: string;
  /** The confirm button's words while the action runs, repeating its verb. */
  busy: string;
  data?: Record<string, unknown>;
  recordId?: string;
};
export type ReviewAction = (action: PendingAction) => void;
/** Why this role cannot take an action, in the words every connected page uses. */
export type RoleRefusal = (roles: readonly string[], action: string) => string;
export type ForecastAssumptions = {
  downside: string;
  delay: string;
  buffer: string;
};
