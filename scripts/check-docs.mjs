// The documentation check: what a document names must exist, what the code
// reads must be documented, the contract must describe itself, the shared
// schema must be documented, every document must reach the snapshot and the
// README's table, the log's events and the integration suites must be the
// ones documented, and the prose must keep the spelling the console uses.
// Pure, run by `test:pure`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { allowedPath } from "./github-snapshot.mjs";

const root = resolve(import.meta.dirname, "..");
// Git's canonical text uses LF; a Windows CRLF checkout does not change historical evidence.
const read = (path) => readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n");
const problems = [];
let checks = 0;
const check = (condition, message) => { checks += 1; if (!condition) problems.push(message); };

// Historical documents retain the exact source paths and commands observed at their recorded revision.
// Only verified bytes may use the reviewed rename map. New prose, even in an append-only release log,
// must name today's files and packages; a directory-prefix mapping never excuses a missing child file.
const identityFiles = JSON.parse(read("docs/product-identity/historical-files.json"));
const identityMap = JSON.parse(read("docs/product-identity/path-map.json"));
const safePath = (path) => typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.split("/").some(part => !part || part === "." || part === "..") && !path.includes(":");
const pathMappings = Object.entries(identityMap.paths).sort(([a], [b]) => b.length - a.length);
for (const [before, after] of pathMappings) {
  assert(safePath(before) && safePath(after) && before !== after, "Identity path mappings must contain distinct safe repository paths");
  check(existsSync(join(root, after)), `Identity path mapping target does not exist: ${after}`);
}
for (const [before, after] of Object.entries(identityMap.packages)) assert(/^@workspace\/[\w-]+$/.test(before) && /^@workspace\/[\w-]+$/.test(after) && before !== after, "Identity package mappings must contain distinct workspace package names");
const mappedPath = (path) => {
  const entry = pathMappings.find(([before]) => path === before || path.startsWith(`${before}/`));
  return entry ? entry[1] + path.slice(entry[0].length) : path;
};
const historicalStarts = new Map();
for (const entry of [...identityFiles.files, ...(identityFiles.appliedMigrationFiles ?? [])]) {
  assert(safePath(entry.path) && /^[a-f0-9]{64}$/.test(entry.sha256), "Historical evidence must name a safe file and SHA-256 digest");
  const file = join(root, entry.path), exists = existsSync(file);
  check(exists, `Historical evidence file is missing: ${entry.path}`);
  if (!exists) continue;
  const matches = createHash("sha256").update(read(entry.path)).digest("hex") === entry.sha256;
  check(matches, `Historical evidence bytes changed: ${entry.path}`);
  if (matches) historicalStarts.set(entry.path, 0);
}
for (const entry of identityFiles.appendOnlyDocuments ?? []) {
  assert(safePath(entry.path) && /^[a-f0-9]{64}$/.test(entry.sha256) && Number.isSafeInteger(entry.byteLength) && entry.byteLength > 0, "Append-only evidence needs its preserved suffix's byteLength and SHA-256 digest");
  const bytes = Buffer.from(read(entry.path), "utf8"), start = bytes.length - entry.byteLength;
  const matches = start >= 0 && createHash("sha256").update(bytes.subarray(start)).digest("hex") === entry.sha256;
  check(matches, `Append-only historical suffix changed: ${entry.path}`);
  if (matches) historicalStarts.set(entry.path, bytes.subarray(0, start).toString("utf8").length);
}
const historicalAt = (doc, offset) => historicalStarts.has(doc) && offset >= historicalStarts.get(doc);

function walk(dir, keep) {
  const out = [];
  for (const entry of readdirSync(join(root, dir))) {
    if (["node_modules", "dist", ".git", "generated"].includes(entry)) continue;
    const path = join(dir, entry).replaceAll('\\', '/');
    if (statSync(join(root, path)).isDirectory()) out.push(...walk(path, keep));
    else if (keep(path)) out.push(path);
  }
  return out;
}

// ---- The documents ----
// The repository's files under docs/, as git lists them: a file .gitignore keeps out of the source (the business
// attachments in docs/source/, local verification reports) or an editor's stray file is not a document. Without git,
// the same exclusions by name.
function docsFiles() {
  try { return execFileSync("git", ["ls-files", "-z", "--", "docs"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean); }
  catch { return walk("docs", (p) => !/(?:^|\/)\./.test(p) && !p.startsWith("docs/source/") && !/^docs\/[^/]*_VERIFICATION\.md$/.test(p)); }
}
const inDocs = docsFiles();
const documents = ["README.md", "replit.md", ...inDocs.filter((p) => p.endsWith(".md")), "artifacts/api-server/src/fonts/README.md"];
const prose = (text) => text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "").replace(/\(https?:\/\/[^)]*\)/g, "").replace(/https?:\/\/\S+/g, "");

// ---- 1. Every path a document names exists (build outputs excepted: they exist only after a build) ----
const buildOutput = /(?:^|\/)(?:dist|node_modules|coverage)(?:\/|$)/;
for (const doc of documents) {
  const text = read(doc);
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].replace(/[.,;:]$/, "");
    if (!/^(?:artifacts|lib|scripts|docs|\.github|\.githooks)\/[\w./\[\]*-]+$/.test(token) || token.includes("*") || buildOutput.test(token)) continue;
    const current = historicalAt(doc, match.index) ? mappedPath(token) : token;
    const shorthand = ["artifacts/valo-pay-1/src", "artifacts/api-server/src"].some((base) => {
      const candidate = `${base}/${token}`;
      return existsSync(join(root, historicalAt(doc, match.index) ? mappedPath(candidate) : candidate));
    });
    check(existsSync(join(root, current)) || shorthand, `${doc} names a path that does not exist: ${token}`);
  }
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    const current = relative(root, resolve(root, dirname(doc), target)).replaceAll("\\", "/");
    check(existsSync(resolve(root, historicalAt(doc, match.index) ? mappedPath(current) : current)), `${doc} links to a file that does not exist: ${target}`);
  }
}

// ---- 2. Every command a document names is a script ----
const rootScripts = new Set(Object.keys(JSON.parse(read("package.json")).scripts));
const packageScripts = new Map();
for (const file of ["artifacts", "lib", "scripts"].flatMap((d) => walk(d, (p) => p.endsWith("/package.json") || p === "scripts/package.json"))) {
  const pkg = JSON.parse(read(file));
  if (pkg.name) packageScripts.set(pkg.name, new Set(Object.keys(pkg.scripts ?? {})));
}
for (const name of Object.values(identityMap.packages)) check(packageScripts.has(name), `Identity package mapping target does not exist: ${name}`);
for (const doc of documents) {
  const text = read(doc);
  for (const match of text.matchAll(/pnpm run ([a-z][\w:-]*)|pnpm (test)\b/g)) {
    const name = match[1] ?? match[2];
    check(rootScripts.has(name), `${doc} names a root script that does not exist: pnpm run ${name}`);
  }
  for (const match of text.matchAll(/pnpm --filter (@workspace\/[\w-]+) run ([\w:-]+)/g)) {
    const name = historicalAt(doc, match.index) ? identityMap.packages[match[1]] ?? match[1] : match[1];
    check(packageScripts.get(name)?.has(match[2]), `${doc} names a package script that does not exist: pnpm --filter ${match[1]} run ${match[2]}`);
  }
}

// ---- 3. Environment variables: documented when read, read when documented ----
const sources = ["artifacts", "lib"].flatMap((d) => walk(d, (p) => /\/src\/.*\.(?:ts|tsx|mjs|cjs)$/.test(p) && !/\.d\.ts$/.test(p)));
const readVariables = new Set();
for (const file of sources) for (const match of read(file).matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\["([A-Z][A-Z0-9_]*)"\])|import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)) readVariables.add(match[1] ?? match[2] ?? match[3]);
const readme = read("README.md");
for (const name of readVariables) check(readme.includes(name), `README.md does not mention ${name}, which the code reads`);
const documented = [...readme.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map((m) => m[1]);
// Variables a test runner, a browser fixture, a script, a development server or the deployment configuration reads or
// sets count as read: the table documents them for the person running or deploying those.
const otherReaders = [".github/workflows/ci.yml", ".replit", ...walk("scripts", (p) => /\.(?:mjs|cjs|sh|ts)$/.test(p)), ...walk("artifacts", (p) => /\/(?:tests|e2e)\/.*\.(?:ts|tsx|mjs)$/.test(p) || /\/(?:playwright[^/]*|vitest|vite)\.config\.ts$/.test(p) || /\/\.replit-artifact\/artifact\.toml$/.test(p))].map((p) => read(p)).join("\n");
for (const name of documented) check(readVariables.has(name) || otherReaders.includes(name), `README.md documents ${name}, which nothing reads`);

// ---- 4. The contract describes itself ----
const spec = JSON.parse(read("lib/api-spec/openapi.json"));
check(spec.info.title !== "Api", "the contract's title is the generator's placeholder");
for (const [path, methods] of Object.entries(spec.paths)) for (const [method, operation] of Object.entries(methods)) {
  check(operation.summary && operation.description, `${method.toUpperCase()} ${path} has no summary or description`);
  for (const parameter of operation.parameters ?? []) check(parameter.description, `${method.toUpperCase()} ${path}: parameter ${parameter.name} is not described`);
}
for (const [name, schema] of Object.entries(spec.components.schemas)) check(schema.description, `schema ${name} is not described`);

// ---- 5. The shared schema's exports carry a doc comment ----
for (const file of walk("lib/valo-pay-1-schema/src", (p) => p.endsWith(".ts"))) {
  const text = read(file);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  for (const node of source.statements) {
    if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) || ts.isExportDeclaration(node)) continue;
    const name = node.name?.text ?? (ts.isVariableStatement(node) ? node.declarationList.declarations.map((d) => d.name.getText(source)).join(",") : "?");
    const leading = text.slice(node.getFullStart(), node.getStart(source));
    check(/\/\*\*[\s\S]*?\*\/\s*$/.test(leading), `${file}: export ${name} has no doc comment`);
  }
}

// ---- 6. Every document reaches the GitHub snapshot ----
for (const doc of documents) check(allowedPath(doc), `${doc} is not in the snapshot tool's list and would be left out of a source upload`);

// ---- 7. The console's routes and the actions are in the contract ----
const contract = read("docs/frontend-contract.md");
for (const match of read("artifacts/valo-pay-1/src/App.tsx").matchAll(/path: '(\/[^']+)'/g)) check(contract.includes(`\`${match[1]}\``), `docs/frontend-contract.md does not list the route ${match[1]}`);
const actionsSource = read("artifacts/api-server/src/domain/actions.ts");
const reasoned = actionsSource.match(/const requiresReason = new Set\(\[([\s\S]*?)\]\);/)[1].match(/"([a-z_]+)"/g).map((s) => s.slice(1, -1));
const mutations = contract.slice(contract.indexOf("## Mutations"), contract.indexOf("## Imports & exports"));
for (const action of reasoned) check(mutations.includes(`\`${action}\``), `docs/frontend-contract.md does not describe the action ${action}`);
for (const match of mutations.matchAll(/`([a-z]+_[a-z_]+)`/g)) check(actionsSource.includes(`"${match[1]}"`), `docs/frontend-contract.md describes an action the code does not have: ${match[1]}`);

// ---- 8. Every route the API mounts is in the contract ----
// Every router app.ts mounts under /api, whatever its variable is called: the ones routes/index.ts gathers and any
// mounted directly (the Paystack test ingress), plus the replay path the recovery middleware serves itself.
// Inline handlers (the JSON 404) and the Clerk proxy, a pass-through mounted at a constant, are not routers of this contract.
const operations = new Set(Object.entries(spec.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`)));
const apiSource = "artifacts/api-server/src", appFile = `${apiSource}/app.ts`, appSource = read(appFile);
const moduleFile = (from, specifier) => [`${join(dirname(from), specifier)}.ts`, join(dirname(from), specifier, "index.ts")].map(path => path.replaceAll('\\', '/')).find((path) => existsSync(join(root, path)));
const imported = new Map();
for (const match of appSource.matchAll(/import\s+(?:(\w+)|\{([^}]*)\})\s+from\s+["'](\.\/[^"']+)["']/g)) {
  for (const name of match[1] ? [match[1]] : match[2].split(",").map((part) => part.trim().split(/\s+as\s+/).pop()).filter(Boolean)) imported.set(name, match[3]);
}
const routers = new Map(); // routes file -> its path prefix below /api
const followed = new Set(); // what app.ts imports from routes/ and mounts at a literal /api path
for (const [, mount, name] of appSource.matchAll(/app\.use\(\s*["'](\/api(?:\/[^"']*)?)["']\s*,\s*([A-Za-z_$][\w$]*)/g)) {
  const specifier = imported.get(name), file = specifier?.startsWith("./routes") ? moduleFile(appFile, specifier) : undefined;
  check(file, `app.ts mounts ${name} at ${mount}, which the documentation check cannot follow to a file under routes/`);
  if (!file) continue;
  followed.add(name);
  const prefix = mount.slice("/api".length);
  routers.set(file, prefix);
  if (file.endsWith("/index.ts")) for (const [, local] of read(file).matchAll(/from ["']\.\/([\w-]+)["']/g)) routers.set(moduleFile(file, `./${local}`), prefix);
}
const served = new Set();
for (const [file, prefix] of routers) for (const match of read(file).matchAll(/\b[A-Za-z_$][\w$]*\.(get|post|patch|put|delete)\(\s*["'`](\/[^"'`$]*)["'`]/g)) {
  const route = `${match[1].toUpperCase()} ${prefix}${match[2].replace(/:(\w+)/g, "{$1}")}`;
  served.add(route);
  check(operations.has(route), `${file} serves ${route}, which lib/api-spec/openapi.json does not describe`);
}
// A router mounted any other way, such as at a path held in a constant, would be skipped silently, so fail instead.
for (const [name, specifier] of imported) if (specifier.startsWith("./routes")) check(followed.has(name), `app.ts imports ${name} from ${specifier} but does not mount it at a literal /api path, so the documentation check cannot follow its routes`);
check(routers.has(`${apiSource}/routes/index.ts`), "the mounted-route check no longer reaches routes/index.ts, the main router app.ts mounts under /api");
check(served.has("POST /v1/providers/paystack/{connectionId}/events"), "the mounted-route check no longer reaches the routers app.ts mounts directly, such as the Paystack test ingress");
check(!read(`${apiSource}/lib/operation-recovery.ts`).includes("/retry$/") || operations.has("POST /v1/operations/{id}/retry"), "the recovery middleware serves POST /v1/operations/{id}/retry, which lib/api-spec/openapi.json does not describe");

// ---- 9. British spelling in prose ----
const american = /\b(colou?rs?(?<!colour)(?<!colours)|behaviors?|organi[sz]ations?(?<!organisation)(?<!organisations)|organize[ds]?|centered|analyzed?|catalogs?|favorites?|honor(?:ed|s)?|labeled|labeling|canceled|fulfill(?:ed|s)?|authoriz(?:e[ds]?|ation|ing)|unauthorized|initializ(?:e[ds]?|ation|ing)|serializ(?:e[ds]?|ation)|normaliz(?:e[ds]?|ation)|optimiz(?:e[ds]?|ation)|customiz(?:e[ds]?|ation)|recogniz(?:e[ds]?|ation)|standardiz(?:e[ds]?|ation)|minimiz(?:e[ds]?|ation)|maximiz(?:e[ds]?|ation)|synchroniz(?:e[ds]?|ation)|sanitiz(?:e[ds]?|ation)|summariz(?:e[ds]?|ation)|prioritiz(?:e[ds]?|ation)|utiliz(?:e[ds]?|ation)|finaliz(?:e[ds]?|ation)|categoriz(?:e[ds]?|ation)|visualiz(?:e[ds]?|ation)|capitaliz(?:e[ds]?|ation)|emphasiz(?:e[ds]?|ation)|realiz(?:e[ds]?|ation)|gray|defense|traveled|traveling|signaled|signaling|modeling|enrollment|installments?)\b/gi;
for (const doc of documents) {
  for (const match of prose(read(doc)).matchAll(american)) check(false, `${doc} uses an American spelling in prose: ${match[0]}`);
}
checks += 1;

// ---- 10. Every file under docs/ is in the README's Documentation table ----
const documentation = readme.slice(readme.indexOf("## Documentation"), readme.indexOf("\n## ", readme.indexOf("## Documentation")));
for (const file of inDocs) check(documentation.includes(`| \`${file}\` |`), `README.md's Documentation table does not list ${file}`);

// ---- 11. The log's events and docs/observability.md agree ----
// Every `event` the API logs is in the document's table, and every event the table lists is logged. The
// providers' `event` fields name a provider's webhook events, not log lines, so that directory is left out.
const logged = new Set();
for (const file of walk(apiSource, (p) => p.endsWith(".ts") && !p.startsWith(`${apiSource}/providers/`))) {
  const text = read(file);
  for (const match of text.matchAll(/\bevent\s*:\s*(["'`])([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\1/g)) logged.add(match[2]);
  // A log event name built at run time (`export.${stage}`) could not be checked against the table, so it is refused.
  for (const match of text.matchAll(/\bevent\s*:\s*`([a-z][a-z0-9_]*\.[^`]*)\$\{/g)) check(false, `${file} logs an event whose name is built at run time (${match[1]}...), which the observability check cannot read; write each name as a literal`);
}
const observability = read("docs/observability.md"), listed = new Set();
for (const row of observability.slice(observability.indexOf("| Event | Level | Fields | Meaning |")).split("\n").slice(2)) {
  if (!row.startsWith("|")) break;
  for (const match of row.split("|")[1].matchAll(/`([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)`/g)) listed.add(match[1]);
}
check(logged.size >= 20, `the event check found only ${logged.size} events in ${apiSource}; its pattern no longer matches how events are logged`);
for (const event of logged) check(listed.has(event), `${apiSource} logs the event ${event}, which docs/observability.md does not list`);
for (const event of listed) check(logged.has(event), `docs/observability.md lists the event ${event}, which ${apiSource} does not log`);

// ---- 12. The README names every suite the integration runner runs ----
const suites = [...read("scripts/run-integration-tests.mjs").matchAll(/tests\/([\w-]+)\.integration\.test\.ts/g)].map((m) => m[1]);
check(suites.length > 0, "the suite check found no suites in scripts/run-integration-tests.mjs");
for (const suite of suites) check(readme.includes(`\`${suite}\``), `README.md does not name the integration suite ${suite}, which scripts/run-integration-tests.mjs runs`);

if (problems.length) {
  console.error(problems.join("\n"));
  assert.fail(`Documentation check found ${problems.length} problem(s)`);
}
console.log(`Documentation checks passed (${checks} checks): paths, links and commands the documents name exist, environment variables are documented and read, the contract describes every operation, parameter and schema, the shared schema's exports are documented, every document reaches the snapshot, the contract lists every route and action, every route app.ts mounts is in the contract, the prose is British, the README lists every document and every integration suite, and the observability table lists exactly the events the API logs.`);
