// The committed contract and its generated packages must be exactly what the
// generator writes. Regenerates them in place, as the README's command does,
// then fails if git sees any difference, a file added or removed included.
// Run by `pnpm run check:contract` and by CI; needs no network or database.
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const generated = ["lib/api-spec", "lib/api-zod", "lib/api-client-react"];
const regenerate = "node scripts/create-valo-pay-1-spec.cjs && pnpm --filter @workspace/valo-pay-1-api-spec run codegen";
for (const [command, args] of [[process.execPath, ["scripts/create-valo-pay-1-spec.cjs"]], ["pnpm", ["--filter", "@workspace/valo-pay-1-api-spec", "run", "codegen"]]]) {
  // pnpm is a .cmd shim on Windows; npm_execpath names the real JS entry when
  // invoked through pnpm run, avoiding a shell and preserving argument boundaries.
  const viaNode = command === 'pnpm' && process.env.npm_execpath;
  const result = spawnSync(viaNode ? process.execPath : command, viaNode ? [process.env.npm_execpath, ...args] : args, { cwd: root, stdio: "inherit", ...(command === 'pnpm' && !viaNode && process.platform === 'win32' ? { shell: true } : {}) });
  if (result.status !== 0) { console.error(`✕ ${regenerate} failed`); process.exit(result.status ?? 1); }
}
const changed = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ...generated], { cwd: root, encoding: "utf8" });
if (changed) {
  spawnSync("git", ["--no-pager", "diff", "--stat", "--", ...generated], { cwd: root, stdio: "inherit" });
  console.error(`${changed}\n✕ The committed contract or its generated packages differ from what the generator writes. Change scripts/create-valo-pay-1-spec.cjs, never the generated files, then run \`${regenerate}\` and commit what it writes.`);
  process.exit(1);
}
console.log("The committed contract (lib/api-spec/openapi.json) and its generated packages match what scripts/create-valo-pay-1-spec.cjs and the codegen write.");
