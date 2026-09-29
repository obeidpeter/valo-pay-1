// A maintainability guard, not a sandbox against malicious code execution.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { pathToFileURL } from "node:url";

const defaultRoot = path.resolve(import.meta.dirname, "..");
const repository = "artifacts/api-server/src/lib/valopay-store.ts";
// Durable export claims and completion use explicit lender-scoped worker transactions.
const exportRepository = "artifacts/api-server/src/lib/export-job-store.ts";
// Opt-in restricted runtime transactions verify and bind the forced-RLS scope.
const isolatedRuntime = "artifacts/api-server/src/lib/runtime-isolation.ts";
// Explicit staging dual-write subordinate to the scoped repository; never owns a connection.
const financialProjection =
  "artifacts/api-server/src/lib/financial-projection.ts";
// The startup check reads DATABASE_URL only to refuse a missing or malformed value before anything starts;
// like every other module, it may not import the database or query it.
const startupCheck = "artifacts/api-server/src/lib/startup-config.ts";
const internalDirectory = "artifacts/api-server/src/lib/repository/";
// Explicitly reviewed modules, not a wildcard grant for a new module in this directory.
const internalModules = new Set(
  [
    "core",
    "types",
    "journal",
    "team-access",
    "payload-rewrap",
    "read-models",
    "retention",
    "export-cleanup",
    "readiness",
  ].map((name) => internalDirectory + name + ".ts"),
);
const publicRepositoryNames = new Set(
  `roles digest bindOperation boundOperation tenantConnections lenderConnections fail ANONYMOUS_WORKSPACE_DAYS SANDBOX_LENDER_LIMIT expiredWorkspaceCleanupEnabled SYSTEM_ACTOR_PREFIX runtimeIsolationVerified systemWorkspaceMatches verifyWorkspaceEncryption protectWorkspacePayloads inWorkspace listMerchants chainSequenceSql loadState auditOverview writeAuditCheck verifyAuditTrail dailyAuditCheckDue checkAuditChainDaily revealImportPayloads settleChanges addedRecords auditObject changeRole saveState inMerchantAsSystem merchantInWorkspace dueScheduledCloses scheduledCloseBacklog recordScheduledCloseFailure sandboxInactiveFor initialiseCloseCursors appendAudit verifyAudit DailyAuditCheck OwedCloses StoreContext StoredRequest MerchantLock WorkspaceAccess SweptExportFile prepareOperation listOperations countPendingOperations readOperation receiptOf cancelOperation lookupOwnOperation cancelOwnOperation rejectOperation journalReceipt completeOperation findIdempotency findStoredAnswer saveIdempotency caseAssignees staffDirectory viewerScope inviteStaff approveInvitation updateStaff approveStaffChange declineStaffChange updateStaffLenders revokeInvitation acceptStaffInvitation provisionStaffWorkspace addStaffAdministrator renewStaffAdministrator createPilotLender OperatorProvisioning rewrapProtectedPayloads PayloadRewrap listRecords listQueue listReconciliation listCloseHistory getCloseDetail loadReportsView getCustomerHistory loadCustomerView loadSettingsView lifecycleInventory executeLifecycleRun JournalNeed sweepExpiredWorkspaces overrideSweptExportRemoval removeSweptExportFiles runExportCleanupPass exportCleanupStatus integrityGuards guardMigrations supersededGuards pingDatabase watchDatabase closeDatabase DatabaseReadiness assertFinalState`.split(
    /\s+/,
  ),
);
const databaseImport =
  /(?:^@workspace\/db(?:\/|$)|^(?:pg|postgres|postgresql|drizzle-orm)(?:\/|$)|(?:^|\/)lib\/db(?:\/|$))/;
const connectionKey =
  /^(?:DATABASE_URL|PGHOST|PGUSER|PGPASSWORD|PGDATABASE|PGPORT)$/;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((e) => !["node_modules", "dist", ".git"].includes(e.name))
      .map(async (entry) => {
        const file = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(file) : [file];
      }),
  );
  return files.flat();
}

export async function inspectDatabaseBoundaries(root = defaultRoot) {
  const violations = [];
  let checked = 0;
  for (const file of [
    ...(await walk(path.join(root, "artifacts"))),
    ...(await walk(path.join(root, "lib"))),
  ]) {
    const relative = path.relative(root, file).replaceAll(path.sep, "/");
    if (
      !relative.includes("/src/") ||
      !/\.[cm]?[jt]sx?$/.test(relative) ||
      relative.startsWith("lib/db/")
    )
      continue;
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    checked++;
    const allowed =
      internalModules.has(relative) ||
      relative === exportRepository ||
      relative === isolatedRuntime ||
      relative === financialProjection;
    function reject(node, message) {
      const { line } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      violations.push(`${relative}:${line + 1}: ${message}`);
    }
    function internalTarget(specifier) {
      if (!specifier.startsWith(".")) return undefined;
      const target =
        path
          .relative(root, path.resolve(path.dirname(file), specifier))
          .split(path.sep)
          .join("/")
          .replace(/\.[cm]?[jt]sx?$/, "") + ".ts";
      return target.startsWith(internalDirectory) ? target : undefined;
    }
    function inspectInternal(node, specifier, typeOnly = false) {
      const target = internalTarget(specifier);
      if (!target) return;
      if (relative === repository) {
        if (
          !ts.isExportDeclaration(node) ||
          !node.exportClause ||
          !ts.isNamedExports(node.exportClause)
        ) {
          reject(
            node,
            "The public repository facade may only explicitly re-export reviewed entrypoints.",
          );
        } else
          for (const item of node.exportClause.elements) {
            if (item.propertyName || !publicRepositoryNames.has(item.name.text))
              reject(
                item,
                "An internal repository capability cannot be exposed by the public facade.",
              );
          }
      } else if (!internalModules.has(relative)) {
        reject(
          node,
          "Repository internals are private; use the valopay-store facade.",
        );
      }
      if (!internalModules.has(target))
        reject(
          node,
          "This repository module has not been reviewed for database access.",
        );
      if (
        relative !== internalDirectory + "core.ts" &&
        relative.startsWith(internalDirectory) &&
        target === internalDirectory + "core.ts" &&
        !typeOnly
      ) {
        reject(
          node,
          "Feature modules receive core capabilities through composition; importing core at runtime creates a cycle.",
        );
      }
    }
    if (relative === repository)
      for (const node of source.statements) {
        if (!ts.isExportDeclaration(node))
          reject(
            node,
            "The public repository facade must contain explicit re-exports only.",
          );
      }
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        const typeOnly =
          node.isTypeOnly ||
          (ts.isImportDeclaration(node) &&
            (node.importClause?.isTypeOnly ||
              (node.importClause?.namedBindings &&
                ts.isNamedImports(node.importClause.namedBindings) &&
                node.importClause.namedBindings.elements.every(
                  (item) => item.isTypeOnly,
                ))));
        inspectInternal(node, node.moduleSpecifier.text, typeOnly);
        if (databaseImport.test(node.moduleSpecifier.text) && !allowed)
          reject(
            node,
            "Database imports belong only in the scoped repository.",
          );
      }
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const specifier = node.moduleReference.expression;
        if (specifier && ts.isStringLiteralLike(specifier))
          inspectInternal(node, specifier.text, node.isTypeOnly);
        if (
          specifier &&
          ts.isStringLiteralLike(specifier) &&
          databaseImport.test(specifier.text) &&
          !allowed
        )
          reject(
            node,
            "Database import-equals declarations belong only in the scoped repository.",
          );
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      )
        inspectInternal(node, node.argument.literal.text, true);
      if (ts.isCallExpression(node)) {
        const target = node.expression;
        if (
          (target.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(target) && target.text === "require")) &&
          node.arguments[0] &&
          ts.isStringLiteralLike(node.arguments[0])
        )
          inspectInternal(node, node.arguments[0].text);
        if (
          (target.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(target) && target.text === "require")) &&
          node.arguments[0] &&
          ts.isStringLiteralLike(node.arguments[0]) &&
          databaseImport.test(node.arguments[0].text) &&
          !allowed
        ) {
          reject(
            node,
            "Dynamic database imports bypass the scoped repository.",
          );
        }
        const member = ts.isPropertyAccessExpression(target)
          ? target.name.text
          : ts.isElementAccessExpression(target) &&
              ts.isStringLiteralLike(target.argumentExpression)
            ? target.argumentExpression.text
            : "";
        if (member === "query" && !allowed)
          reject(node, "Raw query calls belong only in the scoped repository.");
      }
      const namesConnection = allowed || relative === startupCheck;
      if (
        !namesConnection &&
        ts.isPropertyAccessExpression(node) &&
        connectionKey.test(node.name.text)
      )
        reject(
          node,
          "Database connection settings belong only in the repository.",
        );
      if (
        !namesConnection &&
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        connectionKey.test(node.argumentExpression.text)
      )
        reject(
          node,
          "Database connection settings belong only in the repository.",
        );
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { checked, violations };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const { checked, violations } = await inspectDatabaseBoundaries();
  assert.equal(
    violations.length,
    0,
    `Database boundary violations:\n${violations.join("\n")}`,
  );
  console.log(
    `Database boundary passed across ${checked} runtime source files.`,
  );
}
