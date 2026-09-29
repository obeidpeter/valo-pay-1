import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { inspectEffectBoundaries } from './check-effect-boundaries.mjs';

const fixture = mkdtempSync(join(tmpdir(), 'valopay-effect-boundary-'));
const prefix = 'artifacts/api-server/src/';
const write = (path, text) => { const full = join(fixture, prefix, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, text); };
const refused = (source, pattern) => { write('domain/example.ts', source); assert.match(inspectEffectBoundaries(fixture).issues.join('\n'), pattern); };
try {
  write('domain/example.ts', 'import { createHash } from "node:crypto"; export const fingerprint = createHash;');
  assert.deepEqual(inspectEffectBoundaries(fixture).issues, []);
  refused('import "node:https";', /Effect-capable/);
  refused('import client = require("pg");', /Effect-capable/);
  refused('export { request } from "undici";', /Effect-capable/);
  refused('const send = fetch; send("https://example.invalid");', /Network APIs/);
  refused('globalThis["fetch"]("https://example.invalid");', /Computed network/);
  refused('globalThis[`fetch`]("https://example.invalid");', /Computed network/);
  refused('const key = process.env.SECRET;', /ambient credentials/);
  refused('const key = process["env"]["SECRET"];', /Computed process/);
  refused('import(name);', /Dynamic imports/);
  refused('import(`pg`);', /Dynamic imports/);
  refused('const code = new Function("return 1");', /Dynamic code/);
  write('lib/helper.ts', 'import "node:fs";');
  refused('import "../lib/helper";', /Effect-capable/);
  write('lib/helper.ts', 'export const pure = 1;');
  write('domain/example.ts', 'import "../lib/helper";');
  assert.deepEqual(inspectEffectBoundaries(fixture).issues, []);
  write('providers/read-only.ts', 'export const read = 1;');
  refused('import "../providers/read-only";', /cannot depend on a provider/);
  write('domain/example.ts', 'export const pure = 1;');
  write('domain/connected-cash.ts', 'export const payroll = 1;');
  write('domain/connected-credit.ts', 'import { payroll } from "./connected-cash";');
  assert.match(inspectEffectBoundaries(fixture).issues.join('\n'), /Credit computation cannot import/);
  // Visit records through an ordinary root first, then through credit. Its
  // generic purity visit cannot waive credit's transitive workflow boundary.
  write('domain/aaa.ts', 'import "./records";');
  write('domain/records.ts', 'export { payroll } from "./connected-cash";');
  write('domain/connected-credit.ts', 'import { payroll } from "./records";');
  const transitive = inspectEffectBoundaries(fixture).issues.join('\n');
  assert.match(transitive, /records\.ts:1: Credit computation cannot import/);
  assert.match(transitive, /via .*connected-credit\.ts -> .*records\.ts/);
  write('domain/records.ts', 'export const pure = 1;');
  assert.deepEqual(inspectEffectBoundaries(fixture).issues, []);
  write('domain/connected-credit.ts', 'import type { Payroll } from "./types";');
  assert.deepEqual(inspectEffectBoundaries(fixture).issues, []);
  // Reconciliation's two branches may depend on the same plain records module.
  // This diamond must not be mistaken for a cycle by the visited-file cache.
  write('domain/reconciliation.ts', 'import "./reconciliation-matching"; import "./reconciliation-payments"; export type Result = number; export const reconcile = () => 1;');
  write('domain/reconciliation-matching.ts', 'import "./reconciliation-records";');
  write('domain/reconciliation-payments.ts', 'export { record } from "./reconciliation-records";');
  write('domain/reconciliation-records.ts', 'export const record = 1;');
  assert.deepEqual(inspectEffectBoundaries(fixture).issues, []);
  // A helper re-exporting its coordinator closes a real runtime cycle. The
  // diagnostic identifies the closing edge and full cycle for CI readers;
  // which edge closes first depends on filesystem traversal order.
  write('domain/reconciliation-records.ts', 'export const record = 1;\nexport * from "./reconciliation";');
  const circular = inspectEffectBoundaries(fixture).issues.join('\n');
  assert.match(circular, /(?:reconciliation(?:-(?:matching|payments))?\.ts:1|reconciliation-records\.ts:2): Circular runtime dependency:/);
  assert.match(circular, /reconciliation-matching\.ts -> .*reconciliation-records\.ts -> .*reconciliation\.ts -> .*reconciliation-matching\.ts|reconciliation\.ts -> .*reconciliation-matching\.ts -> .*reconciliation-records\.ts -> .*reconciliation\.ts|reconciliation-records\.ts -> .*reconciliation\.ts -> .*reconciliation-matching\.ts -> .*reconciliation-records\.ts/);
  write('domain/reconciliation-records.ts', 'export const record = 1; import type { Result } from "./reconciliation";');
  assert.deepEqual(inspectEffectBoundaries(fixture).issues, []);
  write('domain/reconciliation-records.ts', 'export const record = 1; export { type Result } from "./reconciliation";');
  assert.deepEqual(inspectEffectBoundaries(fixture).issues, []);
  write('domain/reconciliation-records.ts', 'export const record = 1; export type { Result } from "./reconciliation";');
  assert.deepEqual(inspectEffectBoundaries(fixture).issues, []);
  // A mixed re-export retains its value dependency even when it includes types.
  write('domain/reconciliation-records.ts', 'export const record = 1; export { type Result, reconcile } from "./reconciliation";');
  assert.match(inspectEffectBoundaries(fixture).issues.join('\n'), /Circular runtime dependency:/);
  write('domain/reconciliation-records.ts', 'export const record = 1; export {} from "./reconciliation";');
  assert.match(inspectEffectBoundaries(fixture).issues.join('\n'), /Circular runtime dependency:/);
  write('domain/reconciliation-records.ts', 'import "./reconciliation-records";');
  assert.match(inspectEffectBoundaries(fixture).issues.join('\n'), /reconciliation-records\.ts:1: Circular runtime dependency: .*reconciliation-records\.ts -> .*reconciliation-records\.ts/);
  console.log('Effect-boundary mutation fixtures passed: direct/transitive imports, re-exports, ambient keys, dynamic code, network aliases, credit isolation and cycle detection with shared acyclic dependencies.');
} finally { rmSync(fixture, { recursive: true, force: true }); }
