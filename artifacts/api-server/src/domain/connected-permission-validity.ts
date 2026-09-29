/** Shared time/version validity only. Each capability must still bind the
 * tenant, entity, subject, purpose and exact grant used by its own workflow. */
export function permissionActive(permission: {
  status: string;
  validFrom: unknown;
  expiresAt: unknown;
  version: unknown;
}, now: string): boolean {
  const at = Date.parse(now);
  return permission.status === "active"
    && Date.parse(String(permission.validFrom)) <= at
    && Date.parse(String(permission.expiresAt)) > at
    && Number.isSafeInteger(permission.version)
    && Number(permission.version) > 0;
}
