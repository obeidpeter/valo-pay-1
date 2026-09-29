# Operator validation

This is a prepared study, not evidence of completed user research. No lender operators have been observed yet. Automated checks and synthetic performance measurements do not establish that the product is easy for its intended users.

## Arrange a session

Start with five people who perform collections work: two Operations staff, two Finance staff and one Compliance reviewer. This is a small formative study to find problems, not a statistically representative benchmark. Use their usual desktop or laptop, and include a keyboard-only pass where it matches how a participant works. Reserve about 40 minutes per person.

Use an isolated synthetic workspace for each participant. Record a participant code, role, build revision, device, browser and date; do not record names or actual borrower information. Ask for consent before any recording and agree retention with the participant. A facilitator may take de-identified notes instead. No invitations or recordings are sent automatically.

Prepare a fresh workspace, the facilitator's expected outcomes, and a synthetic CSV containing a payment observation for ₦18,000.50. Its amount cell must be `18000.50`, and its column should be named `amount`; use a unique synthetic reference. Do not put any real customer information in the file. Also prepare a file containing one extra decimal place to exercise error correction. Run the study on the new build, then repeat affected tasks after any fixes using different equivalent fixtures.

## Opening script

“We are testing Valo Pay, not you. These are made-up records and no money moves. Work as you normally would and say what you are looking for or expecting. You can stop at any time. I will mostly watch rather than explain the interface. If you get stuck, tell me what you would do next.”

## Tasks to read aloud

Give one task at a time without naming buttons or the sequence of screens. Do not show the facilitator notes until the participant has finished.

| Task | Scenario | Facilitator success criteria |
| --- | --- | --- |
| Find and return | You are working through customers at Zenith Bank. Find Chiamaka Obi, investigate her payment history, then return to the same list to continue your work. | Identifies the right customer and payment context, returns with the same search/page, and can identify the row just visited. |
| Import an amount | You received this synthetic receipt file. Its values are in naira. Add it to the workspace and tell me the amount you expect to see afterwards. | Explicitly chooses naira, checks the preview, identifies ₦18,000.50, imports once and verifies the result. No factor-of-100 error. |
| Correct an import | This second file contains a value that needs correction. Work out what is wrong and show how you would fix it without importing an incorrect batch. | Explains the precision error, corrects it, rechecks, and understands that nothing was imported while errors remained. |
| Investigate unmatched money | A receipt has no confirmed payer. Decide what you can establish from the records and what needs to happen next. | Distinguishes received evidence from an allocation, identifies missing evidence, and keeps the payment unallocated if the payer cannot be established. Completing this task does not require confirming a match. |
| Explain a close | Your manager asks whether today's books are complete. Establish what has run, what remains unresolved and which evidence you would show. | Distinguishes no close, completed close and outstanding exceptions; states the observed status without claiming that synthetic evidence proves live readiness. |
| Prepare evidence | A colleague needs the customer's dispute evidence. Prepare it and explain how you would obtain it if generation is interrupted. | Starts one export, recognises its saved status, downloads the ready result, and can identify how to resume or retry. For failure observation use a controlled test environment; never interrupt production services. |
| Understand access | In the supplied read-only or reviewer persona, assess whether you can add a customer or approve the supplied submission, and explain who can act. | Understands the displayed role requirement and independent-review restriction without filling a form that cannot be submitted. |

## Record results

For each task, record: unassisted success, assisted success, failed or stopped; elapsed time; observable errors; assistance given; the participant's explanation; and an ease rating from 1 (very difficult) to 7 (very easy). Start timing after reading the task and stop when the participant believes they have finished. Confirm the resulting state separately. Mark interrupted tasks rather than treating them as slow completions.

An error is an observable incorrect interpretation or action, not a pause, different navigation preference or facilitator guess. Keep critical errors separate: wrong customer, incorrect amount, unsupported allocation, or misunderstanding whether an export is available. Record the exact behaviour and result; do not infer motives. If help was needed, the outcome is assisted even if the task eventually succeeds.

Report the denominator for every metric. Calculate unassisted completion as unassisted successes divided by attempted, non-interrupted tasks. Report median completion time for unassisted successes separately from assisted and failed tasks. Report critical errors and assistance counts alongside the small-sample percentages. Compare like roles, tasks and fixtures; a small study does not justify population-wide claims.

Fix any wrong-money or wrong-customer interpretation before a pilot. Prioritise other findings by consequence, frequency and recoverability, assign an owner, and retest with new equivalent tasks. Keep untested recommendations and observed findings separate. A facilitator rehearsal can check the script but must not be reported as a session with a lender operator.

The task format follows [Nielsen Norman Group's guidance on realistic, actionable task scenarios](https://www.nngroup.com/articles/task-scenarios-usability-testing/).

## Commissioning dependencies

The configuration inspection on 18 September 2026 confirmed healthy public liveness/readiness checks, with the scheduler intentionally off. It found no Paystack test credentials, outbound email service or verified sender, or managed key provider. A separate staging identity application and independent recovery resources/storage-backup access were not verified. Existing managed sign-in and App Storage do not establish these separate resources.

The alert destination is the address configured in `VALOPAY_ALERT_TO` on the host. Complete email delivery and inbox receipt verification using the procedure in [operational rehearsals](operational-rehearsals.md). Supply the Paystack test key through host secrets and run the existing test-only read-only connection check described in [Paystack setup](paystack.md). Never substitute a live key or paste credentials into a study result, pull request or conversation.

Use the separate identity, restricted database and key-provider procedures in [pilot security](pilot-security.md) and [pilot database recovery](pilot-database.md). Agree recovery objectives with the pilot owner, then verify database, private objects, retained keys and access roles together in an independent restore environment. Record actual measurements and failures. These services and participant sessions cannot be completed by changing application source alone.

## Repeatable automated rehearsal

`node scripts/rehearse-pilot.mjs` runs four existing acceptance suites against the real routes, repository and local PostgreSQL. It does not replace their assertions with mocks or count a skipped suite as a successful rehearsal. The identity service and export object store are controlled test fixtures; there are no real provider calls or inbox deliveries.

Prepare a disposable loopback PostgreSQL database with the current schema, using the repository's database setup instructions. Then set these variables and run the command from the repository root:

```powershell
$env:DATABASE_URL = 'postgres://postgres@127.0.0.1:5432/valopay'
$env:VALOPAY_RUN_INTEGRATION = '1'
$env:VALOPAY_RUN_PILOT_REHEARSAL = '1'
$env:VALOPAY_PILOT_REHEARSAL_REPORT = 'C:/rehearsal-evidence/pilot-rehearsal.json'
$env:NODE_ENV = 'development'
node scripts/rehearse-pilot.mjs
```

Use the local port/login actually provisioned for testing, and keep credentials out of saved command logs. The command refuses remote hosts, URL connection options, production mode and database names other than `valopay`, `valopay_test` or `valopay_pilot_rehearsal`. Both opt-ins are required. It removes inherited provider, identity, monitor and managed-key settings from its child processes, and holds the scheduler and Paystack ingress off. This safeguard does not turn an existing local business database into a disposable database: provision a separate test database first.

The JSON report contains the source commit, HEAD tree, dirty-checkout marker, a SHA-256 fingerprint of tracked and untracked source files, suite outcomes and durations. It contains no database URL, credentials, child process output or customer payloads. A failed suite does not suppress later results. If source changes while the command runs, its result is `source_changed_during_run`; finish editing and repeat before using that run as release evidence. Store the report outside the checkout: the command compares real paths, following links as the system does, so a report path that reaches the checkout through a linked directory, or is itself a link into it, is refused before anything runs. It also makes the report's directory first, so a directory that cannot be created, under a dangling link say, or a report path whose links loop, is refused before any suite rather than after them all. On Windows the comparison uses the system's own real path, which names the folder a subst or mapped drive letter points at; for a drive where that call is unavailable the letter is compared as written, so keep reports on an ordinary local folder. A non-passing run exits unsuccessfully; to diagnose a named suite, run that file directly with the test environment.

| Suite | What it establishes |
| --- | --- |
| `pilot-workflow.integration.test.ts` | Empty-lender setup; checked and committed imports; reconciliation; named case ownership, handover and resolution; close and evidence content; durable request recovery, stale writes and concurrent commits; staff permission and revocation controls. |
| `allocation-decisions.integration.test.ts` | Simultaneous Finance decisions cannot allocate a payment twice; stale proposals are refused without changing the lender's financial state. |
| `source-close-controls.integration.test.ts` | Expected source files, controlled corrections, independent Finance review, late-arrival invalidation and frozen reviewed evidence. |
| `export-jobs.integration.test.ts` | Queued exports and lost acknowledgements; worker interruption/retry; adoption of an already-written private object; lender isolation and audit continuity. |

Run the existing real-database browser checks separately. Build the frontend, push the schema to a separate loopback database named **`valopay_browser_test`**, set `DATABASE_URL` to it, and run `pnpm --filter @workspace/valopay run test:browser:database`. The browser host refuses any other database name or a non-loopback address. These checks use the built frontend and real API, including a successful batch commit whose response is deliberately lost, a reload and recovery through Operations with exactly one imported customer. Browser traces/screenshots are diagnostic evidence; they are not an independent usability study.

The full database/object/key dump-and-restore exercise remains `recovery-rehearsal.integration.test.ts` with its separate opt-ins and measured report, documented in [Operational rehearsals](operational-rehearsals.md). That report must accompany any recovery claim. Neither the pilot command nor the local restore exercise commissions hosted backups, managed-key custody or alert delivery.

## Prepare an observed operator session

Use an isolated synthetic workspace and the build under review. Ask one Operations user and a different Finance reviewer to participate. Real independent approval requires separately authenticated, authorised staff accounts; the sandbox's demo roles are one principal and cannot approve their own work. If those accounts are unavailable, observe preparation and the understandable refusal, and mark independent approval **not tested**.

Open **Presentation** and download its three sample CSVs and presenter brief. Reuse these files rather than maintaining a second fixture pack. Their expected customer reference is `PRES-C001`, instalment `PRES-D001`, payment evidence `PRES-O001`, and amount **₦18,000.50 (1,800,050 kobo)**. Import Customers, then Instalments, then Payment evidence. Select the matching record type and naira units; retain source name `Presentation sample`, stable source-row column `source_row_id`, distinct batch IDs and the downloaded pack's business date. Reconciliation matches this particular sample automatically using R1; it is not a proposal awaiting Finance confirmation.

A new empty lender has no seeded exception. Before observing case handling, the facilitator must prepare a clearly labelled synthetic case with supporting evidence in that same rehearsal lender, using the existing authorised workflow. The automated journey's `mapping_needed` classification case is an example. If that setup is absent, mark the case task **blocked by fixture setup**; do not describe an empty list as successful case resolution or silently switch lenders. Do not clear an existing workspace to restart: use a fresh isolated workspace or a new synthetic lender within the sandbox's limit.

## Short observer worksheet

Record build/revision, date, device/viewport, participant's role, workspace type and whether identity was real or simulated. Use participant codes rather than personal details. Ask the person to explain what they expect to happen, then let them work without navigation hints. Record assistance honestly.

| Task to give the participant | Evidence to record |
| --- | --- |
| Create a lender and find where to add its records. | Time, whether the selected lender is understood, wrong-lender navigation, assistance. |
| Import the three files, inspect their checks and verify the amount before committing. | Mapping/unit errors, first-attempt completion, whether saved checks survive a reload. |
| Reconcile the payment and explain why it matched. | Exact amount, R1 explanation, ability to find the customer's history without searching raw identifiers. |
| Take ownership of the prepared case, record a next action, hand it to Finance and resolve it with evidence. | Owner/deadline clarity, whether the recipient can find it, rationale and preserved handover history. |
| Run a close, explain outstanding issues and prepare it for another Finance reviewer. | Source completeness, ability to distinguish preparation from approval, whether a self-approval is correctly refused. |
| Generate the appropriate evidence export and find it again. | Saved export status, successful download, file opens, expected lender/date/amount and recorded review status. Without independent approval, use the available close/customer evidence and label it unapproved. |
| Explain how to recover a write whose result is unknown. | Whether the person finds Operations and checks the original request before creating a new one. Use controlled network fault injection only in local testing. |

For every row record **unassisted / assisted / failed / blocked / not tested**, elapsed time, exact confusing wording, observed error and recovery. Add one severity and an owner per finding. Capture screenshots only of synthetic data. Compare totals and exported evidence with the expected fixture, rather than treating a success toast as proof.

Suggested release exit criteria: the correct lender and amounts remain clear throughout; no duplicate import/allocation after a retry; no unresolved request is presented as a failed payment; a case retains its ownership and evidence; preparation cannot masquerade as independent approval; the downloaded file corresponds to the requested lender and snapshot. Investigate critical mistakes before admitting real data. Keep completion time descriptive until there is a measured baseline and an agreed target.

The automated runner records `observedHumanStudy: not_performed`. Change that assessment only after a real session produces a completed worksheet. Keep missing provider credentials, hosted recovery, alert delivery and real staff commissioning explicit in the release record.
