import { ConnectedPanel } from "@/components/connected-frame";
import { LockKeyhole } from "lucide-react";
import type { CreditDeskView } from "./types";

export function ModelGovernance({
  model,
  gate,
}: Pick<CreditDeskView, "model" | "gate">) {
  return (
    <ConnectedPanel
      title="Scoring rules and live use"
      description="You can try the proposed controls here. They are not approved for real lending."
    >
      <div className="connected-subgrid">
        <div className="connected-record">
          <h3>{model.name}</h3>
          <p className="mt-2">
            {model.validation}. If a required input is missing, there is no
            score. Its points are never moved to other inputs.
          </p>
        </div>
        <div className="connected-record">
          <h3>
            <LockKeyhole size={16} className="inline mr-2" aria-hidden="true" />
            Not approved for live use
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
