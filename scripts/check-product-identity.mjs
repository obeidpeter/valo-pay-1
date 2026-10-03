// A source regression guard, not evidence that provider-controlled resources were migrated.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const legacyPattern = /\bValo Pay(?! 1\b)|\bValoPay(?!1)[A-Za-z0-9_]*|\bvaloPay(?!1)[A-Za-z0-9_]*|\bValopay[A-Za-z0-9_]*|\bvalo-pay(?!-1(?:\b|_))[A-Za-z0-9_./:-]*|\bvalopay[A-Za-z0-9_./:-]*|\bvalo_pay(?!_1(?:\b|_))[A-Za-z0-9_]*|\bVALOPAY_[A-Z0-9_]+/g;
export const duplicateGeneration = new RegExp('\\b(?:' + [ ['Valo', 'Pay', '1', '1'].join(' '), ['valo', 'pay', '1', '1'].join('-'), ['valo', 'pay', '1', '1'].join('_'), 'ValoPay' + '11', 'valoPay' + '11' ].join('|') + ')\\b');
export const canonicalText = text => text.replaceAll('\r\n', '\n');
export const digest = text => createHash('sha256').update(canonicalText(text)).digest('hex');
export function identityOccurrences(path, text) {
  const result = [];
  for (const [index, line] of canonicalText(text).split('\n').entries()) {
    for (const match of line.matchAll(legacyPattern)) result.push({ path, line: index + 1, lineSha256: digest(line), token: match[0] });
  }
  return result;
}
export function unapprovedOccurrences(path, text, exceptions = []) {
  const remaining = new Map(exceptions.filter(item => item.path === path && item.kind === 'content').map(item => [`${item.lineSha256}:${item.token}`, item.count]));
  return identityOccurrences(path, text).filter(item => {
    const key = `${item.lineSha256}:${item.token}`, available = remaining.get(key) ?? 0;
    if (available > 0) { remaining.set(key, available - 1); return false; }
    return true;
  });
}

export function checkIdentity(root = resolve(import.meta.dirname, '..')) {
  const read = path => readFileSync(resolve(root, path), 'utf8');
  const manifest = JSON.parse(read('product-identity.json'));
  assert.equal(manifest.applicationId, 'valo-pay-1');
  assert.equal(manifest.displayName, 'Valo Pay 1');
  assert.equal(manifest.identifiers.environmentPrefix, 'VALO_PAY_1_');
  assert.equal(manifest.repository.id, '1374783064');
  assert.equal(manifest.repository.owner, 'obeidpeter');
  assert.equal(manifest.repository.canonicalName, manifest.applicationId);
  assert.equal(manifest.hosting.applicationId, 'da98915e-a44c-4f6e-af96-a37614f3a217');
  const backendIdentity = read('artifacts/api-server/src/lib/product-identity.ts');
  assert.equal(backendIdentity.match(/export const APPLICATION_ID = "([^"]+)"/)?.[1], manifest.applicationId, 'Backend identity must match the release manifest');
  assert.equal(backendIdentity.match(/export const RETAINED_REPLIT_ID = "([^"]+)"/)?.[1], manifest.hosting.applicationId, 'Backend deployment binding must match the retained app');
  const browserIdentity = read('artifacts/valo-pay-1/src/lib/browser-identity.ts');
  assert.equal(browserIdentity.match(/export const BROWSER_PRODUCT_ID = '([^']+)'/)?.[1], manifest.applicationId, 'Browser storage identity must match the release manifest');
  assert.equal(JSON.parse(read('package.json')).name, manifest.applicationId);
  assert.deepEqual(manifest.environments, ['development', 'test', 'staging', 'production']);
  const ports = Object.values(manifest.ports);
  assert(ports.every(port => Number.isInteger(port) && port > 1024 && port < 65536));
  assert.equal(new Set(ports).size, ports.length, 'Local services must use distinct ports');
  const history = JSON.parse(read('docs/product-identity/historical-files.json'));
  const oldPackages = Object.keys(JSON.parse(read('docs/product-identity/path-map.json')).packages);
  const policy = JSON.parse(read('docs/product-identity/identity-exceptions.json'));
  assert.equal(policy.schemaVersion, 1);
  for (const item of policy.exceptions) {
    assert(item.reason?.length > 12 && ['content', 'path'].includes(item.kind), 'Every exact exception needs its justification');
    assert(existsSync(resolve(root, item.path)), `Obsolete exception path: ${item.path}`);
    if (item.kind === 'content') {
      assert(/^[a-f0-9]{64}$/.test(item.lineSha256));
      assert(Number.isSafeInteger(item.count) && item.count > 0);
    }
    if (item.temporary) assert(item.removalCondition?.length > 12, 'A temporary exception needs a removal condition');
  }
  const immutable = new Set();
  for (const item of [...history.files, ...history.appliedMigrationFiles]) {
    assert.equal(digest(read(item.path)), item.sha256, `Historical evidence changed: ${item.path}`);
    immutable.add(item.path);
  }
  const appendOnly = new Map(history.appendOnlyDocuments.map(item => [item.path, item]));
  // These four structured inventories deliberately contain old/future identities. They are the reviewed policy,
  // not first-party application consumers; all other documents and configuration are scanned normally.
  const inventories = new Set(['product-identity.json', 'docs/product-identity/identity-exceptions.json', 'docs/product-identity/historical-files.json', 'docs/product-identity/path-map.json']);
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const problems = [];
  for (const path of files) {
    if (!existsSync(resolve(root, path))) { problems.push(`${path}: tracked path missing`); continue; }
    if (legacyPattern.test(path) && !policy.exceptions.some(item => item.kind === 'path' && item.path === path)) problems.push(`${path}: unversioned filename`);
    legacyPattern.lastIndex = 0;
    if (immutable.has(path) || inventories.has(path)) continue;
    let text = read(path);
    if (appendOnly.has(path)) {
      const item = appendOnly.get(path), normalized = Buffer.from(canonicalText(text));
      const suffix = normalized.subarray(normalized.length - item.byteLength).toString('utf8');
      assert.equal(digest(suffix), item.sha256, `Historical release chronology changed: ${path}`);
      text = normalized.subarray(0, normalized.length - item.byteLength).toString('utf8');
    }
    if (duplicateGeneration.test(text)) problems.push(`${path}: repeated generation suffix`);
    const unescaped = text.replaceAll('\\/', '/');
    for (const oldPackage of oldPackages) {
      const at = unescaped.indexOf(oldPackage);
      if (at >= 0 && !/[A-Za-z0-9_-]/.test(unescaped[at + oldPackage.length] || '') && !path.startsWith('docs/product-identity/')) problems.push(`${path}: obsolete owned package ${oldPackage}`);
    }
    problems.push(...unapprovedOccurrences(path, text, policy.exceptions).map(item => `${path}:${item.line}: unapproved legacy reference ${item.token}`));
  }
  if (problems.length) throw new Error(problems.join('\n'));
  console.log(`Product identity: ${files.length} tracked files checked; historical evidence, applied migrations and exact compatibility exceptions verified.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) checkIdentity();
