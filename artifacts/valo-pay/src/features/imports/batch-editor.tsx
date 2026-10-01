import { isStaleRecordError } from "@/components/form-field";
import { ImportCorrections } from "@/components/import-corrections";
import { sampleImportCsv, sampleMapping } from "@/components/import-results";
import { PilotError, PilotPanel, RecoveryNotice } from "@/components/pilot-ui";
import { Button } from "@/components/ui/button";
import { useDialogFocusReturn } from "@/lib/focus";
import { formatDate } from "@/lib/formatters";
import { onlyRoles } from "@/lib/permissions";
import { consoleSourcesViewSchema, type SourceProfile } from "@/lib/source-models";
import {
  lenderPath,
  pilotRequest,
  usePilotQuery,
  useTypedPilotMutation,
} from "@/lib/pilot";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import { useWorkspace } from "@/lib/workspace-context";
import { useQuery } from "@tanstack/react-query";
import { csvHeader, type BatchInput } from "@workspace/valopay-schema";
import { useEffect, useRef, useState } from "react";
import { BatchColumnMapping } from "./batch-column-mapping";
import { BatchCommitDialog } from "./batch-commit-dialog";
import { BatchFileFields } from "./batch-file-fields";
import { BatchResults, BatchRevisionHistory } from "./batch-results";
import { BatchSourceFields } from "./batch-source-fields";
import { empty, samples, suggestedMapping, types } from "./mapping";
import {
  batchDetailSchema,
  batchFormInput,
  importBatchRecordSchema,
  type ExpectedSourceFile,
  type ImportBatch,
} from "./models";

/** The roles the service lets save or import a batch (pilot-workflow's writer); mandates and collection attempts need Admin or Operations. */
const importers = ["Admin", "Operations", "Finance"];

export function BatchEditor({
  id,
  initialProfile,
  initialDate,
  initialExpectation,
  onSaved,
  focusResults,
  onNew,
}: {
  id: string | null;
  initialProfile: string | null;
  initialDate: string | null;
  initialExpectation: string | null;
  onSaved(id: string): void;
  focusResults: { current: boolean };
  onNew(): void;
}) {
  const { merchantId, workspace } = useWorkspace();
  const [selectedProfile, setSelectedProfile] = useState(initialProfile || "");
  const initialProfileApplied = useRef(false);
  const detail = useQuery({
    queryKey: ["pilot", "batch", merchantId, workspace?.actor, id],
    enabled: !!id,
    queryFn: ({ signal }) =>
      pilotRequest(
        lenderPath(`/pilot/batches/${id}`, merchantId),
        batchDetailSchema,
        { signal },
      ),
  });
  const [form, setForm] = useState<BatchInput>(() => ({
      ...empty(),
      ...(initialDate ? { businessDate: initialDate } : {}),
    })),
    [batch, setBatch] = useState<ImportBatch | null>(null),
    [saved, setSaved] = useState(""),
    [fileError, setFileError] = useState(""),
    [reading, setReading] = useState(false),
    [suggested, setSuggested] = useState<Record<string, string>>({}),
    // The sample's mapping, kept while the CSV still has the column it maps.
    [fromSample, setFromSample] = useState<Record<string, string>>({}),
    // Committing a check with warnings takes one more step: the fallbacks are named first.
    [confirmingCommit, setConfirmingCommit] = useState(false);
  const sources = usePilotQuery(
    `/sources${form.businessDate ? `?businessDate=${encodeURIComponent(form.businessDate)}` : ""}`,
    consoleSourcesViewSchema,
  );
  const expectationApplied = useRef(false);
  const applyExpectation = (expectation: ExpectedSourceFile | undefined) => {
    setForm((current) =>
      expectation
        ? {
            ...current,
            sourceExpectationId: expectation.id,
            source: expectation.source,
            sourceBatchId: expectation.sourceBatchId,
            kind: expectation.kind,
            mapping: current.kind === expectation.kind ? current.mapping : {},
          }
        : { ...current, sourceExpectationId: undefined },
    );
    setSelectedProfile("");
  };
  useEffect(() => {
    if (
      id ||
      expectationApplied.current ||
      !sources.data ||
      !initialExpectation
    )
      return;
    expectationApplied.current = true;
    const expected = sources.data.completeness?.files.find(
      (file) => file.id === initialExpectation,
    );
    if (expected) applyExpectation(expected);
  }, [id, initialExpectation, sources.data]);
  const applyProfile = (profile: SourceProfile | undefined) => {
    setSelectedProfile(profile?.id || "");
    if (!profile) return;
    setForm((current) => ({
      ...current,
      sourceExpectationId: undefined,
      source: profile.data.source,
      kind: profile.data.kind,
      mapping: { ...profile.data.mapping },
      amountUnit: profile.data.amountUnit,
      identityColumn: profile.data.identityColumn,
    }));
  };
  useEffect(() => {
    if (id || initialProfileApplied.current || !sources.data) return;
    initialProfileApplied.current = true;
    const profile = sources.data.profiles.find((p) => p.id === initialProfile);
    if (profile) applyProfile(profile);
  }, [id, initialProfile, sources.data]);
  const loaded = useRef(false),
    fileSequence = useRef(0);
  useEffect(
    () => () => {
      fileSequence.current++;
    },
    [],
  );
  const hydrate = (record: ImportBatch) => {
    const next = batchFormInput(record);
    // A recognisable column the saved mapping leaves unused is mapped as suggested: a change the person sees, saves or undoes.
    const suggestions =
      record.status === "committed" || !record.data.check?.columns
        ? {}
        : suggestedMapping(
            next.kind,
            record.data.check.columns,
            next.mapping,
            next.identityColumn,
          );
    setForm({ ...next, mapping: { ...next.mapping, ...suggestions } });
    setSaved(JSON.stringify(next));
    setSuggested(suggestions);
    setBatch(record);
  };
  useEffect(() => {
    if (detail.data && !loaded.current) {
      loaded.current = true;
      hydrate(detail.data.batch);
    }
  }, [detail.data]);
  const dirty = !!form.csv && JSON.stringify(form) !== saved;
  const { confirmDiscard } = useUnsavedChanges(dirty);
  const mutation = useTypedPilotMutation(importBatchRecordSchema, (record) => {
    focusResults.current = true;
    hydrate(record);
    onSaved(record.id);
  });
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!batch?.data.check || !focusResults.current) return;
    focusResults.current = false;
    resultsHeading.current?.focus();
  }, [batch]);
  const busy = mutation.isPending || reading,
    locked =
      busy || mutation.hasUnconfirmedOutcome || batch?.status === "committed";
  // A save or commit refused because the batch changed (the service's "record changed after you opened it"), or a
  // refresh that shows a newer saved version, offers that version. The draft stays editable until the person chooses
  // to replace it. While a save's outcome is unconfirmed, the newer version may be that save: the recovery notice
  // handles it instead.
  const [latestProblem, setLatestProblem] = useState(""),
    [loadingLatest, setLoadingLatest] = useState(false);
  const stale =
    !!id &&
    !mutation.hasUnconfirmedOutcome &&
    isStaleRecordError(mutation.error);
  const newer =
    !!batch &&
    !mutation.hasUnconfirmedOutcome &&
    !!detail.data &&
    detail.data.batch.id === batch.id &&
    Date.parse(detail.data.batch.updatedAt) > Date.parse(batch.updatedAt);
  const loadLatest = async () => {
    if (busy || loadingLatest || !confirmDiscard()) return;
    setLoadingLatest(true);
    setLatestProblem("");
    try {
      // A failed refetch would otherwise resolve with the cached, older batch.
      const result = await detail.refetch({ throwOnError: true });
      if (!result.data?.batch) throw new Error("The batch was not returned.");
      hydrate(result.data.batch);
      mutation.reset();
    } catch {
      setLatestProblem(
        "We could not load the latest version. Your draft is still here. Try again.",
      );
    } finally {
      setLoadingLatest(false);
    }
  };
  const denied = !importers.includes(workspace?.role || "");
  const set = <K extends keyof BatchInput>(key: K, value: BatchInput[K]) =>
    setForm((current) => ({
      ...current,
      ...(["source", "sourceBatchId", "kind", "businessDate"].includes(key)
        ? { sourceExpectationId: undefined }
        : {}),
      [key]: value,
    }));
  const check = batch?.data.check;
  // Suggestions come from the checked columns: a changed file takes them back until its own check.
  const withoutSuggestions = (mapping: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(mapping).filter(
        ([column, field]) => suggested[column] !== field,
      ),
    );
  // A sample column's mapping goes with its column, so an edited sample keeps it and another file never inherits it.
  const withoutSampleColumns = (
    mapping: Record<string, string>,
    csv: string,
  ) => {
    const columns = csvHeader(csv);
    return Object.fromEntries(
      Object.entries(mapping).filter(
        ([column, field]) =>
          fromSample[column] !== field || columns.includes(column),
      ),
    );
  };
  const commit = () => {
    if (!batch) return;
    mutation.mutate({
      path: `/pilot/batches/${batch.id}/commit`,
      data: { expectedUpdatedAt: batch.updatedAt },
    });
  };
  const restoreFocus = useDialogFocusReturn(confirmingCommit);
  const readFile = async (file?: File) => {
    if (!file || !confirmDiscard()) return;
    if (file.size > 1500000) {
      setFileError("Choose a file no larger than 1.5 MB.");
      return;
    }
    const seq = ++fileSequence.current;
    setReading(true);
    setFileError("");
    try {
      const csv = await file.text();
      if (seq === fileSequence.current) {
        setForm((current) => ({
          ...current,
          csv,
          mapping: selectedProfile ? withoutSuggestions(current.mapping) : {},
          name: current.name || file.name,
        }));
        setSuggested({});
      }
    } catch {
      if (seq === fileSequence.current)
        setFileError(
          "The file could not be read. You can paste its CSV content below.",
        );
    } finally {
      if (seq === fileSequence.current) setReading(false);
    }
  };
  const useSample = () => {
    if (!confirmDiscard()) return;
    // Headed in the operator's words, with the mapping that says so.
    const mapping = sampleMapping(
      form.kind,
      samples[form.kind].values,
      "source_row_id",
    );
    setFromSample(mapping);
    setForm({
      ...form,
      csv: sampleImportCsv(
        form.kind,
        samples[form.kind].rowId,
        samples[form.kind].values,
        "naira",
        "source_row_id",
      ),
      mapping,
      name: form.name || `${types[form.kind]} sample`,
      source: form.source || "Pilot sample",
      sourceBatchId: form.sourceBatchId || `${form.kind}-001`,
      identityColumn: "source_row_id",
      amountUnit: "naira",
    });
  };
  const onCsvChange = (csv: string) => {
    setForm((current) => ({
      ...current,
      csv,
      mapping: withoutSampleColumns(withoutSuggestions(current.mapping), csv),
    }));
    setSuggested({});
  };
  if (id && !batch)
    return (
      <PilotPanel title="Saved batch">
        <PilotError
          error={detail.error}
          what="the saved batch"
          retry={() => {
            void detail.refetch();
          }}
        />
        {detail.isLoading && (
          <p role="status">Loading the saved batch…</p>
        )}
      </PilotPanel>
    );
  return (
    <PilotPanel title={batch ? batch.name : "New import batch"}>
      <p className="text-sm text-muted-foreground">
        Use the same source name and source batch ID each time you send this
        file. Give every row a source row ID that never changes, even when you
        correct the row or upload it again. Two different payments need
        different IDs, even if their amounts match.
      </p>
      {batch?.data.rawCsvRemovedAt && (
        <p className="rounded-lg border bg-secondary/30 p-3 text-sm">
          The original CSV file was deleted on{" "}
          {formatDate(batch.data.rawCsvRemovedAt)} under this lender’s data
          retention policy. The imported records, their source row IDs and the
          saved checks are still here.
        </p>
      )}
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate({
            path: id ? `/pilot/batches/${id}/save` : "/pilot/batches",
            data: form,
          });
        }}
      >
        <BatchSourceFields
          id={id}
          form={form}
          set={set}
          disabled={locked || denied}
          selectedProfile={selectedProfile}
          initialProfile={initialProfile}
          sources={sources.data}
          sourcesLoading={sources.isLoading}
          sourcesError={sources.error}
          onProfileChange={(profileId) => {
            if (confirmDiscard())
              applyProfile(
                sources.data?.profiles.find(
                  (profile) => profile.id === profileId,
                ),
              );
          }}
          onExpectationChange={(expectationId) => {
            if (confirmDiscard())
              applyExpectation(
                sources.data?.completeness?.files.find(
                  (file) => file.id === expectationId,
                ),
              );
          }}
          onKindChange={(kind) => {
            if (confirmDiscard())
              setForm({
                ...empty(),
                kind,
                name: form.name,
                source: form.source,
                businessDate: form.businessDate,
              });
          }}
        />

        <BatchFileFields
          id={id}
          form={form}
          disabled={locked || denied}
          fileError={fileError}
          readFile={readFile}
          useSample={useSample}
          onCsvChange={onCsvChange}
        />

        {check?.columns && batch?.status !== "committed" && (
          <BatchColumnMapping
            form={form}
            columns={check.columns}
            disabled={locked || denied}
            suggested={suggested}
            set={set}
          />
        )}
        {(stale || newer) && (
          <div
            role="status"
            className="space-y-3 rounded-lg border border-warning-border bg-warning/20 p-4 text-sm"
          >
            <p>
              {newer
                ? "A newer version of this batch was saved."
                : "This batch changed after you opened it."}{" "}
              Your draft is still here. Load the latest version to continue; it
              replaces your unsaved changes.
            </p>
            <Button
              type="button"
              variant="outline"
              busy={loadingLatest}
              busyLabel="Loading…"
              disabled={busy}
              onClick={() => {
                void loadLatest();
              }}
            >
              Load latest version
            </Button>
            {latestProblem && <p role="alert">{latestProblem}</p>}
          </div>
        )}
        <RecoveryNotice mutation={mutation} />
        <div className="flex flex-wrap gap-3">
          {batch?.status !== "committed" && (
            <>
              <Button type="submit" busy={busy} disabled={denied || locked}>
                Save and check batch
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={
                  denied ||
                  locked ||
                  dirty ||
                  !batch ||
                  batch.status !== "ready" ||
                  (batch.data.sourceQuality &&
                    batch.data.sourceQuality.status !== "checked")
                }
                onClick={() => {
                  if (check?.warnings?.length) setConfirmingCommit(true);
                  else commit();
                }}
              >
                Import checked batch
              </Button>
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            disabled={busy || mutation.hasUnconfirmedOutcome}
            onClick={() => {
              if (confirmDiscard()) onNew();
            }}
          >
            Start another batch
          </Button>
        </div>
        {denied && (
          <p className="text-sm text-muted-foreground">
            {onlyRoles(importers, "import batches", { brief: true })}{" "}
            {onlyRoles(["Admin", "Operations"], "import mandates or collection attempts", { brief: true })}
          </p>
        )}
      </form>
      {id && !form.businessDate && (
        <p className="rounded-lg border p-3 text-sm">
          This older batch has no business date. It stays on the list of source
          files to resolve, and Finance must account for it in the close
          review.
        </p>
      )}
      {initialExpectation &&
        sources.data &&
        !sources.data.completeness?.files.some(
          (file) => file.id === initialExpectation,
        ) && (
          <p role="alert" className="text-sm text-destructive">
            The expected file in your link is not one of this lender’s expected
            files for this date. Check the expected files in Data sources before
            you save this batch.
          </p>
        )}
      {batch && check && (
        <BatchResults
          batch={batch}
          check={check}
          dirty={dirty}
          correctionDisabled={locked || denied}
          resultsHeading={resultsHeading}
        />
      )}
      {detail.data && detail.data.revisions.length > 0 && (
        <BatchRevisionHistory revisions={detail.data.revisions} />
      )}
      {batch?.status === "committed" && (
        <ImportCorrections batchId={batch.id} />
      )}
      <BatchCommitDialog
        confirmingCommit={confirmingCommit}
        warnings={check?.warnings}
        restoreFocus={restoreFocus}
        onCancel={() => setConfirmingCommit(false)}
        onCommit={commit}
      />
    </PilotPanel>
  );
}
