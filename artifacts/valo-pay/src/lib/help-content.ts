/** Public, release-maintained guidance. Reading help never loads a workspace or confers access. */
export type HelpTopicId =
  | "start"
  | "access"
  | "imports"
  | "matching"
  | "mandates"
  | "policies"
  | "cases"
  | "close"
  | "exports"
  | "payment-status"
  | "credit-review"
  | "cash"
  | "accounting"
  | "vat"
  | "payroll"
  | "permissions"
  | "recovery";
export type HelpGuide = {
  id: HelpTopicId;
  category:
    | "Getting started"
    | "Collections"
    | "Pay by Bank"
    | "Credit Desk"
    | "Cash Desk"
    | "Access & recovery";
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
      "Check who you are working for, what you can do and whether the records are samples.",
    destination: "Overview and the workspace lender selector",
    needs:
      "A sample workspace, or an account with access to the intended organisation and lender. Your role determines which actions are available.",
    steps: [
      "Choose sample data for a rehearsal, or sign in for your own workspace. Signing in does not move anonymous sample work into your account.",
      "Check the organisation, selected lender, role and environment before starting. Choose the intended lender from the workspace selector.",
      "On Overview, follow the next action for the task you need. Use My work for assignments and reviews that belong to you.",
    ],
    result:
      "You are working in the selected lender’s records. Reading a guide or choosing a goal does not grant permissions.",
    blocked:
      "If the lender or task is missing, ask your organisation’s administrator to check your membership and lender access. Do not use another account to bypass a restriction.",
    recovery:
      "Return to the same account, organisation and lender to find saved work. Unsaved form entries are not guaranteed to survive a refresh.",
    terms: ["organisation", "sandbox", "role"],
  },
  {
    id: "access",
    category: "Getting started",
    title: "Sign in or accept an invitation",
    summary:
      "Enter through the right account and recover an incomplete or unsuccessful invitation.",
    destination: "Sign in, then your original invitation link",
    needs:
      "Use the email address the invitation was sent to. Staff access also requires the intended organisation, the required authentication factors and an active Valo Pay membership.",
    steps: [
      "Sign in at the deployed address. If sign-in is unavailable on the current host, return to the address your administrator provided.",
      "Reopen the complete invitation link after signing in. Choose the invited organisation and complete the required authentication checks.",
      "Accept the invitation once. After a confirmed acceptance, open the pilot workspace and check that the expected lender and role are available.",
    ],
    result:
      "Membership is confirmed only after the service accepts it. Joining does not enable live payments or customer data.",
    blocked:
      "For an incomplete link, reopen the full original link. For an expired, revoked or still-invalid invitation, ask your administrator for a new invitation. A successful sign-in alone is not proof of workspace access.",
    recovery:
      "If acceptance had no clear answer, open the pilot workspace and check whether membership is active before accepting again. Do not share passwords, authentication codes or invitation tokens in a support message.",
    terms: ["organisation", "role", "unknown-outcome"],
  },
  {
    id: "imports",
    category: "Collections",
    title: "Import your first payment file",
    summary: "Save and check a sample file, fix its rows, then commit it once.",
    destination: "Import batches",
    needs:
      "A selected lender and an Admin, Operations or Finance role. The current import flow accepts synthetic records only. Customer and instalment references must already exist when the selected import kind requires them.",
    steps: [
      "Choose the record type. For incoming payment records, choose Payment evidence. Select Use sample for a format-matched example, or upload a synthetic CSV.",
      "Check the source name, source batch ID, row identities, column mapping and amount unit. Naira and kobo are different units.",
      "Choose Save and check batch. Read the row and field errors, correct them and save again. A saved batch has not yet been committed.",
      "Review the checked rows and any warnings. Choose Commit checked batch once, then read the saved result before opening Reconciliation.",
    ],
    result:
      "A committed batch records its imported rows. Payment observations still need reconciliation; importing evidence does not itself confirm a match or move funds.",
    blocked:
      "Correct the named row or field and keep the original source identities. If referenced records are missing, import or select those records first. Do not disguise a duplicate as a new row.",
    recovery:
      "Reopen the saved batch to continue. If a save or commit has an unknown result, check Operations and the saved batch before resubmitting. An expired original file may no longer be available under the lender’s retention policy.",
    terms: ["observation", "batch", "committed", "reconciliation", "kobo"],
  },
  {
    id: "matching",
    category: "Collections",
    title: "Match a payment to a repayment",
    summary:
      "Review who paid, how much arrived and which instalment the evidence supports.",
    destination: "Reconciliation",
    needs:
      "Payment evidence and an instalment for the selected lender. Admin, Operations and Finance can run reconciliation; Admin or Finance can confirm, reject or manually allocate a payment.",
    steps: [
      "Run reconciliation to compare the available observations and records. Read any unresolved observations or unallocated payments.",
      "For a proposed match, compare the customer, references, amount, currency and matching evidence. A proposed match is waiting for a decision.",
      "Confirm a supported match, or reject it if the evidence does not support it. For a manual allocation, review the selected repayment and amount before saving.",
    ],
    result:
      "A confirmed allocation applies the recorded payment to the named obligation. It does not submit a new debit or transfer money.",
    blocked:
      "Ask Admin or Finance if your role cannot decide the match. Returned funds, a different currency or a reversal-review hold can block allocation; resolve the stated issue first.",
    recovery:
      "If confirmation has no clear answer, inspect the original request and current allocation before trying again. Correct an existing outcome through the supported Finance review route; do not erase the original history.",
    terms: ["reconciliation", "allocation", "instalment", "observation"],
  },
  {
    id: "mandates",
    category: "Collections",
    title: "Pause, cancel or reissue a debit mandate",
    summary:
      "Review the customer’s recurring-debit permission and the effect of changing its record.",
    destination: "Mandates",
    needs:
      "The selected lender’s mandate, its consent evidence and an Admin or Operations role. Mandates govern recurring debit records; Permissions & readiness manages separate account-read, assessment, accounting and payroll permissions.",
    steps: [
      "Find the customer’s mandate. Check its provider reference, debit limit, status and consent evidence before choosing an action.",
      "For an active mandate, Suspend pauses its use and cancels linked scheduled attempts. Cancel ends the existing mandate record where its current state allows it. Read the change summary and record the reason before confirming.",
      "Resume is available for a suspended mandate; it does not recreate cancelled attempts. Reissue creates a separate mandate awaiting activation and requires fresh consent evidence. Existing instalments are not relinked automatically.",
    ],
    result:
      "These sandbox actions update the mandate record and history. No instruction is sent to a bank or provider. Attempts already sent retain their recorded outcomes; changing the mandate is not a refund or proof of provider-side cancellation.",
    blocked:
      "Ask Admin or Operations if your role cannot act. Cancellation cannot be undone. A cancelled, failed, expired or awaiting-activation mandate may be reissued with fresh consent; do not change existing consent evidence or a debit limit in place.",
    recovery:
      "If the action’s result is unclear, check the existing mandate and original operation before trying again. For a real provider mandate, use the accepted provider process and evidence; the sandbox record cannot establish that an external debit authority ended.",
    terms: ["mandate", "account-read", "unknown-outcome"],
  },
  {
    id: "policies",
    category: "Collections",
    title: "Review retry rules and message templates",
    summary:
      "Draft a version, compare its effect and ask a separate Compliance reviewer to decide.",
    destination: "Policies & templates",
    needs:
      "Access to the selected lender. Admin drafts and submits policy or template versions; a Compliance reviewer other than the author approves or rejects them. Existing drafts retain their author restrictions.",
    steps: [
      "Open the policy or template. Review its current status and author. For an approved version, use Draft next version to propose a change while preserving the approved history.",
      "Check retry limits, spacing, notice periods and quiet hours, or the template’s rendered sample message. Test this version rehearses a policy against sample instalments; it does not approve the policy or send a collection instruction.",
      "Submit the draft for review. The separate Compliance reviewer compares the proposed version with the previous evidence and records approval or requests changes with a reason.",
    ],
    result:
      "Approval records a reviewed version. It does not send messages, activate live retries or automatically change each mandate. Applying a policy in Mandates is a separate action requiring the accepted notice and any required fresh consent.",
    blocked:
      "You cannot approve your own submission or edit an approved version in place. Follow the author and role explanation on the action. A missing previous version must be investigated; it is not an empty or implicitly accepted baseline.",
    recovery:
      "Reopen the current version and its review status before submitting again after an unclear response. Keep earlier versions and decisions. A simulated notice is not proof that a customer received or accepted it.",
    terms: [
      "collection-policy",
      "notification-template",
      "independent-review",
      "mandate",
    ],
  },
  {
    id: "cases",
    category: "Collections",
    title: "Take ownership of an issue",
    summary:
      "Give an unresolved item a responsible person, next step and clear handover.",
    destination: "Exceptions → case, or My work",
    needs:
      "Access to the selected lender and a role eligible to handle cases. Admin, Operations, Finance and Compliance reviewer can coordinate cases within the case’s ownership rules; Read-only can inspect them.",
    steps: [
      "Open the issue and read its linked evidence, status, owner and deadline.",
      "Claim an available case if you are eligible, or ask the current owner or Admin to hand it over. Choose only an eligible assignee from the list.",
      "Record the next step and supporting note. Resolve the underlying financial or evidence issue through the relevant workflow before claiming the issue is resolved.",
    ],
    result:
      "The case records responsibility and its history. Handing over a case does not confirm a payment or complete a close.",
    blocked:
      "Only the current owner or Admin can change or hand over an assigned case. Some financial resolutions require Admin or Finance even when another role can coordinate the case.",
    recovery:
      "If another person changed the case, refresh and review their update before saving again. Resolved cases retain their history and cannot be reassigned.",
    terms: ["exception", "case", "role"],
  },
  {
    id: "close",
    category: "Collections",
    title: "Prepare a close for a separate reviewer",
    summary:
      "Explain a saved close and ask another Finance user to review its evidence.",
    destination: "Reports → daily close, then Finance close review",
    needs:
      "A saved close snapshot and available evidence for the lender. Admin, Operations or Finance can prepare; the named Finance reviewer must be a different staff user.",
    steps: [
      "Reconcile the sample payments, then run a daily close from Reports. Open the resulting snapshot in Finance close review.",
      "Read the source completeness and discrepancies. Explain each issue and name a different Finance reviewer. Any acceptance of unresolved items must be explicit.",
      "The named reviewer opens the request from My work, checks the saved evidence and either approves it or requests changes.",
    ],
    result:
      "Approval records acceptance of that evidence snapshot. It does not resolve exceptions, move money or approve later changes automatically.",
    blocked:
      "Switching demo roles does not create an independent staff reviewer. If a reviewer is unavailable, Admin can reassign the review. Fix stale or incomplete evidence as directed before continuing.",
    recovery:
      "Reopen the exact close and read its current review status. Changes requested need a new preparation; earlier snapshots and decisions remain in the history.",
    terms: ["close", "snapshot", "independent-review"],
  },
  {
    id: "exports",
    category: "Collections",
    title: "Find and download saved evidence",
    summary:
      "Follow file preparation and return to the original export if it is interrupted.",
    destination: "Saved exports, or the export control on the source record",
    needs:
      "Current access to the lender and the requested evidence. A close review export needs a current approved review; other export types have their own source and role checks.",
    steps: [
      "Request the evidence from its source record, such as an approved close review or customer timeline.",
      "Read the preparation status. Open Saved exports to follow the saved job rather than starting another export.",
      "When the file is ready and you remain authorised, download it from that job. Keep its reference and integrity details with the file if you need to verify it later.",
    ],
    result:
      "You receive the evidence that was prepared for that export. A download is not proof of a live payment, a tax filing or an accounting entry.",
    blocked:
      "A preparing, failed, expired or unavailable file cannot be treated as a successful download. Follow the job’s explanation; current access is checked again when retrieving the file.",
    recovery:
      "Use the existing job’s recovery action when offered. It preserves the original job and file identity. If access was removed, ask the administrator to check the legitimate access route.",
    terms: ["export", "snapshot", "unknown-outcome"],
  },
  {
    id: "payment-status",
    category: "Pay by Bank",
    title: "Understand payment status without paying twice",
    summary:
      "Tell a pending or unknown payment result apart from a confirmed receipt.",
    destination: "Pay by Bank → existing checkout",
    needs:
      "The intended customer, merchant, bill or repayment, amount and currency. The current connected workspace rehearses payment steps with sample data; it is not a live bank checkout.",
    steps: [
      "Review the merchant, customer, purpose, amount, currency and any displayed fees before authorising the supported sample flow.",
      "Read the checkout’s progress. Pending means the result is not yet confirmed. Awaiting authorisation, processing and outcome unknown do not mean payment is confirmed or safely failed.",
      "Return to the existing checkout to check the result. If the outcome is unknown, use its recovery route and wait for evidence; do not create a replacement payment.",
    ],
    result:
      "A confirmed receipt and settlement status describe different events. Confirmation does not mean the provider’s settlement has completed. In the sample workspace, both are simulated evidence.",
    blocked:
      "The page explains missing authority, held repayments and unavailable actions. An unresolved payment outcome belongs to Admin or Finance for evidence-based resolution.",
    recovery:
      "Leaving the page is not a cancellation. Reopen the same checkout or saved request. Do not treat a timeout, blank page or missing notification as proof that nothing was submitted.",
    terms: ["payment-request", "unknown-outcome", "settlement", "sandbox"],
  },
  {
    id: "credit-review",
    category: "Credit Desk",
    title: "Review an assessment and its evidence",
    summary:
      "Understand the inputs and gaps before recording a reviewer outcome.",
    destination: "Credit Desk → assessment and review",
    needs:
      "An applicant in the selected lender and separate account-read and credit-assessment permissions. Admin or Operations can assess; a different Admin, Finance or Compliance reviewer can review. These are sample assessments and simulated reviewer outcomes.",
    steps: [
      "Choose the applicant and inspect permissions. Run or open the assessment version for the request being considered.",
      "Read the evidence coverage, source age, costs, commitments and explanation. Missing evidence or permission is a blocker, not a zero-risk result.",
      "Use the authorised review panel to record the outcome, rationale and applicant explanation. Explain an override when one is permitted.",
    ],
    result:
      "A versioned assessment and reviewer record remain traceable. A rule score is not a default probability, loan approval, disbursement or real lending decision.",
    blocked:
      "Follow the page’s missing-evidence or permission explanation. Only a permitted reviewer can record an outcome; choosing a guide or scenario does not change their role.",
    recovery:
      "Open Review history for the selected version before submitting again. An already reviewed version keeps its immutable review; a new assessment creates a new version.",
    terms: ["assessment", "account-read", "snapshot"],
  },
  {
    id: "cash",
    category: "Cash Desk",
    title: "Read cash balances and their age",
    summary:
      "Check source timestamps and assumptions before using a cash forecast.",
    destination: "Cash Desk → Cash & forecast",
    needs:
      "The sample Cash Desk and active business-account read permission. Saved forecasts also depend on the current source balances, commitments and permission.",
    steps: [
      "Read each account’s bank balance timestamp and source state. A balance from an earlier time may not describe funds available now.",
      "Compare commitments, expected receipts, fees and the planning buffer. Treat unknown or withheld figures as needing review, not as zero.",
      "Review the assumptions before saving a forecast. If the sample source data is stale, use the supported sample refresh and prepare the forecast again.",
    ],
    result:
      "A forecast is a planning scenario based on its recorded evidence. A planning buffer does not reserve bank funds, and refreshing samples does not contact a bank.",
    blocked:
      "Expired or changed permissions and changed evidence can make a saved forecast unavailable for current use. Resolve the stated dependency before preparing a new version.",
    recovery:
      "Return to the saved forecast and inspect its state. A newly refreshed balance does not automatically approve an old payroll plan or accounting draft.",
    terms: ["stale", "forecast", "account-read"],
  },
  {
    id: "accounting",
    category: "Cash Desk",
    title: "Prepare an accounting draft for review",
    summary:
      "Check a receipt and mapping, then obtain independent Finance review before export.",
    destination: "Cash Desk → Accounting",
    needs:
      "Current business-account read and accounting-draft permissions, the sample receipt and mapping, an Admin or Operations preparer, and a different Finance reviewer.",
    steps: [
      "Prepare the draft and inspect the receipt, gross amount, fees, net amount, invoice allocation and mapping.",
      "A different Finance reviewer checks the current draft and records approval. Recheck any residual difference or blocked period first.",
      "Prepare the reviewed export while evidence and permissions remain current, then download the review file.",
    ],
    result:
      "The current flow prepares a sample accounting export. Nothing has been posted to accounting software; the accounting system remains authoritative.",
    blocked:
      "If permissions or evidence change, refresh the accounting review and obtain a new Finance approval. The previous approval does not cover a changed draft.",
    recovery:
      "Inspect the existing receipt and draft after an interruption. Keep the same receipt identity and check its saved result before repeating an action.",
    terms: ["accounting-draft", "independent-review", "export"],
  },
  {
    id: "vat",
    category: "Cash Desk",
    title: "Prepare a VAT evidence schedule",
    summary:
      "Compare invoice, bank and ledger evidence for an accountant to review.",
    destination: "Cash Desk → VAT evidence",
    needs:
      "Current business-account read and accounting-draft permissions, the sample Cash Desk, and a Finance reviewer to save the schedule.",
    steps: [
      "Review invoice amounts, bank allocations and the ledger control separately. Read the evidence gaps and excluded items.",
      "Resolve or document the evidence needed for review. A bank credit alone does not establish VAT or input-tax recovery.",
      "Finance saves the review schedule and downloads the saved review when it is available.",
    ],
    result:
      "The schedule is preparation for review with an accountant. It does not file a tax return, pay tax or establish a tax entitlement.",
    blocked:
      "Missing evidence, changed sources or changed permissions may withhold earlier figures. Prepare the schedule again under the current permission after reviewing those gaps.",
    recovery:
      "Check the saved schedule and timestamp before saving another. Keep the original record as historical evidence.",
    terms: ["vat-schedule", "export", "stale"],
  },
  {
    id: "payroll",
    category: "Cash Desk",
    title: "Prepare a reviewed payroll file",
    summary:
      "Check funding for an approved net-pay run without implying salaries have been paid.",
    destination: "Cash Desk → Payroll funding",
    needs:
      "An approved sample net-pay run, active business-account read and payroll-preparation permissions, an Admin or Operations preparer, and a different Finance reviewer.",
    steps: [
      "Prepare the funding plan from the approved run. Review the source account, balance timestamp, commitments, fees and buffer.",
      "Have a separate Finance checker review the plan and items. Fix insufficient or stale funding evidence before export.",
      "Prepare and download the reviewed export when current checks allow it. Keep each item’s outcome visible in the existing plan.",
    ],
    result:
      "Funding approval and a downloaded file do not execute salaries. Payroll calculations remain in the payroll system; the sample export leaves payroll unpaid.",
    blocked:
      "Changed permissions or funding can require a refreshed review and new approval. Successful or unknown items must not be exported again as fresh payments.",
    recovery:
      "Reopen the existing plan and check each item. Unknown outcomes stay on hold until evidence resolves them; do not make a replacement run to bypass that hold.",
    terms: ["payroll-file", "independent-review", "unknown-outcome"],
  },
  {
    id: "permissions",
    category: "Access & recovery",
    title: "Change or withdraw a permission",
    summary:
      "Check a permission’s purpose and stop new work that depends on it.",
    destination: "Permissions & readiness",
    needs:
      "Access to the selected lender. In the sample simulator, Admin or Operations can grant a permission; Admin, Operations or Compliance reviewer can revoke one.",
    steps: [
      "Read the purpose, subject and expiry. Account reading, credit assessment, accounting drafts and payroll preparation use separate permissions.",
      "To decline optional sample setup, leave the grant form without saving. You can still inspect the explanation of the blocked workflow.",
      "To withdraw an existing permission, select it, review the displayed subject and consequence, add the required reason and confirm the revocation.",
    ],
    result:
      "Revocation blocks new dependent work and keeps historical evidence. In-flight receipts may still be reconciled. It does not undo an earlier payment or revoke unrelated permissions.",
    blocked:
      "Ask the appropriate authorised person when your role cannot grant or revoke. A sample permission cannot connect a real account or authorise a live bank debit.",
    recovery:
      "After an unclear response, inspect the existing permission and recover the original request before submitting again. A later grant does not restore the validity of an earlier dependent approval automatically.",
    terms: ["account-read", "mandate", "role"],
  },
  {
    id: "recovery",
    category: "Access & recovery",
    title: "Recover an interrupted request",
    summary:
      "Find the saved result without creating a duplicate consequential action.",
    destination: "The page’s recovery notice or Operations",
    needs:
      "The same account or anonymous sandbox, the intended lender and current access. Only requests that reached the service can appear in its saved operation history.",
    steps: [
      "Read the page’s result carefully. An unsaved form, saved draft, pending request and confirmed result are different states.",
      "For an unclear submitted result, use the page’s recovery notice or find the original request in Operations. Check its current status and linked record.",
      "Use the recovery or cancellation offered for that original request. Do not start a replacement payment, import commitment or accounting action while its outcome is unknown.",
    ],
    result:
      "Recovery checks the existing operation and keeps its original identity. A completed record can be opened from its saved result.",
    blocked:
      "An empty history is not proof that an external payment failed. Invitations use the pilot membership check instead of Operations. Some actions are no longer cancellable after completion.",
    recovery:
      "If a request is not listed, inspect the target record and the page’s guidance. Do not assume browser refresh preserves unsaved form entries, and never paste sensitive financial data or credentials into a support message.",
    terms: ["unknown-outcome", "committed", "accounting-draft"],
  },
];

export const helpTerms = [
  {
    id: "organisation",
    term: "Organisation",
    formal: "Tenant",
    meaning:
      "The organisation whose access and records you are using. Lenders within the workspace can have separate access. Selecting a different lender never grants a wider role.",
  },
  {
    id: "sandbox",
    term: "Sample workspace",
    formal: "Synthetic sandbox",
    meaning:
      "An isolated place to rehearse with fictional records. Sample bank readings, permissions and payment outcomes are not live evidence. Signing in does not activate financial services.",
  },
  {
    id: "role",
    term: "Your allowed actions",
    formal: "Role and current authority",
    meaning:
      "Your assigned role and current lender access determine what the service permits. Choosing a task, changing a page or reading this guide does not change that authority.",
  },
  {
    id: "observation",
    term: "Payment evidence",
    formal: "Observation",
    meaning:
      "A record from a statement, provider event or settlement report that needs to be checked. More than one observation can describe the same payment; it must not be counted twice.",
  },
  {
    id: "batch",
    term: "Import batch",
    formal: "Saved import batch",
    meaning:
      "A saved file, column mapping and row checks kept together. Saving allows review and correction; it does not commit the rows for processing.",
  },
  {
    id: "committed",
    term: "Committed import",
    formal: "Commit",
    meaning:
      "The checked batch has been accepted for import into the application. A committed payment observation may still need matching; committed does not mean money moved.",
  },
  {
    id: "kobo",
    term: "Kobo",
    formal: "NGN minor unit",
    meaning:
      "One naira equals 100 kobo. Confirm the import’s amount unit: 2,500 kobo is ₦25, while 2,500 naira is ₦2,500.",
  },
  {
    id: "reconciliation",
    term: "Match payments to repayments",
    formal: "Reconciliation",
    meaning:
      "Compare payment evidence with recorded obligations, identify matches and surface differences. It does not instruct a bank to move funds.",
  },
  {
    id: "allocation",
    term: "Apply a payment to a repayment",
    formal: "Allocation",
    meaning:
      "Record which bill or instalment a received payment covers. A proposed allocation still needs a decision where required.",
  },
  {
    id: "instalment",
    term: "Repayment due",
    formal: "Instalment or due item",
    meaning:
      "An amount owed for a stated date. An outstanding obligation is not a balance of funds held by Valo Pay.",
  },
  {
    id: "exception",
    term: "Issue needing review",
    formal: "Exception",
    meaning:
      "A discrepancy, missing record, unknown outcome or other condition that cannot be safely resolved automatically. It needs the appropriate evidence and authorised action.",
  },
  {
    id: "case",
    term: "Case",
    formal: "Coordinated exception",
    meaning:
      "The issue’s ownership, next step, notes and handover history. Assigning it does not resolve its underlying financial condition.",
  },
  {
    id: "close",
    term: "Daily close",
    formal: "Close snapshot",
    meaning:
      "A saved account of reconciliation results and outstanding issues at that time. Preparing, reviewing and approving the evidence are separate steps.",
  },
  {
    id: "snapshot",
    term: "Saved version of evidence",
    formal: "Snapshot",
    meaning:
      "The evidence recorded at one point in time. A decision on that snapshot does not approve changes made afterwards.",
  },
  {
    id: "independent-review",
    term: "A separate person checks the work",
    formal: "Maker/checker separation",
    meaning:
      "The preparer and reviewer must be different authorised people where required. Switching roles on the same staff identity does not provide independent approval.",
  },
  {
    id: "export",
    term: "Prepared file",
    formal: "Export",
    meaning:
      "A file prepared from permitted records. Creating or downloading one does not prove that money was transferred, a tax return was filed or accounting software was updated.",
  },
  {
    id: "payment-request",
    term: "Request to pay",
    formal: "Checkout or payment intent",
    meaning:
      "A record of what the customer is asked to pay and its progress. Creating or authorising a request is not evidence that a receipt or settlement has completed.",
  },
  {
    id: "unknown-outcome",
    term: "Outcome unknown",
    formal: "Unconfirmed operation",
    meaning:
      "The service does not yet have a reliable final result. Check the original request and supporting evidence. A timeout is not permission to submit a replacement payment.",
  },
  {
    id: "settlement",
    term: "Provider settlement",
    formal: "Settlement",
    meaning:
      "The provider’s transfer and supporting payout evidence. A confirmed customer payment and a completed settlement are different events.",
  },
  {
    id: "assessment",
    term: "Applicant assessment",
    formal: "Credit assessment",
    meaning:
      "A versioned analysis of permitted evidence and rules. A rule score is not a default probability or loan decision, and a sample review does not approve real credit.",
  },
  {
    id: "account-read",
    term: "Permission to read an account",
    formal: "Account-read consent",
    meaning:
      "Authority to use account information for the stated subject, purpose and period. It is not permission to debit the account, assess credit or prepare payroll.",
  },
  {
    id: "mandate",
    term: "Permission for recurring bank debits",
    formal: "Debit mandate",
    meaning:
      "The recorded authority and terms for recurring debit requests. It is separate from account-read permission and does not prove a particular debit succeeded.",
  },
  {
    id: "collection-policy",
    term: "Retry rules",
    formal: "Collection policy",
    meaning:
      "A versioned set of limits, timing and notice requirements for collections. A tested or approved policy does not itself send an instruction or replace the consent and notice checks on a mandate.",
  },
  {
    id: "notification-template",
    term: "Reviewed message wording",
    formal: "Notification template",
    meaning:
      "The versioned text and placeholders used to prepare a customer message. A sample preview or approved template is not evidence that a message was sent, delivered or accepted.",
  },
  {
    id: "stale",
    term: "Data may be out of date",
    formal: "Stale evidence",
    meaning:
      "The source reading or evidence is too old or has changed. Review the displayed timestamp and refresh through the supported route before relying on it for new work.",
  },
  {
    id: "forecast",
    term: "Cash plan",
    formal: "Cash forecast",
    meaning:
      "An estimate based on timestamped balances, receipts, commitments and assumptions. It is not a bank balance or a reservation of money.",
  },
  {
    id: "accounting-draft",
    term: "Accounting work waiting for review",
    formal: "Accounting draft",
    meaning:
      "A proposed mapping and allocation of a receipt to accounting records. Prepared, reviewed, exported and posted are different states; the current sample flow does not post externally.",
  },
  {
    id: "vat-schedule",
    term: "VAT evidence schedule",
    formal: "VAT review schedule",
    meaning:
      "Preparation that keeps invoice, bank and ledger evidence distinct for review with an accountant. It is not a filed return or a tax payment.",
  },
  {
    id: "payroll-file",
    term: "Payroll preparation file",
    formal: "Reviewed payroll export",
    meaning:
      "Preparation based on an approved net-pay run and reviewed funding. Exported does not mean salaries were executed or confirmed paid.",
  },
] as const;

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
