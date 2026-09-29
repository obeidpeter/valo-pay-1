import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const text = readFileSync(resolve(directory, 'traceability.json'), 'utf8');
const matrix = JSON.parse(text);
const counts = {
  TEN: 10, CON: 11, MAN: 15, SCH: 8, DEB: 12, RET: 12, ING: 9,
  REC: 9, EXC: 6, AUD: 7, NOT: 10, UI: 7, API: 8, MEA: 5, BIL: 7,
  'NFR-PERF': 4, 'NFR-AVA': 5, 'NFR-SEC': 10, 'NFR-DP': 8, 'NFR-OBS': 2, 'NFR-OPS': 6,
  'OB-CON': 6, 'OB-CNS': 6, 'OB-DAT': 4, A2A: 12, CRD: 16, MOD: 8,
  CASH: 8, ERP: 8, 'TAX-REC': 6, PAYROLL: 6,
};
const expected = Object.entries(counts).flatMap(([prefix, size]) =>
  Array.from({ length: size }, (_, index) => `${prefix}-${String(index + 1).padStart(2, '0')}`));
const ids = matrix.requirements.map(row => row.id);
assert.equal(new Set(ids).size, 251, 'Requirement IDs must be unique');
assert.deepEqual([...ids].sort(), [...expected].sort(), 'No requirement may be lost or silently introduced');
assert.equal(matrix.requirements.filter(row => row.origin === 'legacy').length, 171);
assert.equal(matrix.requirements.filter(row => row.origin === 'connected').length, 80);
assert.deepEqual(matrix.features.map(row => row.id), Array.from({ length: 18 }, (_, i) => `F${String(i + 1).padStart(2, '0')}`));
assert.equal(matrix.sources.length, 5);
assert.deepEqual(matrix.operating_gates.map(gate => gate.id).sort(), [
  'G0', 'G-DATA', 'G-CORE', 'G-OB', 'G-A2A', 'G-CREDIT', 'G-MODEL',
  'G-AUTO', 'G-ERP', 'G-PAYOUT', 'G-TAX', 'FUND-M9', 'RECOVERY', 'PORTABILITY',
].sort(), 'Every independent operating gate must remain explicit');
const digest = /^[a-f0-9]{64}$/;
const sources = new Set(matrix.sources.map(source => source.id));
const evidence = new Map(matrix.execution_evidence.map(item => [item.id, item]));
const conflicts = new Map(matrix.source_conflict_records.map(item => [item.id, item]));
const changes = new Map(matrix.change_packages.map(item => [item.id, item]));
assert.equal(evidence.size, matrix.execution_evidence.length);
assert.equal(conflicts.size, matrix.source_conflict_records.length);
assert.equal(changes.size, matrix.change_packages.length);
for (const source of matrix.sources) assert.match(source.sha256, digest);
// A file's top-level declarations, parsed rather than matched by line or excerpt, so moved or reformatted
// code still counts. An import, a re-export, a call or a comment declares nothing; nor does an ambient `declare`,
// which describes code kept elsewhere, nor a binding whose value is a require() or import() call, directly or
// through await, parentheses, type assertions (as, satisfies, <T>, !) and property or element reads. Syntax alone
// cannot tell the code a pointer names from a constant aliasing an imported binding, a type of the same name, or an
// import reached another way: through ?? or a conditional, .then(), a renamed createRequire, (0, require)(...) or a
// let assigned later. Those still count; review has to catch them.
const declared = new Map();
const loaded = expression => {
  while (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression) || ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) expression = expression.expression;
  return ts.isCallExpression(expression) && (expression.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(expression.expression) && expression.expression.text === 'require');
};
function declares(path, symbol) {
  if (!declared.has(path)) {
    const names = new Set();
    const bind = name => { if (ts.isIdentifier(name)) names.add(name.text); else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name); };
    for (const statement of ts.createSourceFile(path, readFileSync(resolve(root, path), 'utf8'), ts.ScriptTarget.Latest).statements) {
      if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) continue;
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) if (!declaration.initializer || !loaded(declaration.initializer)) bind(declaration.name);
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
        || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name && ts.isIdentifier(statement.name)) names.add(statement.name.text);
    }
    declared.set(path, names);
  }
  return declared.get(path).has(symbol);
}
let symbols = 0;
for (const component of Object.values(matrix.components)) {
  for (const pointer of [...component.implementation, ...component.contracts, ...component.test_sources]) {
    assert(existsSync(resolve(root, pointer.path)), `Missing repository pointer ${pointer.path}`);
    assert.match(pointer.sha256, digest);
    assert.equal(pointer.source_revision, matrix.baseline_revision);
    if (pointer.symbol === undefined) continue;
    assert(/\.[cm]?[jt]sx?$/.test(pointer.path), `Only a TypeScript or JavaScript file declares a symbol: ${pointer.path} names ${pointer.symbol}`);
    assert(declares(pointer.path, pointer.symbol), `${pointer.path} no longer declares ${pointer.symbol}; point it at the current declaration`);
    symbols += 1;
  }
}
for (const row of matrix.requirements) {
  assert(sources.has(row.source.document_ref), `Unknown source for ${row.id}`);
  assert.match(row.source.normative_content_digest, digest);
  assert(row.source.paragraph > 0 && row.source.acceptance_paragraph > row.source.paragraph);
  assert(row.summary && row.summary.length < 160, `Use a concise original summary for ${row.id}`);
  assert(matrix.components[row.component_ref], `Missing component for ${row.id}`);
  assert(row.implementation && row.testing && row.deployment && row.independent_acceptance && row.remaining_acceptance);
  assert.equal(row.independent_acceptance.status, 'not_recorded', `Acceptance must not be inferred for ${row.id}`);
  for (const id of row.testing.fresh_evidence_ids) assert(evidence.has(id), `Unknown evidence ${id} on ${row.id}`);
  for (const id of row.conflict_ids) assert(conflicts.has(id), `Unknown source conflict ${id} on ${row.id}`);
  for (const id of row.proposed_changes) assert(changes.get(id)?.requirement_ids.includes(row.id), `Unknown or unrelated change ${id} on ${row.id}`);
  for (const featureId of row.feature_ids) {
    assert(matrix.features.find(feature => feature.id === featureId)?.requirement_ids.includes(row.id));
  }
  assert(!('normative' in row) && !('business_outcome' in row), 'Full controlled-document passages belong outside the public repository');
}
for (const feature of matrix.features) {
  assert(feature.source_passages.length, `Missing feature source ${feature.id}`);
  for (const id of feature.requirement_ids) {
    assert(ids.includes(id));
    assert(matrix.requirements.find(row => row.id === id).feature_ids.includes(feature.id));
  }
  for (const passage of feature.source_passages) assert(!('cells' in passage), 'Do not reproduce controlled document rows');
  for (const id of feature.conflict_ids) assert(conflicts.has(id), `Unknown source conflict ${id} on ${feature.id}`);
}
for (const item of evidence.values()) {
  for (const key of ['command', 'source_revision', 'environment', 'dataset', 'expected', 'actual', 'evidence_location', 'scope_limit']) assert(item[key], `Evidence ${item.id} lacks ${key}`);
  for (const id of item.requirement_ids ?? []) {
    assert(ids.includes(id), `Unknown evidence requirement ${id}`);
    assert(matrix.requirements.find(row => row.id === id).testing.fresh_evidence_ids.includes(item.id), `Missing reverse evidence link for ${id}`);
  }
}
for (const item of [...conflicts.values(), ...changes.values()]) {
  for (const id of item.requirement_ids) assert(ids.includes(id), `Unknown linked requirement ${id}`);
  for (const id of item.feature_ids ?? []) assert(matrix.features.some(feature => feature.id === id), `Unknown linked feature ${id}`);
}
assert(!/[A-Z]:[\\/]Users[\\/]/.test(text), 'Do not commit personal absolute source paths');
console.log(`Traceability valid: 251 requirements (171 legacy + 80 Connected), 18 features, 14 unchanged gates, ${symbols} code pointers whose symbols their files still declare, separated evidence and no reproduced source catalogue.`);
