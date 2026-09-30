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

/** The downloaded brief. `date` is the pack's business date (YYYY-MM-DD), shown as the console shows dates. */
export function presenterBrief(date: string): string {
  const day = formatDate(date);
  return `# Valo Pay presenter brief

Prepared for ${day} (WAT). Suggested length: about 6 minutes.

## Opening

Valo Pay helps a lender’s teams connect payment evidence, resolve exceptions and review the daily close. This demonstration uses sample data only. No money moves.

## Before the meeting

${presentationChecks.map(c => `- [ ] ${c.label}`).join('\n')}

## Prepare the sample import

Use one sample lender, in a sandbox you keep for rehearsals. Import Customers, then Instalments, before the meeting. Import Payment evidence during the demonstration. ${sampleImportSteps} Set the business date to ${day}. For each file, select Save and check batch, check the amount, then select Import checked batch once. The instalment and the payment are exactly ₦18,000.50 each. Reconciliation is a separate step. Once it runs, rule R1 matches the payment to ${PRESENTATION_INSTALMENT} automatically and with certainty, because the payment names that instalment and the amounts are equal. The match never appears in Matches to review. Its rule and explanation are in the sample customer’s history: open Customers, search for ${PRESENTATION_CUSTOMER} and open its history.

Importing the same file again does not start over. Its rows keep their source row IDs, so they may be reported as duplicates. For a fresh rehearsal, use a private browser window or a new, empty sample lender, if your role allows you to create one. A new lender has no ready-made exceptions. Prepare a case, or say honestly that there are none. Never clear an existing workspace.

## Demonstration

${presentationSteps.map((s, i) => `### ${i + 1}. ${s.title} · ${s.time}

${s.action}.

Show: ${s.show}

Say: “${s.say}”

If something goes wrong: ${s.fallback}`).join('\n\n')}

## Questions to prepare for

- Who is it for? Start with a lender’s Operations and Finance teams, who handle reconciliation and exceptions.
- What works today? Show the saved records, checks, decisions and exports that this version really offers.
- Is Paystack connected? No. Valo Pay has code for a Paystack test account, tested only with local sample scenarios. No Paystack account or test key is set up, and an external connection has not been verified. Do not claim that Valo Pay accepts payments or offers direct debits.
- Is it ready for live use? Not yet. Team member sign-in with two-step verification, managed keys, restricted database access, recovery and external services must still be checked where Valo Pay will run. They must also pass the agreed acceptance process.
- Does this prove growth or better recoveries? No. Bring separate proof that has been checked: conversations with lenders, signed agreements and measured pilot results, if you have them.
- What will investment pay for? Explain your real plans for hiring, setting up live services and running pilots. Do not invent an amount, a timeline, a number of lenders or a return.

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
