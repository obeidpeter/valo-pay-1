import { ConnectedPanel } from "@/components/connected-frame";
import { LockKeyhole } from "lucide-react";
import type { CreditDeskView } from "./types";

export function ModelGovernance({
  model,
  gate,
}: Pick<CreditDeskView, "model" | "gate">) {
  return (
    <ConnectedPanel
      title="Model governance"
      description="The sandbox makes proposed controls testable. It does not satisfy the approval gate for lending."
    >
      <div className="connected-subgrid">
        <div className="connected-record">
          <h3>{model.name}</h3>
          <p className="mt-2">
            {model.validation}. Every missing mandatory feature keeps the score
            unavailable; its weight is never redistributed.
          </p>
        </div>
        <div className="connected-record">
          <h3>
            <LockKeyhole size={16} className="inline mr-2" aria-hidden="true" />
            Live use is gated
          </h3>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            {gate.requirements.map((requirement) => (
              <li key={requirement}>{requirement}</li>
            ))}
          </ul>
        </div>
      </div>
    </ConnectedPanel>
  );
}
