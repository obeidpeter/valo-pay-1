# GitHub syncing

How source leaves the Replit workspace for the public repository, and the guards around it. The README's Source repository section says what the repository is; this document says how it is fed.

The canonical repository is now `https://github.com/obeidpeter/valo-pay-1`, renamed in place with GitHub repository ID `1374783064` retained. The migration checkout and inspected Replit checkout both use that canonical remote; Replit retained its app UUID, clean **main** branch and publication checkpoint. Before using the Replit Git panel, verify its current branch and **origin** target this same repository, then use them for normal commits, pulls and pushes. A verified remote does not establish Git panel authentication, external deployment trust or a new publication. Do not rely on the old path redirect: it stops working if that name is reused by the future product.

The original Replit checkpoint history is preserved separately on the local
`replit-history-local` branch. **Never push that branch, all branches, or a
mirror of this repository.** It contains local-only material. Internal Replit
remotes are not GitHub sync destinations. Business attachments, agent notes
and local verification reports remain on disk but are excluded from the clean
branch. Review staged files before committing: this is a public repository.

A local Git pre-push guard checks outgoing commit ancestry and source files.
Do not disable it or bypass it with `--no-verify`. The guard does not replace
reviewing content for private information.

The guard now reads the local `valo-pay-1.cleanGitAnchor` configuration key. When upgrading an existing clean-source checkout, read its already reviewed `valopay.cleanGitAnchor` value locally, verify that commit exists and is the approved clean-history anchor, then set **the same full commit ID** under the new key with `git config --local valo-pay-1.cleanGitAnchor "$reviewed_anchor"`. Here `$reviewed_anchor` is that verified existing value, not the latest commit or a newly chosen root. Check `git config --local --get valo-pay-1.cleanGitAnchor` and run the guard before removing the obsolete key. There is no fallback to the old key, no history rewrite, and no permission to push private checkpoint history. If the old approved value is unavailable, stop the push and recover its approval record instead of inventing an anchor. The migration checkout's key was updated; other clones, including the Replit clean checkout, require their own verification.

## Legacy source-only upload utility

The source-only utility remains available for workspaces with the original
private checkpoint history. It is not needed for the linked clean `main`
branch. Do not alternate it with normal Git pushes without reconciling the
local branch and its separate synchronisation state first.

```sh
# Track any newly added source files explicitly first:
git add path/to/new-source-file

# Inspect the source-only file list; no network writes:
node scripts/github-sync.mjs

# After reviewing that list, upload the current source:
node scripts/github-sync.mjs --push
```

Its connector client, `@replit/connectors-sdk`, is a development dependency of the scripts package (`scripts/package.json`), not of the application, so it is installed with the workspace but never reaches the API or the console. The utility targets only the public `obeidpeter/valo-pay-1` repository, as approved by its owner. Public means anyone can read the uploaded source. It sends reviewed source contents, never Git history or credentials, through the Replit GitHub connector. It checks common secret patterns but cannot prove arbitrary content is safe: review new files before uploading.

The Git panel and this script use different authentication paths. A working
GitHub connector does not by itself verify Git panel authentication. Check
that the panel targets `origin` and the clean `main` branch before attempting
to reconnect an account.

Only `.github/workflows/ci.yml` is approved for workflow export. Other workflows and local GitHub actions remain excluded until individually reviewed and added to the allowlist.

The current connector does not offer GitHub's separate workflow-write permission. To sync source while explicitly leaving workflow updates pending:

```sh
node scripts/github-sync.mjs --skip-workflows
node scripts/github-sync.mjs --push --skip-workflows
```

This option preserves existing remote workflow files unchanged and reports pending local workflow changes. It never silently deletes a workflow. Commit the reviewed CI file through GitHub's website, or use a separately authorised clean clone, to enable/update it. An independently created GitHub commit still requires reconciliation before the next source upload. Unchanged workflow blobs are reused, not rewritten.

Updates use ignored local synchronisation state from the previous successful upload. In a workspace without that state, the utility can initialise it only when all selected local source files already match GitHub exactly; otherwise it stops for manual reconciliation. This allows a merged task's main workspace to establish its baseline safely. If GitHub has changed independently, the utility stops rather than overwriting changes; it never force-pushes and also refuses remote file deletions. Authentication failures should be repaired through the GitHub connection, not by pasting tokens into code.

In a **fresh clone from GitHub**, normal Git commits/pushes are safe to use because the clone contains only the clean repository history. Reconcile changes made there before uploading another snapshot from the original Replit workspace.
