/**
 * Stable provider namespace used by source-event and settlement identities.
 * ASCII letters and surrounding spaces are normalised identically by JavaScript
 * and PostgreSQL (translate/btrim), without depending on the database locale.
 * Other Unicode characters remain exact identifiers.
 */
export const providerConnectionKey = (value: string): string => value.replace(/^ +| +$/g, "").replace(/[A-Z]/g, letter => letter.toLowerCase());

/** Explicit connection wins over provider name; unlabelled historical evidence has its own empty namespace. */
export function observationProviderKey(data: Record<string, unknown>): string {
  return providerConnectionKey(typeof data.providerConnection === 'string' ? data.providerConnection : '') || providerConnectionKey(typeof data.provider === 'string' ? data.provider : '');
}

/** A provider delivery is unique within its lender, connection and delivery channel, not globally by event ID. */
export function observationEventKey(data: Record<string, unknown>): string | undefined {
  if (data.eventId === undefined || data.eventId === null) return undefined;
  return JSON.stringify([observationProviderKey(data), String(data.source ?? ''), String(data.eventId)]);
}

/** A settlement batch identity (providerIdentityKey, providerIdentityReview.identities) as its parts: the connection, compared without case or surrounding spaces, and the batch reference; undefined for any other value. */
export function providerIdentityParts(identity: unknown): { connection: string; batchReference: string } | undefined {
  try {
    const parts: unknown = JSON.parse(String(identity));
    return Array.isArray(parts) && parts.length === 2 && typeof parts[0] === "string" && typeof parts[1] === "string" ? { connection: parts[0], batchReference: parts[1] } : undefined;
  } catch {
    return undefined;
  }
}
