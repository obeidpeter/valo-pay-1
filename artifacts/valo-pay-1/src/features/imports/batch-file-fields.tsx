import { pilotField } from "@/components/pilot-ui";
import { Button } from "@/components/ui/button";
import type { BatchInput } from "@workspace/valo-pay-1-schema";

type Props = {
  id: string | null;
  form: Pick<BatchInput, "csv">;
  disabled: boolean;
  fileError: string;
  readFile: (file?: File) => Promise<void>;
  useSample: () => void;
  onCsvChange: (csv: string) => void;
};

export function BatchFileFields({
  id,
  form,
  disabled,
  fileError,
  readFile,
  useSample,
  onCsvChange,
}: Props) {
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 space-y-2 text-sm font-medium">
          Choose CSV file
          <input
            className={pilotField}
            type="file"
            accept=".csv,text/csv"
            disabled={disabled}
            onChange={(e) => {
              void readFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || !!id}
          onClick={useSample}
        >
          Use sample
        </Button>
      </div>
      <label className="block space-y-2 text-sm font-medium">
        CSV content
        <textarea
          id="batch-csv"
          className={`${pilotField} min-h-40 font-mono text-xs`}
          value={form.csv}
          disabled={disabled}
          required
          onChange={(event) => onCsvChange(event.target.value)}
        />
      </label>
      {fileError && (
        <p role="alert" className="text-sm text-destructive">
          {fileError}
        </p>
      )}
    </>
  );
}
