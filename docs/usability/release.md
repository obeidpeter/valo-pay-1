# Controlled usability release and operator guidance

## Release boundary

Candidate branch: **codex/evidence-led-usability**, since merged into the development branch **codex/investor-presentation** with the review rounds that followed. It was reviewed as draft pull request #48, the first of a stack of draft pull requests (#48 to #51 and #53); the code now reaches main in **one pull request from the development branch**, which supersedes that stack. This assignment authorises the existing synthetic preview only. Production publishing/merging, live providers, real-data use, customer communications and paid resources are outside this release. No new schema, secret, feature flag or dependency is needed. Keep scheduler/external side-effect configuration as found.

The code includes a bounded backend correction for proposal identity, allocation ceilings and instalment eligibility because a UI explanation cannot contain those defects. The corresponding tests are required alongside the frontend. Existing NFR-OPS-06 asks for an independent qualified engineer's review of this sensitive change before it reaches main; a passing automated suite is not that review. By the owner's decision, the 23 September 2026 audit and the four independent reviews of its fixes up to 25 September (the review of its merged fixes, and the second, third and fourth reviews), each finding reproduced and fixed with tests, together with the backlog round's independent review of every fix group, are that review ([audit](audit.md#independent-engineer-review); the decision is recorded in the first section of [the build status](../BUILD_STATUS.md)). Manual assistive-technology and physical-device acceptance remains human work.

## Five-component implementation summary

| Component | Implemented support | Evidence and limit |
| --- | --- | --- |
| Learnability | Separate demo role, environment and observation mode; required mapping/amount guidance; check versus import results; exact permission subject/purpose | Source, synthetic UI/browser tests; no novice-completion rate measured |
| Efficiency | Error-only import review, correction links, exact retry, filtered customer return and queue scroll restoration | Executable paths and return offsets checked; no human time reduction claimed |
| Memorability | Stable navigation and terminology, same queue context on return, retained in-session drafts and saved export history | Immediate engineering re-entry checks; delayed human retest pending |
| Errors | Current proposal/version, payment/instalment ceiling and status guards; precise money parser; role-aware controls; unknown outcome stays unresolved until original replay succeeds | Focused adverse cases plus full regression checks; current synthetic scope only |
| Satisfaction | Readable decision evidence, explicit consequences, focused corrections and honest saved/blocked/uncertain feedback | Expert design hypotheses; SEQ/SUS and comfort/control evidence pending |

## Operator instructions and reusable interaction rules

- **Before work:** check active lender, demo role and mode. Observation mode permits reconciliation records; it does not permit live instructions. WAT is the displayed time basis.
- **CSV:** choose the source amount unit, match each destination once, choose the Row ID column, check all rows and inspect errors, which name the column and say what to change. Checks save nothing. The contract is atomic for new rows. Every row needs a source row ID: a row imported before with the same ID and data is skipped, one with the same ID and different data is a row error, and a new row ID with another record's reference is refused. Keep row IDs and references stable. Records a quick import saved before row IDs were required have none, so their rows are not recognised: remove the rows already imported from the file before importing it again.
- **Payment review:** compare the customer, payment evidence, instalment, available receipt credit and outstanding amount. Receipt and settlement are different facts. Item fee evidence is not supplied by this read model; inspect settlement-batch evidence rather than inventing a fee. A changed proposal or closed/disputed instalment requires refreshed review.
- **Incorrect match:** the existing audited correction removes the allocation and restores the affected balances. It does not refund money or delete the original evidence. Never substitute a generic “undo”.
- **Unknown result:** keep the page/dialog open and use its original-request retry. Inputs are held to prevent a second intention. A later session/permission rejection does not establish whether the first request committed. Closing or reloading loses the page's own retry, but a request the service received stays in Request history (`/operations`), which the notices of the dialogs, the export control, the quick import, a daily close, a reconciliation run, an audit log check, Settings and the pilot and connected pages link to: check it there (Check original request) or cancel it if unfinished before starting again. The Request history link in the navigation counts requests still pending. Team, access and lender set-up are not kept there, so their pages ask before being left or reloaded while such a change is unconfirmed. Do not resend merely because a toast or connection disappeared.
- **Exports:** queued/running jobs can be resumed through saved history. A failed job retry refers to that saved job; an uncertain creation retry refers to the original request. Download access is checked again. A ready export shows no expiry date, by the owner's decision: only an approved retention run removes a file (or the expiry sweep, with a whole idle sandbox), and a hold can keep it longer. Once a file is removed, its export says when (`expiredAt`) and by which retention run (`retentionRunId`), keeps its checksum when it had one, and Saved exports lists it under File expired. A downloaded copy cannot be recalled.
- **Forms:** name the correction, associate it with the field, keep unrelated inputs and return focus to the opener or main region if the action removed the opener. Pending changes cannot be dismissed as though cancelled. Show completion only after authoritative response.
- **Connected work:** each permission has one subject/purpose/expiry. Account reading does not authorise a payment, assessment, accounting change or payroll. A browser bank return is not receipt evidence; a model result is not a lender decision; a forecast is not available cash; a review export is not an ERP post or a paid payroll item.

Do not introduce new analytics to measure these rules. Use the manual research template and existing non-sensitive operation references; keep participant records outside the public repository.

## Terminology map

| User-facing term | Preserved technical meaning |
| --- | --- |
| Proposed match | An allocation awaiting permitted confirmation; it has not yet reduced outstanding value |
| Apply payment / allocation | Apply no more than the available receipt credit and current instalment balance |
| Outstanding instalment | Unfulfilled obligation, not funds held by Valo Pay |
| Received / settled | Separate payment evidence and settlement states; neither inferred from a browser return |
| Request not confirmed | A request may have committed; exact replay or authoritative status is needed |
| Sample permission | Simulated purpose-specific authority, not a real bank connection or payment permission |
| Assessment / lender review | Model/rule evidence and a separately reasoned decision, never interchangeable |
| Forecast / available cash | Planning estimate versus timestamped bank-reported availability |
| Draft / reviewed export / posted | Different accounting stages; this sandbox does not perform a live posting |
| Payroll plan / approved / exported / completed | Different funding/evidence stages; export alone cannot establish payment |

British English, full NGN amounts and integer kobo calculations are retained. Status also uses words; colour is supplementary. No substantial navigation change means no old-to-new route migration is needed.

## Verification record

Local verification completed: **325 UI tests across 62 files**, all frontend/API/project and test TypeScript checks, frontend and API builds, database source boundary and documentation checks. Reconciliation passes **414** golden checks and the adjacent daily-close suite passes **110**. The wider available offline backend, security, privacy, import, export, retry, billing, recovery and performance checks pass. The Linux-only snapshot symlink test cannot run as written on Windows; the unchanged canonical suite passed in the first CI checkpoint. No PostgreSQL instance was assumed locally.

The complete desktop/phone Chrome workflow suite passed **36 tests** after the proposal fixture and owner-filter correction. The final response validation, replay guidance and dialog focus restoration have focused regressions and the full 325-test UI pass. After the browser follow-up below, **12 usability cases passed in desktop Chrome and mobile WebKit** on the final local build, including both themes, 320px reflow and dialog opener restoration. CI must validate the final built head in all configured browsers. The local isolated scroll reproduction returns **1800 → 0 → 1800** across tall queue, short page and return. Both builds retain the existing non-blocking main-chunk size warning; the frontend build also reports the existing sheet source-map warning.

CI, candidate identity and actual preview smoke results belong to the pull requests and the delivered evidence manifest. Do not infer deployment from this local record. The new real-API/PostgreSQL browser test commits a synthetic customer, deliberately withholds and loses its response, checks pending/unknown controls, then proves identical-key/body replay and exactly one saved customer.

The first CI checkpoint passed the full source/unit/backend suites, both PostgreSQL jobs and 70 of 72 browser cases. Two mobile WebKit checks exposed a genuine exception-filter width defect in both themes. The follow-up constrains native controls and stacks their labels on phones; it does not remove or relax the reflow assertions. A test-only WebKit runtime installed outside the repository then exposed Windows WebKit's unfocused-button activation behaviour: relying only on the active element lost the dialog opener. Shared dialog handling now remembers the actual activating control for that click without changing global click focus or retaining an unrelated click. Five additional regressions cover pointer and keyboard opening, stale activation and removed openers. The 12-case browser rerun passes. Final CI applies to the updated PR head; no application dependency was added.

A subsequent CI run reported **71 passed and 1 flaky**, with the mobile WebKit dark-mode accessibility case passing on retry. Investigation reproduced a transient inherited-text contrast defect under reduced motion: the universal near-zero transition duration unnecessarily activated colour transitions on plain text. UX-R08 changes transition duration to zero while retaining animation-end events. In an isolated WebKit comparison against the built CSS, 16/16 old-style cases retained stale text after two frames; 16/16 zero-duration cases rendered the correct palette immediately. A new Settings regression checks immediate dark/light inherited colour, text fill and zero transition duration, without arbitrary waits or weakening any axe assertion. The final local build passes all 14 usability cases in Chrome and WebKit, including the new immediate-colour regression and existing axe assertions. Final-head CI remains recorded in the linked PR/evidence manifest; the earlier retry pass alone was not a clean 72-case result. Since then, run 36146887477 of Source checks, on 5f238bb (the head merged as PR #59), passed all eight jobs, every browser project included; CI retries a failed browser test once.

## Before and after interaction paths

| Journey | Baseline friction | Candidate path and authoritative outcome |
| --- | --- | --- |
| Import | Preview and commit completion looked similar; duplicate-only files offered an unproductive import; errors were harder to revisit | Choose the row ID column and map once → check without saving → filter/correct invalid rows → import all valid new rows once; duplicate-only result is terminal and explicit |
| Reconciliation | Generic decision fields and loosely bound proposed match | Compare payment and instalment evidence → review current amount/version → confirm or reject with reason → server verifies identity, eligibility and both balances |
| Interrupted write | Changed input could acquire a new key after a lost acknowledgement | Pending fields held → uncertain result stated → latest recovery refusal visible → original body/key replay → close only on a valid confirmation |
| Queue return | Correct filters but scroll reset after a short page | Retain filter/page → inspect customer → return with the prior in-session position within the same authority scope |
| Permissions | First subject silently selected; grant/revoke authority unclear | Explicit subject/purpose → expiry and consequence review → role-permitted decision → retained historical evidence explained |
| Credit/cash | Decimal rounding and custom tabs made exact input and keyboard navigation fragile | Exact two-decimal money validation → keyboard-operable tabs → review forecast assumptions or independent decision → explicit synthetic result |
| Exports | A lost creation acknowledgement could lead to another format/request | Keep original request → inspect saved export status or exact replay → follow queued/ready job → reauthorised download |

Accessibility scope: automatic axe checks in real browsers, keyboard tab/focus behaviour, dialog content and scroll, screen-size emulation, both themes and reduced-motion handling. WCAG 2.2 AA is a target, not a conformance statement. True screen-reader speech, accessible real Clerk MFA/recovery, physical devices, complete target-size/manual contrast inspection and actual browser 200/400% zoom remain unperformed. A 320 CSS-pixel check is reflow evidence, not a substitute for those tests.

Canonical repeatable repository checks:

```text
pnpm run typecheck
pnpm run check:db-boundary
pnpm test
pnpm --filter @workspace/valopay run build
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/valopay run test:browser
pnpm run test:integration
pnpm --filter @workspace/valopay run test:browser:database
```

Use the existing CI definition for PostgreSQL and browser installation/fixture variables. Never point integration/reset commands at a real workspace. There is no lint script in the repository; TypeScript, existing source/security guards and focused formatting checks are used instead. Windows local runtime limitations are recorded with the final results; CI remains necessary for database and additional-browser evidence.

## Preview and rollback procedure

1. Verify the pull request head, clean source tree, successful required CI and reviewed changed paths. Use the exact candidate source in the existing Replit development preview; do not press Publish or alter provider/scheduler configuration.
2. Read build identity, health and readiness. Open Overview and confirm lender/role/mode; check import preview, proposal review, exact amount validation and permissions. Use synthetic data only. A preview card or a build command alone is not an application smoke test.
3. Keep the production build unchanged. Human and accessibility acceptance remain separate work; the independent engineer review is the owner's decision recorded above. Publish only after a later explicit decision with these residuals visible.
4. On regression stop preview testing and restore the previous reviewed source/build. There is no schema migration to reverse. Preserve any synthetic audit or saved job records; never delete financial evidence as a rollback mechanism. Roll back shared recovery hooks and their consumers together. A backend rollback would remove new allocation protections: keep affected mutations unavailable until a corrected candidate is ready. Do not roll back a fix by re-enabling unsafe work.

## Traceable amendment proposals — not adopted policy

| Proposal | Existing requirement / issue | Suggested acceptance addition; gate retained |
| --- | --- | --- |
| UX-AM01 | UI-01 / UX-R01–02, UX-C04 | Show actual role, environment, mode and time basis; restore authorised queue context. Add novice and return-task evidence by real role. No domain entitlement or live-use gate weakened |
| UX-AM02 | API-03, CON-04 / UX-C01, UX-R03–04 | Require the reviewed proposal identity/version (the API has required it since 25 September 2026, as a breaking change without a new API version); preserve unresolved outcomes through auth failures; keep received requests in a durable scoped journal, as Operations now does, and add lookup by a reloaded form before live writes. Maintain tenant/amount/eligibility and replay invariants |
| UX-AM03 | UI-06 / UX-I03–06, UX-X04 | Include correction index, associated errors, focus return, keyboard tabs, pending/unknown behaviour and WCAG 2.2 checks in component acceptance; retain manual assistive-technology/device requirements |
| UX-AM04 | OB-CNS-02–05 / UX-X01–02 | Test exact subject/purpose/expiry review and permission-denied paths on phone/keyboard; explicitly explain retained historical evidence. Real authority and privacy gates stay closed |
| UX-AM05 | MEA-01, roadmap R0 validation | Track five separate task measures with denominator, baseline, sample and evidence type; schedule formative rounds and a genuine 7–14-day retest. No code pass substitutes for human research or core Test 2/Test 5 |
| UX-AM06 | TEN-01/02/03, UI-05 / UX-B02/05/06 | Before real data, add automatic request lookup by a reloaded form (the server journal and Operations already keep received requests), saved views kept on the server for the signed-in person, search text kept out of addresses and return links, and fresh MFA/revocation tests; the build status lists the first three in its Pre-data gate. Do not expand demo personas into production authority |

These are proposals for the next TRD/roadmap revision. No business-plan prices, financial projections, signed rules, regulatory interpretation, activation gate or study target was silently revised.
