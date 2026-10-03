/** Shared by the development-only HTTP probes. Never guesses a deployed environment. */
export function probeSandboxCookieName(env = process.env) {
  const deployed = env.NODE_ENV === "production" || Boolean(env.REPLIT_DEPLOYMENT && env.REPLIT_DEPLOYMENT !== "0");
  const environment = env.VALO_PAY_1_ENVIRONMENT || (deployed ? undefined : "development");
  if (!["development", "test", "staging", "production"].includes(environment)) throw new Error("Set VALO_PAY_1_ENVIRONMENT explicitly to the target's deployment environment before running a sandbox probe.");
  return `__Host-valo-pay-1_${environment}_sandbox`;
}
