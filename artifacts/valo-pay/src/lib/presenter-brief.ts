import { amountUnitName } from '@workspace/valopay-schema';
import { formatDate } from './formatters';
import { PRESENTATION_CUSTOMER, PRESENTATION_INSTALMENT, presentationChecks, presentationSteps } from './presentation';

/*
 * The presenter's brief and the sample pack, which only the Presentation page
 * offers for download. They live apart from the talking points, which the
 * guide on every console page reads, so the page shell does not carry them.
 */

export function presentationSamples(date: string) {
  return [
    { kind: 'Customers', filename: '01-presentation-customers.csv', csv: 'source_row_id,name,reference,consentProvenance,bankName,accountMasked\npres-c001,Presentation customer,PRES-C001,Synthetic presentation consent,Sandbox Bank,•••• 0001' },
    { kind: 'Instalments', filename: '02-presentation-instalments.csv', csv: `source_row_id,name,reference,customerId,amount,dueDate,owner\npres-d001,Presentation instalment,PRES-D001,PRES-C001,18000.50,${date},lms` },
    { kind: 'Payment evidence', filename: '03-presentation-payment.csv', csv: 'source_row_id,name,reference,customerId,amount,source,dueItemId,narration\npres-o001,Presentation payment,PRES-O001,PRES-C001,18000.50,statement,PRES-D001,PRES-D001 synthetic transfer' },
  ];
}

/**
 * Where the pack goes in Import batches, naming each amount unit as Import
 * batches offers it for the record type: payment evidence calls it by its
 * row's currency too (amountUnitName).
 */
export const sampleImportSteps = `In Import batches, choose the record type that matches each file. Under Amounts in the source file, choose ${amountUnitName('naira', 'due-items')}. For Payment evidence, choose ${amountUnitName('naira', 'observations')}. Use the source name “Presentation sample”, the source row column “source_row_id” and a different file reference for each file.`;

/** A time in the meeting as a clock reads it, from the meeting's start: 165 seconds is "2:45". */
export function meetingClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The demo's slot in the meeting, in seconds from its start: 2:00 to 14:00. */
export const demoSlot = { from: 2 * 60, to: 14 * 60 } as const;

/** When each of the nine moments starts, in seconds from the meeting's start: one after another from 2:00. */
export function momentStarts(): number[] {
  let at: number = demoSlot.from;
  return presentationSteps.map(step => { const start = at; at += step.seconds; return start; });
}

/**
 * The 20-minute meeting the demo sits in, part by part, as the brief and docs/investor-presentation.md set it out. The
 * demo's moments fill 2:00 to 14:00 (momentStarts); what is real comes from Go-live evidence, and the questions from
 * investorAnswers.
 */
export const meetingRunSheet = [
  { from: '0:00', to: '2:00', part: 'The problem and who it is for', notes: 'Say it in your own words. For example: “Valo Pay helps Nigerian lenders collect repayments, see what was paid and prove it. Today it runs on sample data only.”' },
  { from: '2:00', to: '14:00', part: 'The demo', notes: 'Follow the 9 moments under Demonstration. They take about 12 minutes:' },
  { from: '14:00', to: '16:00', part: 'What is real and what comes next', notes: 'Open Go-live evidence. Show that the 5 go-live requirements are still pending, so Valo Pay is not ready to go live. Say that live payments and bank connections are switched off, so no collection instruction can be sent. Then explain the pilot plan with lenders. The requirement Two design-partner lenders needs 2 signed lender contracts. Each pilot will measure how often team members finish their tasks, how many errors they make and how long the daily close takes.' },
  { from: '16:00', to: '20:00', part: 'Questions', notes: 'Give short, honest answers. They are under Questions to prepare for.' },
] as const;

/**
 * Short, honest answers to the questions investors are likely to ask, for the presenter to say. Each claims only what
 * the repository states: no traction, revenue, partner or approval is invented, and every boundary keeps its words.
 */
export const investorAnswers = [
  { question: 'Is this live?', answer: 'No. This is working software in a sandbox with sample data. Live payments and bank connections are switched off, and real customer data is blocked. Go-live evidence lists 5 requirements that are still pending.' },
  { question: 'Who is it for?', answer: 'Nigerian lenders and cooperatives first: the Operations and Finance teams who collect repayments, match payments to instalments and resolve exceptions. Credit Desk serves their credit reviewers. Cash Desk serves small businesses that plan their cash, accounting and payroll.' },
  { question: 'What is connected?', answer: 'No bank, payment provider or accounting software is connected yet. Pay by Bank simulates each bank step, and Credit Desk and Cash Desk read sample bank data. Customer and instalment records arrive as files from a loan management system. Text messages are simulated. Paystack is the first payment provider Valo Pay plans to use, and Xero the first accounting software.' },
  { question: 'Is Paystack connected?', answer: 'No. Valo Pay has code for a Paystack test account, tested only with local sample scenarios. No Paystack account or test key is set up, and an external connection has not been verified. Do not claim that Valo Pay accepts payments or offers direct debits.' },
  { question: 'How is money kept safe?', answer: 'Valo Pay never holds money. With Pay by Bank, the customer authorises each payment at their own bank, and only a payment the bank or provider confirms counts. Whoever prepares a daily close, a credit assessment, an accounting draft or a payroll plan cannot approve it. A different person must review it. Every change is kept in the audit log. Permission to read an account is not permission to take money from it.' },
  { question: 'What is needed before go-live?', answer: 'Go-live evidence lists 5 requirements, and each is still pending. They are a legal opinion, partner access through a payment aggregator, permission to process data, security and operational readiness, and contracts with 2 design-partner lenders. Team member sign-in with two-step verification, managed keys, restricted database access, recovery and external services must also be checked where Valo Pay will run. They must pass the agreed acceptance process.' },
  { question: 'What works today?', answer: 'Show the saved records, checks, decisions and exports that this version really offers.' },
  { question: 'Does this prove growth or better recoveries?', answer: 'No. Bring separate proof that has been checked: conversations with lenders, signed agreements and measured pilot results, if you have them.' },
  { question: 'What will investment pay for?', answer: 'Explain your real plans for hiring, setting up live services and running pilots. Do not invent an amount, a timeline, a number of lenders or a return.' },
] as const;

/** The downloaded brief. `date` is the pack's business date (YYYY-MM-DD), shown as the console shows dates. */
export function presenterBrief(date: string): string {
  const day = formatDate(date);
  const starts = momentStarts();
  const moments = presentationSteps.map((s, i) => `  - ${meetingClock(starts[i]!)} · ${s.title} · ${s.time}`).join('\n');
  return `# Valo Pay presenter brief

Prepared for ${day} (WAT). Meeting: 20 minutes, with a demo of about 12 minutes.

## Opening

Valo Pay helps Nigerian lenders collect repayments, see what was paid and prove it. This demonstration uses sample data only. No money moves.

## 20-minute run sheet

${meetingRunSheet.map(part => `- ${part.from} to ${part.to}: ${part.part}. ${part.notes}${part.from === meetingClock(demoSlot.from) ? `\n${moments}` : ''}`).join('\n')}

## Before the meeting

Rehearse first, in a private window: select Prepare for presentation and try every moment, the payment import too. Then close every private window. The sandbox is kept in the browser, so a new private window starts a new one.

On the day, open the published Valo Pay site in a new private window and keep it open until the meeting ends. Choose one sample lender. Meridian Credit is recommended. Use the demo role Admin. Prepare after 07:00 WAT, when the automatic daily close has run. If you prepared earlier, select Prepare for presentation again after 07:00 WAT. On the Presentation page, select Prepare for presentation and wait until every step is done. It fills this lender with the records each moment shows: the sample customers and instalments imported, the payment batch checked but not imported, 3 daily closes, a claimed case, 3 checkouts, 2 credit assessments, Cash Desk work waiting for approval and 2 saved exports. If a step failed, select Prepare for presentation again. Then open each page you will show, but leave the payment batch for the demo.

${presentationChecks.map(c => `- [ ] ${c.label}`).join('\n')}

## Sample files

Prepare for presentation imports these files for you. Import them by hand only in a sandbox where you have not selected it. Import Customers, then Instalments, before the meeting. Import Payment evidence during the demonstration. ${sampleImportSteps} Set the business date to ${day}. For each file, select Save and check batch, check the amount, then select Import checked batch once. The instalment and the payment are exactly ₦18,000.50 each. Reconciliation is a separate step. Once it runs, rule R1 matches the payment to ${PRESENTATION_INSTALMENT} automatically, with the confidence Certain, because the payment names that instalment and the amounts are equal. The match never appears in Matches to review. Its rule and explanation are in the sample customer’s history: open Customers, search for ${PRESENTATION_CUSTOMER} and open its history.

Importing the same file again does not start over. Its rows keep their source row IDs, so they may be reported as duplicates. For a fresh rehearsal, use a private browser window or a new, empty sample lender, if your role allows you to create one. A new lender has no ready-made exceptions. Prepare a case, or say honestly that there are none. Never clear an existing workspace.

## Demonstration

${presentationSteps.map((s, i) => `### ${i + 1}. ${s.title} · ${s.time}

${s.action}.

Show: ${s.show}

Say: “${s.say}”

If something goes wrong: ${s.fallback}`).join('\n\n')}

## Questions to prepare for

${investorAnswers.map(a => `- ${a.question} ${a.answer}`).join('\n')}

## If something fails

Explain what really happened. If a change was not confirmed, check Request history before you send it again, and use the recovery action there. If an export is still being prepared, check Saved exports. Carry on with a prepared screenshot or recording, and say that it is recorded. Do not switch off safeguards to finish the story.

## Closing

The next step is a controlled pilot with a lender. It will measure how often team members finish their tasks, how many errors they make and how long the daily close takes. Ask for feedback on the workflow and for introductions to lender teams who could use it.
`;
}

export function downloadPresentationFile(filename: string, content: string, csv = false) {
  const url = URL.createObjectURL(new Blob([csv ? '\uFEFF' : '', content], { type: csv ? 'text/csv;charset=utf-8' : 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
