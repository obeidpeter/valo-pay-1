import { ImportRowResults, importSummary } from "@/components/import-results";
import { formatMinor, formatWithOtherCurrencies } from "@/lib/currencies";
import { formatCount, formatDate, formatNumber } from "@/lib/formatters";
import { importFieldsOf } from "@workspace/valopay-schema";
import type { Ref } from "react";
import { Link } from "wouter";
import { defaultTarget } from "./mapping";
import type { ImportBatch, ImportCheck, ImportRevision } from "./models";

type Props = {
  batch: ImportBatch;
  check: ImportCheck;
  dirty: boolean;
  correctionDisabled: boolean;
  resultsHeading: Ref<HTMLHeadingElement>;
};

export function BatchResults({
  batch,
  check,
  dirty,
  correctionDisabled,
  resultsHeading,
}: Props) {
  // The column each checked row names its currency in, found for the saved mapping as the service finds it: only a
  // kind with a currency field (payment evidence) reads one. A converted amount is in its row's currency, naira when it names none.
  const currencyColumn: string | undefined =
    batch && importFieldsOf(batch.data.kind).includes("currency")
      ? check?.columns?.find(
          (column: string) =>
            (Object.hasOwn(batch.data.mapping || {}, column)
              ? batch.data.mapping[column]
              : defaultTarget(column, batch.data.identityColumn)) ===
            "currency",
        )
      : undefined;

  return (
    <section
      className="space-y-3 border-t pt-5"
      aria-label="Saved batch results"
    >
      <h3
        ref={resultsHeading}
        tabIndex={-1}
        className="font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {batch.status === "committed"
          ? "Batch imported"
          : dirty
            ? "Previous check"
            : "Saved check results"}
      </h3>
      {batch.status !== "committed" && dirty && (
        <p className="text-sm text-muted-foreground">
          You have changes that are not saved. Select Save and check batch to
          check them.
        </p>
      )}
      <p role="status" className="text-sm">
        {importSummary(check)}
      </p>
      {!!check.warnings?.length && (
        <div className="space-y-2 rounded-lg border border-warning-border bg-warning/20 p-3 text-sm">
          <h4 className="font-medium">
            {batch.status === "committed"
              ? "Imported with default values"
              : "Check before you import"}
          </h4>
          {check.warnings.map((warning: string) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
      {batch.data.sourceQuality && (
        <div className="rounded-lg border p-3 text-sm space-y-2">
          <h4 className="font-medium">Source quality checks</h4>
          {/* Customers carry no amounts, so a customer batch has rows to count but no total to show. Each total sums the naira rows, with other currencies beside it. */}
          <p>
            {formatCount(batch.data.sourceQuality.sourceRows, "source row")}
            {batch.data.kind !== "customers" &&
              ` · ${batch.data.sourceQuality.sourceAmountKobo == null ? "Source total not recorded" : `${formatWithOtherCurrencies(batch.data.sourceQuality.sourceAmountKobo, batch.data.sourceQuality.sourceOtherCurrencies, "row")} source total`}`}
          </p>
          <p>
            {formatCount(
              batch.data.sourceQuality.importedRows,
              "newly imported row",
            )}
            {batch.data.kind !== "customers" &&
              ` · ${batch.data.sourceQuality.importedAmountKobo == null ? "Imported total not recorded" : `${formatWithOtherCurrencies(batch.data.sourceQuality.importedAmountKobo, batch.data.sourceQuality.importedOtherCurrencies, "row")} newly imported total`}`}
          </p>
          {batch.data.sourceQuality.issues.map((issue: string) => (
            <p key={issue} className="text-destructive">
              {issue}
            </p>
          ))}
          <Link href="/sources" className="text-primary underline">
            Open Data sources
          </Link>
        </div>
      )}
      {batch.status !== "committed" && (
        <p className="text-sm text-muted-foreground">
          Your file and column mapping are saved. Nothing is imported until no
          rows need fixing and you select Import checked batch.
        </p>
      )}
      {/* The wizard's rows to fix, errors CSV and correction focus; a new check starts again from its rows to fix. */}
      <ImportRowResults
        key={batch.updatedAt}
        rows={check.rows}
        label="Import check results"
        filename={`${batch.data.sourceBatchId || batch.data.kind}-errors.csv`}
        onCorrect={
          correctionDisabled
            ? undefined
            : () => document.getElementById("batch-csv")?.focus()
        }
        className="max-h-72 overflow-auto rounded-lg border p-3 text-sm"
      />
      {check.preview?.some((row) => row.amountKobo !== undefined) && (
        <div className="rounded-lg bg-secondary/30 p-3 text-sm">
          <h4 className="font-medium">Converted amounts in the first rows</h4>
          {check.preview.map(
            (row) =>
              row.amountKobo !== undefined && (
                <p key={row.row}>
                  Row {row.row}:{" "}
                  {formatMinor(
                    row.amountKobo,
                    String(
                      (currencyColumn && row.values?.[currencyColumn]) || "",
                    ).trim() || "NGN",
                  )}
                </p>
              ),
          )}
        </div>
      )}
      {!!batch.data.recordIds?.length && (
        <p className="text-sm text-muted-foreground">
          {formatNumber(batch.data.recordIds.length)}{" "}
          {batch.data.recordIds.length === 1 ? "record is" : "records are"}{" "}
          linked to this batch. Continue in{" "}
          <Link className="text-primary underline" href="/reconciliation">
            Reconciliation
          </Link>
          .
        </p>
      )}
    </section>
  );
}

export function BatchRevisionHistory({
  revisions,
}: {
  revisions: ImportRevision[];
}) {
  return (
    <details>
      <summary className="cursor-pointer py-2 text-sm font-medium">
        Mapping and check history
      </summary>
      <ol className="space-y-2 text-sm text-muted-foreground">
        {revisions.map((r) => (
          <li key={r.id}>
            {r.name} · {formatDate(r.createdAt)} · {r.data.actor} ·{" "}
            {r.data.valid} valid, {r.data.invalid} to fix
          </li>
        ))}
      </ol>
    </details>
  );
}
