import type { DomainState } from "../domain/types";

/** What the sandbox cannot prove, listed on the gates page and in the gate pack. */
export const limitations=[
  "Sample data only. Do not upload real lender or customer data.",
  "Legal opinion: a qualified Nigerian legal opinion and the permitted way of operating are not yet verified.",
  "Aggregator partner access: there is no written agreement with an aggregator, and no live keys or live connection. No debit instructions can be sent.",
  "Permission to process data is not yet verified. This covers registration under the Nigeria Data Protection Act, data-processing agreements with lenders, hosting and data transfer arrangements, and encryption of individual fields. Real data stays blocked.",
  "Security and operational readiness is not yet verified. This covers required two-step verification, fresh checks for sensitive actions and independent penetration testing. It also covers a backup restore drill, operating procedures, a web application firewall and live monitoring.",
  "Two design-partner lenders: 2 qualifying signed contracts and a confirmed collection transfer for each instalment are still needed.",
  "Text messages are simulated. There is no live Nigerian text message route yet, no do-not-disturb support and no evidence that a provider accepts the messages.",
  "Valo Pay keeps its current software. Its hosting, security and performance are not yet approved for live use.",
  "Team member access that expires, optional field encryption and a signed Paystack test inbox are built and tested with sample data. Their live set-up and provider acceptance are not yet verified. Still to build: sending and scheduling live collection instructions, secure deletion of keys, and storage that cannot be deleted early.",
  "Load capacity, uptime, backup restoration, message delivery and live response times are not yet certified. Sample results cannot pass the recovery test, the list-price test or the operational test.",
];
/** The readiness gates: prerequisites and decisions, always unproven on synthetic data. */
export function getGates(state:DomainState){
 const evidence=state.records.filter(r=>r.kind==="evidence");
 const prerequisites=[
  ["P1","Legal opinion","Obtain a written legal opinion before sending collection instructions. Adjust the operating scope if a licence is required.","Before month 1"],
  ["P2","Aggregator partner access","Obtain a written partner agreement and partner-level access to the live provider system.","End of month 2"],
  ["P3","Permission to process data","Verify data-protection registration, lender data-processing agreements, security controls and approved hosting arrangements before accepting real data.","Before accepting lender data"],
  ["P4","Security and operational readiness","Resolve high-severity findings from independent penetration testing. Test backup restoration and the emergency stop, write down operating procedures, and check two-step verification.","Before the first live customer group"],
  ["P5","Two design-partner lenders","Sign two lender contracts covering data sharing, customer references and responsibility for collection instructions.","End of month 3"],
 ].map(([id,title,description,due])=>({id,title,description,due,status:"blocked",evidence: evidence.find(r=>r.reference===id||r.data.gateId===id)?.data.reference||"No verified evidence from live use yet"}));
 const decisions=[
  {id:"FUNDING",title:"Stage 2 funding",status:"not_proven",description:"All 4 conditions must be met. Both lenders must pass the operational test. Signed agreements must meet the list-price test. The variable cost of each collection must be ₦15.00 or less. Funding must cover at least 3 months of minimum running costs.",evidence:"No qualifying live results or signed commercial terms yet",due:"End of month 9"},
  {id:"RECOVERY",title:"Recovery fee",status:"not_proven",description:"Each lender’s recovery rate by value must improve by at least 8 percentage points, with a 90% confidence interval above zero. Each group needs the planned minimum sample. Count payments settled through any channel within 30 days. This decision is separate from funding.",evidence:"Sample data cannot prove improved recovery. The fee stays off.",due:"End of month 9"},
  {id:"PORTABILITY",title:"Provider choice at setup",status:"closed",description:"Get written answers from NIBSS and 2 aggregators about partner access and moving mandates between providers. A failed debit must not be switched to another provider.",evidence:"No written permission to move mandates between providers. Provider routing has not been built.",due:"Only after written permission"},
 ];
 return {prerequisites,decisions,limitations,cashKobo:0,burnKobo:1250000000};
}
/** A lender's settings, the role's permissions, and its integrations, members and calendar. */
export function getSettings(state:DomainState,role:string){
 const allowed=(roles:string[])=>roles.includes(role);
 return {merchant:state.merchant,settings:state.settings,permissions:{
  edit:allowed(["Admin","Operations","Finance","Compliance reviewer"]),
  approvePolicies:allowed(["Compliance reviewer"]),reconcile:allowed(["Admin","Operations","Finance"]),
  manageSettings:role==="Admin",instruct:false,realData:false,mfaVerified:false,
  accessNote:"Demo roles let you try different responsibilities with sample data. They do not grant access to live operations."
 },integrations:state.records.filter(r=>r.kind==="integrations"),
 members:["Admin","Operations","Finance","Compliance reviewer","Read-only"].map((name,i)=>({id:`demo-member-${i}`,merchantId:state.merchant.id,kind:"members",name:`Sandbox ${name}`,status:"demo",reference:"",amountKobo:0,customerId:"",createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString(),data:{role:name,mfaEnrolled:false,synthetic:true}})),
 calendar:state.records.filter(r=>r.kind==="calendar")};
}
