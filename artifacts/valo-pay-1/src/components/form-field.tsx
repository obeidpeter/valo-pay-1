import { type ReactNode } from 'react';
import { errorWords } from '@/lib/notify';

/**
 * What every form in the console shares when a value is missing or refused:
 * the message sits under the field it concerns, in the field's own words,
 * the control is marked invalid and described by the message, focus moves
 * to the first field that needs attention, and one alert at the top says
 * what happened so it is announced. Fields are checked before the server is
 * asked, and what the server refuses is placed under the field it names
 * (Nielsen 5: error prevention; 9: plain words, the problem stated
 * precisely, a way to fix it; universal design: perceptible, not colour
 * alone).
 */

export const fieldMessageId = (id: string): string => `${id}-error`;

/** Spread onto a control: marks it invalid and points assistive technology at its message. */
export function invalidProps(id: string, error?: string): { 'aria-invalid'?: true; 'aria-describedby'?: string } {
  return error ? { 'aria-invalid': true, 'aria-describedby': fieldMessageId(id) } : {};
}

/** The message under a field, when there is one. */
export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return <p id={fieldMessageId(id)} className="text-sm text-destructive">{message}</p>;
}

/** The one alert a form shows: what happened, then anything that could not be placed under a field. */
export function FormAlert({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
      <p className="font-medium">{title}</p>
      {children}
    </div>
  );
}

/** Moves focus to a control by its id. */
export function focusField(id: string): void {
  document.getElementById(id)?.focus();
}

/** A correction index for long dialogs: each message links to its actual control. */
export function FormErrorLinks({ errors, fields, prefix }: { errors: Record<string, string>; fields: Array<{ name: string; label: string }>; prefix: string }) {
  const listed = fields.filter(field => errors[field.name]);
  if (!listed.length) return null;
  return <ul className="mt-2 space-y-1">{listed.map(field => <li key={field.name}><button type="button" className="min-h-6 text-left underline underline-offset-2" onClick={() => focusField(`${prefix}-${field.name}`)}>{field.label}: {errors[field.name]}</button></li>)}</ul>;
}

/** Other conflicts (for example an existing reference) do not mean the draft's record is stale. */
export function isStaleRecordError(error: unknown): boolean {
  const value = error as { status?: number; data?: { error?: unknown }; message?: unknown } | null;
  const message = value?.data?.error ?? value?.message;
  return value?.status === 409 && typeof message === 'string' && /record changed after you opened/i.test(message);
}

/** The words for a value that is missing, in the field's own label. */
export function missingMessage(label: string, type: string): string {
  return `${label} is required.${type === 'select' ? ' Choose an option.' : ''}`;
}

/** How many fields need attention, as the alert's title when the server had nothing more specific to say. */
export function attentionTitle(count: number): string {
  return count === 1 ? 'Check the highlighted field before saving.' : `Check the ${count} highlighted fields before saving.`;
}

type Detail = { field?: unknown; message?: unknown };

/** Use the form's visible labels in general validation messages; API and CSV field keys stay unchanged. */
export function formErrorMessage(message: string, fields: Array<{ name: string; label: string }>): string {
  let text = message.replace(/^Invalid [a-z-]+ data:\s*/, 'Check these values: ');
  for (const field of fields) {
    const key = field.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`(^|[\\s;])(?:data\\.)?${key}:`, 'g'), (_, prefix: string) => `${prefix}${field.label}:`);
  }
  return text;
}

/**
 * Sorts what the server said into messages for the fields it names and the
 * rest. A validation failure whose every detail lands on a field needs no
 * general message; any other refusal (a rule, a role) is the title. The
 * service names at most 20 fields, with how many problems it found
 * (detailCount): any it did not name are counted in a general message.
 */
export function serverFieldErrors(error: unknown, resolve: (path: string) => string | null): { fields: Record<string, string>; general: string[] } {
  const data = (error as { data?: { error?: unknown; details?: unknown; detailCount?: unknown } } | null)?.data;
  // Without the service's words, plain ones: never the browser's own error text ("Failed to fetch") or an HTTP status line.
  const said = typeof data?.error === 'string' ? data.error : errorWords(error, 'Valo Pay 1 did not confirm the result.');
  const details = Array.isArray(data?.details) ? (data.details as Detail[]) : [];
  const fields: Record<string, string> = {};
  const general: string[] = [];
  for (const detail of details) {
    const path = String(detail.field ?? ''), message = String(detail.message ?? 'Check this value and try again.');
    const name = resolve(path);
    if (name && !fields[name]) fields[name] = message;
    else general.push(path ? `${path}: ${message}` : message);
  }
  const unnamed = typeof data?.detailCount === 'number' ? data.detailCount - details.length : 0;
  if (unnamed > 0) general.push(`${unnamed} more ${unnamed === 1 ? 'problem was' : 'problems were'} found. Correct these and save again to see ${unnamed === 1 ? 'it' : 'them'}.`);
  const validation = /^validation failed\.?$/i.test(said);
  if (!validation || general.length > 0 || details.length === 0) general.unshift(said);
  return { fields, general };
}
