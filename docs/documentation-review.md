# Documentation review

A review of the documents against the code they describe, made after the security, internationalisation and observability reviews and in the same manner: read every document and the code it names, test what can be tested here, fix what is this repository's to fix, and write down the rest. Its lasting part is a structural documentation check in the test suite. Passing that check does not establish that a product claim or planning assumption is current.

## Release-status review · 29 September 2026

The README, build status, deployment guide and document register now identify deployed PR #76 and distinguish this branch's pending cleanup from that live release. Migration 013 was applied and verified with PRs #71–#72; its instructions remain prerequisites only for hosts that still lack it. Earlier release records retain their original dates and evidence. The worker-health guidance describes source functionality pending deployment, not an observation of the current live worker. Core Word planning versions and external acceptance gates are unchanged by this repository refresh.

## Earlier currency review · 26 September 2026

That review compared the four core Word documents dated 21 September with the repository through PR #66 and the separately recorded deployed PR #64. The [document register](document-register.md) names their refreshed versions, role responsibilities, dated source records and review triggers.

The refresh corrects the inherited Technical Requirements v1.1 pointer, the obsolete FastAPI stack-deviation claim, Paystack saved-event verification status, the duplicated workspace-failure description and the claim that every imported CSV is discarded. It records PR #65 and PR #66 as draft changes rather than deployed functionality. The Word documents distinguish implemented synthetic journeys and rehearsed foundations from real-data, live-provider, hosted-recovery, independent security and human-pilot acceptance. Financial estimates retain their original planning date and need re-estimation before use as the remaining delivery budget.

The original findings below remain a historical review record. Provider/legal research dates are retained; this currency review does not reconfirm external rules, tariffs or product availability. It changes no financial-model calculations and marks no production gate complete. Future reviews must compare claims with implementation and deployment evidence as well as run the mechanical check.

## Scope and method

The README, `docs/BUILD_STATUS.md`, `docs/DATABASE_SECURITY.md`, `docs/frontend-contract.md`, the design rationale, the security and observability reviews, the typeface README, the Replit agent's notes (`replit.md`) and the API contract (`lib/api-spec/openapi.json`); the doc comments on the shared schema, the console's libraries and the API's operational modules. For each document: does every path, command, endpoint and environment variable it names exist; is every environment variable the code reads documented; does a newcomer find what they need; is the spelling and the vocabulary one; and could any of this drift unnoticed.

## What is sound

- **The reviews and the rationale** carry their method, findings and status, so a later change is made against the same reasoning.
- **The contract** is the console's single source for records, pages and mutations, and the shared schema package the single source for statuses and catalogues, so the two cannot disagree by retyping.
- **Module headers** on the domain modules say which requirement each implements.
- **British spelling** in the console, as the contract requires, and the requirement codes used as written in the specification.

## Findings, and what changed

| # | Finding | Kind | Status |
| --- | --- | --- | --- |
| 1 | The generated API packages (`lib/api-zod/src/generated`, `lib/api-client-react/src/generated`) had been edited by hand for the health and readiness operations, although the README documents the generator that writes them. | Accuracy | **Fixed.** Regenerated from the contract with the documented command; the README now says the contract is generated and never edited by hand, and where a change starts. |
| 2 | The served contract had no summary or description on any of its 18 operations, described 3 of its 25 parameters and none of its 28 schemas, and was titled "Api". | Completeness | **Fixed.** Every operation, parameter and schema is described in the generator; the title is "Valo Pay sandbox API". The check refuses an undescribed operation. |
| 3 | The design rationale was named and titled for the landing and sign-in pages while it recorded every state and audit of the console; its list of files was the original two pages'. | Accuracy | **Fixed.** Renamed `docs/design/console.md`, retitled, its files listed. |
| 4 | The README had no index of the documents, no vocabulary (lender and merchant, workspace and sandbox, kobo, WAT), no guide to making a change, one 2,700-character sentence listing the console's tested flows, and sixty lines of Replit-specific publishing procedure. | Navigability | **Fixed.** A Documentation table, a Vocabulary section and a Making a change section; the tested flows as a list; the publishing procedure moved to `docs/github-sync.md` with a pointer left. |
| 5 | American spellings in prose (`behavior`, `authorization`, `authorized`, `initialize`, `serializes`) against the contract's British-spelling rule. | Consistency | **Fixed**, and the check refuses them in prose. |
| 6 | Of the shared schema package's 138 exports, 77 had no doc comment; the console's libraries and the API's operational modules had gaps of their own. | Code documentation | **Fixed** for the shared schema (every export documented, and the check keeps it so), the console's libraries and the API's store, exports, scheduler, packs and readiness modules. The domain internals (the policy engine, reconciliation, close and alerts modules) keep their module headers; their exported helpers are read with the tests that pin them. |
| 7 | A new document could be left out of a source upload: the snapshot tool carries a fixed list, and the security review was missing from it until the last change. | Drift | **Fixed.** The check requires every document under `docs/` to be on the list. |
| 8 | Nothing checked that a path, command or environment variable a document names exists, that a variable the code reads is documented, or that the contract lists every route and action. | Drift | **Fixed.** `scripts/check-docs.mjs`, below. |
| 9 | The scripts package carried a `hello` scaffold, a source file and a script with no purpose beyond satisfying its TypeScript configuration. | Hygiene | **Fixed.** Removed with its script: the configuration covers the Paystack check and `scripts/provision-pilot.ts`, so it no longer needs a placeholder. |
| 10 | `replit.md` repeats parts of the README for the Replit agent. | Duplication | **Left**, as the agent reads it; the check covers its paths, commands and spelling so it cannot drift silently. |
| 11 | The documents had drifted from the code again (September 2026 audit, item 28): the observability table listed an `export.generated` event nothing logs and missed four that are logged; the security documents described the boundary before staff access, the four database modules and the restricted runtime migrations, and said the browser stores only the theme; restore checks named four or nine tables where there are ten; the README listed 10 of the 27 files under `docs/`, described an older CI and integration run, and said the console build needs the Clerk key; the build status named Chromium only; and the design rationale's entry script size was out of date. | Accuracy | **Fixed**, each against the code, and the check now fails when a file under `docs/` is missing from the README's table, when the log's events and the observability table differ in either direction, or when the integration runner gains a suite the README does not name. |

## The check

`node scripts/check-docs.mjs` runs with `pnpm run test:pure` and `pnpm test`. It reads the README, `replit.md`, every document under `docs/`, the typeface README, the contract and the code, and fails the suite when:

- a document names a repository path (other than a build output, which exists only after a build), links to a file, or names a `pnpm` script that does not exist;
- the code reads an environment variable the README does not mention, or the README's table documents one that nothing reads or sets (a test, a script, CI, `.replit`, a development server's configuration or a deployment's `artifact.toml` counts);
- an operation, parameter or schema of the contract has no description, or the contract keeps the generator's placeholder title;
- an export of `lib/valopay-schema` has no doc comment;
- a document under `docs/` is not on the snapshot tool's list, or a file under `docs/` is not in the README's Documentation table;
- a console route or a domain action is missing from `docs/frontend-contract.md`, or the contract describes an action the code does not have;
- a route served by a router `app.ts` mounts under `/api`, whatever its variable is called and including the Paystack test ingress mounted outside `routes/index.ts`, is missing from the contract, `app.ts` mounts something under `/api` the check cannot follow to a file under `routes/`, `app.ts` imports a router from `routes/` without mounting it at a literal `/api` path (a path held in a constant, say), or the check no longer reaches `routes/index.ts`;
- the API logs an `event` that `docs/observability.md` does not list, or the document lists one the API does not log (the providers' webhook event names are left out);
- `scripts/run-integration-tests.mjs` runs a suite the README does not name;
- the prose of a document uses an American spelling from its list.

## Where to document what

- **What the application is and how to run, check and change it**: the README.
- **What this build delivers and does not**: `docs/BUILD_STATUS.md`, one line per capability.
- **A rule**: a doc comment where the rule lives in `lib/valopay-schema` or the domain, naming the requirement code; a golden case that pins it.
- **An API operation**: its summary and description in `scripts/create-valopay-spec.cjs`, then the regeneration.
- **A console behaviour**: `docs/frontend-contract.md`; the reasoning behind a design choice: `docs/design/console.md`.
- **A review** (security, observability, this one): its own document with findings and status, listed in the README's table and on the snapshot tool's list.
- **An operator's question**: `docs/observability.md`; a new log `event` gets its row there in the same change.

## How to re-run

`pnpm run test:pure` runs the check. `node scripts/create-valopay-spec.cjs && pnpm --filter @workspace/api-spec run codegen` regenerates the contract and its packages; a diff after that means a package was edited by hand. `pnpm run check:contract` runs both and fails on such a diff, and CI runs it on every pull request.
