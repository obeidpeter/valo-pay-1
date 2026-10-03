/** Public repository facade. Session handles, raw clients and composition capabilities remain internal. */
export {
  roles,
  digest,
  bindOperation,
  boundOperation,
  tenantConnections,
  lenderConnections,
  fail,
  ANONYMOUS_WORKSPACE_DAYS,
  SANDBOX_LENDER_LIMIT,
  expiredWorkspaceCleanupEnabled,
  SYSTEM_ACTOR_PREFIX,
  runtimeIsolationVerified,
  systemWorkspaceMatches,
  verifyWorkspaceEncryption,
  protectWorkspacePayloads,
  inWorkspace,
  listMerchants,
  chainSequenceSql,
  loadState,
  auditOverview,
  writeAuditCheck,
  verifyAuditTrail,
  dailyAuditCheckDue,
  checkAuditChainDaily,
  revealImportPayloads,
  settleChanges,
  addedRecords,
  auditObject,
  changeRole,
  saveState,
  inMerchantAsSystem,
  merchantInWorkspace,
  dueScheduledCloses,
  scheduledCloseBacklog,
  recordScheduledCloseFailure,
  sandboxInactiveFor,
  initialiseCloseCursors,
  appendAudit,
  verifyAudit,
} from "./repository/core";
export type { DailyAuditCheck, OwedCloses } from "./repository/core";
export type {
  StoreContext,
  StoredRequest,
  MerchantLock,
  WorkspaceAccess,
  SweptExportFile,
} from "./repository/types";
export {
  prepareOperation,
  listOperations,
  countPendingOperations,
  readOperation,
  receiptOf,
  cancelOperation,
  lookupOwnOperation,
  cancelOwnOperation,
  rejectOperation,
  journalReceipt,
  completeOperation,
  findIdempotency,
  findStoredAnswer,
  saveIdempotency,
} from "./repository/core";
export {
  caseAssignees,
  staffDirectory,
  viewerScope,
  inviteStaff,
  approveInvitation,
  updateStaff,
  approveStaffChange,
  declineStaffChange,
  updateStaffLenders,
  revokeInvitation,
  acceptStaffInvitation,
  provisionStaffWorkspace,
  addStaffAdministrator,
  renewStaffAdministrator,
  createPilotLender,
} from "./repository/core";
export type { OperatorProvisioning } from "./repository/team-access";
export { rewrapProtectedPayloads } from "./repository/core";
export type { PayloadRewrap } from "./repository/payload-rewrap";
export {
  listRecords,
  listQueue,
  listReconciliation,
  listCloseHistory,
  getCloseDetail,
  loadReportsView,
  getCustomerHistory,
  loadCustomerView,
  loadSettingsView,
} from "./repository/core";
export { lifecycleInventory, executeLifecycleRun } from "./repository/core";
export type { JournalNeed } from "./repository/retention";
export {
  sweepExpiredWorkspaces,
  overrideSweptExportRemoval,
  removeSweptExportFiles,
  runExportCleanupPass,
  exportCleanupStatus,
  parkedExportFiles,
  requeueParkedExportFile,
  releaseParkedExportFile,
} from "./repository/core";
export {
  integrityGuards,
  guardMigrations,
  supersededGuards,
  pingDatabase,
  watchDatabase,
  closeDatabase,
} from "./repository/core";
export type { DatabaseReadiness } from "./repository/readiness";
export { verifyProductDatabaseBinding } from "./repository/readiness";
export { assertFinalState } from "../domain/final-state-integrity";
