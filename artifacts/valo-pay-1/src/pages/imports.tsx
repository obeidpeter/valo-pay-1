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
        Save a file with its column mapping and row checks. You can come back
        later to fix it. When no rows need fixing, import the whole batch in one
        step. Sample data only.
      </PilotHeading>
      {!merchantId ? (
        <Link href="/pilot" className="text-primary underline">
          Create a lender in Pilot journey
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
          what="import batches"
          pager="import batches"
          retry={() => {
            void list.refetch();
          }}
        />
        {list.isLoading && <p role="status">Loading saved batches…</p>}
        {list.data?.total === 0 && (
          <p className="text-sm text-muted-foreground">
            No saved batches yet. Select Save and check batch to save your
            first one, even if some rows need fixing.
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
                {readableLabel(batch.status)} · version {batch.data.revision}
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
        Open Data sources
      </Link>
      <Link
        href="/pilot"
        className="inline-block text-sm text-primary underline"
      >
        Back to Pilot journey
      </Link>
    </div>
  );
}
