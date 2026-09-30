# Roles, workflow inventory and priority tasks

## Verified authority

The deployed sandbox has five personas: **Admin, Operations, Finance, Compliance reviewer and Read-only**. The server creates an actor such as Sandbox Finance, and that is the persona's only name: the history records its changes under it, and the case assignees and close reviewers list it the same way (they used to say Demo Finance). Switching a persona is a demonstration of role rules, not a real staff appointment, identity proof or MFA acceptance. Source: `artifacts/api-server/src/lib/valopay-store.ts`, `artifacts/api-server/src/domain/actions.ts`, `artifacts/valo-pay/src/lib/permissions.ts` and the three connected domain services.

| Persona / audience | Existing authority and useful work | Boundary |
| --- | --- | --- |
| Admin | Setup, customer/mandate work, imports, reconciliation, exceptions, draft policies, connected preparation | Cannot replace an independent Compliance policy review or Finance-only ERP/payroll review |
| Operations | Customers, mandates, imports, collection follow-up, reconciliation runs, exceptions, connected preparation | Cannot confirm payment allocations, edit settings or approve their own prepared work |
| Finance | Customer/due-item/import work, allocation decisions, precision review, close/billing, cash forecast, independent ERP/payroll review | No permission grant, credit preparation or policy authorship; authority and purpose are rechecked on the server |
| Compliance reviewer | Policy/template review, evidence review, permitted exception editing, permission revocation and independent credit review | Not a general operational writer; cannot approve own work or resolve exceptions through an unlisted action |
| Read-only | Inspect available sandbox records, evidence and status | No mutations; disabled controls explain required roles. Read access is still tenant-scoped |
| Internal support | No independent support-console role was found | Use existing operational runbooks and restricted support references; do not invent impersonation or privileged customer access |
| Payer / applicant | Represented by sample checkout and applicant scenarios inside the operator console | No verified public payer bank hand-off, applicant portal or real bank authentication in this build |
| SME finance / payroll checker | Exercised through Finance; preparation through Admin/Operations, with separate purpose grants | Named production Credit/Cash/Payroll capabilities in TRD v2.0 remain proposed. No new broad role was added |

The matrix describes the inspected implementation, not the broader intended production model. All allowed writes still require current record state, correct lender, evidence, purpose and independent actor where applicable.

## Ten priority journeys

Frequency, active effort and pain below are **expert hypotheses**, not telemetry. Effort bands mean short (one focused task), medium (comparison/correction), or long (multiple independent review steps); they are not measured times. High consequence warrants review even when a task is occasional. Each journey has all five measurement components in the research kit.

| Journey / role | Goal and entry | Frequency / effort hypothesis | Preconditions and available authority | Error consequence / expected correct outcome |
| --- | --- | --- | --- | --- |
| J01 · all personas | Enter or return to the right lender from sign-in/sandbox; use Overview | Every session / short | Account-linked and anonymous workspaces remain separate; role loaded before writes | Wrong lender or mistaken authority; correct lender, demo role, observation mode and next permitted queue understood |
| J02 · Admin, Operations, Finance | Check, correct and import a synthetic CSV from Collections | Periodic/batch / medium | One supported kind, explicit source amount unit, all new rows valid; no live data | Duplicate/wrong amount; exact check/commit/duplicate counts and one original write after lost response |
| J03 · Finance, Admin | Review proposed match and audit a prior automatic match in Reconciliation | Daily, audit monthly / medium | Both records, receipt/settlement basis, current proposal and outstanding ceiling; reason required | Wrong instalment credit or double application; reviewed proposal only, authoritative outcome or safe conflict |
| J04 · Operations, Finance, Admin | Filter Exceptions, inspect issue/customer, record resolution and return | Daily / medium | Owner/type/deadline context, permitted resolution, retained reason | Premature resolution without financial correction; committed exception outcome and same queue context |
| J05 · Admin author + independent Compliance reviewer; Operations applies | Compare a policy version, review it and understand retry blockers | Occasional / long | Author/version, independent reviewer, notice and consent, limits, ownership and stop controls | Unsafe retry policy; appropriate review or correctly stopped action, no implied customer notification |
| J06 · authorised sandbox reader/reviewer | Find a customer and request/recover an audit export | Occasional / medium | Correct customer/lender/format; server checks every download | Wrong-person pack or duplicate requests; saved job status, correct file and honest availability explanation |
| J07 · Admin, Operations, Finance | Run/revisit daily close and inspect period evidence in Reports | Daily/month-end / medium | Close service status distinct from preference; permitted manual action | Mistaking queued/preference state for completed close; dated committed snapshot with unresolved items visible |
| J08 · Admin/Operations grant, Compliance also revoke | Choose a subject/purpose and review revocation in Permissions & readiness | Setup/occasional / medium | Explicit subject and purpose, expiry, reason; no inferred payment authority | Wrong-person consent change; exact scope understood and new dependent work blocked after revocation |
| J09 · Admin/Operations prepare; Finance independently adjusts | Create sample checkout, inspect bank return and unknown outcome | Recurring / medium | Eligible instalment, full amount, server beneficiary, separate one-time permission | Duplicate collection or false paid state; return stays pending and unknown holds new collection until receipt evidence |
| J10a · Admin/Operations + independent reviewer | Prepare Credit Desk assessment and reasoned lender review | Per application / long | Separate account-read and assessment permissions, exact repayment inputs, source quality and model limits | Missing data mistaken for low risk; blocked/usable assessment correctly interpreted; decision separate from score |
| J10b · Admin/Operations/Finance | Inspect and save a Cash Desk forecast | Daily/weekly / medium | Business read grant, legal entity, timestamp, explicit assumptions | Forecast mistaken for spendable cash; committed version and full planning amounts visible |
| J10c · preparation + Finance checker | Prepare/review accounting and VAT evidence | Month-end / long | Separate purpose grants, valid mapping/period, independent review | Wrong company/posting; export remains not posted and tax evidence is not a filed return |
| J10d · preparation + Finance checker | Prepare/review payroll funding and item outcomes | Payroll / long | Separate business-read/payroll grants, approved net pay, independent review | Duplicate/wrong payment; funding/export is not payment, unknown items remain held |

J10 is a family, not a pooled outcome: test and report credit, forecast, accounting, VAT and payroll separately with the relevant specialists. The ten-journey selection is not a claim that one participant should perform every task.

## Whole-product inventory

| Surface | Inspected implementation / state | Coverage and remaining boundary |
| --- | --- | --- |
| Landing, sign-in, sign-up | Existing four-workspace public design and Clerk entry; public visit creates no workspace | Source and local browser regression; actual authenticated MFA/recovery and password-manager testing need a controlled account and assistive-technology session |
| Overview, onboarding, lender selection | Action queues, optional five-step guide, daily-close state, two sample lenders | Existing task links retained; role/mode/time context corrected. No compulsory tour or dynamic menu reorder |
| Customers and timeline | Paged scoped search, masked sample identity, linked history, dispute packs | Captured and regression-tested; temporary load failure remains distinct from missing record |
| Mandates, Collections | Activation/status actions, due items, attempts/retries, source imports, ownership controls | Shared forms and custom mandate creation recover unknown results; policy/notice/kill-switch guards retained |
| Reconciliation and payments | Paged proposals, unallocated receipts, observations, duplicates, audit sample and batches | Decision evidence and bounded backend race/ceiling fixes. No new financial engine |
| Exceptions | Owner/type/deadline filters, customer context, edit/resolve | Notes, result-panel semantics and safe filtered return improved |
| Policies & templates | Draft/version diff, independent review, test explanations | Existing policy workflow retained; shared correction/recovery improved. No signed rule change |
| Reports, Evidence, Audit | Close history, billing, gate register, saved exports, audit verification | Export uncertainty fixed; no new readiness/precision claims or invented export expiry |
| Settings/integrations | Persona, collection preferences, stop switch, test adapter status | Custom save recovery, current mode/authority context. Paystack remains unverified without a test key |
| Connections/permissions | Synthetic grants/revocation, explicit readiness gates | Role-aware actions and exact scope review. No real bank link/token flow |
| Pay-by-bank | Bound synthetic intent, receipt reconciliation, unknown hold, reviewed refund evidence | Permission/money/recovery improvements; real provider hand-off/callback verification gated |
| Credit Desk | Synthetic rule scoring/capacity, source quality, versioned review | Exact amounts and keyboard tabs; model validation, real applicant data and live decisions gated |
| Cash Desk | Synthetic SME accounts, forecast, ERP draft, VAT evidence, payroll plan/export/outcomes | Exact amount/review feedback/recovery; Xero writes, tax submission and corporate payouts gated |

Source and synthetic inspection cannot establish production frequency, live bank coverage, physical-device usability, staffed support response or human task performance. Those limits are retained in the release checklist.
