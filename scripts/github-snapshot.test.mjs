import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { allowedPath, assertSafeText, snapshot, SNAPSHOT_MAX_BYTES } from "./github-snapshot.mjs";
import { target, assertDestination, selectSyncFiles, changedFiles } from "./github-sync-policy.mjs";
assert.equal(allowedPath(".githooks/pre-push"), true);
assert.equal(allowedPath(".githooks/unreviewed-hook"), false);

const approvedRepo = { full_name: target, private: false, archived: false, permissions: { push: true } };
assert.doesNotThrow(() => assertDestination(approvedRepo));
for (const override of [{ full_name: "other/repo" }, { private: true }, { private: undefined }, { archived: true }, { permissions: { push: false } }]) {
  assert.throws(() => assertDestination({ ...approvedRepo, ...override }), /approved public writable destination/);
}
const source = { path: "README.md", type: "blob", mode: "100644", sha: "source-new", content: "reviewed" };
const workflow = { path: ".github/workflows/ci.yml", type: "blob", mode: "100644", sha: "workflow-new", content: "reviewed workflow" };
const remoteWorkflow = { ...workflow, sha: "workflow-old" };
delete remoteWorkflow.content;
const otherRemoteWorkflow = { ...remoteWorkflow, path: ".github/workflows/other.yml" };
assert.deepEqual(selectSyncFiles([source, workflow], [], false), [source, workflow]);
assert.deepEqual(selectSyncFiles([source, workflow], [], true), [source]);
const preserved = selectSyncFiles([source, workflow], [remoteWorkflow, otherRemoteWorkflow], true);
assert.deepEqual(preserved, [source, remoteWorkflow, otherRemoteWorkflow]);
assert.deepEqual(changedFiles(preserved, [remoteWorkflow, otherRemoteWorkflow]), [source]);
assert.deepEqual(changedFiles([source, workflow], [source, remoteWorkflow]), [workflow]);
assert.deepEqual(changedFiles(preserved, preserved), []);

for (const path of ["README.md", ".node-version", "docs/deployment-node.md", "artifacts/api-server/src/app.ts", "lib/db/src/schema/index.ts", "scripts/github-sync.mjs", ".github/workflows/ci.yml", "docs/design/console.md"]) assert.equal(allowedPath(path), true);
for (const name of ['README.md', 'backend-package.md', 'repository-assessment.md', 'source-status-notes.md', 'traceability.json', 'validate-traceability.mjs']) {
  const path = `docs/refactor-2026-09-29/${name}`;
  assert.equal(allowedPath(path), true, `Reviewed programme artifact: ${path}`);
}
for (const name of ['source-reading/Technical_Requirements.json', 'traceability-private-source.json', 'catalogue.json', 'Valo_Pay_Business_Plan_v3.1.docx']) {
  const path = `docs/refactor-2026-09-29/${name}`;
  assert.equal(allowedPath(path), false, `Unreviewed source material: ${path}`);
}
for (const path of [".agents/memory/MEMORY.md", ".conversation/file.md", "docs/source/business.txt", "docs/PUBLISHED_SANDBOX_VERIFICATION.md", ".deployment-runtime/node-v24.15.0-linux-x64/bin/node", "scripts/.deployment-runtime/install.sh", "artifacts/valo-pay/.env.local", "artifacts/api-server/dist/index.js", "lib/backups/records.json", "scripts/password.key", "lib/../private.json", ".github/workflows/deploy.yml", ".github/workflows/ci.yaml", ".github/actions/custom/action.yml", ".github/workflows/../private.yml"]) assert.equal(allowedPath(path), false, path);
assert.throws(() => assertSafeText("fixture", "ghp_" + "a".repeat(36)), /Potential credential/);
assert.throws(() => assertSafeText("fixture", ["postgres:", "//real:password", "@example.invalid/db"].join("")), /Potential credential/);
assert.doesNotThrow(() => assertSafeText("fixture", 'process.env.CLERK_SECRET_KEY'));
const root = mkdtempSync(join(tmpdir(), "valopay-github-test-"));
try {
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
  mkdirSync(join(root, ".agents"));
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, ".deployment-runtime"));
  for (const [path, text] of [["README.md", "# Example\n"], ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"], [".node-version", "24.15.0\n"], ["docs/deployment-node.md", "# Deployment Node\n"], [".deployment-runtime/artifact.sh", "not source\n"], [".agents/internal.md", "private local material"]]) writeFileSync(join(root, path), text);
  execFileSync("git", ["add", "."], { cwd: root });
  assert.deepEqual(snapshot(root).files.map(f => f.path), [".node-version", "README.md", "docs/deployment-node.md", "pnpm-lock.yaml"]);
  assert.deepEqual(snapshot(root).excluded, [".agents/internal.md", ".deployment-runtime/artifact.sh"]);
  // Even if private source extracts are accidentally tracked beside a reviewed
  // matrix, only the explicitly reviewed artifact enters the public snapshot.
  mkdirSync(join(root, 'docs/refactor-2026-09-29'), { recursive: true });
  writeFileSync(join(root, 'docs/refactor-2026-09-29/traceability.json'), '{"syntheticExample":true}\n');
  writeFileSync(join(root, 'docs/refactor-2026-09-29/traceability-private-source.json'), '{"privateSourceExample":true}\n');
  execFileSync('git', ['add', 'docs/refactor-2026-09-29'], { cwd: root });
  assert.equal(snapshot(root).files.find(f => f.path === 'docs/refactor-2026-09-29/traceability.json').content, '{"syntheticExample":true}\n');
  assert.deepEqual(snapshot(root).excluded, ['.agents/internal.md', '.deployment-runtime/artifact.sh', 'docs/refactor-2026-09-29/traceability-private-source.json']);
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, ".github/workflows/ci.yml"), "name: Approved CI\n");
  writeFileSync(join(root, ".github/workflows/deploy.yml"), "name: Unreviewed deployment\n");
  execFileSync("git", ["add", ".github"], { cwd: root });
  assert.equal(snapshot(root).files.length, 6);
  assert.equal(snapshot(root).files.find(f => f.path === ".github/workflows/ci.yml").content, "name: Approved CI\n");
  assert.deepEqual(snapshot(root).excluded, [".agents/internal.md", ".deployment-runtime/artifact.sh", ".github/workflows/deploy.yml", 'docs/refactor-2026-09-29/traceability-private-source.json']);
  writeFileSync(join(root, ".github/workflows/ci.yml"), "ghp_" + "a".repeat(36));
  assert.throws(() => snapshot(root), /Potential credential/);
  writeFileSync(join(root, ".github/workflows/ci.yml"), "name: Approved CI\n");
  // Source uses working files, not stale staged bytes.
  writeFileSync(join(root, "README.md"), "# Updated\n");
  assert.equal(snapshot(root).files.find(f => f.path === "README.md").content, "# Updated\n");
  writeFileSync(join(root, "README.md"), Buffer.from([0]));
  assert.throws(() => snapshot(root), /Binary file/);
  rmSync(join(root, "README.md"));
  // Junctions need no Windows developer-mode privilege and exercise the same
  // refusal of a tracked path whose working file is a link instead of a file.
  const linkTarget = join(root, 'link-target');
  mkdirSync(linkTarget);
  symlinkSync(linkTarget, join(root, "README.md"), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => snapshot(root), /Unsupported link/);
  // Source growth has an explicitly reviewed aggregate budget. Individually
  // small, allowed UTF-8 files still cannot accumulate into an unbounded upload.
  assert.equal(SNAPSHOT_MAX_BYTES, 16 * 1024 * 1024);
  const budgetRoot = join(root, 'aggregate-fixture');
  mkdirSync(join(budgetRoot, 'scripts'), { recursive: true });
  execFileSync('git', ['init', '-q', budgetRoot]);
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: budgetRoot });
  writeFileSync(join(budgetRoot, 'README.md'), '# Synthetic budget fixture\n');
  writeFileSync(join(budgetRoot, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  const megabyte = '// ' + 'x'.repeat(1024 * 1024 - 4) + '\n';
  for (let i = 0; i < 12; i += 1) writeFileSync(join(budgetRoot, `scripts/fixture-${i}.ts`), megabyte);
  execFileSync('git', ['add', '.'], { cwd: budgetRoot });
  assert.equal(snapshot(budgetRoot).files.length, 14, 'Reviewed source above the old 8 MiB cap fits the new bounded budget');
  for (let i = 12; i < 17; i += 1) writeFileSync(join(budgetRoot, `scripts/fixture-${i}.ts`), megabyte);
  execFileSync('git', ['add', 'scripts'], { cwd: budgetRoot });
  assert.throws(() => snapshot(budgetRoot), /separate size review.*16 MiB/);
  writeFileSync(join(budgetRoot, 'scripts/oversized.ts'), '// ' + 'x'.repeat(2 * 1024 * 1024));
  execFileSync('git', ['add', 'scripts/oversized.ts'], { cwd: budgetRoot });
  assert.throws(() => snapshot(budgetRoot), /File needs a separate size review/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("Snapshot safeguards passed: exclusion rules, secret markers, current bytes, binary and symlink refusal, reviewed aggregate budget.");
