import { logger } from "./logger";
import { databaseLimitOf } from "./database-limits";
import { createPaystackTestAdapter } from "../providers/paystack";
import {
  paystackConnections,
  paystackTestSecretKey,
} from "../providers/paystack-ingress-config";
import {
  refuseVerification,
  verifyQueuedPaystackEvent,
  type PaystackVerificationOutcome,
  type PaystackVerificationTransaction,
} from "../providers/paystack-verification";

/** The repository, loaded once a check has its configuration: a refusal before then opens no database. */
let store: typeof import("./valopay-store") | undefined;
// Loading connects to nothing, so it fails only for missing settings, such as the database address.
const loadStore = async () =>
  (store ??= await import("./valopay-store").catch(() =>
    refuseVerification(
      "The database is not configured. Run the command with the API's database settings; nothing was checked.",
      503,
      "not_configured",
    ),
  ));
const configured = <T>(read: () => T): T => {
  try {
    return read();
  } catch (error) {
    // The ingress settings' own refusals are fixed words that name no value.
    return refuseVerification(
      error instanceof Error ? error.message : "Paystack test verification is not configured.",
      503,
      "not_configured",
    );
  }
};

/** Operator-only test evidence preparation. No HTTP route or background scheduler
 * calls this function. Configure a disabled synthetic lender before running it. */
export async function verifyStoredPaystackTestEvent(
  connectionId: string,
  eventId: string,
) {
  const secretKey = configured(paystackTestSecretKey);
  const mapping = configured(paystackConnections);
  const connection = Object.hasOwn(mapping, connectionId)
    ? mapping[connectionId]
    : undefined;
  if (!connection)
    refuseVerification("The test connection is not configured.", 404, "connection_not_mapped");
  const { appendAudit, inMerchantAsSystem, loadState, saveState, systemWorkspaceMatches } =
    await loadStore();
  const transact: PaystackVerificationTransaction = async (
    id,
    write,
    apply,
  ) => {
    const currentConfiguration = () => {
      let current: (typeof mapping)[string] | undefined;
      try {
        current = paystackTestSecretKey() === secretKey ? paystackConnections()[id] : undefined;
      } catch {
        current = undefined;
      }
      if (
        id !== connectionId ||
        !current ||
        current.workspaceId !== connection.workspaceId ||
        current.merchantId !== connection.merchantId
      )
        refuseVerification(
          "The test connection changed during verification. No provider result was applied.",
          409,
          "configuration_changed",
        );
    };
    currentConfiguration();
    const result = await inMerchantAsSystem(
      connection.merchantId,
      "System · Paystack test verification",
      async (ctx) => {
        if (!systemWorkspaceMatches(ctx, connection.workspaceId))
          refuseVerification("Paystack test connection is unavailable.", 403, "connection_unavailable");
        const state = await loadState(ctx, connection.merchantId, "update");
        currentConfiguration();
        const result = apply(state, ctx);
        if (write) {
          // The lender's audit trail names the finding, as the event's history does.
          const found = (result as { outcome?: unknown }).outcome;
          appendAudit(
            state,
            ctx,
            "paystack.test_verification",
            eventId,
            `An operator independently checked stored test evidence${typeof found === "string" ? ` (${found.replaceAll("_", " ")})` : ""}. No financial instruction was created.`,
          );
          await saveState(ctx, state);
        }
        return result;
      },
    );
    if (result === undefined)
      refuseVerification(
        "The mapped test lender is unavailable or busy. Check the same event later.",
        503,
        "lender_unavailable",
      );
    return result;
  };
  return verifyQueuedPaystackEvent({
    connectionId,
    eventId,
    transact,
    adapter: createPaystackTestAdapter({ secretKey }),
  });
}

/** What the command prints and logs: one named outcome, its exit status and a fixed message. */
export type PaystackVerificationReport = {
  result: PaystackVerificationOutcome;
  exitCode: 0 | 1 | 2;
  message: string;
  eventStatus?: string;
  observationCreated?: boolean;
  financialRecordsCreated: 0;
  instructions: "disabled";
};
/** Nothing to put right: check the same event again later. Any other outcome but verified needs the operator. */
const later: readonly PaystackVerificationOutcome[] = ["pending", "reference_not_found", "provider_unavailable", "invalid_response", "lender_unavailable", "database_unavailable"];
const named: readonly PaystackVerificationOutcome[] = [...later, "verified", "credentials_refused", "live_mode", "mismatch", "usage", "not_configured", "connection_not_mapped", "connection_unavailable", "configuration_changed", "lender_not_eligible", "event_not_found", "not_a_test_payment", "held_for_review", "check_limit_reached", "expectation_mismatch", "evidence_changed", "duplicate_observation", "observation_missing"];

/**
 * A check's result, or why it did not reach one, as its report: exit 0
 * verified; 2 not verified yet with nothing to put right (check the same event
 * later); 1 a problem the operator must fix or review first. An error that
 * names no outcome is `failed` (`database_unavailable` at a database limit),
 * and its own words, which may quote a setting, are never repeated.
 */
export function paystackVerificationReport(value: unknown): PaystackVerificationReport {
  const given = value && typeof value === "object" ? (value as { outcome?: unknown; message?: unknown; status?: unknown; observationCreated?: unknown }) : {};
  const outcome = named.find((item) => item === given.outcome);
  const result = outcome ?? (databaseLimitOf(value) ? "database_unavailable" : "failed");
  const message = outcome && typeof given.message === "string" ? given.message
    : result === "database_unavailable" ? "The database was unavailable or busy. Check the same event again later; a completed check is never repeated."
    : "The check could not be completed. Check the same event again; a completed check is never repeated and no instruction was sent.";
  // A result, unlike a refusal, says what became of the event.
  const recorded = !(value instanceof Error) && typeof given.status === "string";
  return {
    result,
    exitCode: result === "verified" ? 0 : later.includes(result) ? 2 : 1,
    message,
    ...(recorded ? { eventStatus: given.status as string, observationCreated: given.observationCreated === true } : {}),
    financialRecordsCreated: 0,
    instructions: "disabled",
  };
}

/** One line per run naming its outcome: never the key, the connection or event ID, or the payment's details. */
function logPaystackVerification(report: PaystackVerificationReport, merchantId?: string) {
  logger[report.exitCode === 0 ? "info" : "warn"](
    {
      event: "paystack.test_verification",
      outcome: report.result,
      exitCode: report.exitCode,
      ...(report.eventStatus ? { eventStatus: report.eventStatus, observationCreated: report.observationCreated } : {}),
      ...(merchantId ? { merchantId } : {}),
    },
    "Paystack saved-event verification finished",
  );
}

/** The command's arguments could not be used: reported and logged like any other run. */
export function paystackVerificationUsage(usage: string): PaystackVerificationReport {
  const report = paystackVerificationReport(Object.assign(new Error(usage), { outcome: "usage" }));
  logPaystackVerification(report);
  return report;
}

/** The command's check of one saved event: it never throws, logs one line naming its outcome and closes the database. */
export async function runPaystackEventVerification(
  connectionId: string,
  eventId: string,
): Promise<PaystackVerificationReport> {
  let report: PaystackVerificationReport;
  try {
    report = paystackVerificationReport(await verifyStoredPaystackTestEvent(connectionId, eventId));
  } catch (error) {
    report = paystackVerificationReport(error);
  } finally {
    await store?.closeDatabase().catch(() => {
      /* the outcome is already decided */
    });
  }
  let merchantId: string | undefined;
  try {
    const mapping = paystackConnections();
    if (Object.hasOwn(mapping, connectionId)) merchantId = mapping[connectionId]!.merchantId;
  } catch {
    merchantId = undefined;
  }
  logPaystackVerification(report, merchantId);
  return report;
}
