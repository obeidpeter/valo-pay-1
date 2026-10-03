import { createHash } from "node:crypto";
import { z } from "zod";
import { sameJson } from "@workspace/valo-pay-1-schema";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const keyId = z.string().regex(/^projects\/[a-zA-Z0-9_-]+\/locations\/[a-zA-Z0-9_-]+\/keyRings\/[a-zA-Z0-9_-]+\/cryptoKeys\/[a-zA-Z0-9_-]+$/);
const origin = z.string().url().refine(value => { const url = new URL(value); return url.protocol === "https:" && url.origin === value && !url.username && !url.password; }, "Use an HTTPS origin without credentials or paths.");
/** Restoration requirements contain identifiers and policy only. Unknown properties (including credentials) are rejected. */
export const recoveryConfigurationSchema = z.object({
  schemaVersion: z.string().regex(/^\d{3}_[a-z0-9_]+$/),
  runtimeDatabaseRole: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  staffMode: z.literal("staging"), issuer: origin, origins: z.array(origin).min(1).max(20),
  encryptionKeyIds: z.array(keyId).min(1).max(20),
  privateObjectAccess: z.literal("authenticated_lender_scoped"),
  schedulerEnabled: z.literal(false), liveOperationsEnabled: z.literal(false),
}).strict();
/** One restored file must retain its lender, export identity, byte count, private access and checksum. */
export const recoveryObjectSchema = z.object({
  lenderId: z.string().min(1).max(100), exportId: z.string().min(1).max(100),
  storageKey: z.string().regex(/^exports\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.(json|csv|pdf)$/),
  checksum: hash, byteLength: z.number().int().min(0).max(32*1024*1024), private: z.literal(true),
}).strict().refine(object => object.storageKey.startsWith(`exports/${object.lenderId}/${object.exportId}.`), "Object identity and private storage key must agree.");
/** Independently protected manifest joins a logical database snapshot to private objects and required access/key configuration. */
export const recoveryManifestSchema = z.object({
  version: z.literal(2), snapshotAt: z.string().datetime(),
  database: z.object({ checksum: hash, byteLength: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict(),
  configuration: recoveryConfigurationSchema,
  objects: z.array(recoveryObjectSchema).max(100000),
}).strict().refine(value => new Set(value.objects.map(object => object.storageKey)).size === value.objects.length, "Every private object must appear once.");
export type RecoveryConfiguration = z.infer<typeof recoveryConfigurationSchema>;
export type RecoveryManifest = z.infer<typeof recoveryManifestSchema>;
export type RecoveryObject = z.infer<typeof recoveryObjectSchema>;
/** SHA-256 and length are computed from the exact restored bytes. */
export function recoveryBytes(bytes: Uint8Array) { return { checksum: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength }; }
/** Fail closed before the restored app is started. Callers supply measured bytes/inventory and independently reviewed target configuration. */
export function verifyRecoveryManifest(raw: unknown, databaseBytes: Uint8Array, restoredObjects: RecoveryObject[], targetConfiguration: RecoveryConfiguration) {
  const manifest = recoveryManifestSchema.parse(raw), configuration = recoveryConfigurationSchema.parse(targetConfiguration);
  if (!sameJson(recoveryBytes(databaseBytes), manifest.database)) throw new Error("The restored database backup does not match its recovery manifest.");
  const normaliseConfig = (config: RecoveryConfiguration) => ({ ...config, origins: [...config.origins].sort(), encryptionKeyIds: [...config.encryptionKeyIds].sort() });
  if (!sameJson(normaliseConfig(configuration), normaliseConfig(manifest.configuration))) throw new Error("The restored access, key or schema configuration does not match the reviewed recovery requirements.");
  const objects = restoredObjects.map(object => recoveryObjectSchema.parse(object)).sort((a,b)=>a.storageKey.localeCompare(b.storageKey));
  if (!sameJson(objects, [...manifest.objects].sort((a,b)=>a.storageKey.localeCompare(b.storageKey)))) throw new Error("A private evidence object is missing, changed, public or assigned to another lender.");
  return { verified: true as const, objects: objects.length, snapshotAt: manifest.snapshotAt, configurationVerified: true as const };
}
