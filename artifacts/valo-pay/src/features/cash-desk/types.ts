import type { ConnectedView } from "@workspace/valopay-schema";

export type CashView = ConnectedView["cash"];
export type ForecastPoint = NonNullable<
  CashView["forecast"]
>["scenarios"][number]["points"][number];
export type PendingAction = {
  action: string;
  title: string;
  detail: string;
  data?: Record<string, unknown>;
  recordId?: string;
};
export type ReviewAction = (action: PendingAction) => void;
export type ForecastAssumptions = {
  downside: string;
  delay: string;
  buffer: string;
};
