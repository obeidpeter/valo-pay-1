// A regression guard against accidental effects, not a security sandbox.
// Production process identities, egress and database privileges remain required.
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const defaultRoot = resolve(import.meta.dirname, '..');
const api = 'artifacts/api-server/src/';
const domain = `${api}domain/`;
const dangerousModule = /^(?:node:)?(?:https?|http2|net|tls|dns|dgram|child_process|worker_threads|fs)(?:\/|$)|^(?:axios|undici|got|pg|postgres|drizzle-orm|@workspace\/db|@google-cloud|@aws-sdk|@replit\/object-storage)(?:\/|$)/;
const permittedExternal = new Set(['@workspace/valopay-schema', 'zod', 'csv-parse/sync', 'node:crypto', 'node:util', 'node:timers/promises']);
const networkNames = new Set(['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource']);

function sourceFiles(root, directory) {
  if (!existsSync(resolve(root, directory))) return [];
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) return [];
    const name = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(root, name) : /\.[cm]?[jt]sx?$/.test(name) ? [name] : [];
  });
}

export function inspectEffectBoundaries(root = defaultRoot) {
  const files = [...sourceFiles(root, api.slice(0, -1)), ...sourceFiles(root, 'lib/valopay-schema/src')];
  const contents = new Map(files.map(file => [file, readFileSync(resolve(root, file), 'utf8')]));
  const issues = [], visited = new Set(), active = new Set(), checkedFiles = new Set();
  function resolveImport(from, specifier) {
    const base = resolve(root, dirname(from), specifier);
    const withoutJs = base.replace(/\.[cm]?js$/, '');
    const choices = [base, `${base}.ts`, `${base}.tsx`, `${withoutJs}.ts`, `${base}/index.ts`];
    const found = choices.map(path => relative(root, path).split(sep).join('/')).find(path => contents.has(path));
    return found;
  }
  function inspect(file, chain, creditRoot = false, coreRoot = false) {
    // A helper already checked for general purity must still be checked under
    // Core's or credit's stricter workflow boundary. Preserve that context through every
    // dependency, including shared helpers and schema barrels.
    creditRoot ||= /\/connected-credit(?:-service)?\.ts$/.test(file);
    coreRoot ||= /\/(?:actions|policy-engine|reconciliation|billing|close)\.ts$/.test(file);
    const visitKey = `${creditRoot ? 'credit' : 'domain'}:${coreRoot ? 'core' : 'shared'}:${file}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    active.add(file);
    checkedFiles.add(file);
    const ast = ts.createSourceFile(file, contents.get(file), ts.ScriptTarget.Latest, true);
    const report = (node, message) => issues.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${message} (via ${chain.join(' -> ')})`);
    function inspectDependency(node, target) {
      // A shared dependency can be visited by several branches of an acyclic
      // graph. Only an edge back into the current traversal is a cycle.
      if (active.has(target)) {
        const cycle = [...chain.slice(chain.indexOf(target)), target];
        report(node, `Circular runtime dependency: ${cycle.join(' -> ')}`);
        return;
      }
      inspect(target, [...chain, target], creditRoot, coreRoot);
    }
    function dependency(node, specifier) {
      if (specifier.startsWith('.')) {
        const target = resolveImport(file, specifier);
        if (!target) { report(node, `Unresolved runtime dependency ${specifier}`); return; }
        if (target.startsWith(`${api}providers/`) || target.startsWith(`${api}routes/`)) report(node, 'Domain computation cannot depend on a provider or HTTP route.');
        // Credit may share plain records and hashes, never another financial
        // workflow or a barrel that exports initiation/cash/payroll actions.
        if (creditRoot && target.startsWith(domain)
          && !/\/(?:connected-credit(?:-service)?|connected-permission-validity|records|record-index|types)\.ts$/.test(target)) {
          report(node, 'Credit computation cannot import collection, cash, payroll or payment workflows.');
        }
        // Core may resolve a checkout outcome through its narrow module; it
        // must never acquire the whole connected coordinator or unrelated
        // Credit/Cash/ERP/payroll workflows, including through a shared helper.
        if (coreRoot && target.startsWith(domain)
          && /\/connected(?:-(?:credit|cash)(?:-service)?)?\.ts$/.test(target)) {
          report(node, 'Core workflows cannot import the connected coordinator, Credit or Cash workflows; use the narrow checkout outcome interface.');
        }
        inspectDependency(node, target);
      } else if (specifier === '@workspace/valopay-schema' && contents.has('lib/valopay-schema/src/index.ts')) {
        inspectDependency(node, 'lib/valopay-schema/src/index.ts');
      } else if (dangerousModule.test(specifier) || !permittedExternal.has(specifier)) {
        report(node, `Effect-capable or unreviewed external dependency ${specifier}`);
      }
    }
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const typeOnly = node.isTypeOnly || (ts.isImportDeclaration(node) && (node.importClause?.isTypeOnly ||
          (!node.importClause?.name && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
           node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every(item => item.isTypeOnly)))) ||
          (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause) &&
           node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly));
        if (!typeOnly) dependency(node, node.moduleSpecifier.text);
      }
      if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        const specifier = node.moduleReference.expression;
        if (specifier && ts.isStringLiteralLike(specifier)) dependency(node, specifier.text);
        else report(node, 'Unresolved import-equals dependency is forbidden in domain code.');
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        report(node, 'Dynamic imports and require are forbidden in the domain dependency graph; use reviewed static imports.');
      }
      if (ts.isIdentifier(node) && networkNames.has(node.text)) report(node, 'Network APIs are forbidden in the domain dependency graph.');
      if (ts.isStringLiteralLike(node) && networkNames.has(node.text) && ts.isElementAccessExpression(node.parent)) report(node, 'Computed network APIs are forbidden in domain code.');
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'env' && ts.isIdentifier(node.expression) && node.expression.text === 'process') report(node, 'Domain code must receive explicit inputs, never ambient credentials or environment.');
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'process') report(node, 'Computed process access is forbidden in domain code.');
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['eval', 'Function'].includes(node.expression.text)) report(node, 'Dynamic code evaluation is forbidden in domain code.');
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') report(node, 'Dynamic code construction is forbidden in domain code.');
      ts.forEachChild(node, visit);
    }
    visit(ast);
    active.delete(file);
  }
  for (const file of files.filter(file => file.startsWith(domain))) inspect(file, [file]);
  return { checked: checkedFiles.size, issues: [...new Set(issues)] };
}

// Real paths: started through a symlinked path, argv names the link while this
// module's URL names the file, and the check would silently not run.
const startedDirectly = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (startedDirectly()) {
  const result = inspectEffectBoundaries();
  if (result.issues.length) { console.error(result.issues.join('\n')); process.exitCode = 1; }
  else console.log(`Effect boundaries passed across ${result.checked} domain and helper modules; Core and Credit capability isolation, no circular runtime dependencies, network, credentials, database or provider imports.`);
}
