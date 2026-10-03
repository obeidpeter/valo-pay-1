import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';

const keyName = /^projects\/[a-zA-Z0-9_-]+\/locations\/[a-zA-Z0-9_-]+\/keyRings\/[a-zA-Z0-9_-]+\/cryptoKeys\/[a-zA-Z0-9_-]+$/;
const envelopeSchema = z.object({ protectedPayload: z.literal(1), key: z.string().regex(keyName), wrappedKey: z.string().min(1).max(20000), iv: z.string().length(16), tag: z.string().length(24), ciphertext: z.string().max(12000000) }).strict();
export interface WrappingKeyProvider { wrap(key: string, dataKey: Buffer, aad: Buffer): Promise<Buffer>; unwrap(key: string, wrappedKey: Buffer, aad: Buffer): Promise<Buffer>; }
export interface PayloadScope { lender: string; record: string; field: string; }
const unavailable = (): never => { throw Object.assign(new Error('Protected data cannot be opened. Contact the Valo Pay 1 team.'), { status: 503 }); };
const aadFor = (scope: PayloadScope) => Buffer.from(JSON.stringify(['valopay', 1, scope.lender, scope.record, scope.field]));
/** The bytes of canonical base64 text of exactly `bytes` bytes, else undefined: Node's decoder skips stray characters and stops at padding, so the text's length proves nothing. */
const exactBase64 = (text: string, bytes: number): Buffer | undefined => {
  const decoded = Buffer.from(text, 'base64');
  return decoded.length === bytes && decoded.toString('base64') === text ? decoded : undefined;
};
export const isProtectedPayload = (value: unknown): boolean => !!value && typeof value === 'object' && 'protectedPayload' in value;

/** Data keys live only for one operation. Managed KMS wraps them; the database
 * holds ciphertext and key identifiers, never a plaintext master/data key. */
export async function sealPayload(value: unknown, scope: PayloadScope, key: string, provider: WrappingKeyProvider) {
  if (!keyName.test(key)) return unavailable();
  const plaintext = Buffer.from(JSON.stringify(value)), aad = aadFor(scope);
  if (plaintext.length > 8 * 1024 * 1024) throw new Error('This file is too large to store securely. Use a smaller file.');
  const dataKey = randomBytes(32), iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv, { authTagLength: 16 }); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrapped = await provider.wrap(key, dataKey, aad);
    return envelopeSchema.parse({ protectedPayload: 1, key, wrappedKey: wrapped.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
  } finally { dataKey.fill(0); plaintext.fill(0); }
}
export async function openPayload(value: unknown, scope: PayloadScope, provider: WrappingKeyProvider): Promise<any> {
  let dataKey: Buffer | undefined, plaintext: Buffer | undefined;
  try {
    const sealed = envelopeSchema.parse(value), aad = aadFor(scope);
    // GCM takes any IV length, and a tag as short as 4 bytes unless its length is fixed: a shortened tag checks only its own bytes.
    const iv = exactBase64(sealed.iv, 12), tag = exactBase64(sealed.tag, 16);
    if (!iv || !tag) return unavailable();
    dataKey = await provider.unwrap(sealed.key, Buffer.from(sealed.wrappedKey, 'base64'), aad);
    if (dataKey.length !== 32) return unavailable();
    const decipher = createDecipheriv('aes-256-gcm', dataKey, iv, { authTagLength: 16 }); decipher.setAAD(aad); decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch { return unavailable(); } finally { dataKey?.fill(0); plaintext?.fill(0); }
}
export function payloadEncryptionKey(): string | undefined {
  const mode = process.env.VALO_PAY_1_PAYLOAD_ENCRYPTION;
  if (!mode || mode === 'off') return undefined;
  if (mode !== 'kms' || !keyName.test(process.env.VALO_PAY_1_KMS_KEY || '')) return unavailable();
  return process.env.VALO_PAY_1_KMS_KEY!;
}
let auth: GoogleAuth | undefined;
export const managedWrappingKeys: WrappingKeyProvider = {
  async wrap(key, dataKey, aad) { return kms('encrypt', key, { plaintext: dataKey.toString('base64'), additionalAuthenticatedData: aad.toString('base64') }, 'ciphertext'); },
  async unwrap(key, wrappedKey, aad) { return kms('decrypt', key, { ciphertext: wrappedKey.toString('base64'), additionalAuthenticatedData: aad.toString('base64') }, 'plaintext'); },
};
async function kms(action: 'encrypt' | 'decrypt', key: string, data: Record<string, string>, field: 'ciphertext' | 'plaintext') {
  if (!keyName.test(key)) return unavailable();
  // Historical envelopes can name a prior wrapping key only when explicitly
  // retained in the operator's allowlist. Arbitrary URLs/keys are never fetched.
  const allowed = [payloadEncryptionKey(), ...(process.env.VALO_PAY_1_KMS_PREVIOUS_KEYS || '').split(',').map(v => v.trim())];
  if (!allowed.includes(key)) return unavailable();
  try {
    auth ||= new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloudkms'] });
    const client = await auth.getClient();
    const response = await client.request<Record<string, string>>({ url: `https://cloudkms.googleapis.com/v1/${key}:${action}`, method: 'POST', data, timeout: 10000, retry: false });
    const encoded = response.data[field];
    if (typeof encoded !== 'string' || encoded.length > 20000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return unavailable();
    return Buffer.from(encoded, 'base64');
  } catch { return unavailable(); }
}
export async function protectStored(value: unknown, scope: PayloadScope) { const key = payloadEncryptionKey(); return key ? sealPayload(value, scope, key, managedWrappingKeys) : value; }
export async function revealStored(value: unknown, scope: PayloadScope):Promise<any> { return isProtectedPayload(value) ? openPayload(value, scope, managedWrappingKeys) : value; }
/** The import-batch fields that hold raw source rows: the original CSV and the validation check with its preview. */
export const PROTECTED_IMPORT_FIELDS = ['csv', 'check'] as const;
export type ProtectedImportField = typeof PROTECTED_IMPORT_FIELDS[number];
type StoredRecord = { id: string; merchantId: string; kind: string; data: Record<string, any> };
/** Seals an import batch's plaintext fields for storage. A field still sealed as it was loaded is kept as stored, never sealed again. */
export async function protectRecordData(record: StoredRecord) {
  if (record.kind !== 'import-batches') return record.data;
  const data = {...record.data};
  for (const field of PROTECTED_IMPORT_FIELDS) if (data[field] !== undefined && !isProtectedPayload(data[field])) data[field] = await protectStored(data[field], { lender:record.merchantId,record:record.id,field });
  return data;
}
/**
 * Opens the named fields of import batches, returning copies in input order.
 * Every field has its own data key, so each sealed field is one key-service
 * call: at most `limit` run at once, and after one fails no other starts. A
 * field already open costs nothing.
 */
export async function revealRecordsData<T extends StoredRecord>(records: readonly T[], fields: readonly ProtectedImportField[] = PROTECTED_IMPORT_FIELDS, limit = 4): Promise<T[]> {
  const opened = records.map(record => record.kind === 'import-batches' ? { ...record, data: { ...record.data } } : record);
  const tasks = opened.flatMap(record => record.kind === 'import-batches' ? fields.filter(field => isProtectedPayload(record.data[field])).map(field => ({ record, field })) : []);
  let next = 0, failed = false;
  const worker = async () => {
    while (!failed && next < tasks.length) {
      const { record, field } = tasks[next++]!;
      try { record.data[field] = await revealStored(record.data[field], { lender: record.merchantId, record: record.id, field }); }
      catch (error) { failed = true; throw error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), tasks.length) }, worker));
  return opened;
}
