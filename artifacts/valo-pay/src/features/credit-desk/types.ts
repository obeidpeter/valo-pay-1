import type { ConnectedView } from "@workspace/valopay-schema";

export type CreditDeskView = ConnectedView["credit"];
export type Assessment = CreditDeskView["assessments"][number];
export type Applicant = ConnectedView["customers"][number];
export type AssessmentTab = "assessment" | "evidence" | "history";
export type AssessmentInputs = {
  scenario: string;
  principal: string;
  repayment: string;
  months: string;
  reason: string;
};
