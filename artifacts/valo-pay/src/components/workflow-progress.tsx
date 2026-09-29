import { Check, Circle, Clock3, AlertCircle } from "lucide-react";

export type WorkflowStep = {
  label: string;
  state: "complete" | "current" | "waiting" | "attention";
};
const stateLabels = { complete: "Recorded", current: "Next step", waiting: "Waiting", attention: "Needs attention" };
const icons = { complete: Check, current: Clock3, waiting: Circle, attention: AlertCircle };

/** Read-only progress: callers describe saved evidence, never optimistic mutation state. */
export function WorkflowProgress({ label, steps }: { label: string; steps: readonly WorkflowStep[] }) {
  return <ol aria-label={label} className="grid gap-2 sm:grid-cols-3">
    {steps.map((step, index) => {
      const Icon = icons[step.state];
      return <li key={step.label} aria-current={step.state === "current" || step.state === "attention" ? "step" : undefined}
        className={`flex min-w-0 items-start gap-2 rounded-lg border p-3 ${step.state === "attention" ? "border-warning/40 bg-warning/5" : step.state === "complete" ? "bg-secondary/40" : "bg-card"}`}>
        <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0"><p className="text-xs font-semibold">{index + 1}. {step.label}</p><p className="mt-1 text-xs text-muted-foreground">{stateLabels[step.state]}</p></div>
      </li>;
    })}
  </ol>;
}
