# Investor presentation preparation

Open **Presentation** in the console navigation. This page supports a 20-minute investor meeting: a nine-moment demonstration of about 12 minutes, a downloadable Markdown presenter brief with the run sheet and short answers to likely questions, the **Prepare for presentation** button, three synthetic CSV files and a personal preparation checklist. It is presentation support, not evidence of production acceptance or an investor pitch containing verified commercial results.

## Prepare the sandbox, then rehearse

1. Confirm the intended release is deployed and that you can open its Presentation page. A merged pull request alone does not establish the host version.
2. Rehearse in a private window first: select **Prepare for presentation**, then try every moment, the payment import included. Then close every private window. The anonymous sandbox is kept in the browser session, so a new private window starts a new sandbox; private windows open at the same time share one session, so a second one is not a separate sandbox.
3. On the day, open the published site in a new private window and keep it open until the meeting ends. Choose one lender (Meridian Credit is recommended; Cedar Cooperative is the other) and use the demo role Admin. Verify the actual permissions needed for the actions you will show. Do not use real customer records or alter access merely to complete the demonstration.
4. Select **Prepare for presentation**. It is offered only in the anonymous sandbox and sends the platform's existing requests, as the pages send them, with sample data only: no money moves and nothing is sent to a bank. For the active lender it leaves:
   - the sample customers and instalments imported from the Presentation page's files, and the sample payment evidence batch saved and checked but **not imported**;
   - a daily close for each of the 3 days before today in West Africa Time, the latest submitted for Finance review, so it waits for a different person;
   - one sample exception claimed by a team member, with a next step and a handover note, while two other open exceptions stay unclaimed;
   - 3 Pay by Bank checkouts on 3 different open instalments, never PRES-D001: one confirmed, one awaiting authorisation and one with an unknown outcome;
   - in Credit Desk, an applicant holding Read applicant accounts and Assess an application, with an assessment waiting for a different person’s review, and an applicant who refused permission;
   - in Cash Desk, the Read business accounts permission, Cash Desk set up with a saved 30-day forecast, an accounting draft and a payroll funding plan waiting for approval, and a saved VAT schedule;
   - in Saved exports, a dispute pack (PDF) for Ada Okonkwo and a billing statement (CSV).

   It puts back the demo role you had. Go-live evidence stays pending, live payments stay switched off, the latest close waits for a second person and no invoice is issued. Pressing it again creates nothing new, and a step that failed runs again.
5. Open each page you will show, but leave the payment batch unimported: you import it once during the demo, then run reconciliation separately if permitted. Both the instalment and receipt are exactly ₦18,000.50 (1,800,050 kobo); the customer reference is PRES-C001. The payment names instalment PRES-D001 and the amounts are equal, so rule R1 matches it automatically, with the confidence Certain: it never appears in Matches to review, which holds only matches Finance must confirm. The third talking point opens the sample customer’s history, where the match is shown with its rule and explanation; until the pack is imported for the lender, it opens the customer search for PRES-C001 instead, which says the customer is not there yet. To show a match that waits for Finance, use the seeded proposal in Matches to review and say that it is not the sample payment.
6. Download the presenter brief and the prepared dispute pack in advance. Keep the file and a short labelled recording or screenshots available if the connection fails. Keep backups within the approved synthetic demonstration workspace.

A checkout the customer has not authorised expires 15 minutes after it is created, so by the meeting the waiting checkout normally shows Checkout expired. An expired checkout does not mean that a payment failed: say so rather than creating a new one. Cash Desk shows each balance’s sample bank timestamp, so a balance prepared hours earlier may read as out of date; say that rather than refreshing it during the meeting.

The three CSV files stay as downloads for a hand import, with the instructions on the page and in the brief: in Import batches choose the corresponding record type; under Amounts in the source file, Naira (₦), which Payment evidence calls Main unit (₦, or the row’s own currency); source name “Presentation sample”; source row column “source_row_id”; a distinct source file reference for each file; and the business date printed on the Presentation page. Save and check each file, review the preview and import it once. Prepare for presentation imports the same rows, so import by hand only in a sandbox where it has not been selected. The files have stable source identities. A repeated import is not a reset; duplicate detection should preserve the original records. For a new rehearsal use a new anonymous session or a new empty synthetic lender, with the appropriate access. Empty lenders have no seeded exceptions or close history until prepared. Do not delete an existing workspace to restart a demo.

## 20-minute run sheet

| Time | Part | What the presenter does |
| --- | --- | --- |
| 0:00 to 2:00 | The problem and who it is for | In their own words, for example: “Valo Pay helps Nigerian lenders collect repayments, see what was paid and prove it. Today it runs on sample data only.” |
| 2:00 to 14:00 | The demo | The nine moments below, 11 minutes 45 seconds in all. |
| 14:00 to 16:00 | What is real and what comes next | Open Go-live evidence: the 5 go-live requirements still pending, so Valo Pay is not ready to go live; live payments and bank connections switched off, so no collection instruction can be sent; and the pilot plan with lenders. The requirement Two design-partner lenders needs 2 signed lender contracts, and each pilot will measure how often team members finish their tasks, how many errors they make and how long the daily close takes. |
| 16:00 to 20:00 | Questions | The short answers under Claims and questions. |

## Twelve-minute demonstration

| Starts | Length | Screen | Point to demonstrate |
| --- | --- | --- | --- |
| 2:00 | 1 minute | Overview | One lender’s outstanding work and actual sample metrics. |
| 3:00 | 90 seconds | Import batches | The prepared payment batch: validation, the exact naira amount and saved source provenance, then one live import. |
| 4:30 | 90 seconds | Reconciliation, then the sample customer’s history | Rule R1 matched the payment to its instalment automatically, with the confidence Certain, and the history shows why; a less certain match waits for Finance. |
| 6:00 | 75 seconds | Exceptions and case history | The prepared case’s owner, next step and handover note, then the owner and due date of another open exception. |
| 7:15 | 75 seconds | Reports and Close review | Recorded closes for the 3 days before today, the latest close’s source coverage and its review waiting for a different Finance reviewer. After the live import, the review says the records changed after this close: a close can be approved only while it still matches its records. |
| 8:30 | 90 seconds | Pay by Bank | Confirmed, awaiting-authorisation and unknown-outcome checkouts; only a payment the bank or provider confirms counts. |
| 10:00 | 90 seconds | Credit Desk | The assessment, waiting for a different person to review it, and the applicant who refused permission; a credit result is not a lending decision. |
| 11:30 | 75 seconds | Cash Desk | The 30-day forecast, then the accounting draft and payroll funding plan waiting for a different Finance reviewer; nothing is posted, filed or paid. |
| 12:45 | 60 seconds | Saved exports | The prepared dispute pack: ready evidence can be retrieved, and pending or failed generation stays explicit. |

The brief adds each moment’s start time from its length, so the run sheet and the moments cannot drift apart; the last ends at 13:45.

Start presentation guide keeps a compact toolbar across console pages. Select a talking point and use its Open link; advancing a talking point does not run an action, navigate away from unsaved work or mark a task complete. From the keyboard, a talking point is chosen in the Talking point list with the arrow keys or by typing its number, 1 to 9. Next talking point is unavailable on the ninth, so reaching it moves the focus to that list rather than the page body. Notes are collapsed by default and are visible to anyone viewing the shared screen when expanded. End presentation removes the toolbar and moves focus to the page's content. On a phone the talking point's title keeps its own line, with the Open link and End presentation under it, and the Talking point list has a row of its own, so it shows the talking point's title; the page being shown stays in view. The toolbar sits above the page, so if a page stops working the toolbar and End presentation stay. Other navigation, environment labels and the normal permission checks remain available.

Preparation checks are self-reported, retained in session storage for the viewer and lender. They survive a page reload, are separate for other lenders, and fall back to memory if storage is unavailable. Clear preparation checks only clears these checkboxes. No readiness status or platform record is changed.

## Claims and questions

Say: “This is a working platform demonstrated with synthetic records. We are preparing controlled lender pilots. External provider verification and production commissioning remain outstanding.”

Demonstrate the behaviour available in the current build. Do not treat a sample amount, completed checklist, local Paystack fixture, prepared sample record or passing automated test as customer traction, recovered revenue, a lending decision, regulatory approval or a commissioned external service. Explain that the Paystack test adapter is prepared but its external connection has not been verified. Real identity/MFA, managed keys, restricted database access, recovery and live acceptance require verification on the intended host.

Bring separately verified customer conversations, agreements, pricing assumptions and pilot results if available. Prepare the actual funding request and spending plan separately; this feature does not supply or invent them. Keep the collections journey first: the six collections moments come before connected banking, and each connected banking moment keeps its boundary. Only a payment the bank or provider confirms counts, a credit result is not a lending decision, and Cash Desk posts nothing to accounting software, files no VAT return and pays no one.

The brief gives these short answers for the presenter to say. Each uses only facts the repository states, and invents no traction, revenue, partner or approval:

- Is this live? No. This is working software in a sandbox with sample data. Live payments and bank connections are switched off, and real customer data is blocked. Go-live evidence lists 5 requirements that are still pending.
- Who is it for? Nigerian lenders and cooperatives first: the Operations and Finance teams who collect repayments, match payments to instalments and resolve exceptions. Credit Desk serves their credit reviewers. Cash Desk serves small businesses that plan their cash, accounting and payroll.
- What is connected? No bank, payment provider or accounting software is connected yet. Pay by Bank simulates each bank step, and Credit Desk and Cash Desk read sample bank data. Customer and instalment records arrive as files from a loan management system. Text messages are simulated. Paystack is the first payment provider Valo Pay plans to use, and Xero the first accounting software.
- Is Paystack connected? No. Valo Pay has code for a Paystack test account, tested only with local sample scenarios. No Paystack account or test key is set up, and an external connection has not been verified. Do not claim that Valo Pay accepts payments or offers direct debits.
- How is money kept safe? Valo Pay never holds money. With Pay by Bank, the customer authorises each payment at their own bank, and only a payment the bank or provider confirms counts. Whoever prepares a daily close, a credit assessment, an accounting draft or a payroll plan cannot approve it. A different person must review it. Every change is kept in the audit log. Permission to read an account is not permission to take money from it.
- What is needed before go-live? Go-live evidence lists 5 requirements, and each is still pending. They are a legal opinion, partner access through a payment aggregator, permission to process data, security and operational readiness, and contracts with 2 design-partner lenders. Team member sign-in with two-step verification, managed keys, restricted database access, recovery and external services must also be checked where Valo Pay will run. They must pass the agreed acceptance process.
- What works today? Show the saved records, checks, decisions and exports that this version really offers.
- Does this prove growth or better recoveries? No. Bring separate proof that has been checked: conversations with lenders, signed agreements and measured pilot results, if you have them.
- What will investment pay for? Explain your real plans for hiring, setting up live services and running pilots. Do not invent an amount, a timeline, a number of lenders or a return.

If a request is not confirmed, check it in Request history and use its recovery action before you submit it again. If an export is pending, show that state and use the previously downloaded sample. Label a backup recording as recorded. Do not disable controls to make a failed step appear successful.

## Verification boundary

Console tests cover guide persistence and lender separation, malformed or unavailable session storage, the absence of operational writes from presentation controls, the sample files through the actual batch/domain functions (an automatic, certain R1 match of exactly 1,800,050 kobo that never enters Matches to review), the third talking point opening the sample customer’s history and the toolbar staying through a page error. They also cover the nine moments’ order, length and links, Pay by Bank, Credit Desk and Cash Desk opened from the page and the guide, the boundary each moment keeps, the run sheet, preparation and answers in the brief (and that this document lists the same answers), the new preparation check and the focus when Next talking point reaches the ninth talking point. Browser checks cover the guide, file downloads with the brief’s run sheet, keyboard-accessible controls (typing a talking point’s number is checked in Chromium), light/dark contrast, narrow screens (each of the nine talking points at 390 by 664 px) and the third talking point against a pack imported and reconciled through the service. These checks describe the story; they do not press Prepare for presentation, whose results are checked with the button itself. These are development checks; rehearse the deployed build before the meeting.
