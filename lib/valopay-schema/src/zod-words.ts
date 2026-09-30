import { z, type ZodErrorMap } from "zod";
import { valueLabel } from "./labels";

/*
 * The words a check uses when its rule gives none of its own. zod's defaults
 * ("String must contain at least 10 character(s)", "Required") reach people in
 * the details of a refused request, so every rule without a message of its own
 * is worded here, in Valo Pay's words: what to enter, never a type name, a code
 * or a field key. A rule's own message, and a schema's own error map, always win.
 * Importing the schema package installs these words for every schema in the
 * process: the API's and the console's.
 */

const listed = (items: string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
const choices = (options: readonly unknown[]) => listed(options.map((option) => valueLabel(option)));
const number = (value: unknown) => typeof value === "bigint" ? value.toString() : Number(value).toLocaleString("en-GB");
const day = (value: unknown) => new Date(Number(value)).toISOString().slice(0, 10);

/** Valo Pay's words for a check's issue; the default when the rule names none. */
export const valoPayErrorMap: ZodErrorMap = (issue, context) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === "undefined" || issue.received === "null") return { message: "Enter a value." };
      if (issue.expected === "integer") return { message: "Enter a whole number." };
      if (issue.expected === "number" || issue.expected === "bigint" || issue.expected === "float") return { message: "Enter a number." };
      if (issue.expected === "boolean") return { message: "Choose yes or no." };
      if (issue.expected === "string") return { message: "Enter text." };
      if (issue.expected === "date") return { message: "Enter a date." };
      return { message: "Check this value. It is not in the form this field takes." };
    case z.ZodIssueCode.invalid_literal:
      return { message: "This value is not allowed here. Check it and try again." };
    case z.ZodIssueCode.invalid_enum_value:
      return { message: `Choose ${choices(issue.options)}.` };
    case z.ZodIssueCode.invalid_union_discriminator:
      return { message: `Choose ${choices(issue.options.map(String))}.` };
    case z.ZodIssueCode.unrecognized_keys:
      return { message: "This request has details Valo Pay does not use. Reload the page and try again." };
    case z.ZodIssueCode.invalid_date:
      return { message: "Enter a real date." };
    case z.ZodIssueCode.invalid_string:
      if (issue.validation === "email") return { message: "Enter an email address, for example name@example.com." };
      if (issue.validation === "url") return { message: "Enter a web address, for example https://example.com." };
      if (issue.validation === "datetime") return { message: "Enter a date and time, for example 2026-09-18T08:00:00+01:00." };
      if (issue.validation === "date") return { message: "Enter a date as YYYY-MM-DD, for example 2026-09-18." };
      if (issue.validation === "time") return { message: "Enter a time as HH:MM, for example 08:00." };
      if (["uuid", "cuid", "cuid2", "ulid", "nanoid"].includes(String(issue.validation))) return { message: "Choose a record from the list." };
      return { message: "Check the format of this value." };
    case z.ZodIssueCode.too_small:
      if (issue.type === "string") return { message: Number(issue.minimum) <= 1 ? "Enter a value." : issue.exact ? `Enter exactly ${number(issue.minimum)} characters.` : `Enter at least ${number(issue.minimum)} characters.` };
      if (issue.type === "number" || issue.type === "bigint") return { message: issue.inclusive ? `Enter ${number(issue.minimum)} or more.` : `Enter more than ${number(issue.minimum)}.` };
      if (issue.type === "array" || issue.type === "set") return { message: Number(issue.minimum) <= 1 ? "Choose at least one item." : `Choose at least ${number(issue.minimum)} items.` };
      if (issue.type === "date") return { message: `Enter a date on or after ${day(issue.minimum)}.` };
      return { message: "This value is too small. Check it and try again." };
    case z.ZodIssueCode.too_big:
      if (issue.type === "string") return { message: issue.exact ? `Enter exactly ${number(issue.maximum)} characters.` : `Use at most ${number(issue.maximum)} characters.` };
      if (issue.type === "number" || issue.type === "bigint") return { message: issue.inclusive ? `Enter ${number(issue.maximum)} or less.` : `Enter less than ${number(issue.maximum)}.` };
      if (issue.type === "array" || issue.type === "set") return { message: `Choose at most ${number(issue.maximum)} items.` };
      if (issue.type === "date") return { message: `Enter a date on or before ${day(issue.maximum)}.` };
      return { message: "This value is too large. Check it and try again." };
    case z.ZodIssueCode.not_multiple_of:
      return { message: `Enter a multiple of ${number(issue.multipleOf)}.` };
    case z.ZodIssueCode.not_finite:
      return { message: "Enter a number." };
    case z.ZodIssueCode.custom:
      // A refinement without words of its own reaches here with zod's "Invalid input".
      return { message: context.defaultError && context.defaultError !== "Invalid input" ? context.defaultError : "Check this value and try again." };
    default:
      return { message: "Check this value. It is not in the form this field takes." };
  }
};

z.setErrorMap(valoPayErrorMap);
