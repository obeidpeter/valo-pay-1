import { PilotError, PilotHeading, PilotPanel } from "@/components/pilot-ui";
import { readableLabel } from "@/components/record-label";
import { PageButtons } from "@/components/record-pagination";
import { BatchEditor } from "@/features/imports/batch-editor";
import { batchListSchema } from "@/features/imports/models";
import { formatDate, formatNumber } from "@/lib/formatters";
import { usePilotQuery } from "@/lib/pilot";
import { confirmUnsavedChanges } from "@/lib/unsaved-changes";
import { useWorkspace } from "@/lib/workspace-context";
import { useRef, useState } from "react";
import { Link, useSearch } from "wouter";

export default function ImportsPage() {
  const { merchantId } = useWorkspace();
  return <LenderImports key={merchantId || "no-lender"} />;
}
function LenderImports() {
  const search = new URLSearchParams(useSearch());
  const { merchantId } = useWorkspace(),
    [offset, setOffset] = useState(0),
    list = usePilotQuery(`/pilot/batches?offset=${offset}`, batchListSchema);
  const [selected, setSelected] = useState<string | null>(() =>
      search.get("batch"),
    ),
    [editor, setEditor] = useState(0),
    // Set by a save or commit, which may open the saved batch in a new editor: its results take focus, as the wizard's do.
    focusResults = useRef(false);
  return (
    <div className="space-y-6">
      <PilotHeading title="Import batches">
        Save the file, mapping and row checks together. Return to fix a batch
        later, then commit every valid row in one step. Only synthetic sample
        records are accepted.
      </PilotHeading>
      {!merchantId ? (
        <Link href="/pilot" className="text-primary underline">
          Create a lender to begin
        </Link>
      ) : (
        <BatchEditor
          key={`${merchantId}:${selected || editor}`}
          id={selected}
          initialProfile={search.get("profile")}
          initialDate={search.get("businessDate")}
          initialExpectation={search.get("expectation")}
          onSaved={(id) => setSelected(id)}
          focusResults={focusResults}
          onNew={() => {
            setSelected(null);
            setEditor((n) => n + 1);
          }}
        />
      )}
      <PilotPanel title="Saved batches">
        <PilotError
          error={list.error}
          pager="import batches"
          retry={() => {
            void list.refetch();
          }}
        />
        {list.isLoading && <p role="status">Loading batches…</p>}
        {list.data?.total === 0 && (
          <p className="text-sm text-muted-foreground">
            Your first saved batch will appear here, including any rows that
            need correction.
          </p>
        )}
        <div className="space-y-2">
          {list.data?.items.map((batch) => (
            <button
              key={batch.id}
              type="button"
              onClick={() => {
                if (confirmUnsavedChanges()) setSelected(batch.id);
              }}
              className="flex w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-4 text-left hover:bg-secondary/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span>
                <strong className="text-sm">{batch.name}</strong>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {batch.data.source} · {batch.data.sourceBatchId} ·{" "}
                  {formatDate(batch.updatedAt)}
                </span>
              </span>
              <span className="rounded-full bg-secondary px-3 py-1 text-xs">
                {readableLabel(batch.status)} · revision {batch.data.revision}
              </span>
            </button>
          ))}
        </div>
        {list.data && list.data.total > 25 && (
          <div className="flex flex-wrap items-center gap-3">
            <PageButtons
              label="import batches"
              busy={list.isPlaceholderData}
              atStart={!offset}
              atEnd={offset + 25 >= list.data.total}
              onPrevious={() => setOffset((n) => Math.max(0, n - 25))}
              onNext={() => setOffset((n) => n + 25)}
              previous="Previous batches"
              next="Next batches"
            >
              <span className="text-sm">
                {formatNumber(offset + 1)}–
                {formatNumber(Math.min(offset + 25, list.data.total))} of{" "}
                {formatNumber(list.data.total)}
              </span>
            </PageButtons>
          </div>
        )}
      </PilotPanel>
      <Link
        href="/sources"
        className="inline-block text-sm text-primary underline"
      >
        Manage source schedules, mappings and totals
      </Link>
      <Link
        href="/pilot"
        className="inline-block text-sm text-primary underline"
      >
        Return to the pilot journey
      </Link>
    </div>
  );
}
