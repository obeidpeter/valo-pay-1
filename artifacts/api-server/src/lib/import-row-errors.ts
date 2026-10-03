import type { ZodIssue } from "zod";
import { defaultStatus, importFieldLabel, recordTypeLabel, valueLabel } from "@workspace/valo-pay-1-schema";
import type { ProblemRule, ValidationProblem } from "../domain/validation";

/*
 * An import row's error in the operator's words (usability backlog UX-B10):
 * each failing rule names the column it concerns, the CSV header the operator
 * mapped with the shared label beside it, or the label alone where no column
 * fills the field, and says what to enter. Codes are shown with their labels.
 * The record API's own words for every problem are kept as the row's detail.
 */

const MISSING = Symbol("missing");
const dated = /(At|Date|Deadline)$/;
const blank = (value: unknown) => value === undefined || value === null || String(value).trim() === "";
/** Codes with their labels, as a list to choose from: "Active (active) or Inactive (inactive)". */
const choices = (options: readonly unknown[]) => {
  const named = options.map((option) => `${valueLabel(option)} (${String(option)})`);
  return named.length > 1 ? `${named.slice(0, -1).join(", ")} or ${named.at(-1)}` : named[0] ?? "";
};
const notChoice = (value: unknown, options: readonly unknown[]) => blank(value) ? MISSING : `“${String(value)}” is not one of the choices. Use ${choices(options)}.`;
const DATE = "Use YYYY-MM-DD or a UTC timestamp such as 2026-09-18T07:00:00Z, and a real date.";

/** zod's own texts, which a row error never shows; a schema's own words for an issue are plain already. */
const zodText = /^(Required|Expected |Invalid|Unrecognized key|String must|Number must|Array must|Set must|Date must|BigInt must|Intersection results)/;
/**
 * An issue no rule below words: a list or an object, which no CSV cell can be (Valo Pay 1 sets such fields), the
 * schema's own words, or a plain request to check the value. zod's text stays in the detail.
 */
function otherIssue(issue: ZodIssue): string {
  if (issue.code === "invalid_type" && ["array", "object", "map", "set"].includes(issue.expected)) return "A CSV column cannot fill this field. Choose Skip column for it.";
  return zodText.test(issue.message) ? "Check this value; it is not in the form this field takes." : issue.message;
}
/** What a schema issue asks for, in plain words. */
function issueWords(issue: ZodIssue, field: string): string | typeof MISSING {
  switch (issue.code) {
    case "invalid_type":
      if (issue.received === "undefined" || issue.received === "null") return MISSING;
      if (issue.expected === "integer") return "Enter a whole number.";
      if (issue.expected === "number") return "Enter a number.";
      if (issue.expected === "boolean") return "Use true or false.";
      return otherIssue(issue);
    case "too_small":
      if (issue.type === "string") return Number(issue.minimum) <= 1 ? MISSING : `Enter at least ${issue.minimum} characters.`;
      return issue.type === "number" ? `Enter a number of at least ${issue.minimum}.` : otherIssue(issue);
    case "too_big":
      if (issue.type === "string") return `Use at most ${issue.maximum} characters.`;
      return issue.type === "number" ? `Enter a number of at most ${issue.maximum}.` : otherIssue(issue);
    case "invalid_enum_value":
      return notChoice(issue.received, issue.options);
    case "invalid_string": case "custom":
      return dated.test(field) ? DATE : otherIssue(issue);
    default:
      return otherIssue(issue);
  }
}
/** What a rule asks for: its words, MISSING for a value the row lacks, or undefined to keep the refusal's own words. */
function ruleWords(rule: ProblemRule | undefined, field: string, kind: string, unit: "naira" | "kobo", column: string | undefined): string | typeof MISSING | undefined {
  switch (rule?.type) {
    case "required": return MISSING;
    case "boolean": return "Use true or false.";
    case "date": return DATE;
    case "length": return `Use at most ${rule.max} characters.`;
    case "choice": return notChoice(rule.value, rule.options);
    case "amount":
      if (!column) return MISSING;
      return unit === "naira" ? "Enter an amount above ₦0 in naira, for example 1,000.50." : "Enter a whole number of kobo above 0, for example 100000 for ₦1,000.";
    case "link":
      return `No ${recordTypeLabel(rule.kind)} has the ${rule.kind === "policies" ? "ID" : "reference or ID"} “${rule.value}” in this lender.`;
    case "starting-status": {
      const start = defaultStatus[kind as keyof typeof defaultStatus];
      return `${valueLabel(rule.value)} (${rule.value}) is set by Valo Pay 1 later, so a new ${recordTypeLabel(kind)} cannot start with it. Leave the column blank${start ? ` or use ${choices([start])}` : ""}.`;
    }
    case "issue": return issueWords(rule.issue, field);
    default: return undefined;
  }
}

/**
 * One invalid row's message and detail from its problems: one sentence for each
 * column, the first problem found for it (a later one repeats what it asks), in
 * the order they were found; the detail keeps every problem in the record API's words.
 */
export function importRowError(problems: ValidationProblem[], context: { kind: string; unit: "naira" | "kobo"; columnOf: (field: string) => string | undefined }): { message: string; detail: string } {
  const seen = new Set<string>(), sentences: string[] = [];
  for (const problem of problems) {
    const key = problem.field ?? `\u0000${problem.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!problem.field) { sentences.push(problem.rule?.type === "issue" ? otherIssue(problem.rule.issue) : problem.message); continue; }
    const label = importFieldLabel(context.kind, problem.field), column = context.columnOf(problem.field);
    const words = ruleWords(problem.rule, problem.field, context.kind, context.unit, column);
    if (words === MISSING && !column) { sentences.push(`No column is mapped to ${label}. Map the column that holds it.`); continue; }
    const named = column && column.toLowerCase() !== label.toLowerCase() ? `${label} (column ${column})` : label;
    sentences.push(`${named}: ${words === MISSING ? "Enter a value; it is blank on this row." : words ?? problem.message}`);
  }
  return { message: sentences.join(" "), detail: problems.map((problem) => problem.message).join("; ") };
}
