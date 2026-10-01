/**
 * Supported message tokens shared by previews and approval validation. {{lender}}
 * is the lender's name; {{merchant}}, its earlier spelling, keeps working in
 * templates saved with it.
 */
export const templatePlaceholders = ['amount', 'date', 'lender', 'merchant', 'contact'] as const;
/** The tokens a message must include: the lender's name may be written {{lender}} or {{merchant}}. */
const requiredPlaceholders: ReadonlyArray<{ name: string; accepts: readonly string[] }> = [
  { name: 'amount', accepts: ['amount'] }, { name: 'date', accepts: ['date'] }, { name: 'lender', accepts: ['lender', 'merchant'] }, { name: 'contact', accepts: ['contact'] },
];

/** Every message includes the amount, the date, the lender's name and the contact details; unmatched braces and unknown tokens are refused. */
export function templateTextProblems(value: unknown): string[] {
  const text = typeof value === 'string' ? value : '';
  const found = new Set<string>();
  const problems: string[] = [];
  const remainder = text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_token, name: string) => {
    const field = name.trim();
    found.add(field);
    if (!(templatePlaceholders as readonly string[]).includes(field)) problems.push(`Unknown placeholder {{${field}}}. Use only {{amount}}, {{date}}, {{lender}} and {{contact}}.`);
    return '';
  });
  if (/[{}]/.test(remainder)) problems.push('A placeholder has unmatched braces. Use two braces on each side, for example {{amount}}.');
  for (const { name, accepts } of requiredPlaceholders) if (!accepts.some((field) => found.has(field))) problems.push(`Add {{${name}}} to the message.`);
  return [...new Set(problems)];
}
