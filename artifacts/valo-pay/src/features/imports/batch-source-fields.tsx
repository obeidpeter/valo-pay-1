import { PilotError, pilotField } from "@/components/pilot-ui";
import { formatDate } from "@/lib/formatters";
import { amountUnitName, type BatchInput } from "@workspace/valopay-schema";
import { Link } from "wouter";
import { types } from "./mapping";
import type { SourcesView } from "@/lib/source-models";
import type { SetBatchField } from "./models";

type Props = {
  id: string | null;
  form: BatchInput;
  set: SetBatchField;
  disabled: boolean;
  selectedProfile: string;
  initialProfile: string | null;
  sources: SourcesView | undefined;
  sourcesLoading: boolean;
  sourcesError: unknown;
  onProfileChange: (id: string) => void;
  onExpectationChange: (id: string) => void;
  onKindChange: (kind: BatchInput["kind"]) => void;
};

export function BatchSourceFields({
  id,
  form,
  set,
  disabled,
  selectedProfile,
  initialProfile,
  sources,
  sourcesLoading,
  sourcesError,
  onProfileChange,
  onExpectationChange,
  onKindChange,
}: Props) {
  return (
    <>
      {!id && (
        <div className="space-y-2">
          <label className="block space-y-1 text-sm font-medium">
            Source profile
            <select
              className={pilotField}
              disabled={disabled || sourcesLoading}
              value={selectedProfile}
              onChange={(event) => onProfileChange(event.target.value)}
            >
              <option value="">No source profile</option>
              {sources?.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} · {types[profile.data.kind]}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            A source profile fills in the source name, record type, source row
            ID column, amount unit and column mapping. Its expected rows and
            total are checked again before you import.
          </p>
          {initialProfile &&
            sources &&
            !sources.profiles.some((p) => p.id === initialProfile) && (
              <p role="alert" className="text-sm text-destructive">
                Source profile not found. It may have been deleted, or it
                belongs to another lender. Choose a source profile above, or
                open Data sources.
              </p>
            )}
          <PilotError error={sourcesError} />
        </div>
      )}
      <fieldset
        disabled={disabled}
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        <div className="space-y-1 text-sm font-medium">
          <label htmlFor="import-business-date">Business date (WAT)</label>
          <input
            id="import-business-date"
            aria-describedby="import-business-date-help"
            className={pilotField}
            type="date"
            required={!id || !!form.businessDate}
            disabled={!!id}
            value={form.businessDate || ""}
            onChange={(e) => set("businessDate", e.target.value)}
          />
          <p
            id="import-business-date-help"
            className="text-xs font-normal text-muted-foreground"
          >
            The day this file covers, not the day you upload it. You cannot
            change it after you save the batch.
          </p>
        </div>
        {!id && (
          <label className="space-y-1 text-sm font-medium">
            Expected file
            <select
              className={pilotField}
              value={form.sourceExpectationId || ""}
              disabled={sourcesLoading}
              onChange={(event) => onExpectationChange(event.target.value)}
            >
              <option value="">
                Choose an expected file, or enter details below
              </option>
              {sources?.completeness?.files.map((file) => (
                <option key={file.id} value={file.id}>
                  {file.source} · {file.sourceBatchId} · {types[file.kind]}
                </option>
              ))}
            </select>
            <span className="block text-xs text-muted-foreground">
              Expected files for{" "}
              {form.businessDate ? formatDate(form.businessDate) : "the chosen date"}.{" "}
              <Link
                className="text-primary underline"
                href={`/sources?businessDate=${form.businessDate || ""}`}
              >
                Open Data sources
              </Link>
            </span>
          </label>
        )}
        <label className="space-y-1 text-sm font-medium">
          Batch name
          <input
            className={pilotField}
            required
            value={form.name}
            maxLength={120}
            onChange={(e) => set("name", e.target.value)}
            placeholder="September payment evidence"
          />
        </label>
        <label className="space-y-1 text-sm font-medium">
          Record type
          <select
            className={pilotField}
            disabled={!!id}
            value={form.kind}
            onChange={(event) =>
              onKindChange(event.target.value as BatchInput["kind"])
            }
          >
            {Object.entries(types).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm font-medium">
          Source name
          <input
            className={pilotField}
            required
            disabled={!!id}
            value={form.source}
            maxLength={100}
            onChange={(e) => set("source", e.target.value)}
            placeholder="Pilot loan system"
          />
        </label>
        <label className="space-y-1 text-sm font-medium">
          Source batch ID
          <input
            className={pilotField}
            required
            disabled={!!id}
            value={form.sourceBatchId}
            maxLength={120}
            onChange={(e) => set("sourceBatchId", e.target.value)}
            placeholder="statement-2026-09"
          />
        </label>
        <label className="space-y-1 text-sm font-medium">
          Source row ID column
          <input
            className={pilotField}
            required
            value={form.identityColumn}
            maxLength={100}
            onChange={(e) => set("identityColumn", e.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm font-medium">
          Amounts in the source file
          <select
            className={pilotField}
            value={form.amountUnit}
            onChange={(e) =>
              set("amountUnit", e.target.value as "naira" | "kobo")
            }
          >
            <option value="naira">
              {amountUnitName("naira", form.kind)}, for example 1,000.50
            </option>
            <option value="kobo">
              {amountUnitName("kobo", form.kind)}, for example 100050
            </option>
          </select>
        </label>
      </fieldset>
    </>
  );
}
