import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Server-owned identifiers; never take the scope from an encrypted payload. */
export interface FieldScope { tenantId: string; recordId: string; field: string }
/** Inject keys from a secret manager. Keep old versions available until migration and restore checks finish. */
export interface FieldKeyRing { activeKeyId: string; keys: ReadonlyMap<string, Uint8Array> }
export interface EncryptedField {
  version: 1;
  algorithm: 'A256GCM';
  keyId: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

const MAX_FIELD_BYTES = 16 * 1024;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const validKeyId = (value: unknown): value is string => typeof value === 'string' && KEY_ID.test(value);
export class FieldEncryptionError extends Error {
  constructor() { super('Protected details could not be saved or read. Contact the Valo Pay 1 team.'); this.name = 'FieldEncryptionError'; }
}
function fail(): never { throw new FieldEncryptionError(); }

function contextBytes(scope: FieldScope, keyId: string): Buffer {
  if (!validKeyId(keyId)) return fail();
  const parts = [scope?.tenantId, scope?.recordId, scope?.field];
  if (parts.some(value => typeof value !== 'string' || !value.trim() || value.length > 256)) return fail();
  // The array and fixed domain prevent concatenation ambiguity and use in a different feature.
  return Buffer.from(JSON.stringify(['valopay:protected-field', 1, 'A256GCM', keyId, ...parts]), 'utf8');
}

function keyBytes(ring: FieldKeyRing, keyId: string): Buffer {
  if (!validKeyId(keyId) || !(ring?.keys instanceof Map)) return fail();
  const value = ring.keys.get(keyId);
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) return fail();
  return Buffer.from(value);
}

function decode(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_FIELD_BYTES * 4 / 3) || !/^[A-Za-z0-9_-]*$/.test(value)) return fail();
  const result = Buffer.from(value, 'base64url');
  if (result.toString('base64url') !== value || (length !== undefined && result.byteLength !== length)) return fail();
  return result;
}

/** Versioned authenticated ciphertext. This helper does not enable real-data storage or migrate existing records. */
export function encryptField(plaintext: string, scope: FieldScope, ring: FieldKeyRing): EncryptedField {
  if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext, 'utf8') > MAX_FIELD_BYTES) return fail();
  const keyId = ring?.activeKeyId;
  const aad = contextBytes(scope, keyId);
  const key = keyBytes(ring, keyId);
  const clear = Buffer.from(plaintext, 'utf8');
  try {
    // Reject malformed Unicode instead of silently storing replacement
    // characters for an unpaired surrogate supplied in a JSON string.
    if (clear.toString('utf8') !== plaintext) return fail();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
    return { version: 1, algorithm: 'A256GCM', keyId, iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
  } catch { return fail(); }
  finally { key.fill(0); clear.fill(0); }
}

/** Rejects any change to the tenant, record, field, key id, IV, ciphertext or tag. Never falls back to plaintext. */
export function decryptField(value: unknown, scope: FieldScope, ring: FieldKeyRing): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const envelope = value as Partial<EncryptedField>;
  if (envelope.version !== 1 || envelope.algorithm !== 'A256GCM' || typeof envelope.keyId !== 'string') return fail();
  const aad = contextBytes(scope, envelope.keyId);
  const key = keyBytes(ring, envelope.keyId);
  let unverified: Buffer | undefined;
  let clear: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, decode(envelope.iv, 12), { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(decode(envelope.tag, 16));
    // Nothing is returned until final authenticates the complete field.
    unverified = decipher.update(decode(envelope.ciphertext));
    clear = Buffer.concat([unverified, decipher.final()]);
    return clear.toString('utf8');
  } catch { return fail(); }
  finally { key.fill(0); unverified?.fill(0); clear?.fill(0); }
}

/** Re-encrypts with the active version and a fresh IV; persist only after the caller's transaction succeeds. */
export function rotateField(value: unknown, scope: FieldScope, ring: FieldKeyRing): EncryptedField {
  return encryptField(decryptField(value, scope, ring), scope, ring);
}
