import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, CheckCircle2, Circle, Building2, AlertCircle, Clock3 } from "lucide-react";
import { merchantSchema, pilotProgressSchema } from "@workspace/valopay-schema";
import { useWorkspace } from "@/lib/workspace-context";
import { useTypedPilotMutation, usePilotQuery } from "@/lib/pilot";
import { useUnsavedChanges } from "@/lib/unsaved-changes";
import {
  PilotError,
  PilotHeading,
  PilotPanel,
  RecoveryNotice,
  pilotField,
} from "@/components/pilot-ui";
import { Button } from "@/components/ui/button";
import { readableLabel } from "@/components/record-label";

export default function PilotPage() {
  const { merchantId, workspace, setMerchantId } = useWorkspace();
  const journey = usePilotQuery("/pilot/progress", pilotProgressSchema);
  const [name, setName] = useState(""),
    [segment, setSegment] = useState("Consumer lending");
  const create = useTypedPilotMutation(merchantSchema, () => setName(""));
  // Operations does not record lender creation: while it is unanswered, leaving or reloading would lose the only check.
  useUnsavedChanges(create.isPending || create.hasUnconfirmedOutcome);
  // The new lender is selected once the creation has settled: its success runs while it is still being sent, and
  // selecting it then would ask to discard the guard above.
  const created = create.data?.id;
  useEffect(() => { if (created) setMerchantId(created); }, [created]);
  const steps = journey.data?.steps || [];
  return (
    <div className="space-y-7 pb-10">
      <PilotHeading title="Pilot journey">
        Follow the pilot steps for one lender. Progress shows checked work and
        recorded decisions. It is not approval to use real customer data or to
        move money.
      </PilotHeading>
      <PilotError
        error={journey.error}
        what="the pilot journey"
        retry={() => {
          void journey.refetch();
        }}
      />
      {journey.isLoading && <p role="status">Loading pilot progress…</p>}
      {journey.data?.access && <section className="rounded-xl border bg-secondary/20 p-4 text-sm">
        <p className="font-semibold">Staff access · {journey.data.access.state === "configured" ? "Set up for sample data" : "Not set up"}</p>
        <p className="mt-1 text-muted-foreground">{journey.data.access.message}</p>
        <Link href="/team" className="mt-2 inline-flex min-h-11 items-center text-primary underline">Open Team and access</Link>
      </section>}
      <div className="grid gap-4 lg:grid-cols-3">
        {steps.map((step, index) => (
          <Link
            key={step.id}
            href={merchantId ? step.href : "/pilot"}
            className="group flex gap-4 rounded-xl border bg-card p-5 hover:border-primary/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="pt-1 text-primary" aria-hidden="true">
              {step.state === "completed" ? (
                <CheckCircle2 className="h-5 w-5" />
              ) : step.state === "blocked" ? (
                <AlertCircle className="h-5 w-5 text-destructive" />
              ) : step.state === "awaiting_review" ? (
                <Clock3 className="h-5 w-5" />
              ) : (
                <Circle className="h-5 w-5" />
              )}
            </span>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">
                Step {index + 1} ·{" "}
                {readableLabel(step.state)}
              </p>
              <h2 className="mt-2 font-semibold">{step.name}</h2>
              {step.evidence.map(item => <p key={item} className="mt-2 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{item}</p>)}
              {!!step.missing.length && <div className="mt-3 border-t pt-3 text-sm"><p className="font-medium">Next step</p>{step.missing.map(item => <p key={item} className="mt-1 text-muted-foreground">{item}</p>)}</div>}
              <ArrowRight
                aria-hidden="true"
                className="mt-4 h-4 w-4 text-primary"
              />
            </div>
          </Link>
        ))}
      </div>
      <PilotPanel title="Set up a lender">
        <p className="text-sm text-muted-foreground">
          Create an empty sample lender to practise the pilot. Then import its
          sample customers, followed by their mandates, instalments and payment
          evidence. Scheduled actions start switched off.
        </p>
        <form
          className="grid items-end gap-4 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate({
              path: "/pilot/lenders",
              lender: false,
              data: { name, segment },
            });
          }}
        >
          <label className="space-y-2 text-sm font-medium">
            Lender name
            <input
              className={pilotField}
              required
              minLength={2}
              maxLength={100}
              value={name}
              disabled={create.isPending || create.hasUnconfirmedOutcome}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="space-y-2 text-sm font-medium">
            Lender type
            <select
              className={pilotField}
              value={segment}
              disabled={create.isPending || create.hasUnconfirmedOutcome}
              onChange={(e) => setSegment(e.target.value)}
            >
              {[
                "Consumer lending",
                "Cooperative",
                "Asset finance",
                "Business finance",
              ].map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          </label>
          <Button
            type="submit"
            busy={create.isPending}
            disabled={
              workspace?.role !== "Admin" || create.hasUnconfirmedOutcome
            }
          >
            <Building2 aria-hidden="true" className="mr-2 h-4 w-4" />
            Create lender
          </Button>
        </form>
        {workspace?.role !== "Admin" && (
          <p className="text-sm text-muted-foreground">
            Only Admin can create a lender. Your role is{" "}
            {workspace?.role || "not set"}.
            {workspace?.accessMode !== "staff" &&
              " Change your demo role in Settings."}
          </p>
        )}
        <RecoveryNotice mutation={create} persistent={false} />
        {create.isSuccess && (
          <p role="status" className="text-sm">
            Lender created. Open Import batches to add its sample records.
          </p>
        )}
      </PilotPanel>
      <div className="flex flex-wrap gap-5 text-sm">
        <Link href="/operations" className="text-primary underline">
          Open Request history
        </Link>
        <Link href="/team" className="text-primary underline">
          Open Team and access
        </Link>
      </div>
    </div>
  );
}
