export const target = "obeidpeter/valo-pay-1";
export const repositoryId = "1374783064";

export function assertDestination(repo) {
  if (String(repo.id) !== repositoryId || repo.full_name !== target || repo.private !== false || repo.archived || !repo.permissions?.push) {
    throw new Error("Repository must match the approved public writable destination: " + target);
  }
}

export function isWorkflow(file) {
  return file.path.startsWith(".github/workflows/");
}

export function selectSyncFiles(local, remote, skipWorkflows) {
  if (!skipWorkflows) return local;
  // Explicitly preserve existing remote workflows, including ones not in the local allowlist.
  // This option must never delete or overwrite a remote workflow.
  return [
    ...local.filter(file => !isWorkflow(file)),
    ...remote.filter(file => file.type === "blob" && isWorkflow(file))
      .map(({ path, mode, type, sha }) => ({ path, mode, type, sha })),
  ];
}

export function changedFiles(files, remote) {
  return files.filter(file => !remote.some(other =>
    other.path === file.path && other.sha === file.sha && other.mode === file.mode && other.type === file.type));
}
