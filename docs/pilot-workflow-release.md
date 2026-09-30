# Pilot workflow release

This release connects lender setup, saved import batches, reconciliation, coordinated exceptions, close review and evidence exports. All financial records remain synthetic. Real staff access is an opt-in staging foundation; enabling it does not open the pre-data or live-operation gates.

## Design decisions

- Keep original mutation requests and atomic completion receipts in a lender- and user-scoped server journal. A reload can discover received requests in Operations, which summarises what each asked and links to its record, and retry the exact stored request; the navigation's Operations link counts the pending ones. Recovery stays manual: a reloaded form does not look up its own request. No request bodies or credentials are written to browser storage. A pending journal entry means completion is not confirmed; it does not mean a payment failed.
- Save imports as versioned batches, including their source namespace, immutable source-row identities, mapping, amount unit, checks and committed record links. Corrections require the current batch version. Commit remains all-or-nothing. Similar rows with different source identities remain separate records.
- Coordinate existing exceptions using a named assignee, next action, deadline, linked evidence and append-only handover history. Case handling cannot replace Finance allocation or policy approval. Concurrent updates require the version the operator reviewed.
- In staging staff mode, resolve the organisation and active membership on the server for every transaction, hold membership/organisation locks through commit, require a verified Clerk session and both MFA factors, and use the stable user identity in approval checks. Demo role switching is unavailable. Invitations are manually shared, expire, and require a verified matching email. No email is sent by this release.
- Provision the first organisation/admin through an explicit operator command. Browser users cannot bootstrap themselves as pilot administrators. Default sandbox entry remains available when staff mode is off.

## Acceptance journey

Create an empty synthetic lender → save/check/correct an import batch → commit once, including after a lost response → reconcile payment evidence → claim and hand over an exception → resolve it through the existing controlled workflow → inspect a dated close → request and download its evidence. Verify isolation, permission refusals, revocation, stale edits and uncertain results alongside the successful journey.

## Deployment boundary

Apply the additive schema to a disposable database first. Verify the code and migration before applying them to the existing synthetic development preview. The code reaches main in one pull request from the development branch, codex/investor-presentation, which supersedes the stack of open draft pull requests #48 to #51 and #53. Production, live financial operations, external email, real customer ingestion and real Clerk/provider acceptance are separate gates.

The forced-RLS rehearsal of the time, since removed, was independent of this application repository. This release must not claim forced row security protects the default runtime. Staff access supplements the repository's explicit workspace/lender predicates and requires an independent security review before real data.

Authoritative references: [Clerk session claims](https://clerk.com/docs/guides/sessions/session-tokens), [Clerk Express SDK](https://clerk.com/docs/reference/express/overview), [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html).

## Setup and rollback

Apply `lib/db/migrations/003_pilot_workflow.sql` before deploying this API, as `docs/database-migrations.md` describes. It adds five tables without rewriting existing financial records. It is repeatable and transactional. Every constraint carries the name the Drizzle schema gives it, so a database built by the file and one built by `pnpm --filter @workspace/db run push` are identical; `artifacts/api-server/tests/pilot-workflow-migration.integration.test.ts` rehearses the file (with `004_staff_lender_access.sql`) on a throwaway database and compares the result with the pushed schema, column by column and constraint by constraint. A database built by an earlier draft of the file keeps its unnamed constraints; they enforce the same rules. Back up the synthetic development database first. Rollback means restoring the previous application build and leaving the additive tables in place; do not drop the journal or access history during rollback.

Default development access remains unchanged. A separate synthetic staff staging host requires the existing Clerk keys, `CLERK_JWT_KEY` (the instance's JWT public key in PEM form, with its line breaks, as Clerk shows it with the instance's API keys), `VALOPAY_STAFF_ACCESS=staging`, the exact `VALOPAY_STAFF_ISSUER`, and HTTPS origins in `VALOPAY_STAFF_ORIGINS`; Clerk accepts sessions only from those origins. Without `CLERK_SECRET_KEY` or `CLERK_JWT_KEY`, or with a JWT key Clerk cannot use (one pasted on one line with `\n` escapes, say), the server does not start, and its `config.invalid` line names the setting and how to write it. With the key, staff sessions are verified without a call to Clerk's Backend API, whose rate limit forged tokens could otherwise use up (the README's environment table). The start-up check cannot tell another Clerk instance's key from the right one, and with it every staff request is answered 401, so sign in once after setting it. Enable organisations and second-factor authentication in Clerk. Provision the first administrator explicitly, with the staging host's `DATABASE_URL` in the environment:

```sh
VALOPAY_STAFF_ACCESS=staging pnpm --filter @workspace/scripts exec tsx ./provision-pilot.ts --synthetic-staging org_EXAMPLE user_EXAMPLE "Pilot workspace"
```

The command (`scripts/provision-pilot.ts`) accepts existing Clerk organisation/user IDs and creates an empty application workspace with its first administrator. It checks its arguments and `VALOPAY_STAFF_ACCESS=staging` before it loads the database pool, and prints the usage or the missing setting instead; with restricted runtime isolation on, it refuses, because isolated workspaces are provisioned through the migration owner's connection. `scripts/operator-commands.test.mjs` runs these refusals offline, `artifacts/api-server/tests/pilot-administrators.integration.test.ts` runs every mode on PostgreSQL, and `pnpm run typecheck` covers the script. Confirm those identities with the operator before running it. It never grants live-data access. Add invitees to the same Clerk organisation, create their Valo Pay invitation, and share the link manually. An Admin, Finance or Compliance reviewer invitation can be accepted only once a second administrator has approved it, so provision a second administrator (below) before inviting Finance or Compliance reviewers. Acceptance checks verified email, organisation, invitation expiry and both authentication factors. Memberships expire after 90 days; a person other than an administrator needs a new invitation after revocation or expiry, and an administrator is renewed by the operator (below). Read access requires MFA within 12 hours; writes require it within 10 minutes. Team and access provides Account security and Verify identity controls. Never send identity-service secrets in invitations.

## Pilot administrators

An administrator's membership lasts 90 days, like any other, and nobody can renew it from the console: an administrator whose access has ended cannot sign in to invite or renew anyone, so a pilot whose administrators all lapse is locked out of its own team. The operator command has two more modes for this, both with the staging host's `DATABASE_URL` and `VALOPAY_STAFF_ACCESS=staging`:

```sh
VALOPAY_STAFF_ACCESS=staging pnpm --filter @workspace/scripts exec tsx ./provision-pilot.ts --synthetic-staging --add-administrator org_EXAMPLE user_SECOND "Second administrator"
VALOPAY_STAFF_ACCESS=staging pnpm --filter @workspace/scripts exec tsx ./provision-pilot.ts --synthetic-staging --renew org_EXAMPLE user_EXAMPLE
```

- `--add-administrator` gives another person of the same Clerk organisation an administrator membership for 90 days, with a `staff.administrator_added` event in the access history.
- `--renew` extends an administrator's membership to 90 days from now, whether it is still active or has already ended, with a `staff.renewed` event recording the previous and the new expiry. It moves the membership's version, so an edit of it already open in Team and access is refused as stale.
- Every mode can be run again: provisioning an organisation that already has this first administrator, or adding a person who is already an active administrator, changes nothing and says where things stand; two runs at once never fail on a duplicate row. Each prints its outcome as JSON and exits 0, or prints the refusal in plain words and exits 1.
- They refuse a suspended or revoked membership (an administrator restores that with a new invitation), a membership of another role (an administrator changes roles in Team and access), a person with no membership (for `--renew`) and an organisation not yet provisioned.

A second administrator is also what the pilot's separation of duties needs: an invitation or membership change that grants Admin, Finance or Compliance reviewer takes effect only when an administrator other than the one who asked approves it, and lifting the emergency stop and approving a retention run need a second administrator too ([pilot security](pilot-security.md#separation-of-duties-in-a-staff-pilot)). A pilot with one administrator cannot approve any of these from the console: the operator adds the second with `--add-administrator`, which needs no approval because the operator's provisioning is where administration starts. The invitation's answer and the refusal of a self-approval say so.

The routine that keeps a pilot's administration alive:

1. Provision the first administrator, then add a second with `--add-administrator` a few weeks later, so the two expiries are staggered and one can always act.
2. From 14 days before an administrator's access ends, the console shows that administrator a warning above every page; it also warns every administrator when the last administrator's access ends within 14 days, after which nobody could invite, change or renew staff.
3. Before an expiry, run `--renew` for each administrator who should keep access. If every administrator has lapsed, `--renew` restores one; nothing else is needed.
4. Check the access history in Team and access for the `staff.renewed` or `staff.administrator_added` entry.

## API supplement

All paths below are beneath `/api/v1`. Lender paths require `merchantId`; paged lists accept `offset` and return at most 25 items. Every resource is scoped to the server-resolved workspace. Mutation inputs use the strict shared contracts in `lib/valopay-schema/src/pilot.ts`.

| Endpoint | Contract and permissions |
| --- | --- |
| `GET /pilot/journey` | Saved lender counts, synthetic-only marker and access mode |
| `POST /pilot/lenders` | Admin (a staff host also requires recent MFA); name and segment; required idempotency key; creates an empty synthetic lender with automatic close disabled; a sandbox workspace holds at most five lenders (409 beyond); a name that matches a lender already in the workspace, ignoring letter case and surrounding or repeated spaces, is refused with 409 naming that lender. Not journaled: the page asks before it is left or reloaded while a creation is being sent or unconfirmed |
| `GET /operations` | This caller's requests, 25 to a page, each with its `summary` (the action or route in words, the record it names and at most three short fields), status and receipt, without stored bodies; a request sealed by payload encryption has no summary |
| `GET /operations/pending` | The number of this caller's pending requests in the lender, which the navigation shows beside Operations |
| `POST /operations/:id/retry` | Uses the exact saved request and key; requires the original actor and role plus current permission |
| `POST /operations/:id/cancel` | Serialises with the lender transaction; refuses completed work and blocks future execution |
| `GET /pilot/batches` | Paged summaries without CSV or row previews |
| `GET /pilot/batches/:id` | Admin, Operations or Finance; saved source, mapping, checks and revision history |
| `POST /pilot/batches` | Save/check a source batch; source name, batch ID, stable row-ID column, record kind, CSV, mapping, amount unit and synthetic-only confirmation |
| `POST /pilot/batches/:id/save` | Correct an unfinished batch with its current `expectedUpdatedAt`; preserve source and row identities |
| `POST /pilot/batches/:id/commit` | Current version required; all-or-nothing revalidation and import; returns the saved batch record |
| `GET /pilot/cases/:id` | Exception, eligible assignees, evidence choices and immutable handover events |
| `POST /pilot/cases/:id` | Claim, handover or update with current version, note, next action, future follow-up and up to 20 evidence links; current assignee or Admin controls an assigned case |
| `GET /team` | Staff directory; the lenders to grant, invitations, changes waiting for a second administrator and access history are Admin-only; anyone else sees only colleagues who share one of their lenders, only those lenders, and no one's expiry but their own; in the sandbox every list is empty (`lenders: []`) |
| `POST /team/invitations` | Staff Admin; verified email and application role; returns the one-time invitation token once, and `approval: awaiting` for an Admin, Finance or Compliance reviewer invitation |
| `POST /team/invitations/:id/approve` | Staff Admin other than the one who sent it; approves a waiting Admin, Finance or Compliance reviewer invitation (403 for the sender, 409 for any other invitation) |
| `POST /team/invitations/:id/revoke` | Staff Admin; revoke an unused invitation |
| `PATCH /team/members/:id` | Staff Admin; role, status, reason and current version; no self-edit or reactivation of revoked membership. A change that grants Admin, Finance or Compliance reviewer waits for a second administrator (`pendingChange`); the membership is unchanged until then |
| `POST /team/changes/:id/approve` | Staff Admin other than the one who asked and the person changed; applies exactly the waiting change (409 once decided, or when the membership changed since) |
| `POST /team/changes/:id/decline` | Staff Admin; declines a waiting change, or withdraws it for the one who asked |
| `POST /team/accept` | Verified matching email and organisation, fresh MFA and an unused invitation token; an Admin, Finance or Compliance reviewer invitation must be approved first |
| `POST /team/verify` | Clerk reverification challenge; does not grant membership or execute a financial request |

Journal entries survive reload and restart once received by the server. Only a keyed write is journaled; every console write carries a key. Team, access and lender set-up and the demo role switch are not journaled. Anonymous history still depends on its sandbox cookie and existing workspace expiry; signed-in history follows the account. Requests that never reached the service cannot be recovered. Pending entries can be retried or cancelled; a cancelled entry never completes afterwards, even if an attempt with its key was already running. Validation failures do not prove a financial transaction occurred. At most 100 unfinished requests per caller/lender may be retained. Completed journal payloads currently follow workspace retention; review a separate retention policy before any real-data pilot.

Staff membership changes take the organisation lock before the member lock. Financial writes retain a shared organisation lock through commit, so revocation waits for already-authorised work and blocks later work. This does not claim to cancel a transaction that had already started.

## Validation and remaining gates

The pure pilot suite covers source identity, changed-payload conflicts, batch correction, stale commits, immutable evidence, case ownership and financial invariants. The opt-in PostgreSQL suite exercises actual routes, persistent receipts, duplicate concurrent requests, cancellation, cross-workspace isolation, invitation binding, MFA, and revocation ordering. Identity-service results in that suite are controlled verified-session fixtures: real Clerk organisation selection, MFA and invitation acceptance still require a configured staging acceptance test. Provider credentials and external message delivery are not prerequisites for the synthetic journey and remain unconfigured.

The browser/database rehearsal creates an empty lender, saves and reopens a batch, loses a successful commit response and finds its completion after reloading Operations, with exactly one imported customer. Lender selection is retained in tab storage under the server's opaque user/workspace scope; only the lender ID is stored. Customer evidence packs include source-row provenance and case handover notes. The backup/restore rehearsal compares all eleven application/service tables, including unfinished requests, revoked memberships, lender access grants and orphan export cleanup records with their retry and lease state.

This foundation covers the core collections pilot. Connected credit and cash modules retain their existing simulation-specific authority checks; it does not approve real underwriting, payroll, bank instructions or new provider access.
