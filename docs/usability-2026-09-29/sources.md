# Sources and boundaries for the beginner usability programme

Reviewed 29 September 2026. The implementation baseline is merged PR #78, revision `83eda41dba56da6dfc65a10ce3e228906de17dac`, in `obeidpeter/valo-pay`. This programme starts on `codex/beginner-usability-2026-09-29`. These notes establish the source interpretation; they do not certify the candidate implementation or a new deployment.

The task is to make existing work understandable and recoverable for a person unfamiliar with Valo Pay. Domain knowledge and authority still matter. A beginner explanation must not grant a permission, turn an assessment into a decision, or turn a preparation/export into an external instruction.

## Source inventory and review method

The six supplied Word files were read through extracted body paragraphs and tables. Their originals and complete extracts are retained outside the public repository. The extraction also checked for tracked insertions/deletions and supplementary notes; no tracked edits were present. Source locators below are one-based `w:p` ordinals in `word/document.xml`, including table paragraphs, not rendered page numbers. No claim of Word layout or page-by-page visual review is made; this is a content and requirements review, with no Word edits.

| Source | Version / date | Use in this programme | SHA-256 |
| --- | --- | --- | --- |
| 10 Usability Heuristics for User Interface Design, Jakob Nielsen | Supplied extract, attributed 1 January 1995 | Controlling usability framework; all ten retained below in original order | `4ffba483fa84903abc89d6ed64fbb50df7cbe6f6da81d6eef077d407c0264d18` |
| Valo Pay Business Plan | 3.1 / 26 September 2026 | Product purpose, synthetic/live distinctions, non-custody and commercial ownership | `8d13cdfd1e9537b481f7b3b80bbe5104b8a0ce52cb736f1153c30cee0af03ffe` |
| Valo Pay Technical Requirements | 2.1 / 26 September 2026 | Permitted behaviour, status wording, roles, safety, accessibility and acceptance | `b61fac7c21bc2c25488b596d9f9cdaecce282d713e9cfc5988e1c2fbed987a56` |
| Valo Pay Product Roadmap | 2.1 / 26 September 2026 | Existing synthetic work versus gated future delivery and fallback | `2a969c987877bf5a54acaae086c86eb18340efaf686465afa3048a34b2ce8da3` |
| Valo Pay Marketing and Sales Strategy | 2.1 / 26 September 2026 | Truthful demonstrations, distinct audiences and unsupported claims | `71014855de872ffa84f93e32654f9b7c10cc08f8efd91c9fcf5450a9391af237` |
| Valo Pay Master Document Register | 1.0 / 26 September 2026 | Controlled-document versions, evidence classification and accountable review | `888ba953ee27a93cdf2275c39cef9e88d3c0e1fa8f1e79421d960040bc8a4c8a` |

The supplied versions match the core planning table in [the maintained register](../document-register.md). A filename search of the available Downloads collection found no newer Valo Pay core planning revisions. Higher-numbered documents for the distinct Valo product are not replacements. No independently approved newer controlled Word revision was identified. This conclusion is limited to the available collection and repository, not every possible external document.

Later implementation evidence includes [Connected Banking](../connected-banking.md), [the frontend contract](../frontend-contract.md), [the role/task map](../usability/role-task-map.md), [PR #78 source dispositions](../refactor-2026-09-29/source-status-notes.md) and its [251-requirement catalogue](../refactor-2026-09-29/traceability.json). Actual navigation and display guards were checked in `artifacts/valo-pay/src/App.tsx` and `artifacts/valo-pay/src/lib/permissions.ts`; the server remains authoritative. Tests, browser observations, participant observations and planning targets must retain separate evidence classifications.

## All ten heuristics in the original order

The names and meaning below follow the supplied Nielsen document. The Valo Pay checks are this programme's application, not quotations from Nielsen or universal numerical standards.

| # | Heuristic | Retained meaning | Valo Pay application and boundary |
| --- | --- | --- | --- |
| 1 | Visibility of system status | Tell people what is happening with timely, appropriate feedback. | Keep loading, draft, saved, queued, submitted, unknown and confirmed states distinct. Show source age and a durable result; never invent progress or infer payment from browser return. |
| 2 | Match between system and the real world | Use familiar task language and a natural, meaningful order. | Explain reconciliation as matching payments to bills or repayments. Preserve the formal term where needed. Reading an account is not authority to debit it; an assessment is not a lending decision. |
| 3 | User control and freedom | Make mistaken navigation escapable and support undo/redo where possible. | Provide back, cancel, draft editing and resumable guidance. Warn only for genuinely unsaved work. Submitted external work needs real status/correction handling; never imply leaving cancels it or erase audit history for a cosmetic undo. |
| 4 | Consistency and standards | Use the same meaning and established interaction conventions consistently. | Keep shared navigation, forms and status vocabulary consistent. Save, submit for review, approve, send externally and verify remain different actions. Pair icons and colour with words. |
| 5 | Error prevention | Remove avoidable error conditions or check them before commitment. | Show amount, entity, destination, version and effect for consequential work; preview imports and explain field errors. Preserve single-operation identity, stale-review rejection and independent approval. |
| 6 | Recognition rather than recall | Keep relevant objects, choices and instructions visible or readily available. | Retain customer/reference, amount, selected view and source evidence during review; use names with copyable references. Separate no records, no results, unavailable access and failed loading. |
| 7 | Flexibility and efficiency of use | Support both ordinary routes and optional accelerators for frequent work. | Keep guidance skippable and recoverable, preserve safe views and support keyboard use. No shortcut can bypass permissions, evidence or maker/checker controls. |
| 8 | Aesthetic and minimalist design | Remove irrelevant material so useful information remains prominent. | Give the page a clear purpose and next action; disclose secondary technical detail progressively. Keep fees, missing evidence, stale data and consequences visible. |
| 9 | `Help users recognize, diagnose, and recover from errors` | Explain the problem plainly and offer a constructive solution. | Say what failed, what is known about saving/submission and the safe next step. Unknown financial outcomes recover the original operation; they are not invitations to submit again. |
| 10 | Help and documentation | Make concise, searchable instructions available around the user's task. | Link to the relevant task guide and glossary, state prerequisites/outcomes and blocked routes. Do not advertise a staffed channel or response time without evidence. |

Nielsen source locators: headings at P0005, P0008, P0011, P0014, P0017, P0020, P0023, P0026, P0029 and P0032; explanation paragraphs immediately follow each heading.

## Requirements that constrain the interface

- **Product and evidence:** Business Plan P0101–0111 and Roadmap P0089–0094 distinguish persisted synthetic journeys from live banking, credit decisions, ERP writes, tax filing and payroll execution. Marketing P0004–0006 requires separate offers and claims tied to observed scope. Sample records must remain clearly labelled.
- **Navigation and context:** TRD §12.1, P0678–0680, requires actual entitlement, entity context, recognisable workspaces, human record names, visible status and separate permission purposes. Showing a useful destination does not authorise its records or actions.
- **Review and recovery:** TRD §12.2, P0682–0684, requires exact object/version and effect, stale approval invalidation, precise outcome verbs, recoverable work and safe unknown-outcome handling. Server-confirmed state must support claims such as saved, submitted or not submitted.
- **Accessibility:** TRD §12.3, P0686–0687, requires labelled controls, focus, keyboard completion, status feedback, reflow, contrast and reduced-motion support, alongside independent device and assistive-technology checks. Automated accessibility checks are evidence for their tested conditions, not certification.
- **Current roles:** TRD TEN-02 P0759–0763 names five existing roles and separately proposed expanded capabilities. This programme keeps Admin, Operations, Finance, Compliance reviewer and Read-only. Research cohorts such as payroll checker, applicant or SME finance do not create new application roles.
- **Purposes and financial meaning:** Business Plan P0080–0095 and Roadmap P0080–0082 keep account-read, credit, individual payment, recurring debit, accounting and corporate payout authority separate. Payroll export stays unpaid, an accounting export stays unposted, a VAT schedule stays unfiled, and source balances remain distinct from forecasts.
- **Acceptance:** TRD §13 P0690–0691 and Master Register P0014–0018 require explicit evidence levels. A test, render or synthetic demonstration does not pass a live gate or establish human usability.

## Conflicts and dispositions

| ID | Dated source / discrepancy | Programme disposition |
| --- | --- | --- |
| US-SRC-01 | Word Master Register P0020–0028 and the four planning documents name PR #64 as deployed and #65/#66 as drafts. At the programme start the maintained register named PR #77 as latest and #78 as a candidate. | Resolved in maintained repository guidance during this programme: [build status](../BUILD_STATUS.md), [document register](../document-register.md) and deployment guidance now identify merged/deployed PR #78, `83eda41dba56da6dfc65a10ce3e228906de17dac`, public build `83eda41 2026-09-29T10:26:46.692Z`. The original Word snapshots remain dated evidence; no controlled Word revision is implied. The usability branch remains a candidate. This disposition is not a fresh production probe. |
| US-SRC-02 | Word Master Register P0116 lists migrations 001–012; later code and release records include 013. | Resolved in the maintained [migration catalogue](../database-migrations.md) and release guidance; preserve the dated Word copy. No migration is authorised by usability work; 010–012 remain isolated opt-in staging/rehearsal work. |
| US-SRC-03 | TRD F05 and Roadmap F05 selectors differ; F14 release descriptions also differ. | Carry forward [SRC-03/SRC-04](../refactor-2026-09-29/source-status-notes.md). Product/engineering must reconcile controlled sources before schedule commitments. Do not pull later live features into this programme. |
| US-SRC-04 | Older implementation used a fixed 2027 discount year; Business Plan P0439 and TRD BIL-02 require signed/reviewed contract timing. | The owner explicitly chose **Use reviewed contract dates** for PR #78. Preserve that approved behaviour: future invoices require actual reviewed monthly dates/reference, while issued invoices and linked adjustment rates remain immutable. Do not assign dates, change prices or simplify this review away. |
| US-SRC-05 | Full production isolation/recovery and expanded-role acceptance exceed bounded synthetic code/test evidence. | Keep source requirements and the narrower implemented evidence visible. No wording change may claim those gaps closed or infer new privileges from a chosen goal. |
| US-SRC-06 | TRD API-03 requires keys for mutating public requests; legacy unkeyed v1 calls retain compatibility. | Preserve the outstanding versioned migration in the prior source dispositions. The console's existing keyed recovery must remain safe; this UI programme does not silently break old consumers. |

## Evidence and research limits

The [research kit](research-kit.md) and [empty measurement template](measurement-template.csv) prepare independent first-use testing. No participants were recruited or measured in this source task. Orientation within one minute, 90% unassisted routine-task completion, universal critical-state comprehension among tested participants and average task ease of 4/5 are **user-proposed evaluation targets**, not Nielsen standards or observed results.

External legal, regulatory, provider, tariff, funding and market claims in the planning sources were not reverified in this usability source review. They remain dated source material and owner dependencies. No new live permission, integration, notification, financial instruction, merge or deployment follows from these notes.
