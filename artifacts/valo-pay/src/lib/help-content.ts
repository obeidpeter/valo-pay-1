/** Public, release-maintained guidance. Reading help never loads a workspace or confers access. */
export type HelpTopicId =
  | "start"
  | "access"
  | "imports"
  | "matching"
  | "cases"
  | "collections"
  | "close"
  | "customers"
  | "mandates"
  | "policies"
  | "payment-status"
  | "credit-review"
  | "cash"
  | "accounting"
  | "vat"
  | "payroll"
  | "permissions"
  | "reports"
  | "exports"
  | "audit"
  | "evidence"
  | "recovery"
  | "team"
  | "retention"
  | "settings";
/**
 * A task guide in its fixed parts (docs/design/writing.md, Help and Terms explained). Its category is the
 * navigation group its page sits in, so a guide and its page are found in the same place. Its words are the words
 * on screen, and a step that presses a button starts with that button's own label.
 */
export type HelpGuide = {
  id: HelpTopicId;
  category:
    | "Getting started"
    | "Daily work"
    | "Customers and policies"
    | "Connected banking"
    | "Oversight"
    | "Setup and administration";
  title: string;
  summary: string;
  destination: string;
  needs: string;
  steps: string[];
  result: string;
  blocked: string;
  recovery: string;
  terms: string[];
};

export const helpGuides: HelpGuide[] = [
  {
    id: "start",
    category: "Getting started",
    title: "Choose your workspace and first task",
    summary:
      "Check which lender you are working on, what your role allows and that the records are sample data.",
    destination: "Overview, and Active lender",
    needs:
      "The sandbox, or an account with access to your organisation and lender. Your role decides what you can do.",
    steps: [
      "To practise, open the sandbox. To use your workspace, sign in. Work in the sandbox is not copied to your workspace.",
      "Check the lender, your role and the mode at the top of the page. To work on another lender, choose it in Active lender.",
      "On Overview, follow Your next step. Open My work to find the cases and reviews assigned to you.",
    ],
    result:
      "You are working on the chosen lender’s records. Reading a guide does not give you more permissions.",
    blocked:
      "If a lender or task is missing, ask an Admin of your organisation to check your access. Do not use another account to get round a restriction.",
    recovery:
      "Sign in to the same account and choose the same lender to find your saved work. If you reload the page, anything you have not saved may be lost.",
    terms: ["sandbox", "your-workspace", "active-lender", "role", "records-payments-only"],
  },
  {
    id: "access",
    category: "Getting started",
    title: "Sign in, create an account or accept an invitation",
    summary:
      "Sign in or create an account with the right email address, and what to do when an invitation link does not work.",
    destination: "Sign in, then your invitation link",
    needs:
      "Use the email address the invitation was sent to. For team access you also need the right organisation, two-step verification and an active membership.",
    steps: [
      "Sign in at the web address your Admin gave you. If you have no account yet, select Create an account and use the email address the invitation was sent to. If sign-in is not available on this site, go back to that address.",
      "After you sign in, open the full invitation link again. Choose the organisation that invited you and complete two-step verification.",
      "Select Accept invitation once. When the page confirms that you have joined, open Overview and check that you see the right lender and role.",
    ],
    result:
      "You are a member only when Valo Pay confirms it. Your workspace holds sample data only, and live payments and bank connections stay switched off.",
    blocked:
      "If the link is incomplete, open the full link from the original email. If the invitation has expired or was withdrawn, ask an Admin for a new one. Signing in alone does not give you access.",
    recovery:
      "If you are not sure the invitation was accepted, open Overview and check whether you are a member before you accept again. Never share passwords, sign-in codes or invitation links in a support message.",
    terms: ["organisation", "role", "request-not-confirmed"],
  },
  {
    id: "imports",
    category: "Daily work",
    title: "Import your first payment file",
    summary: "Save and check a sample file, fix its rows, then import it once.",
    destination: "Import batches",
    needs:
      "A chosen lender and the Admin, Operations or Finance role. Imports take sample data only. Some record types refer to customers or instalments, so import those first.",
    steps: [
      "Choose the record type. For incoming payments, choose Payment evidence. Select Use sample to load an example, or choose your own sample CSV file.",
      "Check Source name, Source batch ID, the source row ID column, the column mapping and the amount unit. Naira and kobo are different units.",
      "Select Save and check batch. Read the row and field errors, correct them and save again. A saved batch is not imported yet.",
      "Check the rows and any warnings. Select Import checked batch once, then read the result before you open Reconciliation.",
    ],
    result:
      "Importing adds the checked rows to Valo Pay. Imported payment evidence still needs matching in Reconciliation. Importing does not confirm a match, and no money moved.",
    blocked:
      "Correct the row or field the error names, but keep each row’s source row ID. If a record it refers to is missing, import that record first. Do not change a duplicate row to make it look new.",
    recovery:
      "Open the saved batch to continue. If you do not know whether a save or import worked, check Request history and the saved batch before you try again. The original file may have been deleted under the lender’s data retention policy.",
    terms: ["observation", "batch", "committed", "source-row-id", "reconciliation", "kobo"],
  },
  {
    id: "matching",
    category: "Daily work",
    title: "Match a payment to an instalment",
    summary:
      "Check who paid, how much arrived and which instalment the payment pays.",
    destination: "Reconciliation, then Matches to review",
    needs:
      "Payment evidence and an instalment for the chosen lender. Admin, Operations or Finance can run reconciliation. Admin or Finance can confirm or reject a match, or allocate a payment.",
    steps: [
      "Select Run reconciliation to compare payment evidence with instalments. Then read any payment evidence that was not matched and any unallocated payments.",
      "In Matches to review, compare the customer, references, amount and currency with the explanation. A match to review is waiting for a decision.",
      "Select Confirm match if the evidence supports it, or Reject match if it does not. To pair a payment yourself, select Allocate payment and check the instalment and amount before saving.",
    ],
    result:
      "Confirming records that the payment pays that instalment. It does not start a new debit, and no money moved.",
    blocked:
      "If your role cannot decide a match, ask Admin or Finance. You cannot allocate a payment that went back to the payer, one in another currency, or one on hold for a reversal review. The page says which applies.",
    recovery:
      "If you do not know whether your decision was saved, check the original request and the payment before you try again. To correct a decision, ask Finance to review the match. The original history is always kept.",
    terms: ["reconciliation", "match", "allocation", "instalment", "observation"],
  },
  {
    id: "cases",
    category: "Daily work",
    title: "Take ownership of an exception",
    summary:
      "Give an open exception an owner, a next step and a clear handover.",
    destination: "Exceptions, then the exception’s case; or My work",
    needs:
      "Access to the chosen lender. Admin, Operations, Finance and Compliance reviewer can work on cases, depending on who owns them. Read-only can view them.",
    steps: [
      "Open the exception and its case. Read its linked evidence, status, owner and deadline.",
      "If the case has no owner and your role allows it, select Claim and save next step. Otherwise ask its owner or an Admin to hand it over.",
      "Record the next step and a note, then select Save next step. To pass the case on, choose the new owner and select Save handover.",
      "Fix the payment or evidence problem on its own page, then select Resolve exception.",
    ],
    result:
      "The case records who is responsible and what happened. Handing over a case does not confirm a payment or complete a daily close.",
    blocked:
      "Only the case owner or Admin can change or hand over an assigned case. Some resolutions need Admin or Finance, even when another role can work on the case.",
    recovery:
      "If someone else changed the case, select Refresh case and read their update before you save again. Resolved cases keep their history and cannot be handed over.",
    terms: ["exception", "case", "role"],
  },
  {
    id: "collections",
    category: "Daily work",
    title: "Track instalments and collection attempts",
    summary:
      "See which instalments are due, overdue or failed, and what should happen next.",
    destination: "Collections",
    needs:
      "Access to the chosen lender. Every role can read the list. Each button says which roles can use it.",
    steps: [
      "Open Collections. Choose All instalments, Overdue, Due today or Failed collection attempts. Use Collected by to filter by who collects them.",
      "Read each row’s amount, what is outstanding, the due date, its status and owner, and its next step.",
      "To see what the retry policy would do next, select Test retry policy. To practise a failed collection attempt, select Simulate failed collection attempt.",
      "To add sample instalments, select Import sample data.",
    ],
    result:
      "The list shows each instalment as its saved records describe it. Testing a policy changes nothing. Simulating a failure adds a failed collection attempt to the sample records. No money moved, and nothing was sent to a bank.",
    blocked:
      "If an instalment is on hold or in dispute, its row says why. Only Admin or Finance can release an instalment from dispute.",
    recovery:
      "If an action was interrupted, check Request history before you try again, so it is not done twice.",
    terms: ["instalment", "collection-attempt", "collection-policy", "outstanding"],
  },
  {
    id: "close",
    category: "Daily work",
    title: "Prepare a daily close for a different reviewer",
    summary:
      "Explain a saved daily close and ask a different Finance team member to review it.",
    destination: "Reports, then Close review",
    needs:
      "A saved daily close for the lender. Admin, Operations or Finance can prepare it. The Finance reviewer you name must be a different person.",
    steps: [
      "Run reconciliation on the sample payments, then select Run daily close on Reports. Open the saved close in Close review.",
      "Check that every expected file arrived and read the differences. Explain each one and name a different Finance reviewer. If you accept a difference that is still open, say so.",
      "Select Submit for Finance review. The reviewer opens it from My work, checks it, and selects Approve close or Request changes.",
    ],
    result:
      "Approval records that the reviewer accepted that daily close. It does not resolve exceptions, move money or approve later changes automatically.",
    blocked:
      "A different person must review it. Switching demo roles is not a second person. If the reviewer is away, an Admin can give the review to someone else. If the page says evidence is out of date or incomplete, fix it before you continue.",
    recovery:
      "Open the same close and read its review status. If the reviewer asked for changes, prepare the close again. Earlier closes and decisions stay in the history.",
    terms: ["close", "close-review", "reviewer"],
  },
  {
    id: "customers",
    category: "Customers and policies",
    title: "Find a customer and their history",
    summary:
      "Find a customer, then read their mandates, instalments, payments and past events on one page.",
    destination: "Customers, then the customer’s history",
    needs:
      "Access to the chosen lender. Every role can read customer records. Admin, Operations or Finance can add a customer.",
    steps: [
      "Open Customers. Search by name, reference or masked phone number, or press / to move to the search box.",
      "Open the customer’s history from their row. Check the Balance summary first: what is outstanding and what is allocated.",
      "Read their mandates, instalments, payments and past events. To add a customer, select Add customer and enter sample details only.",
      "To collect a customer’s records for a dispute, select Export dispute pack (PDF), then download it from Saved exports when it is ready.",
    ],
    result:
      "You see one customer’s records together. Reading them changes nothing, and Valo Pay never holds money.",
    blocked:
      "If a customer is missing, check that you chose the right lender in Active lender. Only Admin, Operations or Finance can add a customer.",
    recovery:
      "If adding a customer was interrupted, check Request history before you add them again, so you do not add them twice.",
    terms: ["customer-history", "instalment", "outstanding", "mandate", "sample-data"],
  },
  {
    id: "mandates",
    category: "Customers and policies",
    title: "Suspend, resume, cancel or reissue a mandate",
    summary: "Check a customer’s mandate and what changing it does.",
    destination: "Mandates",
    needs:
      "The chosen lender’s mandate, its consent evidence and the Admin or Operations role. Permissions to read accounts or prepare files are separate: you manage them in Permissions and readiness.",
    steps: [
      "Find the customer’s mandate. Check its provider reference, debit limit, status and consent evidence before you choose an action.",
      "Select Suspend mandate to stop an active mandate being used; its scheduled collection attempts are cancelled. Select Cancel mandate to end it, if its status allows. Read the summary and enter a reason before you confirm.",
      "Select Resume mandate to use a suspended mandate again; cancelled attempts do not come back. Select Reissue mandate to create a new mandate that waits for activation and needs new consent evidence. Instalments do not move to it automatically.",
    ],
    result:
      "These actions change only the mandate record and its history. Nothing is sent to a bank or provider. Attempts already sent keep their results, and changing a mandate is not a refund.",
    blocked:
      "If your role cannot do this, ask someone with the Admin or Operations role. You cannot undo a cancellation. You can reissue a mandate that is cancelled, failed, expired or waiting for activation, with new consent. Do not edit its consent evidence or debit limit in place.",
    recovery:
      "If you do not know whether the action worked, check the mandate and the original request before trying again. A real mandate at a provider ends only through the provider’s own process.",
    terms: ["mandate", "account-read", "request-not-confirmed"],
  },
  {
    id: "policies",
    category: "Customers and policies",
    title: "Review retry policies and message templates",
    summary:
      "Draft a version, test it and ask a different Compliance reviewer to decide.",
    destination: "Policies and templates",
    needs:
      "Access to the chosen lender. An Admin drafts and submits policy and template versions. A Compliance reviewer who is not the author approves or rejects them.",
    steps: [
      "Open the policy or template and check its status and author. To change an approved version, select Draft next version; the approved version and its history stay.",
      "Check retry limits, the gap between retries, notice periods and quiet hours, or the template’s sample message. Select Test retry policy to try a version on sample instalments.",
      "Select Submit for review. A different Compliance reviewer compares it with the previous version, then approves or rejects it with a reason.",
    ],
    result:
      "Approval records a reviewed version. It does not send messages, start live retries or change any mandate. Applying a policy to a mandate is a separate step on Mandates, and it needs the customer’s accepted notice and any new consent.",
    blocked:
      "You cannot approve your own submission or edit an approved version. Each button says who can use it. If the previous version is missing, report it rather than treating it as empty or approved.",
    recovery:
      "If you do not know whether your submission was saved, open the version and check its review status before you submit again. Earlier versions and decisions are always kept. A sample notice does not show that a customer received or accepted it.",
    terms: ["collection-policy", "notification-template", "reviewer", "mandate"],
  },
  {
    id: "payment-status",
    category: "Connected banking",
    title: "Understand payment status without paying twice",
    summary:
      "Tell a payment that is pending or has an unknown outcome apart from a confirmed payment.",
    destination: "Pay by Bank, then the checkout",
    needs:
      "The customer, lender, instalment, amount and currency. Pay by Bank practises the payment steps with sample data. It is not a live bank checkout.",
    steps: [
      "Check the lender, customer, purpose, amount and currency. Then select Simulate authorisation to practise the customer’s step at their bank.",
      "Read the checkout’s progress. Awaiting authorisation, Authorised, Pending and Outcome unknown all mean the payment is not confirmed. They do not mean it failed either.",
      "Go back to the same checkout to check the result. If its outcome is unknown, wait for evidence. After 24 hours the daily close opens an exception for Finance, and the checkout links to it. Do not create a new checkout to replace it.",
    ],
    result:
      "A confirmed payment and a settlement are different events: confirmation does not mean the provider has paid out. In the sandbox, both are sample evidence.",
    blocked:
      "The page explains what is missing, which instalments are on hold and which actions are not available. If a payment’s outcome stays unknown, Admin or Finance resolves it from the evidence.",
    recovery:
      "Leaving the page does not cancel anything. Open the same checkout again. A timeout, a blank page or a missing notice does not prove that nothing was sent.",
    terms: ["payment-request", "unknown-outcome", "settlement", "sandbox"],
  },
  {
    id: "credit-review",
    category: "Connected banking",
    title: "Review an assessment and its evidence",
    summary:
      "Understand the evidence and its gaps before you record a review decision.",
    destination: "Credit Desk, then the assessment and its review",
    needs:
      "An applicant for the chosen lender, with two separate permissions: Read applicant accounts and Assess an application. Admin or Operations runs the assessment. A different Admin, Finance or Compliance reviewer reviews it.",
    steps: [
      "Choose the applicant and check their permissions. Select Run assessment for a new version, or choose the version you are reviewing in Assessment version.",
      "Read how much evidence there is, how old it is, and the costs, commitments and explanation. Missing evidence or permission stops the assessment. It does not mean zero risk.",
      "In the review panel, enter your decision, your reasons and the explanation for the applicant, then select Record review. If you change the recommended outcome, explain why.",
    ],
    result:
      "Each assessment version and its review are kept, so you can see who decided what. A credit result is not a lending decision: a score is not a chance of default, a loan approval or a payout.",
    blocked:
      "Follow the page’s explanation of missing evidence or permissions. Only a permitted reviewer can record a decision. Reading a guide does not change your role.",
    recovery:
      "Open Review history for the version before you submit again. A saved review cannot be changed. To start again, run a new assessment: it creates a new version.",
    terms: ["assessment", "account-read", "reviewer"],
  },
  {
    id: "cash",
    category: "Connected banking",
    title: "Read cash balances and their age",
    summary:
      "Check when balances were read, and the assumptions, before you use a cash forecast.",
    destination: "Cash Desk, then Cash and forecast",
    needs:
      "The sample business and an active Read business accounts permission. A saved forecast also depends on the current balances, commitments and permission.",
    steps: [
      "Check when each account’s balance was read and whether its source is up to date. An older balance may not show the money available now.",
      "Compare commitments, expected receipts, fees and the planning buffer. Treat unknown or hidden figures as needing review, not as zero.",
      "Check the assumptions, then select Save forecast. If the sample data is out of date, select Refresh sample balances and prepare the forecast again.",
    ],
    result:
      "A forecast is a plan based on its recorded evidence. A planning buffer keeps no money aside, and refreshing sample data does not contact a bank.",
    blocked:
      "If a permission expired or changed, or the evidence changed, you cannot use the saved forecast. Fix what the page names, then prepare a new version.",
    recovery:
      "Open the saved forecast and check its state. A new balance does not approve an old payroll plan or accounting draft.",
    terms: ["stale", "forecast", "business-account-read"],
  },
  {
    id: "accounting",
    category: "Connected banking",
    title: "Prepare an accounting draft for review",
    summary:
      "Check a receipt and how it maps to your accounts, then have a different Finance reviewer check it before export.",
    destination: "Cash Desk, then Accounting",
    needs:
      "The Read business accounts and Prepare accounting drafts and VAT schedules permissions, and the sample receipt. An Admin or Operations team member prepares the draft, and a different Finance reviewer checks it.",
    steps: [
      "Select Prepare accounting draft. Check the receipt, the amount before fees, the fee, the amount after fees, the invoice it pays and the account mapping.",
      "A different Finance reviewer checks the draft and selects Approve draft. Before that, recheck any amount still owed and any closed accounting period.",
      "Select Prepare export file while the evidence and permissions are current, then download the export file.",
    ],
    result:
      "This prepares a sample accounting export. Nothing was posted to accounting software, and your accounting software stays the official record.",
    blocked:
      "If permissions or evidence change, prepare the review again and get a new Finance approval. The previous approval does not cover a changed draft.",
    recovery:
      "After an interruption, open the same receipt and draft and check the saved result before you repeat anything. Do not create a new receipt for the same money.",
    terms: ["accounting-draft", "reviewer", "export"],
  },
  {
    id: "vat",
    category: "Connected banking",
    title: "Prepare a VAT schedule",
    summary:
      "Compare invoice, bank and ledger evidence for an accountant to review.",
    destination: "Cash Desk, then VAT evidence",
    needs:
      "The Read business accounts and Prepare accounting drafts and VAT schedules permissions, the sample business, and a Finance reviewer to save the schedule.",
    steps: [
      "Check invoice amounts, bank payments and the ledger total separately. Read the evidence gaps and the items left out.",
      "Resolve or note the evidence needed for review. A bank payment alone does not prove that VAT is due or that input tax can be claimed back.",
      "Finance saves the VAT schedule and downloads it when it is ready.",
    ],
    result:
      "The schedule helps you prepare for a review with an accountant. No VAT return was filed and no tax was paid.",
    blocked:
      "If evidence is missing, or sources or permissions changed, earlier figures may be hidden. Review the gaps, then prepare the schedule again.",
    recovery:
      "Check the saved schedule and when it was saved before you save another. The original stays as a record.",
    terms: ["vat-schedule", "export", "stale"],
  },
  {
    id: "payroll",
    category: "Connected banking",
    title: "Prepare a reviewed payroll file",
    summary:
      "Check there is money for an approved net-pay run. This does not pay salaries.",
    destination: "Cash Desk, then Payroll funding",
    needs:
      "An approved sample net-pay run, and the Read business accounts and Prepare payroll funding permissions. An Admin or Operations team member prepares the plan, and a different Finance reviewer checks it.",
    steps: [
      "Select Prepare funding plan for the approved run. Check the source account, when its balance was read, and the commitments, fees and buffer.",
      "Ask a different Finance reviewer to check the plan and its items and select Approve funding plan. If the funding evidence is too low or out of date, fix it before export.",
      "When the checks pass, select Prepare bank export file and download it. Track each item’s outcome in the same plan.",
    ],
    result:
      "Approving the funding and downloading the file pay no one. No one has been paid, and your payroll system still does the calculations.",
    blocked:
      "If permissions or funding change, the plan needs a new review and approval. Do not export items already paid, or items whose outcome is unknown, again as new payments.",
    recovery:
      "Open the same plan and check each item. Items whose outcome is unknown stay on hold until evidence settles them. Do not make a new run to get round the hold.",
    terms: ["payroll-file", "reviewer", "unknown-outcome"],
  },
  {
    id: "permissions",
    category: "Connected banking",
    title: "Grant or withdraw a permission",
    summary:
      "Check what a permission is for, and stop new work that depends on it.",
    destination: "Permissions and readiness",
    needs:
      "Access to the chosen lender. In the sandbox, Admin or Operations can grant a permission, and Admin, Operations or Compliance reviewer can withdraw one.",
    steps: [
      "Read the purpose, subject and expiry. Reading accounts, assessing an application, preparing accounting drafts and preparing payroll funding each need a separate permission.",
      "If you do not want to set up a sample permission, leave the form without saving. You can still read why the task is blocked.",
      "To withdraw a permission, select Withdraw on its row and check who it covers and what will stop. Enter a reason, then select Withdraw permission.",
    ],
    result:
      "Withdrawing stops new work that depends on the permission and keeps past evidence. Payments already on their way can still be reconciled. It does not undo an earlier payment or withdraw other permissions.",
    blocked:
      "If your role cannot grant or withdraw a permission, ask an Admin. A sample permission cannot connect a real account or allow a live bank debit. Permission to read an account is not permission to take money from it.",
    recovery:
      "If you do not know whether your change was saved, check the permission and the original request before you try again. Granting a permission again does not make earlier approvals that relied on it valid again.",
    terms: ["permission", "account-read", "mandate", "role"],
  },
  {
    id: "reports",
    category: "Oversight",
    title: "Read reports and run a daily close",
    summary:
      "Check totals, run a daily close, and read billing and pilot results.",
    destination: "Reports",
    needs:
      "Access to the chosen lender. Admin, Operations or Finance can run a daily close. Admin or Finance can issue an invoice.",
    steps: [
      "Open Reports and choose a view: Totals and closes, Billing or Pilot results.",
      "In Totals and closes, select Run daily close to save the day’s reconciliation results and open exceptions. Then prepare the close for review in Close review.",
      "In Billing, check the statement for the billing month. Select Export billing statement (CSV) to download it.",
      "In Pilot results, read what was measured. Results from sample data do not show live performance.",
    ],
    result:
      "A daily close is saved as a record you can review. Running it is not approval: a different person must review it. Reports use sample data only.",
    blocked:
      "If a daily close cannot run, the page says why, such as a date in the future. Missing files do not stop it: the close records them for the Finance reviewer. Each button says which roles can use it.",
    recovery:
      "If a daily close was interrupted, check Request history before you run it again.",
    terms: ["close", "close-review", "pilot-results", "sample-data"],
  },
  {
    id: "exports",
    category: "Oversight",
    title: "Find and download a saved export",
    summary:
      "Follow an export while it is prepared, and go back to it if you are interrupted.",
    destination: "Saved exports, or the export button on the record you are exporting",
    needs:
      "Access to the lender and to the record you export. A close review export needs an approved review. Other exports have their own role checks.",
    steps: [
      "Start the export from the record it comes from, such as an approved close review or a customer’s history.",
      "Open Saved exports to follow it. Do not start another export of the same record while one is waiting.",
      "When it shows Ready to download, download it. Keep the details Saved exports shows with the file, so you can show later that it has not changed.",
    ],
    result:
      "You get the file prepared for that export. A download does not move money, file a tax return or post to accounting software.",
    blocked:
      "You cannot download an export that is waiting, has failed or has expired. Follow the explanation shown for it. Your access is checked again when you download.",
    recovery:
      "If Saved exports offers Retry export, use it: it keeps the original export. If your access was removed, ask an Admin.",
    terms: ["export", "request-not-confirmed"],
  },
  {
    id: "audit",
    category: "Oversight",
    title: "Search and check the audit log",
    summary:
      "Find who changed what and when, and check that no entry has been changed since.",
    destination: "Audit log",
    needs: "Access to the chosen lender.",
    steps: [
      "Open Audit log. Search by action, person or summary, or press / to move to the search box.",
      "Read each entry’s time, who made the change, the action and the record it changed.",
      "Select Check audit log to check that every entry is still linked to the one before it.",
    ],
    result:
      "A check covers the entries that existed when it ran, so check again after new changes. Reading the log changes nothing.",
    blocked:
      "If the check fails, an entry or its link does not match. Ask an Admin to look into it. If it keeps happening, contact the Valo Pay team.",
    recovery:
      "If a check was interrupted, look in Request history, then select Check audit log again.",
    terms: ["audit-log"],
  },
  {
    id: "evidence",
    category: "Oversight",
    title: "Record go-live evidence and commercial terms",
    summary:
      "Keep the evidence needed before live use, the signed commercial terms and the regular reviews.",
    destination: "Go-live evidence",
    needs:
      "Access to the chosen lender. Admin can add evidence. Admin or Finance can add commercial terms and confirm discount dates.",
    steps: [
      "Open Go-live evidence and read Go-live requirements: what is recorded and what is still missing.",
      "Select Add evidence and enter its title, owner and date, with a reference or link to the document.",
      "Select Add terms to record a lender’s commercial terms. When the terms have discount dates, a different person selects Confirm discount dates after checking the signed agreement.",
      "Every two weeks, select Record review and tick the tasks you checked.",
    ],
    result:
      "The page shows what is recorded and what is still missing. Sample data is not live evidence, and recording evidence does not switch on live payments.",
    blocked:
      "Each button says which roles can use it. A different person must confirm discount dates: switching demo roles is not a second person.",
    recovery:
      "If a save was interrupted, check Request history before you add the item again.",
    terms: ["evidence", "reviewer", "sample-data"],
  },
  {
    id: "recovery",
    category: "Setup and administration",
    title: "Check a request that was not confirmed",
    summary:
      "Find out what happened to a request without doing the same thing twice.",
    destination: "The Request not confirmed notice on the page, or Request history",
    needs:
      "The same account (or the same sandbox, in the same browser), the same lender and current access. Request history lists only requests that reached Valo Pay.",
    steps: [
      "Read the page’s message carefully. An unsaved form, a saved draft, a request not confirmed and a confirmed result are different things.",
      "When a request is not confirmed, select Check original request on the notice, or find the request in Request history. Check its status and the record it changed.",
      "If the check does not work, select Cancel if unfinished for that request. Do not start a new payment, import or accounting action while its outcome is not known.",
    ],
    result:
      "Checking uses the original request, so nothing is done twice. If it finished, open the saved result from the notice or from Request history.",
    blocked:
      "An empty Request history does not prove that a payment failed. For an invitation, check your membership in your workspace instead. A finished request can no longer be cancelled.",
    recovery:
      "If a request is not listed, open the record it would have changed and read the page’s guidance. Reloading the page loses anything you did not save. Never paste financial details or passwords into a support message.",
    terms: ["request-not-confirmed", "request-history"],
  },
  {
    id: "team",
    category: "Setup and administration",
    title: "Invite team members and manage their access",
    summary: "Give each person a role and the lenders they may work on.",
    destination: "Team and access",
    needs:
      "Your workspace with team access switched on, and the Admin role. In the sandbox you practise with demo roles instead.",
    steps: [
      "Open Team and access and read Access status. In the sandbox, change your demo role in Settings instead.",
      "To invite someone, enter their email address and role, then select Create invitation. Share the invitation link with them.",
      "After they accept, choose the lenders they may work on and select Save lender access.",
      "Some invitations and role changes need a second Admin to approve them before they take effect.",
    ],
    result:
      "The person works only on the lenders you gave them, in their role. An invitation lasts seven days, and access lasts 90 days from when they accept.",
    blocked:
      "Only Admin can invite or change team members. You cannot approve your own invitation or change: another Admin must.",
    recovery:
      "If an invitation or change was interrupted, refresh Team and access to see whether it was saved before you try again.",
    terms: ["team-member", "role", "demo-role"],
  },
  {
    id: "retention",
    category: "Setup and administration",
    title: "Choose how long files are kept and delete old ones",
    summary:
      "Set how long files and request data are kept, and delete them with a second Admin’s approval.",
    destination: "Data retention (Admin only)",
    needs:
      "The Admin role. In a pilot, a different Admin approves each deletion run.",
    steps: [
      "In Retention policy, choose how long each kind of file is kept, enter a reason and select Save retention policy. Saving a policy deletes nothing.",
      "To keep an item from deletion, choose it and select Place a hold.",
      "Select Prepare deletion preview to see exactly which items would be deleted.",
      "A different Admin checks every item, ticks the box and selects Approve deletion. Then select Start deletion.",
    ],
    result:
      "Only the approved items are deleted, and a deletion record proves each one. Financial records and the audit log are never deleted.",
    blocked:
      "An item on hold is never deleted. In a pilot, a different Admin must approve a deletion preview you prepared.",
    recovery:
      "If a run stops part way, open it in Deletion runs and select Continue deletion. Items already deleted stay deleted.",
    terms: ["deletion-run", "deletion-record", "audit-log"],
  },
  {
    id: "settings",
    category: "Setup and administration",
    title: "Change settings, the emergency stop and your demo role",
    summary:
      "Change how collections run for this lender, stop all collection instructions, or practise with another role.",
    destination: "Settings",
    needs:
      "Only Admin can change collection settings or turn the emergency stop on or off. In the sandbox, anyone can switch demo role.",
    steps: [
      "To practise as another role, choose it in Demo role and select Switch role. Switching demo roles is not a second person.",
      "To change collection settings, select Edit, change the values and select Save changes.",
      "To stop all collection instructions, enter a reason and select Turn on emergency stop. In a pilot, turning it off needs a second Admin to approve.",
      "In Appearance, choose a theme for this browser. Keyboard lists the shortcuts.",
    ],
    result:
      "Your changes apply to this lender and are saved in the audit log. Live payments and bank connections stay switched off whatever you choose.",
    blocked:
      "If a control is not available, it says which roles can use it. In the sandbox, change your demo role in Settings.",
    recovery:
      "If a change was interrupted, check Request history before you make it again.",
    terms: ["demo-role", "emergency-stop", "collection-transfer", "role"],
  },
];

/**
 * A term in Terms explained: the word exactly as the page shows it and one or two plain sentences. `also` holds the
 * words earlier releases used for it (the old headings and formal names), which search still finds but the page
 * never shows.
 */
export type HelpTerm = { id: string; term: string; meaning: string; also: readonly string[] };

/** In the order of their headwords, as a reader scans a list of terms. */
export const helpTerms: readonly HelpTerm[] = [
  {
    id: "account-mapping",
    term: "Account mapping",
    meaning:
      "The accounts, company and tax code an accounting draft uses in your accounting software. Each draft names the mapping version it used.",
    also: ["chart of accounts", "ledger mapping", "mapping", "account codes"],
  },
  {
    id: "accounting-draft",
    term: "Accounting draft",
    meaning:
      "A proposed entry for a receipt in the accounting records, waiting for a Finance review. Valo Pay does not post it to your accounting software.",
    also: ["Accounting work waiting for review", "ERP"],
  },
  {
    id: "active-lender",
    term: "Active lender",
    meaning:
      "The lender whose records you are working on, chosen in the sidebar or, on a phone, at the top of the page. Choosing another lender never gives you a wider role.",
    also: ["lender", "lender selector", "workspace lender selector", "workspace selector", "merchant"],
  },
  {
    id: "affordability-check",
    term: "Affordability check",
    meaning:
      "How much the applicant could repay each month under the sample policy. It cuts regular income to allow for a bad month, then takes away essential costs, existing repayments and a safety margin. It is not a loan offer.",
    also: ["repayment capacity", "debt-service ratio", "stressed income", "Largest new monthly repayment the applicant can afford", "Loan amount this schedule supports"],
  },
  {
    id: "allocation",
    term: "Allocate payment",
    meaning:
      "Putting a payment’s money against an instalment yourself, when Valo Pay did not find a match. Money not yet put against an instalment is unallocated.",
    also: ["Apply a payment to a repayment", "Allocation", "allocated", "unallocated", "apply", "applied"],
  },
  {
    id: "assessment",
    term: "Assessment",
    meaning:
      "A check of an applicant’s bank evidence against set rules, saved as a new version each time. A credit result is not a lending decision.",
    also: ["Applicant assessment", "Credit assessment", "Assess an application", "rule score", "score"],
  },
  {
    id: "audit-log",
    term: "Audit log",
    meaning:
      "The record of every change, in the order it happened. Each entry is linked to the one before, so a check can show whether any entry was changed.",
    also: ["audit trail", "audit record", "Check audit log"],
  },
  {
    id: "case",
    term: "Case",
    meaning:
      "Who owns an exception, its next step and its handover history. Handing over a case does not fix the problem behind it.",
    also: ["Coordinated exception", "Case handling", "Coordinate a case", "handover", "next action"],
  },
  {
    id: "forecast",
    term: "Cash forecast",
    meaning:
      "An estimate of cash from dated balances, expected receipts, commitments and your assumptions. It is not a bank balance, and it keeps no money aside.",
    also: ["Cash plan", "Cash and forecast"],
  },
  {
    id: "cautious-case",
    term: "Cautious case",
    meaning:
      "Cash Desk’s forecast if less money comes in, and later, while payments out stay due. A forecast is a planning estimate, not money held or set aside.",
    also: ["downside scenario", "downside", "stress case", "worst case"],
  },
  {
    id: "payment-request",
    term: "Checkout",
    meaning:
      "A request for a customer to pay one instalment from their bank. Creating or authorising a checkout does not show that the money arrived.",
    also: ["Request to pay", "Checkout or payment intent", "payment intent", "Pay-by-bank"],
  },
  {
    id: "close-review",
    term: "Close review",
    meaning: "A Finance team member’s check of a daily close. A different person must review it.",
    also: ["Finance close review", "Finance review"],
  },
  {
    id: "collection-attempt",
    term: "Collection attempt",
    meaning:
      "One try to take a payment from a customer’s account. A failed collection attempt may be retried under the retry policy.",
    also: ["debit attempt", "failed collection", "Failed attempts", "retry"],
  },
  {
    id: "collection-transfer",
    term: "Collection transfer",
    meaning:
      "The agreement that moves collection work to Valo Pay. Returning collection hands it back to the previous owner.",
    also: ["cutover", "hand-back", "hand back", "Return collection ownership", "fallback owner"],
  },
  {
    id: "customer-history",
    term: "Customer history",
    meaning:
      "One customer’s mandates, instalments, payments and past events on one page. Open it from the customer’s row on Customers.",
    also: ["Customer timeline", "timeline"],
  },
  {
    id: "close",
    term: "Daily close",
    meaning:
      "The saved record of the day’s reconciliation results and open exceptions. Preparing, reviewing and approving it are separate steps.",
    also: ["Close snapshot", "snapshot", "Saved version of evidence", "saved close", "closing positions", "close statement"],
  },
  {
    id: "deletion-record",
    term: "Deletion record",
    meaning: "The record that proves an item was deleted. It stays after the item has gone.",
    also: ["deletion receipt", "Saved deletion receipts"],
  },
  {
    id: "deletion-run",
    term: "Deletion run",
    meaning:
      "An approved set of items to delete. In a pilot a different Admin approves it, and financial records and the audit log are never deleted.",
    also: ["retention run", "deletion preview", "Preview a deletion run", "retention"],
  },
  {
    id: "demo-role",
    term: "Demo role",
    meaning:
      "The role you switch to in the sandbox, in Settings, to try what each role can do. Switching demo roles is not a second person.",
    also: ["persona", "demo persona", "workspace role selector", "Switch role"],
  },
  {
    id: "difference-from-your-ledger",
    term: "Difference from your ledger",
    meaning:
      "The VAT account in your ledger minus the balance Cash Desk expects from the period’s invoices, adjustments and VAT payments. A difference means the VAT schedule needs review.",
    also: ["ledger control variance", "VAT variance", "variance", "ledger difference"],
  },
  {
    id: "emergency-stop",
    term: "Emergency stop",
    meaning:
      "The control that stops all collection instructions for a lender. Only Admin can turn it on or off, and each change is saved in the audit log.",
    also: ["kill switch", "Turn on emergency stop", "Turn off emergency stop"],
  },
  {
    id: "evidence",
    term: "Evidence",
    meaning:
      "Proof that people add or export, such as an entry in the evidence register or an evidence pack. Sample data is not live evidence.",
    also: ["evidence register", "evidence pack", "Go-live evidence"],
  },
  {
    id: "exception",
    term: "Exception",
    meaning:
      "Something that needs a person to review and resolve it, such as a difference, a missing record or an outcome that is unknown.",
    also: ["Issue needing review", "issue", "item", "discrepancy"],
  },
  {
    id: "expected-case",
    term: "Expected case",
    meaning:
      "Cash Desk’s forecast using the approved amounts. Compare it with the cautious case. A forecast is a planning estimate, not money held or set aside.",
    also: ["base scenario", "base case"],
  },
  {
    id: "export",
    term: "Export",
    meaning:
      "A file Valo Pay prepares from your records, kept on Saved exports. Creating or downloading it does not move money, file a tax return or change your accounting software.",
    also: ["Prepared file", "job", "saved evidence", "Saved exports"],
  },
  {
    id: "batch",
    term: "Import batch",
    meaning: "A saved file with its column mapping and row checks. Saving a batch does not import its rows.",
    also: ["Saved import batch", "source batch"],
  },
  {
    id: "committed",
    term: "Imported",
    meaning:
      "The checked rows of a batch are now in Valo Pay. Imported payment evidence may still need matching, and importing moves no money.",
    also: ["Committed import", "Commit", "committed", "Import checked batch", "Last imported"],
  },
  {
    id: "input-vat",
    term: "Input VAT",
    meaning:
      "VAT on purchases. Only VAT with an approved decision to reclaim it counts as input VAT you can reclaim. The rest waits for review.",
    also: ["recoverable input tax", "input tax", "Input VAT you can reclaim", "Input VAT needing review"],
  },
  {
    id: "instalment",
    term: "Instalment",
    meaning:
      "An amount a customer owes on a set date. Valo Pay never holds money: it records what is owed and what was paid.",
    also: ["Repayment due", "Instalment or due item", "due item", "repayment", "bill", "obligation"],
  },
  {
    id: "instructions-after-go-live",
    term: "Instructions after go-live",
    meaning:
      "A lender mode in which Valo Pay may send collection instructions once the lender is approved for live use. Live payments and bank connections are switched off, so no instruction reaches a bank.",
    also: ["Can send collection instructions", "instruction mode", "Mode"],
  },
  {
    id: "kobo",
    term: "Kobo",
    meaning:
      "A hundredth of a naira: ₦1.00 is 100 kobo. Check which unit your file uses: 2,500 kobo is ₦25.00, but 2,500 naira is ₦2,500.00.",
    also: ["NGN minor unit", "minor unit"],
  },
  {
    id: "loan-amount",
    term: "Loan amount",
    meaning:
      "The amount the applicant asks to borrow. The affordability check shows how much of it the repayment schedule supports. It is not a loan offer.",
    also: ["principal", "requested amount", "loan principal"],
  },
  {
    id: "mandate",
    term: "Mandate",
    meaning:
      "A customer’s permission for recurring bank debits, which you can suspend, resume, cancel or reissue. It does not show that any one debit worked.",
    also: ["Permission for recurring bank debits", "Debit mandate", "recurring debit", "pause", "Pause, cancel or reissue a debit mandate"],
  },
  {
    id: "match",
    term: "Match",
    meaning:
      "A pairing of a payment with an instalment that Valo Pay found. A match in Matches to review waits for someone to confirm or reject it.",
    also: ["proposed match", "Matches to review", "Confirm match", "Reject match"],
  },
  {
    id: "notification-template",
    term: "Message template",
    meaning:
      "The reviewed wording of a message to a customer. A preview or an approved template does not show that a message was sent, received or accepted.",
    also: ["Reviewed message wording", "Notification template"],
  },
  {
    id: "organisation",
    term: "Organisation",
    meaning:
      "The company or cooperative whose Valo Pay account you use. It can hold several lenders, and your access can differ between them.",
    also: ["Tenant"],
  },
  {
    id: "stale",
    term: "Out of date",
    meaning:
      "The data is too old, or it has changed. Check the time shown and refresh it on the page before you use it for new work.",
    also: ["Data may be out of date", "Stale evidence", "stale"],
  },
  {
    id: "unknown-outcome",
    term: "Outcome unknown",
    meaning:
      "A bank or provider has not said what happened to a payment. Wait for evidence, and do not create a new payment to replace it.",
    also: ["unknown outcome", "timeout"],
  },
  {
    id: "output-vat",
    term: "Output VAT",
    meaning:
      "VAT on approved sales invoices. Valo Pay files no VAT return and pays no tax.",
    also: ["output tax", "VAT on sales", "Output VAT (on sales)"],
  },
  {
    id: "outstanding",
    term: "Outstanding",
    meaning: "The amount still owed on an instalment. Unpaid is a status; outstanding is an amount.",
    also: ["still due", "residual"],
  },
  {
    id: "observation",
    term: "Payment evidence",
    meaning:
      "A record of a payment from a bank statement, a settlement report or a provider notification. Two records can describe the same payment. Valo Pay joins them when they match, and holds any it cannot tell apart for Finance to check.",
    also: ["Observation", "payment observation", "source record", "webhook"],
  },
  {
    id: "payroll-file",
    term: "Payroll funding",
    meaning:
      "The Cash Desk section that checks there is money for an approved net-pay run and prepares a reviewed file for payroll. Exporting the file moves no money, and no one has been paid.",
    also: ["Payroll preparation file", "Reviewed payroll export", "payroll file", "Prepare payroll funding"],
  },
  {
    id: "permission",
    term: "Permission",
    meaning:
      "A recorded agreement for one purpose, such as reading an applicant’s accounts. You grant it and can withdraw it, and its status is Active, Withdrawn or Expired.",
    also: ["consent", "authority", "revoke", "Permissions & readiness", "Access & recovery"],
  },
  {
    id: "pilot-results",
    term: "Pilot results",
    meaning:
      "What a pilot measured, such as how often matches were right. Results from sample data do not show live performance.",
    also: ["Pilot evidence", "Operational evidence"],
  },
  {
    id: "account-read",
    term: "Read applicant accounts",
    meaning:
      "The permission to read an applicant’s bank accounts for one purpose and period. It does not allow an assessment: that needs Assess an application. Permission to read an account is not permission to take money from it.",
    also: ["Permission to read an account", "Account-read consent", "account-read"],
  },
  {
    id: "business-account-read",
    term: "Read business accounts",
    meaning:
      "The permission to read the sample business’s bank accounts for Cash Desk. Permission to read an account is not permission to take money from it.",
    also: ["business-account read permission"],
  },
  {
    id: "received-before-fees",
    term: "Received before fees",
    meaning:
      "The amount paid against an invoice. Received after fees is that amount less the fee.",
    also: ["gross receipt", "net receipt", "gross", "net", "Received after fees"],
  },
  {
    id: "reconciliation",
    term: "Reconciliation",
    meaning:
      "Comparing payment evidence with instalments to find matches and differences. It does not tell a bank to move money.",
    also: ["Match payments to repayments", "reconcile"],
  },
  {
    id: "records-payments-only",
    term: "Records payments only",
    meaning:
      "A lender mode in which Valo Pay records and matches payments but never sends a collection instruction to a bank or provider. Your team can still import, match and resolve records.",
    also: ["Watch only", "observation mode", "Observation only", "Mode"],
  },
  {
    id: "regular-income",
    term: "Regular income",
    meaning:
      "The applicant’s salary or business income per 30 days, from their bank evidence. Transfers between their own accounts, loan money, refunds and sales of assets do not count.",
    also: ["sustainable income", "eligible income", "Regular income per 30 days"],
  },
  {
    id: "request-history",
    term: "Request history",
    meaning:
      "The page that lists your requests for this lender and what happened to each. It was called Operations.",
    also: ["Operations", "operations history"],
  },
  {
    id: "request-not-confirmed",
    term: "Request not confirmed",
    meaning:
      "Valo Pay’s answer to a request was lost, so you do not know yet whether it was saved. Check the original request before you change anything.",
    also: ["Outcome not confirmed", "Unconfirmed operation", "unconfirmed request", "interrupted request", "recover", "recovery", "Recover an interrupted request", "Access & recovery"],
  },
  {
    id: "collection-policy",
    term: "Retry policy",
    meaning:
      "The rules for when and how often to retry a collection. Testing or approving a policy sends no instruction and does not replace a mandate’s consent and notice checks.",
    also: ["Retry rules", "Collection policy", "collection rules", "Policies & templates", "Review retry rules and message templates"],
  },
  {
    id: "reviewer",
    term: "Reviewer",
    meaning:
      "The person who checks work that someone else prepared. A different person must review it, and switching demo roles is not a second person.",
    also: ["preparer", "A separate person checks the work", "Maker/checker separation", "maker", "checker", "independent review"],
  },
  {
    id: "role",
    term: "Role",
    meaning:
      "Your job in Valo Pay, which decides what you can do. The roles are Admin, Operations, Finance, Compliance reviewer and Read-only, and reading help does not change yours.",
    also: ["Your allowed actions", "Role and current authority", "authority"],
  },
  {
    id: "sample-business",
    term: "Sample business",
    meaning:
      "Cash Desk’s made-up business. It is separate from the lender and its customers.",
    also: ["SME", "Sample SME", "SME legal entity", "Trading company"],
  },
  {
    id: "sample-data",
    term: "Sample data",
    meaning: "Sample data is made up. It is not real customers or money.",
    also: ["synthetic", "fixture", "illustrative", "sample records"],
  },
  {
    id: "sample-rule-score",
    term: "Sample rule score",
    meaning:
      "A score from sample rules that have not been validated for real lending. It does not predict whether the applicant will repay, and it is not a lending decision.",
    also: ["rulecard score", "rulecard", "credit score", "probability of default", "Sample rule score (not validated)"],
  },
  {
    id: "sandbox",
    term: "Sandbox",
    meaning:
      "The practice workspace you can open without an account. It holds sample data, is kept in this browser and may be deleted after 30 days without changes.",
    also: ["Sample workspace", "Synthetic sandbox", "anonymous sandbox"],
  },
  {
    id: "settlement",
    term: "Settlement",
    meaning:
      "When the payment provider pays out the money it collected, shown in a settlement report. A confirmed payment and a completed settlement are different events.",
    also: ["Provider settlement", "payout", "settlement batch"],
  },
  {
    id: "source-row-id",
    term: "Source row ID",
    meaning:
      "A row’s own ID in the source file. Valo Pay uses it to recognise a row it has already imported.",
    also: ["row identity", "Row ID", "source identity"],
  },
  {
    id: "still-owed",
    term: "Still owed",
    meaning:
      "What is left to pay on an invoice after this payment and any credit note.",
    also: ["invoice residual", "residual", "Amount still owed", "balance due"],
  },
  {
    id: "team-member",
    term: "Team member",
    meaning: "A person who uses Valo Pay for a lender. Each team member has one role.",
    also: ["user", "staff member", "colleague", "member"],
  },
  {
    id: "typical-account-balance",
    term: "Typical account balance",
    meaning:
      "The middle value of the applicant’s daily closing balances: half the days closed higher and half lower.",
    also: ["median observed liquidity", "liquidity buffer", "median balance"],
  },
  {
    id: "vat-schedule",
    term: "VAT schedule",
    meaning:
      "The file VAT evidence prepares, keeping invoice, bank and ledger evidence apart for an accountant. It files no VAT return and pays no tax.",
    also: ["VAT evidence schedule", "VAT review schedule"],
  },
  {
    id: "your-workspace",
    term: "Your workspace",
    meaning:
      "The workspace linked to your account when you sign in. In this release it also holds sample data only, and work you do in the sandbox is not copied to it.",
    also: ["account-linked workspace", "pilot workspace", "signed-in workspace"],
  },
];

/** Deliberately static: never carry record IDs, invitation tokens, arbitrary URLs or untrusted queries into a return link. */
export const helpReturnPaths = [
  "/",
  "/sign-in",
  "/sign-up",
  "/overview",
  "/customers",
  "/mandates",
  "/collections",
  "/reconciliation",
  "/exceptions",
  "/policies",
  "/reports",
  "/evidence",
  "/audit",
  "/settings",
  "/pay-by-bank",
  "/credit-desk",
  "/cash-desk",
  // Each of these Cash Desk sections has its own guide, whose help returns to the same section.
  "/cash-desk?view=accounting",
  "/cash-desk?view=vat",
  "/cash-desk?view=payroll",
  "/connections",
  "/pilot",
  "/imports",
  "/operations",
  "/team",
  "/close-review",
  "/sources",
  "/work",
  "/lifecycle",
  "/exports",
  "/presentation",
] as const;
export function safeHelpReturnTo(
  value: string | null | undefined,
): string | null {
  return value && helpReturnPaths.some((path) => path === value) ? value : null;
}
export function helpHref(topic: HelpTopicId, returnTo?: string): string {
  const params = new URLSearchParams({ topic });
  const safe = safeHelpReturnTo(returnTo);
  if (safe) params.set("returnTo", safe);
  return `/help?${params}`;
}
/** The help index, for a page without a guide of its own; it returns to that page. */
export function helpIndexHref(returnTo?: string): string {
  const safe = safeHelpReturnTo(returnTo);
  return safe ? `/help?${new URLSearchParams({ returnTo: safe })}` : "/help";
}

export function matchesHelpSearch(query: string, ...text: string[]): boolean {
  const normalise = (value: string) =>
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase();
  const content = normalise(text.join(" "));
  return normalise(query)
    .trim()
    .split(/\s+/)
    .every((word) => content.includes(word));
}
