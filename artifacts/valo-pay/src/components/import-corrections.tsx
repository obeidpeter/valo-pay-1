import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { z } from "zod";
import {
  importCorrectionsResponseSchema,
  importCorrectionPreviewSchema,
  importFieldLabel,
  type ImportCorrectionPreviewInput,
} from "@workspace/valopay-schema";
import { useWorkspace } from "@/lib/workspace-context";
import {
  lenderPath,
  pilotRequest,
  usePilotMutation,
  usePilotQuery,
} from "@/lib/pilot";
import { nairaToKobo, koboToNaira } from "@/lib/money-input";
import { answerProblem } from "@/lib/answers";
import { formatDate, formatKobo, formatNumber } from "@/lib/formatters";
import { readableLabel } from "@/components/record-label";
import { PilotError, RecoveryNotice, pilotField } from "@/components/pilot-ui";
import { Button } from "@/components/ui/button";
import { ScrollFrame } from "@/components/scroll-frame";
import {
  confirmUnsavedChanges,
  useUnsavedChanges,
} from "@/lib/unsaved-changes";

type Workbench = z.infer<typeof importCorrectionsResponseSchema>;
type Preview = z.infer<typeof importCorrectionPreviewSchema>;
type Proposal = Workbench["proposals"][number];
function RemedyLinks() {
  return (
    <p className="text-sm">
      Review existing payment matches in{" "}
      <Link className="text-primary underline" href="/reconciliation">
        Reconciliation
      </Link>
      , or assign an investigation in{" "}
      <Link className="text-primary underline" href="/exceptions">
        Exceptions
      </Link>
      . Collection history is available in{" "}
      <Link className="text-primary underline" href="/collections">
        Collections
      </Link>
      .
    </p>
  );
}
function Comparison({ preview }: { preview: Preview }) {
  return (
    <div className="space-y-3 rounded-xl border bg-secondary/20 p-4">
      <h4 className="font-semibold">Before and after</h4>
      {!!preview.differences.length && (
        <ScrollFrame label="Correction comparison">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Field</th>
                <th className="p-2">Current value</th>
                <th className="p-2">Proposed value</th>
              </tr>
            </thead>
            <tbody>
              {preview.differences.map((d) => (
                <tr key={d.field} className="border-t">
                  <th className="p-2 font-medium">
                    {importFieldLabel(preview.targetKind, d.field)}
                  </th>
                  <td className="p-2">
                    {d.field === "amountKobo"
                      ? formatKobo(Number(d.before))
                      : String(d.before ?? "Not recorded")}
                  </td>
                  <td className="p-2">
                    {d.field === "amountKobo"
                      ? formatKobo(Number(d.after))
                      : String(d.after)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollFrame>
      )}
      <p className="text-xs text-muted-foreground">
        Source: {preview.source} · row {preview.rowId}
      </p>
      {preview.blockers.length > 0 && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-amber-500/40 p-3"
        >
          <strong className="text-sm">This correction cannot proceed</strong>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {preview.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <RemedyLinks />
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Affected payments, collection evidence and closes (
          {formatNumber(preview.affected.length)})
        </summary>
        <div className="mt-2 max-h-64 space-y-2 overflow-auto">
          {preview.affected.length ? (
            preview.affected.map((r) => (
              <p key={r.id} className="rounded-lg border p-2 text-sm">
                <strong>
                  {r.name || r.reference || readableLabel(r.kind)}
                </strong>
                <span className="block text-xs text-muted-foreground">
                  {readableLabel(r.kind)} · {r.reference || r.id} ·{" "}
                  {readableLabel(r.status)}
                </span>
              </p>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              No dependent financial records or saved closes were found.
            </p>
          )}
        </div>
      </details>
      <p className="text-sm text-muted-foreground">{preview.consequence}</p>
    </div>
  );
}
function CorrectionEditor({
  target,
  batchId,
  workbench,
}: {
  target: Workbench["targets"][number];
  batchId: string;
  workbench: Workbench;
}) {
  const { merchantId } = useWorkspace();
  const [name, setName] = useState(target.name),
    [phone, setPhone] = useState(target.phoneMasked),
    [amount, setAmount] = useState(koboToNaira(target.amountKobo)),
    [date, setDate] = useState(target.dueDate?.slice(0, 10) || "");
  const [reason, setReason] = useState(""),
    [evidence, setEvidence] = useState(""),
    [reviewer, setReviewer] = useState(""),
    [localError, setLocalError] = useState<Error | null>(null);
  const [comparison, setComparison] = useState<{
    input: ImportCorrectionPreviewInput;
    preview: Preview;
  } | null>(null);
  const proposed = usePilotMutation(() => {
    setComparison(null);
    setReason("");
    setEvidence("");
  });
  const dryRun = useMutation({
    mutationFn: async (input: ImportCorrectionPreviewInput) => {
      const preview = await pilotRequest(
        lenderPath("/pilot/import-corrections/preview", merchantId),
        importCorrectionPreviewSchema,
        { method: "POST", body: JSON.stringify(input) },
      );
      if (
        preview.merchantId !== merchantId ||
        preview.targetId !== target.id ||
        preview.batchId !== batchId
      )
        throw new Error(
          "The comparison belongs to another record. Refresh this batch.",
        );
      return { input, preview };
    },
    onSuccess: setComparison,
  });
  const denied = !["Admin", "Operations", "Finance"].includes(workbench.role),
    pending = workbench.proposals.some(
      (p) => p.preview.targetId === target.id && p.status === "awaiting_review",
    ),
    locked =
      denied ||
      pending ||
      dryRun.isPending ||
      proposed.isPending ||
      proposed.hasUnconfirmedOutcome;
  useUnsavedChanges(
    !pending &&
      !proposed.hasUnconfirmedOutcome &&
      Boolean(
        reason ||
        evidence ||
        name !== target.name ||
        phone !== target.phoneMasked ||
        amount !== koboToNaira(target.amountKobo) ||
        date !== (target.dueDate?.slice(0, 10) || ""),
      ),
  );
  const reset = () => {
    setComparison(null);
    setLocalError(null);
  };
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        setLocalError(null);
        try {
          const changes: ImportCorrectionPreviewInput["changes"] =
            target.kind === "customers"
              ? {
                  ...(name !== target.name ? { name } : {}),
                  ...(phone !== target.phoneMasked
                    ? { phoneMasked: phone }
                    : {}),
                }
              : target.kind === "due-items"
                ? {
                    ...(nairaToKobo(amount) !== target.amountKobo
                      ? { amountKobo: nairaToKobo(amount) }
                      : {}),
                    ...(date !== target.dueDate?.slice(0, 10)
                      ? { dueDate: date }
                      : {}),
                  }
                : { name: target.name };
          if (!Object.keys(changes).length)
            throw new Error("Change a value before previewing the correction.");
          dryRun.mutate({
            batchId,
            targetId: target.id,
            expectedUpdatedAt: target.updatedAt,
            changes,
            syntheticOnly: true,
          });
        } catch (error) {
          // The console's own check, shown in its words (saidBy reads data.error).
          setLocalError(
            answerProblem(
              error instanceof Error
                ? error.message
                : "Check the proposed values.",
            ),
          );
        }
      }}
    >
      <p className="text-sm text-muted-foreground">
        Current record: {target.reference || target.name} · source row{" "}
        {target.rowId}. Approval requires a different person with the Finance
        role. Switching demo roles does not count as independent review.
      </p>
      {pending && (
        <p role="status" className="rounded-lg border p-3 text-sm">
          This record already has a pending correction. Review or withdraw it
          below before preparing another.
        </p>
      )}
      <fieldset disabled={locked} className="grid gap-4 sm:grid-cols-2">
        {target.kind === "customers" && (
          <>
            <label className="space-y-1 text-sm font-medium">
              Corrected customer name
              <input
                className={pilotField}
                value={name}
                minLength={2}
                maxLength={160}
                required
                onChange={(e) => {
                  reset();
                  setName(e.target.value);
                }}
              />
            </label>
            <label className="space-y-1 text-sm font-medium">
              Corrected masked phone
              <input
                className={pilotField}
                value={phone}
                maxLength={40}
                onChange={(e) => {
                  reset();
                  setPhone(e.target.value);
                }}
              />
              <span className="block text-xs text-muted-foreground">
                Keep personal phone digits masked, for example +234 •••• 32.
              </span>
            </label>
          </>
        )}
        {target.kind === "due-items" && (
          <>
            <label className="space-y-1 text-sm font-medium">
              Corrected instalment amount (₦)
              <input
                className={pilotField}
                inputMode="decimal"
                value={amount}
                required
                onChange={(e) => {
                  reset();
                  setAmount(e.target.value);
                }}
              />
            </label>
            <label className="space-y-1 text-sm font-medium">
              Corrected due date
              <input
                type="date"
                className={pilotField}
                value={date}
                required
                onChange={(e) => {
                  reset();
                  setDate(e.target.value);
                }}
              />
            </label>
          </>
        )}
      </fieldset>
      {!target.supported && (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-sm">
            Amendments currently support customer names, masked phone numbers,
            and unpaid scheduled instalment amounts or due dates. This record
            type remains unchanged.
          </p>
          <RemedyLinks />
        </div>
      )}
      <Button
        variant="outline"
        type="submit"
        disabled={locked}
        busy={dryRun.isPending}
      >
        {target.supported ? "Preview correction" : "Inspect affected evidence"}
      </Button>
      <PilotError error={localError || dryRun.error} fallback="The correction preview could not be prepared. Check your connection and try again." />
      {comparison && (
        <>
          <Comparison preview={comparison.preview} />
          {comparison.preview.blockers.length === 0 && (
            <>
              <fieldset disabled={locked} className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-1 text-sm font-medium">
                  Reason for correction
                  <textarea
                    required
                    minLength={10}
                    maxLength={1000}
                    className={pilotField}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <label className="space-y-1 text-sm font-medium">
                  Evidence reference
                  <input
                    required
                    minLength={5}
                    maxLength={1000}
                    className={pilotField}
                    value={evidence}
                    onChange={(e) => setEvidence(e.target.value)}
                    placeholder="Corrected file, case or source reference"
                  />
                </label>
                <label className="space-y-1 text-sm font-medium">
                  Independent Finance reviewer
                  <select
                    required
                    className={pilotField}
                    value={reviewer}
                    onChange={(e) => setReviewer(e.target.value)}
                  >
                    <option value="">Choose a reviewer</option>
                    {workbench.reviewers
                      .filter((r) => r.actor !== workbench.actor)
                      .map((r) => (
                        <option key={r.actor} value={r.actor}>
                          {r.name}
                        </option>
                      ))}
                  </select>
                </label>
              </fieldset>
              <Button
                type="button"
                disabled={
                  locked ||
                  reason.trim().length < 10 ||
                  evidence.trim().length < 5 ||
                  !reviewer
                }
                busy={proposed.isPending}
                onClick={() =>
                  proposed.mutate({
                    path: "/pilot/import-corrections",
                    data: {
                      ...comparison.input,
                      previewDigest: comparison.preview.previewDigest,
                      reason,
                      evidence,
                      reviewer,
                    },
                  })
                }
              >
                Propose correction
              </Button>
              <p className="text-xs text-muted-foreground">
                The imported record changes only after independent approval. A
                pending instalment correction blocks approval of a daily close.
              </p>
            </>
          )}
        </>
      )}
      <RecoveryNotice mutation={proposed} />
    </form>
  );
}
function ProposalCard({
  proposal,
  workbench,
  highlighted,
}: {
  proposal: Proposal;
  workbench: Workbench;
  highlighted: boolean;
}) {
  const [reason, setReason] = useState("");
  const [recoveryReason, setRecoveryReason] = useState(""), [replacement, setReplacement] = useState("");
  const card = useRef<HTMLElement>(null);
  useEffect(() => { if (highlighted) { card.current?.focus(); card.current?.scrollIntoView?.({ block: 'center' }); } }, [highlighted]);
  const mutation = usePilotMutation(() => setReason(""));
  const recovery = usePilotMutation(() => { setRecoveryReason(""); setReplacement(""); });
  const own = proposal.proposedPrincipal === workbench.ownPrincipal;
  const reviewer =
    workbench.role === "Finance" &&
    workbench.actor === proposal.reviewer &&
    !own;
  const pending = proposal.status === "awaiting_review",
    busy = mutation.isPending || mutation.hasUnconfirmedOutcome || recovery.isPending || recovery.hasUnconfirmedOutcome;
  useUnsavedChanges(
    pending && !mutation.hasUnconfirmedOutcome && !recovery.hasUnconfirmedOutcome && Boolean(reason || recoveryReason || replacement),
  );
  const decide = (action: "approve" | "reject" | "withdraw") =>
    mutation.mutate({
      path: `/pilot/import-corrections/${proposal.id}/decision`,
      data: { proposalDigest: proposal.proposalDigest, assignmentEventId: proposal.assignmentEventId, action, reason },
    });
  return (
    <article
      ref={card}
      tabIndex={highlighted ? -1 : undefined}
      className={`space-y-3 rounded-xl border p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${highlighted ? 'border-primary' : ''}`}
      aria-label={`Correction ${proposal.preview.rowId}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">{readableLabel(proposal.status)}</h4>
        <span className="text-xs text-muted-foreground">
          {formatDate(proposal.createdAt)}
        </span>
      </div>
      <p className="text-sm">{proposal.reason}</p>
      <p className="break-words text-xs text-muted-foreground">
        Evidence: {proposal.evidence} · proposed by {proposal.proposedBy} ·
        reviewer {proposal.reviewer}
      </p>
      <Comparison preview={proposal.preview} />
      {pending && !proposal.current && (
        <p role="alert" className="text-sm text-destructive">
          The record or its related evidence changed. This proposal cannot be
          approved. Withdraw or reject it, then prepare a fresh comparison.
        </p>
      )}
      {pending && own && (
        <p className="text-sm text-muted-foreground">
          You proposed this correction. A different person must review it; you
          can withdraw it.
        </p>
      )}
      {pending && (reviewer || own) && (
        <div className="space-y-3">
          <label className="block space-y-1 text-sm font-medium">
            Decision reason
            <textarea
              className={pilotField}
              minLength={10}
              maxLength={1000}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {reviewer && (
              <>
                <Button
                  disabled={
                    busy || reason.trim().length < 10 || !proposal.current
                  }
                  onClick={() => decide("approve")}
                >
                  Approve and apply correction
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || reason.trim().length < 10}
                  onClick={() => decide("reject")}
                >
                  Reject correction
                </Button>
              </>
            )}
            {own && (
              <Button
                variant="outline"
                disabled={busy || reason.trim().length < 10}
                onClick={() => decide("withdraw")}
              >
                Withdraw correction
              </Button>
            )}
          </div>
        </div>
      )}
      {proposal.decision && (
        <p className="rounded-lg bg-secondary/40 p-3 text-sm">
          {readableLabel(proposal.decision.action)} · {proposal.decision.actor}{" "}
          · {proposal.decision.reason}
        </p>
      )}
      {!!proposal.assignmentHistory.length && <details className="rounded-lg border p-3 text-sm">
        <summary className="cursor-pointer font-medium">Reviewer assignment history</summary>
        <p className="mt-2 text-muted-foreground">Original reviewer: {proposal.originalReviewer}. The original proposal and comparison remain unchanged.</p>
        <ol className="mt-2 space-y-2">{proposal.assignmentHistory.map(event => <li key={event.id}>
          <p>{event.fromReviewer} → {event.reviewer}</p><p className="text-xs text-muted-foreground">{event.actor} · {formatDate(event.at)}</p><p>{event.reason}</p>
        </li>)}</ol>
      </details>}
      {pending && workbench.role === 'Admin' && <details className="rounded-lg border p-3 text-sm">
        <summary className="cursor-pointer font-medium">Recover reviewer assignment</summary>
        <div className="mt-3 space-y-3">
          <p>If the reviewer is unavailable, assign another active Finance reviewer. This records the reason and preserves the original evidence. It does not approve or apply the correction.</p>
          <label className="block space-y-1 font-medium">Replacement Finance reviewer
            <select className={pilotField} value={replacement} disabled={busy} onChange={event => setReplacement(event.target.value)}>
              <option value="">Choose an independent reviewer</option>
              {workbench.reviewers.filter(person => person.actor !== proposal.reviewer && person.actor !== proposal.proposedBy && !person.actor.startsWith('Sandbox ')).map(person => <option key={person.actor} value={person.actor}>{person.name}</option>)}
            </select>
          </label>
          <p className="text-xs text-muted-foreground">If no eligible reviewer is listed, grant another person Finance access in Team first. The new reviewer may reject stale evidence so a fresh proposal can be prepared.</p>
          <label className="block space-y-1 font-medium">Reassignment reason
            <textarea className={pilotField} minLength={10} maxLength={1000} value={recoveryReason} disabled={busy} onChange={event => setRecoveryReason(event.target.value)} />
          </label>
          <Button variant="outline" disabled={busy || !replacement || recoveryReason.trim().length < 10} onClick={() => recovery.mutate({
            path: `/pilot/import-corrections/${proposal.id}/recovery`, data: { proposalDigest: proposal.proposalDigest, expectedAssignmentEventId: proposal.assignmentEventId, reviewer: replacement, reason: recoveryReason },
          })}>Reassign correction reviewer</Button>
        </div>
      </details>}
      <RecoveryNotice mutation={mutation} />
      <RecoveryNotice mutation={recovery} />
    </article>
  );
}
export function ImportCorrections({ batchId }: { batchId: string }) {
  const requestedCorrection = new URLSearchParams(useSearch()).get('correction');
  const query = usePilotQuery(
    `/pilot/import-corrections?batchId=${encodeURIComponent(batchId)}`,
    importCorrectionsResponseSchema,
  );
  const [selected, setSelected] = useState("");
  const data: Workbench | null = query.data ?? null,
    target = data?.targets.find((t) => t.id === selected);
  return (
    <section
      className="space-y-4 border-t pt-6"
      aria-label="Controlled import corrections"
    >
      <div>
        <h3 className="text-lg font-semibold">Correct a committed import</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Keep the original file and row history intact. Compare a supported
          change, record its evidence, then send it for independent review.
          Other source fields cannot be edited directly; use the dedicated
          workflow action to record a change with its evidence.
        </p>
      </div>
      <PilotError
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
      {query.isLoading && (
        <p role="status">Loading source records and correction history…</p>
      )}
      {data && (
        <>
          <label className="block space-y-1 text-sm font-medium">
            Imported record
            <select
              className={pilotField}
              value={selected}
              onChange={(e) => {
                if (confirmUnsavedChanges()) setSelected(e.target.value);
              }}
            >
              <option value="">Choose a record to compare</option>
              {data.targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name || t.reference} · {t.rowId}
                </option>
              ))}
            </select>
          </label>
          {target && (
            <CorrectionEditor
              key={`${target.id}:${target.updatedAt}`}
              target={target}
              batchId={batchId}
              workbench={data}
            />
          )}
          <h4 className="pt-2 font-semibold">Correction history</h4>
          {requestedCorrection && !data.proposals.some(proposal => proposal.id === requestedCorrection) && <p role="status" className="rounded-lg border p-3 text-sm">The linked correction was not found in this batch. Check the selected lender and open the assignment again from My work.</p>}
          {data.proposals.length ? (
            data.proposals.map((p) => (
              <ProposalCard key={`${p.id}:${p.assignmentEventId || 'original'}`} proposal={p} workbench={data} highlighted={p.id === requestedCorrection} />
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              No corrections have been proposed for this batch.
            </p>
          )}
        </>
      )}
    </section>
  );
}
