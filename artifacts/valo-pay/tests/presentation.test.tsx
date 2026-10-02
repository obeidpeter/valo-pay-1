import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { installFakeApi, type FakeApi } from './fake-api';
import { renderApp, screen, userEvent, waitFor, within } from './harness';
import { demoSlot, investorAnswers, meetingClock, meetingRunSheet, momentStarts, presentationSamples, presenterBrief } from '@/lib/presenter-brief';
import { presentationChecks, presentationSteps } from '@/lib/presentation';
import { queryClient } from '@/App';
import { Layout } from '@/components/layout';
import { PresentationProvider } from '@/components/presentation-guide';
import { WorkspaceProvider } from '@/lib/workspace-context';
import { seedMerchant } from '../../api-server/src/lib/valopay-seed';
import { saveImportBatch, commitImportBatch } from '../../api-server/src/domain/pilot-workflow';
import { reconcile } from '../../api-server/src/domain/reconciliation';
import { pageReconciliation } from '../../api-server/src/lib/console-read-models';
import type { Context, DomainState } from '../../api-server/src/domain/types';

let api: FakeApi;
beforeEach(() => { sessionStorage.clear(); api = installFakeApi(); });
afterEach(() => { api.uninstall(); sessionStorage.clear(); });

/** The pack as the rehearsal imports it: each file saved, checked and committed once through the real batch functions. */
function importPack(state: DomainState, ctx: Context, date = '2026-09-22') {
  const kinds = ['customers', 'due-items', 'observations'] as const;
  return presentationSamples(date).map((sample, index) => {
    const input = { name: sample.kind, kind: kinds[index]!, source: 'Presentation sample', sourceBatchId: sample.filename, businessDate: date, identityColumn: 'source_row_id', amountUnit: 'naira' as const, syntheticOnly: true as const, mapping: {}, csv: sample.csv };
    const batch = saveImportBatch(state, ctx, input);
    return { input, batch, committed: commitImportBatch(state, ctx, batch.id, batch.updatedAt) };
  });
}
/** Starts the guide at a talking point for the first lender, as the preparation page saves it. */
function presentAt(step: number) {
  sessionStorage.setItem(`valopay-presentation-v1:${JSON.stringify(['Sandbox Admin', api.merchantIds[0]])}`, JSON.stringify({ active: true, step, checked: [] }));
}

it('keeps presentation controls separate from platform actions and resumes after navigation and reload', async () => {
  const user = userEvent.setup();
  renderApp('/presentation');
  await user.click(await screen.findByRole('button', { name: 'Start presentation guide' }));
  let guide = screen.getByRole('region', { name: 'Presentation guide' });
  expect(within(guide).getByText(/Show presenter notes/).closest('details')?.open).toBe(false);
  await user.click(within(guide).getByRole('link', { name: 'Open Overview' }));
  await screen.findByRole('heading', { name: 'Overview' });
  expect(screen.queryByRole('region', { name: 'Tips' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Next talking point' }));
  expect(window.location.pathname).toBe('/overview');
  cleanup();
  renderApp('/overview');
  guide = await screen.findByRole('region', { name: 'Presentation guide' });
  expect(within(guide).getByText('2 of 9 · Bring in payment evidence')).toBeTruthy();
  await user.click(within(guide).getByRole('link', { name: 'Open Import batches' }));
  await screen.findByRole('heading', { name: 'Import batches' });
  await user.click(screen.getByRole('button', { name: 'End presentation' }));
  expect(screen.queryByRole('region', { name: 'Presentation guide' })).toBeNull();
  expect(api.calls.filter(c => c.method !== 'GET')).toEqual([]);
});

it('separates preparation by lender and clearing checkboxes preserves all records', async () => {
  const user = userEvent.setup(), before = structuredClone(api.state());
  renderApp('/presentation');
  const check = await screen.findByRole('checkbox', { name: /I chose one sample lender/ });
  await user.click(check);
  await user.click(screen.getByRole('button', { name: 'Start presentation guide' }));
  await user.selectOptions(screen.getByLabelText('Active lender', { selector: '#lender-sidebar' }), api.merchantIds[1]!);
  expect(screen.queryByRole('region', { name: 'Presentation guide' })).toBeNull();
  expect(screen.getByText('0 of 7 preparation checks marked')).toBeTruthy();
  await user.selectOptions(screen.getByLabelText('Active lender', { selector: '#lender-sidebar' }), api.merchantIds[0]!);
  expect(screen.getByText('1 of 7 preparation checks marked')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Clear preparation checks' }));
  expect(screen.getByText('0 of 7 preparation checks marked')).toBeTruthy();
  expect(api.state()).toEqual(before);
  expect(api.calls.filter(c => c.method !== 'GET')).toEqual([]);
});

it('ignores malformed saved state and works when browser storage is unavailable', async () => {
  const key = `valopay-presentation-v1:${JSON.stringify(['Sandbox Admin', api.merchantIds[0]])}`;
  sessionStorage.setItem(key, JSON.stringify({ active: true, step: 999, checked: ['build'] }));
  const user = userEvent.setup();
  renderApp('/presentation');
  await screen.findByRole('button', { name: 'Start presentation guide' });
  expect(screen.queryByRole('region', { name: 'Presentation guide' })).toBeNull();
  cleanup();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  renderApp('/presentation');
  await user.click(await screen.findByRole('button', { name: 'Start presentation guide' }));
  expect(screen.getByRole('region', { name: 'Presentation guide' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Next talking point' }));
  expect(screen.getByText('2 of 9 · Bring in payment evidence')).toBeTruthy();
  expect(api.calls.filter(c => c.method !== 'GET')).toEqual([]);
});

it('imports the exact sample pack through batch validation, matches it automatically by rule R1 and refuses duplicate ingestion', () => {
  const state = seedMerchant('presentation-fixture', true);
  const ctx = { actor: 'Presentation rehearsal', role: 'Admin', now: '2026-09-22T10:00:00.000Z' };
  for (const { input, batch, committed } of importPack(state, ctx)) {
    expect(batch.data.check.invalid, JSON.stringify(batch.data.check)).toBe(0);
    expect(batch.status).toBe('ready');
    expect(committed.data.check.imported).toBe(1);
    const repeated = saveImportBatch(state, ctx, { ...input, sourceBatchId: `${input.sourceBatchId}-repeat` });
    expect(repeated.data.check.skipped).toBe(1);
    expect(repeated.data.check.valid).toBe(0);
  }
  const customer = state.records.find(r => r.reference === 'PRES-C001')!;
  const due = state.records.find(r => r.reference === 'PRES-D001')!;
  const observation = state.records.find(r => r.reference === 'PRES-O001')!;
  expect(due.amountKobo).toBe(1_800_050);
  expect(observation.amountKobo).toBe(due.amountKobo);
  expect(observation.customerId).toBe(customer.id);
  expect(observation.data.dueItemId).toBe(due.id);
  reconcile(state, ctx);
  expect(observation.status).toBe('resolved');
  // The payment names its instalment and equals it, so rule R1 matches it automatically, with the confidence Certain, for exactly 1,800,050 kobo.
  const allocations = state.records.filter(r => r.kind === 'allocations' && r.data.dueItemId === due.id);
  expect(allocations).toHaveLength(1);
  expect(allocations[0]).toMatchObject({ status: 'confirmed', amountKobo: 1_800_050, data: { rule: 'R1', confidence: 'certain', automatic: true } });
  expect(String(allocations[0]!.data.explanation)).toContain('matches instalment PRES-D001');
  const payment = state.records.find(r => r.kind === 'payments' && r.id === allocations[0]!.data.paymentId)!;
  expect(payment).toMatchObject({ status: 'allocated', amountKobo: 1_800_050, data: { allocatedKobo: 1_800_050 } });
  expect(due).toMatchObject({ status: 'paid', data: { outstandingKobo: 0 } });
  // So it is never in Matches to review, which holds only the seeded proposal that step three used to land on.
  const review = pageReconciliation(state, 'proposals', { limit: 100 }, ctx.now).items;
  expect(review.map(r => r.id)).not.toContain(allocations[0]!.id);
  expect(review.map(r => state.records.find(p => p.id === r.data.paymentId)?.reference)).toEqual(['SBX-PAY-1003']);
});

// Integration fix: the kit said to choose Naira for every file, but Import batches offers Payment evidence no unit by
// that name. It names the option each record type offers (amountUnitName).
it('names the amount unit of each sample file as Import batches offers it', async () => {
  const brief = presenterBrief('2026-09-22');
  expect(brief).toContain("In Import batches, choose the record type that matches each file. Under Amounts in the source file, choose Naira (₦). For Payment evidence, choose Main unit (₦, or the row’s own currency).");
  expect(brief).not.toMatch(/choose Naira,/);
  renderApp('/presentation');
  expect((await screen.findByText(/^In Import batches, choose the record type/)).textContent).toMatch(/^In Import batches, choose the record type that matches each file\. Under Amounts in the source file, choose Naira \(₦\)\. For Payment evidence, choose Main unit \(₦, or the row’s own currency\)\. Use the source name/);
});

// The brief's answer to an investor's direct question claims only what exists: code, tested with local sample scenarios.
it('answers whether Paystack is connected with what exists and no more', () => {
  const brief = presenterBrief('2026-09-22');
  expect(brief).toContain('- Is Paystack connected? No.');
  expect(brief).toContain('No Paystack account or test key is set up');
  expect(brief).toContain('external connection has not been verified');
  expect(brief).not.toMatch(/has a Paystack test connection/);
});

// The 20-minute meeting in the downloaded brief: the opener, the nine moments from 2:00, what is real, then questions.
it('sets out the 20-minute run sheet, the preparation and honest answers in the presenter brief', () => {
  const brief = presenterBrief('2026-09-22');
  const section = (from: string, to: string) => brief.slice(brief.indexOf(from), brief.indexOf(to));
  const runSheet = section('## 20-minute run sheet', '## Before the meeting');
  expect(runSheet).toContain('- 0:00 to 2:00: The problem and who it is for. Say it in your own words. For example: “Valo Pay helps Nigerian lenders collect repayments, see what was paid and prove it. Today it runs on sample data only.”');
  expect(runSheet).toContain([
    '- 2:00 to 14:00: The demo. Follow the 9 moments under Demonstration. They take about 12 minutes:',
    '  - 2:00 · Start with the work · 1 minute',
    '  - 3:00 · Bring in payment evidence · 90 seconds',
    '  - 4:30 · Explain the match · 90 seconds',
    '  - 6:00 · Give an exception an owner · 75 seconds',
    '  - 7:15 · Review the day’s close · 75 seconds',
    '  - 8:30 · Take a payment by bank · 90 seconds',
    '  - 10:00 · Check an applicant’s affordability · 90 seconds',
    '  - 11:30 · See the business’s cash · 75 seconds',
    '  - 12:45 · Leave with the evidence · 60 seconds',
    '- 14:00 to 16:00: What is real and what comes next. Open Go-live evidence. Show that the 5 go-live requirements are still pending, so Valo Pay is not ready to go live. Say that live payments and bank connections are switched off, so no collection instruction can be sent. Then explain the pilot plan with lenders.',
  ].join('\n'));
  expect(runSheet).toContain('- 16:00 to 20:00: Questions. Give short, honest answers. They are under Questions to prepare for.');
  // The last moment ends by 14:00, when what is real begins.
  expect(momentStarts().at(-1)! + presentationSteps.at(-1)!.seconds).toBeLessThanOrEqual(demoSlot.to);
  // The preparation starts with the button, and keeps the payment batch for the live import.
  const before = section('## Before the meeting', '## Sample files');
  expect(before).toContain('On the Presentation page, select Prepare for presentation and wait until every step is done.');
  expect(before).toContain('Then open each page you will show, but leave the payment batch for the demo.');
  // The automatic daily close at 07:00 WAT would close the latest prepared date again.
  expect(before).toContain('Use the demo role Admin. Prepare after 07:00 WAT, when the automatic daily close has run. If you prepared earlier, select Prepare for presentation again after 07:00 WAT.');
  const answers = section('## Questions to prepare for', '## If something fails');
  expect(answers).toContain('- Is this live? No. This is working software in a sandbox with sample data. Live payments and bank connections are switched off');
  expect(answers).toContain('- Who is it for? Nigerian lenders and cooperatives first');
  expect(answers).toContain('- What is connected? No bank, payment provider or accounting software is connected yet.');
  expect(answers).toContain('- How is money kept safe? Valo Pay never holds money.');
  expect(answers).toContain('Permission to read an account is not permission to take money from it.');
  expect(answers).toContain('- What is needed before go-live? Go-live evidence lists 5 requirements, and each is still pending.');
  // The answers claim no traction, revenue, partner or approval.
  expect(answers).not.toMatch(/\b(?:revenue|traction|partnered|partnership|approved by|licen[cs]ed)\b|we have signed|is connected to/i);
});

// The team's document tells the same story as the brief: the same parts of the meeting, moments and answers.
it('lists the brief’s run sheet, moments and answers in docs/investor-presentation.md', () => {
  // From the console package, as the console's tests run, or from the repository's root.
  const doc = readFileSync([join(process.cwd(), '..', '..', 'docs', 'investor-presentation.md'), join(process.cwd(), 'docs', 'investor-presentation.md')].find(path => existsSync(path))!, 'utf8');
  for (const part of meetingRunSheet) expect(doc).toContain(`| ${part.from} to ${part.to} | ${part.part} |`);
  const starts = momentStarts();
  presentationSteps.forEach((step, index) => expect(doc).toContain(`| ${meetingClock(starts[index]!)} | ${step.time} |`));
  for (const { question, answer } of investorAnswers) expect(doc).toContain(`- ${question} ${answer}`);
  expect(doc).toContain('use the demo role Admin. Prepare after 07:00 WAT, when the automatic daily close has run. If you prepared earlier, select Prepare for presentation again after 07:00 WAT.');
});

// Dates as the console writes them, never ISO, in the brief and on the page; durations in numerals.
it("writes the pack's dates and the talking points' durations as the rest of the console does", async () => {
  const brief = presenterBrief('2026-09-22');
  expect(brief).toContain('Prepared for 22 Sept 2026 (WAT). Meeting: 20 minutes, with a demo of about 12 minutes.');
  expect(brief).toContain('Set the business date to 22 Sept 2026.');
  expect(brief).toContain('### 1. Start with the work · 1 minute');
  expect(brief).toContain('### 2. Bring in payment evidence · 90 seconds');
  expect(brief).toContain('### 3. Explain the match · 90 seconds');
  expect(brief).not.toMatch(/\d{4}-\d{2}-\d{2}|\bsec\b|six minutes|twelve minutes|twenty minutes/);
  // The files themselves keep the ISO date other systems read.
  expect(presentationSamples('2026-09-22')[1]!.csv).toContain(',2026-09-22,');
  renderApp('/presentation');
  const pack = (await screen.findByRole('heading', { name: 'Sample files' })).closest('section')!;
  expect(within(pack).getByText(/^Prepare for presentation imports the customer and instalment files/).textContent).toMatch(/The files’ business date is \d{1,2} \w{3,4} \d{4} \(WAT\)\.$/);
  expect(pack.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  // Each download's name starts with its visible label, then says which file.
  for (const kind of ['customers', 'instalments', 'payment evidence']) expect(within(pack).getByRole('button', { name: `Download CSV of ${kind}` })).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1, name: 'Presentation' }).nextElementSibling!.textContent).toBe('Show investors how a lender gets from records to a reviewed close, and what connected banking adds: a demo of about 12 minutes in a 20-minute meeting.');
  expect(screen.getByText('The presenter brief holds the 20-minute run sheet and short answers to likely questions.')).toBeTruthy();
  expect(screen.getAllByText('1 minute')).toHaveLength(1);
  expect(screen.getAllByText('90 seconds')).toHaveLength(4);
  expect(screen.getAllByText('75 seconds')).toHaveLength(3);
  expect(screen.getAllByText('60 seconds')).toHaveLength(1);
});

it('opens the sample customer at step three, where the automatic R1 match and its explanation are shown', async () => {
  api.mutate((state, ctx) => { importPack(state, ctx, api.now.slice(0, 10)); reconcile(state, ctx); });
  const customer = api.state().records.find(r => r.kind === 'customers' && r.reference === 'PRES-C001')!;
  presentAt(2);
  const user = userEvent.setup();
  renderApp('/overview');
  const guide = await screen.findByRole('region', { name: 'Presentation guide' });
  expect(within(guide).getByText('3 of 9 · Explain the match')).toBeTruthy();
  const link = within(guide).getByRole('link', { name: 'Open the sample customer' });
  await waitFor(() => expect(link.getAttribute('href')).toBe(`/customers/${customer.id}`));
  await user.click(within(guide).getByText(/Show presenter notes/));
  expect(within(guide).getByText(/rule R1 matched them automatically, with the confidence Certain/)).toBeTruthy();
  expect(within(guide).getByText(/never appears in Matches to review/)).toBeTruthy();
  await user.click(link);
  await screen.findByRole('heading', { level: 1, name: 'Presentation customer' });
  const history = screen.getByRole('heading', { name: 'Customer history' }).closest('div.bg-card') as HTMLElement;
  const match = within(history).getByText(/^Matched automatically by rule R1\. Confidence: Certain\./);
  expect(match.textContent).toContain('Provider reference PRES-O001 matches instalment PRES-D001');
  expect(within(match.parentElement!).getByText('₦18,000.50')).toBeTruthy();
  expect(api.calls.filter(c => c.method !== 'GET')).toEqual([]);
});

// Preparation starts with Prepare for presentation, and the checklist asks for it; the files stay for a hand import.
it('starts the preparation with Prepare for presentation and keeps the sample files for a hand import', async () => {
  const user = userEvent.setup(), before = structuredClone(api.state());
  renderApp('/presentation');
  const checks = (await screen.findByRole('heading', { name: 'Before you share your screen' })).closest('section')!;
  expect(within(checks).getByText(/^Start with Prepare for presentation, then check each page yourself\./)).toBeTruthy();
  expect(within(checks).getAllByRole('checkbox').map(box => box.closest('label')!.textContent)).toEqual(presentationChecks.map(check => check.label));
  expect(within(checks).getByText('0 of 7 preparation checks marked')).toBeTruthy();
  await user.click(within(checks).getByRole('checkbox', { name: 'I pressed Prepare for presentation for this lender and checked each page I will show.' }));
  expect(within(checks).getByText('1 of 7 preparation checks marked')).toBeTruthy();
  const pack = screen.getByRole('heading', { name: 'Sample files' }).closest('section')!;
  expect(within(pack).getByText(/^Prepare for presentation imports the customer and instalment files for this lender\. It also saves and checks the payment file, so you can import it once during the demo\. Download the files only to import them by hand\./)).toBeTruthy();
  expect(within(pack).getAllByRole('button', { name: /^Download CSV/ })).toHaveLength(3);
  expect(presenterBrief('2026-09-22')).toContain('- [ ] I pressed Prepare for presentation for this lender and checked each page I will show.');
  // Ticking the check is the presenter's own note: it changes no record.
  expect(api.state()).toEqual(before);
  expect(api.calls.filter(c => c.method !== 'GET')).toEqual([]);
});

/** A phrase found anywhere in an element's text, whatever its punctuation. */
const phrase = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

// The demo of a 20-minute meeting: the six collections moments in their order, then connected banking, then the evidence.
it('tells nine moments in about 12 minutes and opens Pay by Bank, Credit Desk and Cash Desk from the page and the guide', async () => {
  expect(presentationSteps.map(step => step.title)).toEqual(['Start with the work', 'Bring in payment evidence', 'Explain the match', 'Give an exception an owner', 'Review the day’s close', 'Take a payment by bank', 'Check an applicant’s affordability', 'See the business’s cash', 'Leave with the evidence']);
  const total = presentationSteps.reduce((sum, step) => sum + step.seconds, 0);
  expect(total).toBeGreaterThan(11 * 60);
  expect(total).toBeLessThanOrEqual(12 * 60);
  renderApp('/presentation');
  const story = (await screen.findByRole('heading', { name: 'Nine moments that explain the value' })).closest('section')!;
  expect(within(story).getAllByRole('article').map(card => card.querySelector('span')?.textContent)).toEqual(['01', '02', '03', '04', '05', '06', '07', '08', '09']);
  expect(within(story).getAllByRole('link').map(link => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Open Overview', '/overview'], ['Open Import batches', '/imports'], ['Open the sample customer', '/customers?q=PRES-C001'],
    ['Open Exceptions', '/exceptions'], ['Open Reports', '/reports#daily-closes'], ['Open Pay by Bank', '/pay-by-bank'],
    ['Open Credit Desk', '/credit-desk'], ['Open Cash Desk', '/cash-desk'], ['Open Saved exports', '/exports'],
  ]);
  cleanup();
  // In the guide, each connected banking moment opens its page, and its notes keep the boundary it must say.
  presentAt(5);
  const user = userEvent.setup();
  renderApp('/overview');
  await screen.findByRole('region', { name: 'Presentation guide' });
  for (const [counter, action, href, heading, boundary] of [
    ['6 of 9 · Take a payment by bank', 'Open Pay by Bank', '/pay-by-bank', 'Pay by Bank', 'Only a payment the bank or provider confirms counts.'],
    ['7 of 9 · Check an applicant’s affordability', 'Open Credit Desk', '/credit-desk', 'Credit Desk', 'A credit result is not a lending decision.'],
    ['8 of 9 · See the business’s cash', 'Open Cash Desk', '/cash-desk', 'Cash Desk', 'Nothing was posted to accounting software. No VAT return was filed and no tax was paid. No one has been paid.'],
  ] as const) {
    const guide = screen.getByRole('region', { name: 'Presentation guide' });
    expect(within(guide).getByText(counter)).toBeTruthy();
    const link = within(guide).getByRole('link', { name: action });
    expect(link.getAttribute('href')).toBe(href);
    await user.click(link);
    await screen.findByRole('heading', { level: 1, name: heading });
    expect(window.location.pathname).toBe(href);
    await user.click(within(guide).getByText(/Show presenter notes/));
    expect(within(guide).getByText(phrase(boundary))).toBeTruthy();
    await user.click(within(guide).getByRole('button', { name: 'Next talking point' }));
  }
  expect(within(screen.getByRole('region', { name: 'Presentation guide' })).getByText('9 of 9 · Leave with the evidence')).toBeTruthy();
  expect(api.calls.filter(c => c.method !== 'GET')).toEqual([]);
});

// Reaching the ninth talking point makes Next talking point unavailable; the focus then goes to the talking points, not the page body.
it('keeps the keyboard focus in the guide when Next talking point reaches the last talking point', async () => {
  presentAt(6);
  const user = userEvent.setup();
  renderApp('/overview');
  const guide = await screen.findByRole('region', { name: 'Presentation guide' });
  const next = within(guide).getByRole('button', { name: 'Next talking point' }) as HTMLButtonElement;
  next.focus();
  await user.keyboard('{Enter}');
  expect(within(guide).getByText('8 of 9 · See the business’s cash')).toBeTruthy();
  expect(document.activeElement).toBe(next);
  await user.keyboard('{Enter}');
  expect(within(guide).getByText('9 of 9 · Leave with the evidence')).toBeTruthy();
  expect(next.disabled).toBe(true);
  const list = within(guide).getByLabelText('Talking point') as HTMLSelectElement;
  expect(document.activeElement).toBe(list);
  expect(list.value).toBe('8');
  expect([...list.options].map(option => option.textContent)).toEqual(presentationSteps.map((step, index) => `${index + 1}. ${step.title}`));
  expect(api.calls.filter(c => c.method !== 'GET')).toEqual([]);
});

// Each moment is told over what Prepare for presentation leaves for the lender, and keeps the boundary that applies to it.
it('tells each moment over the prepared records and keeps its boundary statements', () => {
  const notes = (title: string) => { const step = presentationSteps.find(s => s.title === title)!; return `${step.show} ${step.say} ${step.fallback}`; };
  expect(notes('Start with the work')).toContain('They are sample data, not real growth or measured savings.');
  expect(notes('Bring in payment evidence')).toContain('Open the prepared payment batch, which is checked but not imported.');
  expect(notes('Bring in payment evidence')).toContain('then select Import checked batch once.');
  expect(notes('Explain the match')).toContain('If the customer is not found, this lender is not prepared yet. Select Prepare for presentation on the Presentation page.');
  expect(notes('Give an exception an owner')).toContain('Open the case of the exception that shows Assigned to. Its handover history shows who claimed it, the next step and the handover note.');
  expect(notes('Give an exception an owner')).toContain('Resolving an exception does not make a payment or supply missing evidence.');
  expect(notes('Review the day’s close')).toContain('a close for each of the 3 days before today');
  expect(notes('Review the day’s close')).toContain('Its review waits for a different Finance reviewer.');
  expect(notes('Review the day’s close')).toContain('Since your live import it also says Records changed after this close and Out of date: a close can be approved only while it still matches its records.');
  expect(notes('Review the day’s close')).toContain('A different person must review it');
  expect(notes('Review the day’s close')).toContain('Switching demo roles is not a second person.');
  expect(notes('Take a payment by bank')).toContain('Checkout history holds 3 prepared checkouts. Select each one: Confirmed, Awaiting authorisation and Outcome unknown.');
  expect(notes('Take a payment by bank')).toContain('Only a payment the bank or provider confirms counts.');
  expect(notes('Take a payment by bank')).toContain('An expired checkout does not mean that a payment failed.');
  expect(notes('Take a payment by bank')).toContain('Live payments and bank connections are switched off. No money moved. Nothing was sent to a bank.');
  expect(notes('Check an applicant’s affordability')).toContain('Show the score and the affordability check. It waits for a different person to review it.');
  expect(notes('Check an applicant’s affordability')).toContain('Each assessment waits for a different person to review it.');
  expect(notes('Check an applicant’s affordability')).toContain('choose the applicant who refused permission. There is no score, and the refusal does not count against them.');
  expect(notes('Check an applicant’s affordability')).toContain('A credit result is not a lending decision.');
  expect(notes('Check an applicant’s affordability')).toContain('Switching demo roles is not a second person');
  expect(notes('See the business’s cash')).toContain('The accounting draft and the payroll funding plan each wait for a different Finance reviewer to approve them.');
  expect(notes('See the business’s cash')).toContain('Nothing was posted to accounting software. No VAT return was filed and no tax was paid. No one has been paid.');
  expect(notes('See the business’s cash')).toContain('Permission to read an account is not permission to take money from it.');
  expect(notes('Leave with the evidence')).toContain('Open the prepared dispute pack for Ada Okonkwo.');
  expect(notes('Leave with the evidence')).toContain('Do not call a waiting file ready.');
});

it('sends step three to the customer search while the sample pack is not imported', async () => {
  presentAt(2);
  renderApp('/overview');
  const guide = await screen.findByRole('region', { name: 'Presentation guide' });
  await waitFor(() => expect(api.calls.some(c => c.path === '/v1/records/customers' && c.query.search === 'PRES-C001')).toBe(true));
  expect(within(guide).getByRole('link', { name: 'Open the sample customer' }).getAttribute('href')).toBe('/customers?q=PRES-C001');
});

/** A page that stops working as it renders. */
function BrokenPage(): never {
  throw new Error('Rendering failed: an internal detail');
}

it('keeps the toolbar and End presentation when a page stops working during a presentation', async () => {
  // The boundary logs what it caught, and React reports the thrown render; neither is the subject here.
  vi.spyOn(console, 'error').mockImplementation(() => { /* silenced */ });
  presentAt(0);
  window.history.replaceState({}, '', '/reports');
  const user = userEvent.setup();
  render(
    <Router>
      <QueryClientProvider client={queryClient}>
        <WorkspaceProvider>
          <PresentationProvider><Layout><BrokenPage /></Layout></PresentationProvider>
        </WorkspaceProvider>
      </QueryClientProvider>
    </Router>,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'We could not display this page' })).toBeTruthy();
  const guide = await screen.findByRole('region', { name: 'Presentation guide' });
  expect(within(guide).getByText('1 of 9 · Start with the work')).toBeTruthy();
  expect(within(guide).getByRole('link', { name: 'Open Overview' })).toBeTruthy();
  await user.click(within(guide).getByRole('button', { name: 'End presentation' }));
  expect(screen.queryByRole('region', { name: 'Presentation guide' })).toBeNull();
  // Ending the presentation leaves the page's notice, and every record, as they were.
  expect(screen.getByRole('heading', { level: 1, name: 'We could not display this page' })).toBeTruthy();
  expect(api.calls.filter(c => c.method !== 'GET')).toEqual([]);
});
