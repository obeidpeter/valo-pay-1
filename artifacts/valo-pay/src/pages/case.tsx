import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useWorkspace } from "@/lib/workspace-context";
import { usePilotMutation, usePilotQuery } from "@/lib/pilot";
import { caseDetailSchema } from "@workspace/valopay-schema";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import {
  PilotError,
  PilotPanel,
  RecoveryNotice,
  pilotField,
} from "@/components/pilot-ui";
import { Button } from "@/components/ui/button";
import { FieldError, FormAlert, attentionTitle, focusField, invalidProps } from "@/components/form-field";
import { formatDate } from "@/lib/formatters";
import { formatRecordMoney } from "@/lib/currencies";
import { readableLabel, StatusBadge } from "@/components/record-label";
import { exceptionStatus } from "@/components/exception-context";
import { recordKindName } from "@/lib/record-kinds";
import { LookedFor } from "@/components/notice";
import { NotFoundNotice } from "@/pages/not-found";

const watInput = (iso: string) =>
  new Date(Date.parse(iso) + 3600000).toISOString().slice(0, 16);
/** The roles the service lets work on a case (coordinateCase); Read-only can review it only. */
const caseRoles = ["Admin", "Operations", "Finance", "Compliance reviewer"];
type Assignee = { actor: string; name: string; role: string };
/** Why this person cannot change the case, in the service's rules, or "" when they can. */
function caseLock(
  role: string | undefined,
  actor: string,
  record: any,
  assignees: Assignee[],
  sandbox: boolean,
): string {
  const holder = record.data.case?.assignee as string | undefined;
  const holderName = record.data.case?.assigneeName || holder;
  if (!caseRoles.includes(role || ""))
    return `Only Admin, Operations, Finance and Compliance reviewer team members can change a case. Your role is ${role || "not known yet"}.${sandbox ? " Change your demo role in Settings." : ""}`;
  if (["closed", "resolved"].includes(record.status))
    return `This exception is ${record.status === "closed" ? "closed" : "resolved"}. Its case keeps its history and cannot be handed over.`;
  if (!holder && !assignees.some((person) => person.actor === actor))
    return "You cannot claim this case because you are not on the list of people who can work on this lender’s cases. Ask an Admin to give you access to this lender in Team and access.";
  if (holder && holder !== actor && role !== "Admin")
    return `This case is assigned to ${holderName}. Only ${holderName} or an Admin can record its next step or hand it over.`;
  return "";
}
/** The address is a case page, but the current lender has no exception with that ID. */
function MissingCase({ id }: { id: string }) {
  useEffect(() => {
    document.title = "Case not found · Valo Pay";
  }, []);
  return (
    <NotFoundNotice
      title="Case not found"
      primary={{ href: "/exceptions", label: "Back to Exceptions" }}
      secondary={{ href: "/overview", label: "Open Overview" }}
    >
      <p>
        No case has the ID <LookedFor>{id}</LookedFor> for this lender. It may
        have been deleted, or it belongs to another lender. Check the address
        or choose another lender.
      </p>
      <p>Nothing has changed.</p>
    </NotFoundNotice>
  );
}
export default function CasePage({ params }: { params: { id: string } }) {
  const { merchantId } = useWorkspace(),
    query = usePilotQuery(`/pilot/cases/${params.id}`, caseDetailSchema);
  // A confirmed 404 is its own page; any other failure keeps the retry below.
  if ((query.error as { status?: number } | null)?.status === 404)
    return <MissingCase id={params.id} />;
  // The page is named Case; once the exception loads, its heading also names the exception's type.
  const type = query.data?.record.data?.type;
  return (
    <div className="space-y-6">
      <Link href="/exceptions" className="text-sm text-primary underline">
        Back to Exceptions
      </Link>
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          {type ? `Case: ${readableLabel(type)}` : "Case"}
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Record who owns this exception, its next step and its evidence.
          Recording a handover does not allocate a payment or resolve the
          exception.
        </p>
      </header>
      <PilotError
        error={query.error}
        what="this case"
        retry={() => {
          void query.refetch();
        }}
      />
      {query.isLoading && <p role="status">Loading this case…</p>}
      {query.data && (
        <CaseWork
          key={`${merchantId}:${params.id}`}
          data={query.data}
          refresh={() => query.refetch()}
        />
      )}
    </div>
  );
}
function CaseWork({ data, refresh }: { data: any; refresh(): Promise<any> }) {
  const { workspace, merchantId } = useWorkspace();
  const [record, setRecord] = useState(data.record),
    [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [assignee, setAssignee] = useState(
    record.data.case?.assignee || workspace?.actor || "",
  );
  const [nextAction, setNextAction] = useState(
    record.data.case?.nextAction || "",
  );
  const [when, setWhen] = useState(() =>
    watInput(
      record.data.case?.nextActionAt ||
        new Date(Date.now() + 86400000).toISOString(),
    ),
  );
  // The suggested time is fixed when the form opens, not recalculated as the clock moves.
  const [savedWhen, setSavedWhen] = useState(when);
  const [evidence, setEvidence] = useState<string[]>(
      record.data.case?.evidenceIds || [],
    ),
    [search, setSearch] = useState("");
  const { confirmDiscard } = useUnsavedChanges(
    Boolean(note.trim()) ||
      when !== savedWhen ||
      nextAction !== (record.data.case?.nextAction || "") ||
      assignee !== (record.data.case?.assignee || workspace?.actor || "") ||
      JSON.stringify(evidence) !==
        JSON.stringify(record.data.case?.evidenceIds || []),
  );
  const resetDraft = (latest: any) => {
    const followUp = watInput(
      latest.data.case?.nextActionAt ||
        new Date(Date.now() + 86400000).toISOString(),
    );
    setRecord(latest);
    setNote("");
    setErrors({});
    setAssignee(latest.data.case?.assignee || workspace?.actor || "");
    setNextAction(latest.data.case?.nextAction || "");
    setEvidence(latest.data.case?.evidenceIds || []);
    setWhen(followUp);
    setSavedWhen(followUp);
  };
  const mutation = usePilotMutation(resetDraft);
  const assignees: Assignee[] = data.assignees;
  const holder = record.data.case?.assignee as string | undefined;
  const holderName = record.data.case?.assigneeName || holder;
  // The service refuses a change from anyone but the assignee or an Admin, and gives a case only to someone on the lender's list.
  const locked = caseLock(workspace?.role, workspace?.actor || "", record, assignees, workspace?.accessMode !== "staff");
  const denied = Boolean(locked);
  const formerHolder = Boolean(holder) && !assignees.some((person) => person.actor === holder);
  const mustHandOver = formerHolder && assignee === holder;
  const busy = mutation.isPending || mutation.hasUnconfirmedOutcome,
    changed = Date.parse(data.record.updatedAt) > Date.parse(record.updatedAt);
  /** The service's own limits, checked before asking it, so each problem is named at its field. */
  const check = () => {
    const found: Record<string, string> = {};
    if (nextAction.trim().length < 3)
      found["case-next-action"] = "Enter the next step (at least 3 characters).";
    if (!when || !(Date.parse(`${when}:00+01:00`) > Date.now()))
      found["case-follow-up"] = "Choose a follow-up time in the future. The exception deadline stays as it is.";
    if (note.trim().length < 3)
      found["case-note"] = "Enter a handover or progress note (at least 3 characters).";
    return found;
  };
  const submit = (action: "claim" | "update" | "handover") => {
    const found = check();
    setErrors(found);
    const first = ["case-next-action", "case-follow-up", "case-note"].find((id) => found[id]);
    if (first) {
      focusField(first);
      return;
    }
    mutation.mutate({
      path: `/pilot/cases/${record.id}`,
      data: {
        action,
        assignee,
        expectedUpdatedAt: record.updatedAt,
        note,
        nextAction,
        nextActionAt: new Date(`${when}:00+01:00`).toISOString(),
        evidenceIds: evidence,
      },
    });
  };
  const described = (id: string, help?: string) => {
    const props = invalidProps(id, errors[id]);
    return { ...props, "aria-describedby": [help, props["aria-describedby"]].filter(Boolean).join(" ") || undefined };
  };
  const edit = (id: string, apply: () => void) => {
    apply();
    setErrors((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  };
  return (
    <>
      <div className="grid gap-5 lg:grid-cols-[1fr_1.4fr]">
        <PilotPanel title="Exception details">
          <p className="text-2xl font-semibold tabular-nums">
            {formatRecordMoney(record, record.amountKobo)}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
            <dt className="text-muted-foreground">Status</dt>
            <dd><StatusBadge status={exceptionStatus(record)} /></dd>
            <dt className="text-muted-foreground">Team</dt>
            <dd>{record.data.owner || "No team"}</dd>
            <dt className="text-muted-foreground">Assigned to</dt>
            <dd>{record.data.case?.assigneeName || "No one yet"}</dd>
            <dt className="text-muted-foreground">Exception deadline</dt>
            <dd>
              {record.data.dueBy ? formatDate(record.data.dueBy) : "Not set"}
            </dd>
            <dt className="text-muted-foreground">Next step</dt>
            <dd>{record.data.case?.nextAction || "Not recorded"}</dd>
            <dt className="text-muted-foreground">Follow-up time</dt>
            <dd>
              {record.data.case?.nextActionAt
                ? formatDate(record.data.case.nextActionAt)
                : "Not set"}
            </dd>
          </dl>
          <p className="text-sm text-muted-foreground whitespace-pre-line">{record.data.notes}</p>
          <Link
            href={`/exceptions?${new URLSearchParams({ record: record.id, ...(merchantId ? { lender: merchantId } : {}) })}#record-${record.id}`}
            className="inline-block text-sm text-primary underline"
          >
            Open in Exceptions
          </Link>
          <Link
            href="/reconciliation"
            className="block text-sm text-primary underline"
          >
            Open Reconciliation
          </Link>
        </PilotPanel>
        <PilotPanel
          title={record.data.case ? "Record the next step" : "Claim this case"}
        >
          {changed && (
            <p
              role="status"
              className="rounded-lg border border-warning-border p-3 text-sm"
            >
              Someone changed this case after you opened it, so you cannot
              save this draft. Copy anything you need, then select Refresh
              case.
            </p>
          )}
          <form
            className="space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              submit(
                !record.data.case?.assignee
                  ? "claim"
                  : assignee !== record.data.case.assignee
                    ? "handover"
                    : "update",
              );
            }}
          >
            <fieldset
              disabled={busy || denied || changed}
              className="space-y-4"
            >
              {Object.keys(errors).length > 0 && (
                <FormAlert title={attentionTitle(Object.keys(errors).length)} />
              )}
              <p className="text-xs text-muted-foreground">
                Every field is required except linked evidence.
              </p>
              <div className="space-y-1">
                <label className="block space-y-1 text-sm font-medium">
                  Assigned to
                  <select
                    id="case-assignee"
                    className={pilotField}
                    value={assignee}
                    disabled={!holder}
                    aria-describedby="case-assignee-help"
                    onChange={(e) => setAssignee(e.target.value)}
                  >
                    {!holder && !assignees.some((person) => person.actor === assignee) && (
                      <option value={assignee} disabled>
                        You · not on the list of people who can work on cases
                      </option>
                    )}
                    {formerHolder && (
                      <option value={holder} disabled>
                        {holderName} · can no longer work on cases
                      </option>
                    )}
                    {assignees.map((person) => (
                      <option key={person.actor} value={person.actor}>
                        {person.name} · {person.role}
                      </option>
                    ))}
                  </select>
                </label>
                <p id="case-assignee-help" className="text-xs text-muted-foreground">
                  {!holder
                    ? "Claiming assigns this case to you. Once it is yours, you can hand it over."
                    : formerHolder
                      ? `${holderName} can no longer work on cases for this lender. Choose who takes the case over.`
                      : "Only people who can work on cases for this lender are listed. Read-only team members cannot be given a case."}
                </p>
              </div>
              <div className="space-y-1">
                <label className="block space-y-1 text-sm font-medium">
                  Next step
                  <input
                    id="case-next-action"
                    className={pilotField}
                    required
                    maxLength={240}
                    value={nextAction}
                    {...described("case-next-action")}
                    onChange={(e) => edit("case-next-action", () => setNextAction(e.target.value))}
                    placeholder="Confirm the payer and review the matching evidence"
                  />
                </label>
                <FieldError id="case-next-action" message={errors["case-next-action"]} />
              </div>
              <div className="space-y-1">
                <label className="block space-y-1 text-sm font-medium">
                  Follow-up time (WAT)
                  <input
                    id="case-follow-up"
                    className={pilotField}
                    type="datetime-local"
                    required
                    min={watInput(new Date().toISOString())}
                    value={when}
                    {...described("case-follow-up", "case-follow-up-help")}
                    onChange={(e) => edit("case-follow-up", () => setWhen(e.target.value))}
                  />
                </label>
                <p id="case-follow-up-help" className="text-xs text-muted-foreground">
                  A time in the future. The exception’s own deadline does not change.
                </p>
                <FieldError id="case-follow-up" message={errors["case-follow-up"]} />
              </div>
              <div className="space-y-1">
                <label className="block space-y-1 text-sm font-medium">
                  Handover or progress note
                  <textarea
                    id="case-note"
                    className={`${pilotField} min-h-24`}
                    required
                    maxLength={2000}
                    value={note}
                    {...described("case-note")}
                    onChange={(e) => edit("case-note", () => setNote(e.target.value))}
                    placeholder="What was checked, what remains and why this next step is needed"
                  />
                </label>
                <FieldError id="case-note" message={errors["case-note"]} />
              </div>
              <details>
                <summary className="cursor-pointer py-2 text-sm font-medium">
                  Linked evidence ({evidence.length})
                </summary>
                <label className="block text-sm">
                  Find evidence
                  <input
                    className={pilotField}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Name, reference or record type"
                  />
                </label>
                <div className="mt-2 max-h-52 space-y-2 overflow-auto rounded-lg border p-3">
                  {data.evidence
                    .filter((item: any) =>
                      `${item.name} ${item.reference} ${item.kind} ${recordKindName(item.kind)}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .slice(0, 100)
                    .map((item: any) => (
                      <label
                        key={item.id}
                        className="flex items-start gap-2 text-sm"
                      >
                        <input
                          className="mt-1"
                          type="checkbox"
                          checked={evidence.includes(item.id)}
                          onChange={(e) =>
                            setEvidence((previous) =>
                              e.target.checked
                                ? [...previous, item.id]
                                : previous.filter((id) => id !== item.id),
                            )
                          }
                        />
                        <span>
                          {item.name}
                          <small className="block text-muted-foreground">
                            {recordKindName(item.kind)} · {item.reference}
                          </small>
                        </span>
                      </label>
                    ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Up to 20 evidence links. The list shows the first 100 matching
                  records.
                </p>
              </details>
            </fieldset>
            <RecoveryNotice mutation={mutation} />
            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                disabled={denied || busy || changed || mustHandOver}
                busy={mutation.isPending}
                aria-describedby={locked ? "case-locked" : undefined}
              >
                {!record.data.case?.assignee
                  ? "Claim and save next step"
                  : assignee !== record.data.case.assignee
                    ? "Save handover"
                    : "Save next step"}
              </Button>
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!confirmDiscard()) return;
                  void refresh().then((result) => {
                    // A failed refetch can still contain cached data. Keep the draft until a fresh read succeeds.
                    if (result.isSuccess && result.data) resetDraft(result.data.record);
                  });
                }}
              >
                Refresh case
              </Button>
            </div>
            {mutation.isSuccess && (
              <p role="status" className="text-sm">
                Case saved. Its handover history is updated.
              </p>
            )}
            {locked && (
              <p id="case-locked" className="text-sm text-muted-foreground">
                {locked}
              </p>
            )}
          </form>
        </PilotPanel>
      </div>
      <PilotPanel title="Handover history">
        {data.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No handover recorded yet. Claim the case to add the first next step.
          </p>
        ) : (
          <ol className="space-y-5">
            {[...data.events].reverse().map((event: any) => (
              <li key={event.id} className="border-l-2 border-primary/30 pl-4">
                <p className="text-sm font-semibold">
                  {event.name} · {event.data.after?.assigneeName}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">
                  {event.data.note}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Next step: {event.data.after?.nextAction} ·{" "}
                  {formatDate(event.data.after?.nextActionAt)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {event.data.actor} · {formatDate(event.createdAt)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </PilotPanel>
    </>
  );
}
