import { pilotField } from "@/components/pilot-ui";
import {
  importFieldLabel,
  importFieldsOf,
  type BatchInput,
} from "@workspace/valo-pay-1-schema";
import { defaultTarget, fields } from "./mapping";
import type { SetBatchField } from "./models";

type Props = {
  form: BatchInput;
  columns: string[];
  disabled: boolean;
  suggested: Record<string, string>;
  set: SetBatchField;
};

export function BatchColumnMapping({
  form,
  columns,
  disabled,
  suggested,
  set,
}: Props) {
  return (
    <fieldset disabled={disabled} className="rounded-xl border p-4">
      <legend className="px-2 text-sm font-semibold">Column mapping</legend>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {columns.map((column: string) => {
          const value =
            form.mapping[column] ?? defaultTarget(column, form.identityColumn);
          // A field of this kind that the common list lacks, such as a suggested batch reference, is offered too.
          const options =
            value &&
            !fields.includes(value) &&
            importFieldsOf(form.kind).includes(value)
              ? [...fields, value]
              : fields;
          return (
            <label className="space-y-1 text-sm" key={column}>
              {column}
              <select
                className={pilotField}
                value={value}
                onChange={(e) =>
                  set("mapping", {
                    ...form.mapping,
                    [column]: e.target.value,
                  })
                }
              >
                <option value="">
                  {column === form.identityColumn
                    ? "Source row ID only"
                    : "Skip column"}
                </option>
                {options.map((field) => (
                  <option key={field} value={field}>
                    {importFieldLabel(form.kind, field)}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
      {Object.keys(suggested).length > 0 && (
        <p className="mt-3 text-sm">
          Suggested from the column names:{" "}
          {Object.entries(suggested)
            .map(
              ([column, field]) =>
                `${column} as ${importFieldLabel(form.kind, field)}`,
            )
            .join(", ")}
          . Save and check the batch to use{" "}
          {Object.keys(suggested).length === 1 ? "it" : "them"}, or choose
          another option.
        </p>
      )}
    </fieldset>
  );
}
