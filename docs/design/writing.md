# Writing for Valo Pay

This guide sets how Valo Pay speaks. It covers every word a person reads: the landing page, sign-in, the console, help, notices, the service's messages, prepared files and the sample records. A change to visible text follows it. A change to a name or a term changes this guide first, in the same pull request.

## Who reads it

Collections staff at Nigerian lenders and cooperatives, credit and risk reviewers, finance teams at small businesses, Admins, and first-time visitors. Many read on phones. Many read English as a second or third language. Most are not engineers.

## How to write

1. **Lead with what matters.** Put the point, the result or the action first. Background comes after it, or in help.
2. **Keep sentences short.** Aim for 20 words or fewer. Never more than 30. One idea per sentence.
3. **Use everyday words.** Use the words in the terms table below. Do not show engineering words. If a precise term is needed, use the term from the table and explain it once in Terms explained.
4. **Say who does what.** Use the active voice. Speak to the reader as "you". Name the role when a role must act.
5. **Say what to do next.** Every error, refusal, empty list and warning says what happened and what the reader can do.
6. **Say it once.** Put a limit next to the choice it affects, once. Do not repeat it in every paragraph.
7. **Be positive and direct.** No double negatives. No legal phrasing such as "does not establish" or "no result authorises".
8. **Write British English.** Organisation, authorise, colour, cancelled, programme, instalment, licence (noun).

## What must always stay true

Shorten these statements, but never weaken or drop one where it applies. Use these words for them.

| Fact | Wording |
| --- | --- |
| Valo Pay never holds money | "Valo Pay never holds money." |
| Sample data only | "Sample data only." Explain once, where a visitor first meets it: "Sample data is made up. It is not real customers or money." |
| Nothing real happens in the sandbox or your workspace | "Live payments and bank connections are switched off." |
| Nothing moved | "No money moved." · "Nothing was sent to a bank." · "Nothing was posted to accounting software." · "No VAT return was filed and no tax was paid." · "No one has been paid." |
| Credit results | "A credit result is not a lending decision." |
| Second-person review | "A different person must review it." Where it matters: "Switching demo roles is not a second person." |
| Permissions | "Permission to read an account is not permission to take money from it." |

## Who speaks

- **Valo Pay** for facts about the system: "Valo Pay has not received this request."
- **We** only in the headings of failures: "We could not load your work."
- Never "the service", "the server", "the console", "the application" or "the platform".
- For problems a lender cannot fix, point to **the Valo Pay team**: "If this keeps happening, contact the Valo Pay team."

## Names

A page has one name. The navigation label, the page heading, the browser title ("{name} · Valo Pay"), the help destination and every link to it use exactly that name, with its capital letter. Write "and", never "&".

### Products

The landing page offers four **products**: **Collections**, **Pay by Bank**, **Credit Desk** and **Cash Desk**. Write them with capitals, as names. In a sentence: "a Pay by Bank checkout". The console groups the last three under **Connected banking**.

### The places

| Name | Meaning |
| --- | --- |
| **sandbox** | The practice workspace you can open without an account. It holds sample data, is kept in this browser and may be deleted after 30 days without changes. |
| **your workspace** | The workspace linked to your account when you sign in. In this release it also holds sample data only. Work you do in the sandbox is not copied to it. |
| **pilot** | A real trial with a lender's named staff, agreed with the Valo Pay team. |
| **lender** | The business whose records you are working on. The console shows it as **Active lender**. |

Do not use "workspace" for a product or for Valo Pay as a whole. Do not use "console", "environment", "host", "tenant", "merchant" or "persona" in reader text.

### Pages

| Group | Pages |
| --- | --- |
| Daily work | Overview · My work · Exceptions · Reconciliation · Collections · Import batches · Close review |
| Customers and policies | Customers · Mandates · Policies and templates |
| Connected banking | Pay by Bank · Credit Desk · Cash Desk · Permissions and readiness |
| Oversight | Reports · Saved exports · Audit log · Go-live evidence |
| Setup and administration | Pilot journey · Data sources · Request history · Team and access · Data retention · Settings · Presentation |

Other pages: **Help** (tabs **Task guides** and **Terms explained**), **Case** (one exception's case, under Exceptions), **Customer history** (one customer, under Customers), **Sign in**, **Create an account**, **Accept your invitation**, **Page not found**.

Request history was called Operations. "Operations" is now only a role.

Sections named in the navigation of a page use the same words as the heading they open. Cash Desk's sections are **Cash and forecast**, **Accounting**, **VAT evidence** and **Payroll funding**. Reports' views are **Totals and closes**, **Billing** and **Pilot results**.

## People and roles

| Use | Meaning | Do not use |
| --- | --- | --- |
| **customer** | A person or business that owes a lender money | borrower, obligor |
| **applicant** | A customer being assessed, in Credit Desk only. Say once: "Applicants are your customers." | |
| **payer** | Whoever sent a payment, before it is linked to a customer | |
| **team member** | A person who uses Valo Pay for a lender | user, staff user, teammate, colleague, persona, operator |
| **Admin, Operations, Finance, Compliance reviewer, Read-only** | The five roles, always with a capital, exactly as the role chip shows them. In a sentence: "an Admin", "a Finance team member". | administrator (for the role), checker, maker, assessor |
| **demo role** | The role you switch to in the sandbox, in Settings | workspace role selector, persona |
| **preparer** and **reviewer** | The person who prepares work and the different person who reviews it | maker, checker, assessor |
| **the Valo Pay team** | The people who run Valo Pay | operator, platform operator, support (unless a named route exists) |

In a refusal, write role names exactly as listed, with no article: "Only Admin or Finance can …".

## Terms

Use the word in the first column. Terms explained defines each one in plain words.

### Collections

| Use | Meaning | Do not use |
| --- | --- | --- |
| **instalment** | An amount a customer owes on a set date | repayment, bill, due item, obligation |
| **payment** | Money a customer paid | receipt (except in Cash Desk accounting), credit, funds |
| **collection** | The work of getting payments; also the Collections page | |
| **collection attempt** | One try to take a payment from a customer's account. "Failed collection attempt" | debit attempt, failed collection |
| **retry** | Trying a collection again | re-present |
| **retry policy** | The rules for when and how often to retry | retry rules, collection rules, collection policy |
| **message template** | The reviewed wording of a customer message | notification template |
| **mandate** | A customer's permission for recurring bank debits. Actions: suspend, resume, cancel, reissue | pause |
| **payment evidence** | A record of a payment from a bank statement, a settlement report or a provider notification | observation, source record, webhook |
| **match** | A pairing of a payment with an instalment that Valo Pay found. "Matches to review", "Confirm match", "Reject match" | |
| **allocate** | Put a payment's money against an instalment yourself. "Allocate payment", "unallocated" | apply, assign, credit, unapplied, unmatched |
| **outstanding** | The amount still owed on an instalment. "Unpaid" is a status | still due, residual |
| **possible duplicate** | A payment that may have been counted twice | suspected duplicate |
| **exception** | Something that needs a person to review and resolve it | issue, item |
| **case** | Who owns one exception, its next step and its handover history | |
| **next step** | What happens next on a case | next action |
| **handover** | Passing a case to another team member | (for collection transfer) |
| **collection transfer** | The agreement that moves collection work to Valo Pay; **return collection** hands it back | cutover, hand-back, fallback owner |
| **emergency stop** | The control that stops all collection instructions. Turn it **on** or **off** | kill switch, activate, deactivate |
| **Resolved** / **Closed automatically** | A person chose an outcome / Valo Pay closed it because its cause went away | condition cleared |
| **daily close** | The saved record of the day's reconciliation results and open exceptions | snapshot, close snapshot, closing positions, close statement |
| **close review** | A Finance team member's check of a daily close | Finance close review |
| **difference** | An amount that must be explained | discrepancy, variance, issue |
| **before fees**, **fee**, **after fees** | Settlement amounts | gross, net |
| **Certain** / **Probable** | How sure a match is | high-confidence |

### Data and records

| Use | Meaning | Do not use |
| --- | --- | --- |
| **import batch** | A saved file with its column mapping and row checks | source batch |
| **import**, **imported** | Accept a checked batch into Valo Pay. "Import checked batch", "Imported", "Last imported" | commit, committed |
| **data source** | A place files come from, such as a bank or Paystack | |
| **source profile** | The saved settings for one data source | reusable mapping, saved mapping |
| **expected files** | The files you expect from a source for a date | declaration, expectations, control totals, completeness |
| **source row ID** | A row's own ID in the source file | row identity, source identity |
| **version** | A saved version of something | revision |
| **export** | A file Valo Pay prepares from your records; they are kept on Saved exports | job, prepared file, request (for an export) |
| **deletion run** | An approved set of items to delete | retention run |
| **deletion record** | The record that proves an item was deleted | receipt, deletion receipt |
| **audit log** | The record of every change | audit trail, audit record |
| **billing month** | The month an invoice covers | billing period, invoice period |
| **evidence** | Proof that people add or export, such as the evidence register or an evidence pack | (do not use it for measured results) |
| **results** | Measured outcomes, such as pilot results | evidence |

### Connected banking

| Use | Meaning | Do not use |
| --- | --- | --- |
| **checkout** | A request for a customer to pay one instalment from their bank | request to pay, payment intent, journey |
| **authorise** | Only what a customer does at their bank to approve a payment | (for staff or permissions) |
| **approve** | What a staff member does to accept work | authorise |
| **permission** | A recorded agreement for one purpose. Verbs: **grant** and **withdraw**. Statuses: **Active**, **Withdrawn**, **Expired** | consent, authority, revoke, enable, restore |
| **Read applicant accounts**, **Assess an application**, **Read business accounts**, **Prepare accounting drafts and VAT schedules**, **Prepare payroll funding** | The names of the permissions | account-read consent, SME erp draft permission |
| **confirmed** | A payment the bank or provider has confirmed | verified |
| **outcome** | What happened to a payment. "Outcome unknown" when the bank or provider has not said yet | result |
| **loan amount** | The amount an applicant asks to borrow | principal |
| **affordability check** | Whether an applicant can afford the repayments | capacity, debt-service |
| **transactions** | The bank transactions an assessment reads | observations |
| **score** | The sample rule score. Where it is introduced: "Sample rule score (not validated)" | rulecard |
| **accounting software** | The lender's or business's accounting system; name Xero when it is meant | ERP, accounting system |
| **export file** | The file Cash Desk prepares for accounting or payroll | manifest, review file |
| **VAT schedule** | The file VAT evidence prepares | review schedule, sample schedule |
| **amount still owed** | What is left to pay on an invoice | residual |
| **sample business** | Cash Desk's made-up small business | SME entity, legal entity |

### Words for sample and real

| Use | Meaning | Do not use |
| --- | --- | --- |
| **sample data**, **sample records** | Made-up records | synthetic (except in Terms explained), illustrative, fixture, rehearsal |
| **simulate** | A button that pretends a bank or provider event | |
| **live** | The future real service: "live payments", "live use" | |

### Things never shown to readers

Do not show these words or values in reader text: principal, digest, snapshot, payload, idempotency, journal, lease, tombstone, fingerprint, hash, checksum, provenance, canonical, schema, record kind, basis, projection, worker, job, build, host, webhook, adapter, provision, MFA, and raw codes such as `review_pending` or route names.

The exception: where an auditor needs a checksum or a hash, show it inside a **Technical details** section that is closed by default, with one plain sentence saying what it is for.

## Patterns

### Page headings and descriptions

- The page heading is the page's name. No eyebrow above it.
- The line under the navigation label says what the page is for, in one sentence that starts with a verb. A page's own introduction adds only what the reader needs before starting, and never repeats that line.
- Headings are in sentence case. Product names keep their capitals.
- No instructions inside headings. Counts go in brackets: "Issued invoices (3)".
- No CSS that changes the case of headings or status words.

### Buttons and links

- A button is a verb and its object, in sentence case, with no full stop: "Import checked batch", "Turn on emergency stop".
- The button that opens a dialog, the dialog's title and the dialog's submit button use the same verb and object. The title may be a question: "Approve accounting draft?" with the button "Approve draft".
- An edit form is titled "Edit {thing}", and its submit button says "Save changes".
- The busy label repeats the verb: "Importing…", "Saving…", "Checking original request…".
- **Add** a record you type in or an item in a list. **Create** a new top-level thing: a lender, an invitation, a checkout. **Draft** a new version of a policy or a template. **Run** a process: reconciliation, a daily close, a test, an assessment. **Record** something that happened elsewhere: a refund, a reminder, a notice.
- A reviewer **Approves** or **Rejects**. The person who asked may **Withdraw**. Discount dates are the one exception: a second person **confirms** them against the signed agreement.
- Go to a page with "Open {page name}". Return with "Back to {page name}". Use "Review" only when the reader must decide something.
- Dismiss with **Cancel**. If the action itself cancels something, dismiss with "Keep {thing}".
- "Try again" repeats something that failed. "Check original request" asks about a request whose answer was lost.

### Notices

| Kind | Title | Body |
| --- | --- | --- |
| Done | "{Thing} {done}": "Settings saved", "Batch imported" | Where to see it, if not on screen |
| Problem | "{Thing} not {done}": "Settings not saved" | Why, in a few words, then what to do |
| Could not load | "We could not load {thing}" | The reason if known, then "Try again" |
| Request not confirmed | "Request not confirmed" | "We do not know yet whether Valo Pay saved this. Check the original request before you change anything." Buttons: "Check original request", "Open Request history" |
| Refusal | Say what the reader cannot do | "Only {roles} can {action}. Your role is {role}." In the sandbox add: "Change your demo role in Settings." |

Under a disabled button, say only "Only {roles} can {action}." and any specific reason. The bar above every page shows the reader's role and, in the sandbox, a link to change it.

Use at most one reassurance line, worded the same everywhere: "Nothing has changed."

### Empty lists

- "No {things} yet" when nothing exists; "No {things} match your search" or "No {things} match these filters" after a search or filter.
- Then one sentence that names the button or link that helps: "Select Add evidence to record the first one."
- When nothing is needed, say so plainly: "Nothing to adjust this month."

### Confirmation dialogs

- Title: a question with the action and the object: "Return collection to the previous owner?"
- First line: what will happen. Second line: what cannot be undone, or the boundary that applies.
- Buttons: "Cancel" (or "Keep {thing}") and the verb from the title.
- A checkbox confirmation is in the first person and plain: "I have checked every item and approve deleting them."

### Forms

- A label is a plain noun, with a unit symbol only: "Monthly licence fee (₦)", "Grace period (minutes)".
- Help sits under the field: the format, an example or a limit. "At least 10 characters. Saved in the audit log."
- Reason fields are labelled "Reason" or "Reason for {purpose}", and show their minimum length.
- People type money in naira and rates in per cent. Kobo appears only where a file's amount unit must be chosen.
- An error says what to enter, in the field's own words: "Enter the next step (at least 3 characters)." "Choose a reason."
- Explain the required-field mark once per form: "Fields marked * are required."
- Use the page's own messages, not the browser's.

### Status words

Every status passes through the shared labels (`valueLabel` and `StatusBadge`). No raw codes, no underscores, no CSS capitals.

| Status | Meaning |
| --- | --- |
| Not started | Nothing has happened yet |
| Waiting | Queued, such as an export |
| In progress | Work has started |
| Waiting for review | A second person must review it |
| Approved / Rejected / Withdrawn | A reviewer's decision, or the requester took it back |
| Completed | Done |
| Failed | It did not work; say what to do |
| Blocked | It cannot continue until something changes; say what |
| Ready to download | An export file is ready |
| Deleted | It was deleted |
| Out of date | The data is too old to rely on |
| Outcome unknown | A bank or provider has not said what happened to a payment |
| Needs attention | A warning that does not block work |

Record-specific words stay where they are clear: Active, Suspended, Signed, Confirmed, Refunded, Reversed, Overdue.

### Numbers, money, dates and times

- Use numerals for every quantity: "3 exceptions", "About 6 minutes", "45 seconds". Counts come from the plural formatter, so it is never "1 hours".
- Money: "₦25,000.00", with two decimals, as the shared formatter writes it. "naira" in sentences. "NGN" only where a currency code is typed or exported. Rates in per cent.
- Dates and times: as the shared formatter writes them, "29 Sept 2026, 14:05 WAT". Ranges use "to": "1 Sept 2026 to 29 Sept 2026". Times are 24-hour, with two digits: "08:00 WAT". The console says "Times in West Africa Time (WAT)" once; after that, "WAT".
- "every two weeks", not "fortnightly".
- A missing value reads "None" or "Not recorded", never a dash.

### Punctuation

- No em dashes. Use a full stop, a colon or "for example".
- Use the typographic apostrophe (’) in reader text.
- "·" only between short labels, never between sentences.
- No arrows in running text: "Cash Desk, then Accounting".

## Files Valo Pay prepares

- PDFs are written for people: plain headings, amounts as "₦25,000.00", dates as "29 Sept 2026" and times in WAT.
- CSV and JSON files are also read by other systems. Keep their column headers, keys, codes and ISO timestamps as they are.
- The name Valo Pay gives a saved export reads as words: "Dispute pack (PDF)", never "dispute-pack · pdf".

## Names that code relies on

Some stored values are identifiers as well as text, such as the demo actor names ("Sandbox Admin") that the second-person rules compare, and stored prefixes that code matches. Change how they are shown, never the stored value.

## Help and Terms explained

- A help guide keeps its fixed parts: Where to go, Before you begin, Follow these steps, What happens afterwards, If you are blocked, If you were interrupted, Terms in this guide.
- Every page links to a guide about that page, or to the help index.
- Steps start with the button's own words: "Select Import checked batch."
- Terms explained lists each term **exactly as it appears on screen**, with one or two plain sentences. Old paraphrases may stay as hidden search words, never as headings.

## Messages from Valo Pay

The console shows the service's messages as they are written, so they follow this guide too.

- Say what happened and what to do, in two short sentences at most.
- Refusals: "Only {roles} can {action}." Add the specific reason when there is one.
- Something changed after the reader opened it: "This {thing} changed after you opened it. Reload the page and try again."
- Something is missing: "{Thing} not found. It may have been deleted, or it belongs to another lender."
- Never name internal concepts, HTTP status codes or field names such as `expectedUpdatedAt`.
- Never put a raw status after an article ("A pending_activation mandate"). Say "This mandate is waiting for activation."
- Use the same words as the console for the same thing. Send words for display through the shared labels (`valueLabel` and the record-type labels); keep codes in data fields.
- An explanation that offers choices has three parts: what happened, then each choice on its own line, then what happens next. Shorten the words, never the choices.
- Requirement and test IDs (BIL-01, AUD-06, Test 5) do not appear in sentences. Go-live evidence may show P1 to P5 as a small tag beside a requirement's name.
- Texts written for a lender's customers are short, friendly and in the second person. They name the lender and never use staff words.
- Message templates use `{{lender}}` for the lender's name. `{{merchant}}` keeps working in saved templates.

## Checking your writing

Before you finish a change to visible text:

1. Read it aloud. Cut every word that does not help the reader act.
2. Check each sentence is 30 words or fewer, and most are 20 or fewer.
3. Check names and terms against this guide.
4. Check a boundary statement still says what it said.
5. Run the console's tests and `node scripts/check-docs.mjs`. `artifacts/valo-pay/tests/language.test.tsx` checks the first view of every page, as Admin: one name per page in its navigation link, heading and browser title, and no "&", em dash, arrow, straight apostrophe, code such as `review_pending`, `REVIEW_PENDING` or `post.records.customers`, retired name or word kept from readers.
