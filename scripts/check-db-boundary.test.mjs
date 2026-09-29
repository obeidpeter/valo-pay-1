import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectDatabaseBoundaries } from "./check-db-boundary.mjs";

const temporary = await mkdtemp(
  path.join(os.tmpdir(), "valopay-repository-boundary-"),
);
// Each fixture is refused by the rule it exercises and by no other, so a rule
// that stopped firing cannot hide behind another one.
const rule = {
  facadeWildcard:
    "The public repository facade may only explicitly re-export reviewed entrypoints.",
  facadeCapability:
    "An internal repository capability cannot be exposed by the public facade.",
  facadeStatement:
    "The public repository facade must contain explicit re-exports only.",
  internal: "Repository internals are private; use the valopay-store facade.",
  unreviewed:
    "This repository module has not been reviewed for database access.",
  cycle:
    "Feature modules receive core capabilities through composition; importing core at runtime creates a cycle.",
  databaseImport: "Database imports belong only in the scoped repository.",
  databaseImportEquals:
    "Database import-equals declarations belong only in the scoped repository.",
  dynamicDatabase: "Dynamic database imports bypass the scoped repository.",
  rawQuery: "Raw query calls belong only in the scoped repository.",
  connection: "Database connection settings belong only in the repository.",
};
const cases = [
  [
    "route import",
    "routes/probe.ts",
    "import { sessionFor } from '../lib/repository/core';",
    [rule.internal],
  ],
  [
    "route re-export",
    "routes/probe.ts",
    "export { sessionFor } from '../lib/repository/core';",
    [rule.internal],
  ],
  [
    "dynamic import",
    "routes/probe.ts",
    "void import('../lib/repository/core.js');",
    [rule.internal],
  ],
  [
    "require",
    "routes/probe.ts",
    "require('../lib/repository/core');",
    [rule.internal],
  ],
  [
    "import equals",
    "routes/probe.ts",
    "import internal = require('../lib/repository/core');",
    [rule.internal],
  ],
  [
    "type import",
    "routes/probe.ts",
    "import type { Session } from '../lib/repository/types';",
    [rule.internal],
  ],
  [
    "import type query",
    "routes/probe.ts",
    "type Internal = typeof import('../lib/repository/core');",
    [rule.internal],
  ],
  [
    "normalised relative path",
    "routes/probe.ts",
    "import { sessionFor } from '../lib/repository/../repository/core.js';",
    [rule.internal],
  ],
  [
    "facade wildcard",
    "lib/valopay-store.ts",
    "export * from './repository/core';",
    [rule.facadeWildcard],
  ],
  [
    "facade raw capability",
    "lib/valopay-store.ts",
    "export { sessionFor } from './repository/core';",
    [rule.facadeCapability],
  ],
  [
    "facade renamed capability",
    "lib/valopay-store.ts",
    "export { sessionFor as saveState } from './repository/core';",
    [rule.facadeCapability],
  ],
  [
    "facade client construction",
    "lib/valopay-store.ts",
    "export const rawClient = {};",
    [rule.facadeStatement],
  ],
  [
    "unreviewed internal module",
    "lib/repository/unreviewed.ts",
    "import { pool } from '@workspace/db'; pool.query('SELECT 1');",
    [rule.databaseImport, rule.rawQuery],
  ],
  [
    "core importing an unreviewed module",
    "lib/repository/core.ts",
    "import { helper } from './unreviewed';",
    [rule.unreviewed],
  ],
  [
    "facade re-exporting an unreviewed module",
    "lib/valopay-store.ts",
    "export { loadState } from './repository/unreviewed';",
    [rule.unreviewed],
  ],
  [
    "feature runtime cycle",
    "lib/repository/journal.ts",
    "import { sessionFor } from './core';",
    [rule.cycle],
  ],
  [
    "direct external database",
    "routes/probe.ts",
    "import { pool } from '@workspace/db';",
    [rule.databaseImport],
  ],
  [
    "external database import equals",
    "routes/probe.ts",
    "import database = require('@workspace/db');",
    [rule.databaseImportEquals],
  ],
  [
    "dynamic external database",
    "routes/probe.ts",
    "void import('@workspace/db');",
    [rule.dynamicDatabase],
  ],
  [
    "connection setting",
    "routes/probe.ts",
    "const url = process.env.DATABASE_URL;",
    [rule.connection],
  ],
  [
    "computed connection setting",
    "routes/probe.ts",
    "const password = process.env['PGPASSWORD'];",
    [rule.connection],
  ],
];
try {
  for (const [index, [name, file, source, expected]] of cases.entries()) {
    const root = path.join(temporary, String(index));
    const filename = path.join(root, "artifacts/api-server/src", file);
    await mkdir(path.dirname(filename), { recursive: true });
    await mkdir(path.join(root, "lib"), { recursive: true });
    await writeFile(filename, source);
    const { violations } = await inspectDatabaseBoundaries(root);
    assert.deepEqual(
      violations,
      expected.map(
        (message) => `artifacts/api-server/src/${file}:1: ${message}`,
      ),
      `${name} must be refused by its own rule`,
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
    "lib/startup-config.ts":
      "export const configured = Boolean(process.env.DATABASE_URL);",
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
    "The explicit facade, typed core composition and the startup check's reading of DATABASE_URL remain permitted",
  );
  // Through a symlinked path the check still runs: the module's URL is its
  // real path, whatever path started it.
  const linked = path.join(temporary, "linked-scripts");
  await symlink(import.meta.dirname, linked, "junction");
  try {
    const run = spawnSync(
      process.execPath,
      [path.join(linked, "check-db-boundary.mjs")],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(
      run.stdout,
      /^Database boundary passed across \d+ runtime source files\.$/m,
      "Started through a symlinked path, the check must inspect the repository, not exit silently",
    );
  } finally {
    await unlink(linked);
  }
  console.log(
    `Repository boundary fixtures passed (${cases.length} refusals, each by its own rule, and the permitted composition): private capabilities, unreviewed modules, facade exports, relative paths, database imports and connection settings; started through a symlinked path, the check still runs.`,
  );
} finally {
  assert.equal(
    path.dirname(path.resolve(temporary)),
    path.resolve(os.tmpdir()),
  );
  await rm(temporary, { recursive: true, force: true });
}
