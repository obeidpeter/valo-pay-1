import { ConnectedPanel, ConnectedStatus } from "@/components/connected-frame";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDate } from "@/lib/formatters";
import { valueLabel } from "@workspace/valo-pay-1-schema";
import { FileCheck2 } from "lucide-react";
import { AssessmentEvidence } from "./assessment-evidence";
import { AssessmentHistory } from "./assessment-history";
import { AssessmentSummary } from "./assessment-summary";
import { recommendationLabels } from "./labels";
import type { Assessment, AssessmentTab } from "./types";

type Props = {
  assessments: Assessment[];
  selected: Assessment | undefined;
  modelVersion: string;
  tab: AssessmentTab;
  onSelect: (id: string) => void;
  onTabChange: (tab: AssessmentTab) => void;
};

export function AssessmentWorkspace({
  assessments,
  selected,
  modelVersion,
  tab,
  onSelect,
  onTabChange,
}: Props) {
  const result = selected?.result;
  return (
    <ConnectedPanel
      title="Assessment results"
      description="Each run creates a new version. Earlier versions and their reviews are kept."
    >
      {!selected ? (
        <div className="py-12 text-center">
          <FileCheck2
            size={36}
            className="mx-auto mb-4 text-muted-foreground"
            aria-hidden="true"
          />
          <h3 className="font-semibold">No assessments yet</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Grant both permissions, choose a scenario and select Run
            assessment. You will then see the score, the affordability check
            and the policy checks.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-4">
            <label htmlFor="credit-result">Assessment version</label>
            <select
              id="credit-result"
              value={selected.id}
              onChange={(event) => {
                onSelect(event.target.value);
                onTabChange("assessment");
              }}
            >
              {assessments.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.customerName} · version {item.result.version} ·{" "}
                  {recommendationLabels[item.result.policy.recommendation] ??
                    valueLabel(item.result.policy.recommendation)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
            <div>
              <h3 className="text-xl font-semibold">{selected.customerName}</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Version {result!.version} · {formatDate(selected.createdAt)}
              </p>
            </div>
            <ConnectedStatus record="assessment" status={result!.state} />
          </div>
          <Tabs
            value={tab}
            onValueChange={(value) => onTabChange(value as typeof tab)}
          >
            <TabsList
              className="flex w-full justify-start gap-2 mb-5 h-auto flex-wrap"
              aria-label="Assessment details"
            >
              {(["assessment", "evidence", "history"] as const).map((value) => (
                <TabsTrigger key={value} value={value} className="min-h-10">
                  {value === "assessment"
                    ? "Assessment"
                    : value === "evidence"
                      ? "Evidence"
                      : "Review history"}
                </TabsTrigger>
              ))}
            </TabsList>
            <AssessmentSummary assessment={selected} />
            <AssessmentEvidence
              result={selected.result}
              modelVersion={modelVersion}
            />
            <AssessmentHistory assessment={selected} />
          </Tabs>
        </>
      )}
    </ConnectedPanel>
  );
}
