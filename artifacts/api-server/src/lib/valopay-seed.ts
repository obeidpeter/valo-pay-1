import { randomUUID } from "node:crypto";
import { closeRules } from "@workspace/valopay-schema";
import type { DomainState, Merchant, ValopayRecord } from "../domain/types";

export function seedMerchant(id: string, smaller = false): DomainState {
  const now = new Date();
  const date = (days: number) => new Date(now.getTime()+days*86400000).toISOString();
  const merchant: Merchant = {id,name:smaller?"Cedar Cooperative":"Meridian Credit",shortName:smaller?"CC":"MC",segment:smaller?"Smaller lender · sample data":"Tier-2 lender · sample data",mode:"observation",status:"active",provider:"Sandbox Rail",monthlyVolume:smaller?4000:20000,killSwitch:false,preDataReady:false,preLiveReady:false};
  const state: DomainState = {merchant,settings:{executionStart:6,executionEnd:10,authorisationMode:"batch",contactRoute:`the ${merchant.name} collections team`,minimumTicketKobo:1000000,defaultOwner:"lms",environment:"sandbox",reversalWindowDays:7,providerFeeSchedule:{"Sandbox Rail":{bps:50,capKobo:100000}},policyKillSwitches:{},closeTime:closeRules.defaultTime,scheduledCloseEnabled:true},records:[]};
  function add(kind:string,name:string,status:string,data:Record<string,unknown>={},amountKobo=0,customerId="",reference=""): ValopayRecord {
    const r:ValopayRecord={id:randomUUID(),merchantId:id,kind,name,status,data,amountKobo,customerId,reference,createdAt:date(-3),updatedAt:date(-3)};
    state.records.push(r); return r;
  }
  const policy=add("policies","Standard lender retry policy","draft",{version:1,maxAttempts:3,spacingHours:48,firstNoticeHours:48,retryNoticeHours:24,partialAllowed:false,author:"Sandbox Admin",reviewer:"",complianceMapping:"Central Bank of Nigeria rules on notices and retries; FCCPC rules on debt-recovery conduct. Needs independent review."});
  add("templates","Pre-debit notice","draft",{version:1,purpose:"pre_debit",text:"{{merchant}}: Your payment of {{amount}} is due on {{date}}. For help, contact {{contact}}.",author:"Sandbox Admin"});
  const names=["Ada Okonkwo","Túndé Bakare","Chiamaka Ọbi","Yusuf Bello","Ngozi Eze","Dami Adéyẹmí","Ifẹ Nwosu","Ṣeyi Ajayi"]; // Yoruba and Igbo names carry their marks, as their bearers write them
  names.forEach((name,i)=>{
    const c=add("customers",name,"active",{bankName:["Access Bank","GTBank","Zenith Bank","UBA"][i%4],accountMasked:`•••• ${1000+i}`,phoneMasked:`+234 ••• ••${30+i}`,consentProvenance:"Sample imported consent",synthetic:true},0,"",`DEMO-C${1001+i}`);
    const mandate=add("mandates",`${name} · monthly mandate`,i===2||i===5?"pending_activation":i===7?"suspended":"active",{workflow:i%2?"hosted_consent":"transfer_to_activate",frequency:"monthly",activationDeadline:date(i===2?2:5),consentEvidence:`DEMO-CONSENT-${i+1}`,consentGaps:i===7?["No captured timestamp"]:[],policyId:policy.id,origin:"imported",reminderCount:i===2?1:0,synthetic:true},5000000,c.id,`SBX-MND-${1001+i}`);
    const amount=[2500000,4200000,1800000,3500000,2500000,6000000,1500000,800000][i]!;
    const due=add("due-items",`${name} · instalment ${i+1}`,"scheduled",{dueDate:date(i<4?-2:2).slice(0,10),mandateId:mandate.id,owner:"lms",outstandingKobo:amount,synthetic:true,overrideReason:i===7?"Sample Admin accepted the small-amount warning":""},amount,c.id,`DEMO-LOAN-${1001+i}`);
    if(i<3){
      // The engine's own words for these rules (reconciliation-matching), so sample and live records read the same.
      const certain=`Provider reference SBX-PAY-${1001+i} matches instalment DEMO-LOAN-${1001+i} through its collection attempt’s provider reference. The currency and the amount before fees also match.`;
      const probable="The amount and payer match one instalment due within five days. Finance must confirm the match.";
      const payment=add("payments",`${name} · received`,i===2?"proposed":"allocated",{channel:i===1?"transfer":"direct_debit",collectionStatus:"succeeded",settlementStatus:"settled",reversalStatus:"none",refundStatus:"none",dueItemId:due.id,allocatedKobo:i===2?0:amount,rule:i===2?"R5":"R1",confidence:i===2?"probable":"certain",explanation:i===2?probable:certain,synthetic:true},amount,c.id,`SBX-PAY-${1001+i}`);
      add("observations",`${name} · payment evidence`,"resolved",{source:i===1?"transfer":"webhook",paymentId:payment.id,provider:"Sandbox Rail",dueItemId:due.id,resolutionKey:"provider_reference",eventId:`seed-${i}`,synthetic:true},amount,c.id,payment.reference);
      if(i!==2){
        add("allocations",`${name} · certain match`,"confirmed",{paymentId:payment.id,dueItemId:due.id,rule:"R1",confidence:"certain",automatic:true,explanation:certain,synthetic:true},amount,c.id);
        due.status="paid"; due.data.outstandingKobo=0;
      } else {
        // A proposed payment always carries its proposed allocation for Finance to confirm or reject.
        add("allocations",`${name} · probable match`,"proposed",{paymentId:payment.id,dueItemId:due.id,rule:"R5",confidence:"probable",automatic:false,explanation:probable,reviewed:null,synthetic:true},amount,c.id);
        payment.data.proposedDueItemId=due.id; payment.data.proposedAmountKobo=amount;
      }
      add("attempts",`${name} · external attempt`,"succeeded",{dueItemId:due.id,number:1,source:"external",occurredAt:date(-3),providerReference:payment.reference,synthetic:true},amount,c.id);
    }
    if(i===3){
      add("attempts",`${name} · external attempt`,"failed",{dueItemId:due.id,number:1,source:"external",failureCode:"INSUFFICIENT_FUNDS",occurredAt:date(-2),synthetic:true},amount,c.id);
      due.status="in_collection";
    }
    if([2,5,7].includes(i)){
      add("exceptions",i===7?"Missing consent evidence":i===5?"Activation awaiting consent":"Payment needs confirmation","open",{type:i===7?"imported_consent_gap":i===5?"activation_expired":"unallocated_payment",severity:i===7?"high":"medium",owner:i===2?"Finance":i===7?"Admin":"Operations",dueBy:date(i===7?-1:1),linkedRecordId:i===2?due.id:mandate.id,notes:"Sample exception. Review the linked record and choose an outcome.",synthetic:true},amount,c.id);
    }
  });
  const unidentified=add("payments","Unidentified transfer","unallocated",{channel:"transfer",collectionStatus:"succeeded",settlementStatus:"settled",reversalStatus:"none",refundStatus:"none",allocatedKobo:0,narration:"Loan repayment",observedAt:date(-3),synthetic:true},3200000,"","SBX-UNIDENTIFIED-001");
  add("exceptions","Transfer has no unique reference","open",{type:"unallocated_payment",severity:"medium",owner:"Finance",dueBy:date(1),notes:"Confirm the payer before allocation.",linkedRecordId:unidentified.id,synthetic:true},3200000);
  add("cutovers","Initial lender cohort","draft",{inventory:"Loan management system schedule; provider’s recurring plan; lender’s manual collections",incumbentDisabled:false,externalAttemptsImported:true,dualRunComplete:false,accountableUser:"",fallbackOwner:"lms",confirmation:"",synthetic:true});
  add("experiments","Recovery test plan","draft",{baselineRate:0.4,holdoutShare:0.5,minPerArm:600,analysisDate:date(120).slice(0,10),enrolmentClose:date(90).slice(0,10),seed:"valopay-stage1-sandbox",policyId:policy.id,synthetic:true});
  add("commercial",merchant.name,"discovery",{monthlyVolume:merchant.monthlyVolume,averageTicketKobo:2500000,implementationKobo:smaller?100000000:300000000,licenceKobo:smaller?35000000:60000000,usageBps:30,usageCapKobo:15000,signed:false,signedFullPriceTerms:false,effectiveDate:"2028-01-01",startCondition:"After funding is confirmed and the launch date is agreed",conversationComplete:false,designPartner:true,synthetic:true});
  for(const [key,name] of [["P1","Legal opinion"],["P2","Aggregator partner access"],["P3","Data protection registration and data-processing agreement"],["P4","Security and operational readiness"],["P5","Two design-partner lenders"]]){
    add("evidence",`${key} · ${name}`,"pending",{gateId:key,reference:"",notes:"External evidence required. Sample records cannot satisfy this gate."},0,"",key);
  }
  add("integrations","Sandbox Rail","simulated",{type:"aggregator",description:"Simulated provider for sample data only. No real provider is connected.",capabilities:["mandate tracking","sample payment evidence"],synthetic:true});
  add("integrations","SMS route","not_connected",{type:"sms",description:"No messages are sent. Delivery through Nigerian transactional routes, including do-not-disturb rules, must be verified first."});
  add("integrations","Loan management system","csv_only",{type:"lms",description:"Sample CSV import and outcome export only. No direct connection to the loan management system."});
  return state;
}