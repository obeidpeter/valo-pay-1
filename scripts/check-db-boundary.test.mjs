import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectDatabaseBoundaries } from "./check-db-boundary.mjs";

const temporary = await mkdtemp(
  path.join(os.tmpdir(), "valopay-repository-boundary-"),
);
const cases = [
  [
    "route import",
    "routes/probe.ts",
    "import { sessionFor } from '../lib/repository/core';",
  ],
  [
    "route re-export",
    "routes/probe.ts",
    "export { sessionFor } from '../lib/repository/core';",
  ],
  [
    "dynamic import",
    "routes/probe.ts",
    "void import('../lib/repository/core.js');",
  ],
  ["require", "routes/probe.ts", "require('../lib/repository/core');"],
  [
    "import equals",
    "routes/probe.ts",
    "import internal = require('../lib/repository/core');",
  ],
  [
    "type import",
    "routes/probe.ts",
    "import type { Session } from '../lib/repository/types';",
  ],
  [
    "import type query",
    "routes/probe.ts",
    "type Internal = typeof import('../lib/repository/core');",
  ],
  [
    "normalised relative path",
    "routes/probe.ts",
    "import { sessionFor } from '../lib/repository/../repository/core.js';",
  ],
  [
    "facade wildcard",
    "lib/valopay-store.ts",
    "export * from './repository/core';",
  ],
  [
    "facade raw capability",
    "lib/valopay-store.ts",
    "export { sessionFor } from './repository/core';",
  ],
  [
    "facade renamed capability",
    "lib/valopay-store.ts",
    "export { sessionFor as saveState } from './repository/core';",
  ],
  [
    "facade client construction",
    "lib/valopay-store.ts",
    "export const rawClient = {};",
  ],
  [
    "unreviewed internal module",
    "lib/repository/unreviewed.ts",
    "import { pool } from '@workspace/db'; pool.query('SELECT 1');",
  ],
  [
    "feature runtime cycle",
    "lib/repository/journal.ts",
    "import { sessionFor } from './core';",
  ],
  [
    "direct external database",
    "routes/probe.ts",
    "import { pool } from '@workspace/db';",
  ],
  [
    "dynamic external database",
    "routes/probe.ts",
    "void import('@workspace/db');",
  ],
];
try {
  for (const [index, [name, file, source]] of cases.entries()) {
    const root = path.join(temporary, String(index));
    const filename = path.join(root, "artifacts/api-server/src", file);
    await mkdir(path.dirname(filename), { recursive: true });
    await mkdir(path.join(root, "lib"), { recursive: true });
    await writeFile(filename, source);
    const { violations } = await inspectDatabaseBoundaries(root);
    assert.ok(
      violations.length,
      `${name} must not bypass the private repository boundary`,
    );
  }
  const permitted = path.join(temporary, "permitted");
  const files = {
    "lib/valopay-store.ts":
      "export { loadState, saveState } from './repository/core'; export type { StoreContext } from './repository/types';",
    "lib/repository/core.ts":
      "import { pool } from '@workspace/db'; import { createJournalRepository } from './journal'; pool.query('SELECT 1');",
    "lib/repository/journal.ts":
      "type Core = Pick<typeof import('./core'), 'sessionFor'>; export function createJournalRepository(core: Core) { return core; }",
    "routes/probe.ts": "import { loadState } from '../lib/valopay-store';",
  };
  for (const [file, source] of Object.entries(files)) {
    const filename = path.join(permitted, "artifacts/api-server/src", file);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, source);
  }
  await mkdir(path.join(permitted, "lib"), { recursive: true });
  assert.deepEqual(
    (await inspectDatabaseBoundaries(permitted)).violations,
    [],
    "The explicit facade and typed core composition remain permitted",
  );
  console.log(
    `Repository boundary fixtures passed (${cases.length} refusals and the permitted composition): private capabilities, facade exports, relative paths and database imports.`,
  );
} finally {
  assert.equal(
    path.dirname(path.resolve(temporary)),
    path.resolve(os.tmpdir()),
  );
  await rm(temporary, { recursive: true, force: true });
}
