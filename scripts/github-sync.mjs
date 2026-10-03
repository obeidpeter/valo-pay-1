import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { snapshot } from "./github-snapshot.mjs";
import { target, assertDestination, selectSyncFiles, changedFiles, isWorkflow } from "./github-sync-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = resolve(root, ".local/github-sync/state.json");
const args = process.argv.slice(2);
if (args.some(arg => !["--push", "--skip-workflows"].includes(arg)) || new Set(args).size !== args.length) {
  throw new Error("Usage: node scripts/github-sync.mjs [--push] [--skip-workflows]");
}
const skipWorkflows = args.includes("--skip-workflows");
const { files: snapshotFiles, excluded } = snapshot(root);
let files = snapshotFiles;
console.log(`Source snapshot: ${files.length} files; ${excluded.length} local-only files excluded.`);
if (!args.includes("--push")) {
  console.log(files.filter(f => !skipWorkflows || !isWorkflow(f)).map(f => f.path).join("\n"));
  if (skipWorkflows) console.log("Workflow updates excluded explicitly; existing remote workflows will be preserved.");
  console.log("Dry run only. Review new source before using --push. Original Git history is never uploaded.");
} else {
  // No tokens are read or stored by this utility; the connector injects credentials.
  const connector = new ReplitConnectors();
  async function api(path, method = "GET", body) {
    const response = await connector.proxy("github", path, {
      method, body, headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!response.ok) {
      const text = await response.text();
      let error;
      try { error = JSON.parse(text); } catch { /* HTML responses are reported without dumping their content. */ }
      const detail = /Cloudflare/i.test(text) && /blocked/i.test(text)
        ? " The connector request was blocked by Cloudflare; this is not evidence of an expired GitHub login."
        : typeof error?.message === "string" ? ` ${error.message.slice(0, 500)}` : "";
      throw new Error(`GitHub ${method} ${path} failed (${response.status}).${detail} No automatic retry or force-push.`);
    }
    return response.json();
  }
  const base = `/repos/${target}`;
  const repo = await api(base);
  assertDestination(repo);
  let state;
  try { state = JSON.parse(readFileSync(statePath, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw new Error("Invalid synchronization state; reconcile before uploading.");
  }
  if (state && (state.repository !== target || state.branch !== repo.default_branch)) throw new Error("Synchronization target changed.");
  const branch = encodeURIComponent(repo.default_branch);
  const head = (await api(`${base}/git/ref/heads/${branch}`)).object.sha;
  const remote = await api(`${base}/git/trees/${head}?recursive=1`);
  if (remote.truncated) throw new Error("Cannot verify a truncated remote tree.");
  files = selectSyncFiles(snapshotFiles, remote.tree, skipWorkflows);
  if (skipWorkflows) {
    const pending = changedFiles(snapshotFiles.filter(isWorkflow), remote.tree);
    console.log("Workflow updates skipped explicitly; existing remote workflows are preserved.");
    if (pending.length) console.log(`Pending workflow files (not synced): ${pending.map(f => f.path).join(", ")}`);
  }
  const blobs = remote.tree.filter(f => f.type === "blob");
  const same = blobs.length === files.length && remote.tree.every(f => f.type === "tree" || (f.type === "blob" && files.some(local => local.path === f.path && local.sha === f.sha && local.mode === f.mode)));
  function saveState(commit) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath + ".tmp", JSON.stringify({ repository: target, branch: repo.default_branch, commit }, null, 2) + "\n", { mode: 0o600 });
    renameSync(statePath + ".tmp", statePath);
  }
  if (same) {
    // Also recovers safely when an earlier response was lost after a successful push.
    saveState(head);
    console.log(`Already verified: ${repo.html_url} (${files.length} files).`);
  } else {
    if (!state) throw new Error("Missing synchronization state and source differs from GitHub. Reconcile first; do not push workspace history.");
    if (head !== state.commit) throw new Error("GitHub changed since the previous upload. Reconcile remote changes first.");
    if (remote.tree.some(f => f.type !== "tree" && !files.some(local => local.path === f.path))) throw new Error("Upload would remove remote files. Deletions require explicit review.");
    // Reuse unchanged blobs, especially workflows that need separate write permission.
    const changes = changedFiles(files, remote.tree);
    let tree;
    try {
      const entries = [];
      for (const file of changes) {
        const blob = await api(`${base}/git/blobs`, "POST", {
          content: Buffer.from(file.content, "utf8").toString("base64"),
          encoding: "base64",
        });
        if (blob.sha !== file.sha) throw new Error(`Uploaded blob verification failed for ${file.path}.`);
        entries.push({ path: file.path, mode: file.mode, type: "blob", sha: blob.sha });
      }
      tree = await api(`${base}/git/trees`, "POST", {
        base_tree: remote.sha,
        tree: entries,
      });
    } catch (error) {
      if (changes.some(isWorkflow)) {
        throw new Error(`${error.message} This upload changes GitHub Actions workflows, which require separate workflow permission. To sync source without workflow changes, use --push --skip-workflows.`, { cause: error });
      }
      throw error;
    }
    const commit = await api(`${base}/git/commits`, "POST", { message: "Sync reviewed Valo Pay 1 source snapshot", tree: tree.sha, parents: [head] });
    await api(`${base}/git/refs/heads/${branch}`, "PATCH", { sha: commit.sha, force: false });
    const verifiedHead = (await api(`${base}/git/ref/heads/${branch}`)).object.sha;
    const verified = await api(`${base}/git/trees/${verifiedHead}?recursive=1`);
    const verifiedBlobs = verified.tree.filter(f => f.type === "blob");
    if (verifiedHead !== commit.sha || verified.truncated || verifiedBlobs.length !== files.length ||
        !files.every(file => verifiedBlobs.some(f => f.path === file.path && f.sha === file.sha && f.mode === file.mode))) {
      throw new Error("Remote verification failed; synchronization state was not advanced.");
    }
    saveState(commit.sha);
    console.log(`Verified ${files.length} matching files in public repository ${repo.html_url}`);
  }
}