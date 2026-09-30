# Valo Pay usability research kit

Status: **prepared; participant recruitment, sessions and human results pending**. This protocol contains no simulated participants, invented quotations, participant success rates or satisfaction scores. Automated acceptance tests are separate engineering evidence. Use the release audit to identify the exact candidate build before each session.

## Purpose and boundaries

Evaluate learnability, efficiency, memorability, errors and satisfaction separately for the priority journeys J01–J10. The linked [measurement template](measurement-template.csv) has one row for each component in each journey/cohort. J10 is split into credit, forecast, accounting/VAT and payroll; do not combine their results into a single task score.

The five components are NN/G's framing; the proposed targets, task scenarios, cohorts and time limits below are Valo Pay study choices. They are not a weighted NN/G score, certification or demonstrated outcome. [NN/G: Usability 101](https://www.nngroup.com/articles/usability-101-introduction-to-usability/)

Use only the existing authorised synthetic preview, with external instructions disabled. No real applicant, bank, payroll or customer data. No payments, live bank hand-offs, customer messages, accounting posts, tax filings or paid services. A missing real authentication/MFA environment means that part of J01 is **blocked**, not passed. Do not collect a participant's password, MFA code or identity document.

## Recruit actual users, with actual authority

Start with small formative rounds of approximately five participants per materially different priority group where practical. This is a proposed recruitment starting point, not a sample that proves population-wide performance. Record the number invited, eligible, enrolled, completed and withdrawn. Use a researcher to plan subsequent quantitative sample sizes around the required precision, expected baseline rate, effect and available population. Report raw counts and uncertainty with any summary.

| Cohort | Real work experience to recruit | Existing test persona | Tasks |
| --- | --- | --- | --- |
| Collections operators | Daily mandate/exception/import work; mix of first-time Valo Pay users and experienced operators | Operations | J01, J02, J04, J05 operator variant, J07, J08 |
| Lender finance | Receipt matching, instalment allocation, month-end and dispute evidence | Finance | J01, J03, J04, J06, J07, J09 review variant |
| Compliance/risk reviewers | Independent policy/credit review and evidence assessment | Compliance reviewer | J01, J05 independent review, J08 revoke variant, J10a review |
| Administrators | Workspace setup, integrations and operational controls | Admin | J01, J02, J05 author variant, J08; prepare J10 fixtures |
| Occasional readers/support | Periodic reporting or support diagnosis without change authority | Read-only | J01, J04 read variant, J06 where export authorised, J07 read variant |
| SME finance | Cash planning and accounting review | Finance; Operations for maker tasks | J10b, J10c |
| Payroll makers/approvers | Payroll preparation and independent sign-off | Operations maker; separate Finance reviewer | J10d |
| Payers/applicants | People who use bank payment/permission and lending application flows | Research participant with a facilitator-prepared sample only | Comprehension portions of J08/J09/J10a; no claim of production payer/applicant authentication |

Internal support, SME finance, payroll approver, payer and applicant are research cohorts, not newly granted application roles. The implementation currently uses Admin, Operations, Finance, Compliance reviewer and Read-only. Apply existing action and purpose-grant permissions; never switch everyone to Admin to complete the script. A correctly identified lack of authority can be the correct task outcome.

Screen for domain familiarity separately from general software skill, tenure in the actual task, prior Valo Pay exposure, typical device/connection and accessibility needs. Recruit keyboard-only and assistive-technology users where practicable; do not assume one participant represents all disabilities. Offer breaks and accessible consent materials. Do not ask employers to observe identifiable individual performance.

## Session preparation and facilitator script

1. Record build/commit, environment, browser/version, viewport, device type, input/assistive technology, theme, test persona and anonymised fixture ID. Record WAT time basis and whether this is baseline or candidate. Clone/reset the same synthetic fixture before each comparable run; never reset a participant's real workspace.
2. Preflight the authorised sample in each necessary role. Confirm amounts, owners, due dates, proposal evidence, permission expiry and queued exports. Prepare equivalent A/B fixture sets so later participants do not simply remember the answer. Keep task text and financial difficulty comparable.
3. For J03 prepare one correct proposal, one completed-month automatic match needing review, and a separate concurrent-change case. For J06 prepare an interrupted acknowledgement and a saved export job. For J08–J10 prepare purpose-specific permissions and safe blocked variants. Record fixtures and expected outcomes in the private study plan before testing; do not improvise the correct answer afterwards.
4. Say: “We are studying how the product supports your work. We are not assessing you. Use only the sample records provided. You can stop or take a break at any time. Please work as you normally would. I will ask what you expected afterwards.”
5. Obtain participation consent. Request separate, optional recording consent if recording is necessary and already approved. Default to manual observation; no new analytics or unrestricted session recording.
6. In a **formative** session invite think-aloud comments and record diagnostic observations. In a **timed benchmark** ask participants to work normally without concurrent think-aloud; ask retrospective questions after timing stops. Do not mix these times in a before/after comparison.
7. Read one neutral task card. Start the timer when the participant begins, after task understanding is checked. Do not name the button or route they should use. Answer domain clarification neutrally; classify clarification separately from interface coaching.
8. If asked for help, say: “What would you normally try next?” Once navigation or task-solving assistance is provided, mark the attempt assisted. Do not later count it as unassisted. Log exact assistance and the point it occurred.
9. Stop at the predeclared outcome, participant withdrawal, or safe limit. Suggested initial limit: 8 minutes for a routine task, 12 minutes for a comparison/maker-reviewer task; pilot and freeze these limits before benchmarking. A timeout is not success. Pause immediately if real data or external side effects appear.
10. Record the observed server-confirmed result, not just the clicked button or a confident verbal answer. Ask SEQ immediately after the attempt, including failed attempts. Debrief after the response. Administer SUS once after a representative session, then close with neutral custom questions.

NN/G describes usability testing as observing representative users doing realistic tasks with a facilitator; these specific neutral scripts, limits and fixture rules are Valo Pay's proposed application. [Usability Testing 101](https://www.nngroup.com/articles/usability-testing-101/)

## Neutral task cards and objective outcomes

Give participants only the **task** column. Routes, expected outcomes and stop criteria are facilitator notes. Use supplied sample references rather than real names or account numbers.

| ID / entry point | Task to read | Correct outcome / safe stop |
| --- | --- | --- |
| J01 · public page/sign-in/overview | “You are starting work for Cedar Cooperative. Find the work available to your assigned role. Explain which organisation you are in and whether an action here would instruct a real payment. Then return after the provided session interruption.” | Correct lender, role, sandbox and operating-mode interpretation; reaches permitted work. On expiry, authenticates through the authorised test provider if available and checks outcome before resubmission. Never shares credentials or treats observation mode as forbidding all reconciliation writes. Unavailable auth/MFA is recorded as blocked coverage. |
| J02 · import entry from relevant record page | “Add the supplied sample file. Some entries may need attention. Decide what can be accepted, correct the file as needed, and tell us what was added and what was not.” | Chooses correct import type, row ID column and mapping, notices invalid rows, uses existing preview/all-or-partial contract correctly, submits valid records once, explains saved/rejected/pending results. Interrupted-response variant uses safe original-request recovery; no duplicate records. |
| J03 · reconciliation | “A receipt may belong to the supplied instalment. Decide whether it should be applied and explain your evidence. Then review the sample automatic match flagged by Finance.” | Compares person/reference, amount, available credit, outstanding and matching reason; distinguishes receipt/settlement and fee treatment. Correct proposal applied/rejected with reason. Incorrect audited match superseded only after examining its financial effect. In changed-proposal variant stops at conflict, refreshes and reviews again; never forces the old amount. |
| J04 · exceptions | “Find the work owned by Finance that needs attention for the sample case. Review its history, record the appropriate outcome if your role permits it, and return to the same queue.” | Filters/owner/deadline understood; full notes and linked evidence examined; allowed resolution is committed with a specific reason and correct code. No claim that resolving itself refunds/allocates/reissues. Returns to original owner/type/view. Read-only variant explains required authority without attempting a workaround. |
| J05 · policies/collections | “The supplied policy change is awaiting review. Decide whether you can approve it, explain what would change, and determine whether the sample instalment is eligible for another attempt.” | Independent authorised reviewer checks version/scope/evidence; author cannot self-approve. Existing notice evidence, ownership, quiet hours, attempt caps, kill switch and unknown-outcome blocks remain. Correct refusal or escalation counts as success in blocked variants. No actual debit initiated. |
| J06 · customer timeline/export | “Prepare an evidence file for the supplied customer. The connection may be interrupted. Find out whether the request was saved and obtain the correct file when available.” | Correct customer/lender/format; follows queued or failed job state; checks saved job or retries original uncertain request; does not switch format to bypass recovery. Download matches selected pack and current permission. Explains lack of advertised expiry, checksum/access information and inability to recall an already downloaded copy. |
| J07 · reports | “You are returning at month-end. Find the relevant closing records for the supplied dates and explain what is still incomplete. Complete today's sample close if your role allows it.” | Uses correct report view and WAT date range; distinguishes current totals from historical closes and sample evidence from real performance. Run close result is verified by its saved record. On uncertainty checks records before retry. Reader variant retrieves the same period without writing. |
| J08 · connections | “The sample organisation needs account information for a particular purpose. Grant only what is needed for that purpose. Later, stop further access for that purpose and explain what remains on record.” | Correct subject, purpose and duration; account-data permission distinguished from payment authorisation. Revocation recorded using authorised role; no assertion that prior records/downloaded evidence are erased. Denied/expired grant blocks dependent new work. |
| J09 · Pay-by-bank | “Review the supplied sample checkout. After returning from the bank step, establish whether the merchant has actually received the payment. Explain what to do if the result is uncertain or a refund is requested.” | Checks beneficiary/amount/fees; bank return alone not treated as received. Pending/unknown checked through receipt evidence; no duplicate checkout or refund claimed. Refund request and independent Finance confirmation kept separate. Payer cohort tests comprehension only; no production bank route implied. |
| J10a · Credit Desk | “Prepare a sample assessment from the supplied information and explain whether the result supports a lending decision. Review the insufficient-data case as well.” | Separate data-read and assessment permissions; insufficient data distinguished from low output; sample/unvalidated model limits explained; assessment not a lender approval. Separate eligible reviewer handles decision and evidence; maker cannot self-review. |
| J10b · Cash Desk forecast | “Determine what cash is available now and what the base and downside forecasts suggest for the supplied date. Explain the assumptions and any stale information.” | Actual available cash distinguished from projections; exact currency/amount, scenario, date and freshness understood. Refresh/stop at invalid or expired source data; does not treat a forecast as spendable funds. |
| J10c · Cash Desk accounting/VAT | “Review the proposed accounting treatment and VAT evidence for the supplied sample receipts. Prepare only the supported output when you have authority.” | Reviews classifications/exclusions; bank credit not automatically assumed taxable revenue. Draft/suggestion and evidence export distinguished from a posted ledger entry or filed return. Finance reviews/exports, maker does not bypass separation. No live ERP or tax submission. |
| J10d · Cash Desk payroll | “Prepare or review the supplied sample payroll according to your assigned role. Explain what has been approved, what has been scheduled and whether anyone has been paid.” | Correct permission, organisation, beneficiary references, date and total; independent Finance approval where required; stale evidence blocks unsafe approval. File/schedule/approval not represented as completed payouts. No live salary instruction. |

J10a–d are separate subtask records with distinct role cohorts and denominators. Assign a manageable role-relevant subset per session; nobody needs to complete every task. Predeclare reading-only and blocked variants so a safe stop is evaluated consistently.

## Measurement definitions and targets

All baselines/results are **not measured** until genuine sessions occur. Use one raw observation per participant, build, journey variant and attempt. Retain failures, assistance, blocks and withdrawals; do not discard slow or unsuccessful attempts to improve the headline.

| Component | Operational measure and denominator | Proposed project target / interpretation |
| --- | --- | --- |
| Learnability | First-attempt correct unassisted outcomes / all eligible first attempts for that task and cohort. Include intended safe stops; report system-blocked setup separately. Also record active seconds to first correct outcome, help requests and misconceptions. | About 90% unassisted completion, refined before comparable quantitative testing. No claim that a five-person round establishes this rate. |
| Efficiency | Median active task seconds among comparable successful learned attempts; report success rate, total elapsed time, system/provider wait, manual steps, re-entry and corrections separately. A step is one intentional navigation, entry, selection or submission; record definition changes. | About 20% reduction in avoidable active time only where baseline friction is established. Preserve required review; no time target overrides correctness. |
| Memorability | Correct unassisted delayed outcomes / eligible returning participants; compare each person's result, assistance count and active time with their earlier learned attempt. Report attrition and intervening practice separately. | Retain return-task success without extra assistance. Exact allowed time change to be set before data collection; no pretend “memory score”. |
| Errors | Errors / predeclared error opportunities for each variant; log severity 0–4, type, detection and recovery. Safe recovery rate = correctly recovered error episodes / recoverable episodes. Recovery seconds start at detection. Report near misses separately. | No unresolved critical financial/privacy defect in tested release scope; exact human sample and opportunities always stated. Zero observed errors does not mean zero risk. |
| Satisfaction | SEQ per attempted task (1–7); SUS once per representative session (0–100), both with response n and missing answers. Record custom confidence/frustration comments separately. | Improve comparable task ease/session perceived usability without sacrificing accuracy. No invented baseline, minimum “certified” score or blend with other components. |

For error opportunities, freeze the checklist before sessions: J01 lender/role/mode and expiry decisions; J02 mapping/invalid-row/commit/retry decisions; J03 identity/amount/proposal/correction decisions; J04 owner/deadline/outcome/return; J05 authority/version/retry preconditions; J06 customer/format/status/recovery; J07 period/close-state/retry; J08 subject/purpose/duration/revocation; J09 beneficiary/amount/receipt/refund; each J10 subtask's distinct permission/evidence/interpretation/approval checks. Count each listed decision at most once per occurrence; repeated attempts are linked episodes, not silently expanded denominators.

Severity uses NN/G's 0–4 convention, with frequency, impact and persistence considered. Two reviewers should adjudicate consequential disagreements; keep the rationale rather than multiplying ordinal scores. This is an expert judgement method, not a numeric financial risk model. [Severity Ratings for Usability Problems](https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/)

## Comparable sessions and delayed retest

- **First-use:** recruit fresh Valo Pay novices within each domain cohort. A participant cannot be a fresh novice for both baseline and candidate. Use comparable independent novice groups, balanced on domain experience and accessibility needs; report imbalance.
- **Learned efficiency:** give both versions the same practice opportunity and clear criterion for task familiarity. Use equivalent fixtures and counterbalance version/task order (for example AB/BA) when the same people compare versions. Analyse practice/order effects; do not compare first-use think-aloud baseline to practised silent candidate.
- **Memorability:** provisionally invite the same participants back after 7–14 days without intervening Valo Pay practice. Record actual interval and any exposure. Use equivalent task data, same role/device when feasible and no refresher tour or coaching. Keep exposed participants as a labelled separate group. Do not call an immediate repeated browser script a memorability test.
- **Connectivity:** label normal, throttled and interrupted sessions separately. Record start/end of browser/API wait. A waiting period must be observable in the UI or network log; do not subtract thinking time as “network wait”. Compare matching conditions.
- **Accessibility/device:** include desktop/tablet operational comparisons and phone payer/approval tasks, both themes and relevant keyboard/assistive technology. Emulation and physical-device evidence remain separate. Failure criteria include loss of critical amounts, focus, labels or actions. Automated checks supplement manual observation; they do not certify WCAG 2.2 AA. [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- Freeze tasks, targets, exclusions and analysis plan before the benchmark. Any later change gets a dated amendment and reason; do not silently loosen a target after an unfavourable result.

## Questionnaires ready for administration

### After each attempt: SEQ

Ask exactly: **“Overall, how difficult or easy was the task to complete?”** Show seven response positions, **1 Very difficult** through **7 Very easy**. Allow a skipped answer; do not infer one from performance. Record the original response immediately, before debrief or praise. This is a task-ease measure, not an accuracy assessment. Use the same direction/wording for both versions. [MeasuringU: Single Ease Question](https://measuringu.com/seq10/)

Recording line: `participant_code ____  build ____  journey/variant ____  SEQ (1–7 or missing) ____  reason in participant's own words (optional, consented) ____`

### After the representative session: SUS

Open the [standard ten-item SUS questionnaire shown by NN/G](https://www.nngroup.com/articles/measuring-perceived-usability/#the-system-usability-scale-sus-post-test-assessment-of-usability) and present the unmodified wording/order, with five agreement positions from strongly disagree to strongly agree. The full instrument is linked rather than replaced with paraphrased questions. Ask for their overall impression of the version just used; collect before a group debrief or showing others' opinions. Do not coach the meaning of an answer. [NN/G instrument guidance](https://www.nngroup.com/articles/measuring-perceived-usability/)

Response sheet: `participant_code ____  build ____  session cohort ____  Q1 ____ Q2 ____ Q3 ____ Q4 ____ Q5 ____ Q6 ____ Q7 ____ Q8 ____ Q9 ____ Q10 ____  complete? ____`

Score each complete response: odd-numbered items contribute response minus 1; even-numbered items contribute 5 minus response. Sum the ten contributions and multiply by 2.5. Keep all raw responses; a missing item means unscored unless an alternative missing-data rule was declared before testing. Report the 0–100 score and response n; it is **not a percentage of satisfied users**. [MeasuringU: SUS scoring](https://measuringu.com/sus/)

The SEQ and SUS serve different task/session purposes and should accompany observed performance. Five formative participants' ratings may diagnose questions to pursue but do not establish a precise population benchmark. Human SEQ/SUS values in this repository remain pending.

### Custom debrief, recorded separately

Ask: “What did you expect would happen?” “What tells you the action finished?” “Was anything unclear about your authority or the evidence?” “What would you check before doing this in your own work?” “Which part took more effort than you expected?” These are original Valo Pay research questions. Do not label their responses SEQ or SUS, calculate a combined trust score or reinterpret confidence as correctness.

## Minimal manual recording template

Keep raw participant records outside the public repository in an access-controlled research location agreed before recruitment. The checked-in CSV is an empty scorecard plan, not a place to upload participant recordings or financial records.

| Field | Allowed entry |
| --- | --- |
| Session | Random participant code; cohort; test persona; domain experience band; Valo Pay exposure band; consent status |
| Build and setup | Exact source/build; synthetic fixture code; baseline/candidate; date/time; timezone; browser/version; viewport; emulated/physical; keyboard/assistive tech; theme; connection condition |
| Attempt | Journey/subtask/variant; first-use/learned/delayed; order; start/end; elapsed seconds; observed system/provider wait seconds; active seconds; manual steps; re-entry count |
| Outcome | Correct unassisted / correct assisted / safe stop / incorrect / unfinished / setup blocked / withdrew; authoritative synthetic outcome reference (no full payload) |
| Help/errors | Domain clarification count; navigation help count; predeclared opportunity count; errors by type/severity; near misses; detection; recovery outcome/time; issue ID |
| Questionnaires | SEQ raw value or missing; ten SUS raw responses in private session record; computed SUS or unscored; custom comments separately |
| Retest | Original session code; actual interval; exposure since; paired outcome/assistance/time; attrition reason if volunteered |
| Evidence | Redacted observation/screenshot reference; reviewer; evidence classification (human observation / self-report / engineering / hypothesis); protocol amendment |

Use synthetic fixture codes and aggregated validation categories, never raw account numbers, transaction narration, consent text, credit features, payroll rows, keys or unrestricted screen replay. Do not record real credentials. Obtain the study owner's retention/access/deletion decision before collecting personal data; no new external service is authorised here. Screen recordings require a distinct justified approval and consent. Report quotations only when genuine, permitted and anonymised.

## Analysis and hand-off checklist

Keep denominators and samples visible by role, journey, variant, device and study phase. Show raw success/assistance counts, median and spread of comparable times, error opportunities and severity, SEQ distributions, SUS response n and uncertainty. Mark unknown or unrun cells **not measured**, not zero. Do not pool incompatible J10 cohorts or hide a critical defect in an average.

For each finding retain the observed step, expected outcome, evidence reference, source guidance if relevant, five-component effect, severity rationale, fix/deferral and retest result. Human observations can support learnability/memorability/satisfaction claims only after actual sessions; engineering tests support specified behaviour and safeguards. Compare against the frozen project targets without claiming all users or all devices are covered.

Current genuine human findings: **none collected**. Recruitment, novice rounds, practised timing, delayed retests, assistive-technology sessions, physical-device tests and questionnaires are pending. The kit can be used after the controlled preview passes its engineering release checks.
