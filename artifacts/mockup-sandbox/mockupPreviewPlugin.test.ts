// Disposable discovery fixtures: no network, project files or running watcher.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mockupPreviewPlugin } from "./mockupPreviewPlugin";

const temporaryDirectory = await realpath(tmpdir());
const root = await mkdtemp(path.join(temporaryDirectory, "valo-pay-1-mockup-discovery-"));
const directory = path.join(root, "src/components/mockups");
const generated = path.join(root, "src/.generated/mockup-components.ts");
const plugin = mockupPreviewPlugin();
// Invoke exactly the Vite hooks that discover and generate the registry during builds.
const configure = plugin.configResolved as (config: { root: string }) => void;
const build = plugin.buildStart as () => Promise<void>;
const registry = async () => {
  await build();
  const source = await readFile(generated, "utf8");
  return [...source.matchAll(/^  (".*?"): \(\) => import\((".*?")\)/gm)]
    .map((match) => [JSON.parse(match[1]!), JSON.parse(match[2]!)]);
};
const add = async (relative: string) => {
  const file = path.join(directory, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "export default function Preview() { return null; }\n");
};
try {
  configure({ root });
  assert.deepEqual(await registry(), [], "a missing directory generates an empty registry");
  for (const file of ["Zeta.tsx", "nested/Alpha.tsx", "nested/Readme.txt", "_Hidden.tsx", "_helpers/Hidden.tsx", "nested/_private/Hidden.tsx", ".Hidden.tsx", ".cache/Hidden.tsx", "folder.tsx/Child.tsx", "literal{brace}/Card.tsx"]) await add(file);
  assert.deepEqual(await registry(), [
    ["./components/mockups/Zeta.tsx", "../components/mockups/Zeta.tsx"],
    ["./components/mockups/folder.tsx/Child.tsx", "../components/mockups/folder.tsx/Child.tsx"],
    ["./components/mockups/literal{brace}/Card.tsx", "../components/mockups/literal{brace}/Card.tsx"],
    ["./components/mockups/nested/Alpha.tsx", "../components/mockups/nested/Alpha.tsx"],
  ], "nested TSX files retain stable POSIX imports; helpers, hidden paths, other extensions and directories are excluded");
  const first = await readFile(generated, "utf8");
  await build();
  assert.equal(await readFile(generated, "utf8"), first, "a repeated scan produces the same registry");
  // Junctions need no symlink privilege on Windows; on Unix these are ordinary directory links.
  const linked = path.join(directory, "linked"), cycle = path.join(directory, "nested/back");
  await symlink(path.join(directory, "nested"), linked, "junction");
  await symlink(directory, cycle, "junction");
  try {
    const entries = await registry();
    assert.ok(entries.some(([key]) => key === "./components/mockups/linked/Alpha.tsx"), "linked mockup directories still appear");
    assert.equal(entries.length, 5, "a directory link cycle is bounded, with no repeated traversal");
  } finally {
    await unlink(cycle);
    await unlink(linked);
  }
  await unlink(path.join(directory, "Zeta.tsx"));
  await add("Added.tsx");
  const refreshed = await registry();
  assert.ok(refreshed.some(([key]) => key === "./components/mockups/Added.tsx"));
  assert.ok(refreshed.every(([key]) => key !== "./components/mockups/Zeta.tsx"), "added and removed previews update the registry");
  console.log("Mockup discovery passed: empty, nested, hidden/helper filtering, files-only, literal names, stable imports, linked directories, cycle protection and rescans.");
} finally {
  // Verify the actual target before recursive cleanup, including on Windows.
  assert.equal(await realpath(root), root);
  assert.equal(path.dirname(root), temporaryDirectory);
  assert.ok(path.basename(root).startsWith("valo-pay-1-mockup-discovery-"));
  await rm(root, { recursive: true, force: true });
}
