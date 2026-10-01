import { beforeEach, afterEach, it, expect } from "vitest";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { queryClient } from "@/App";
import { createHmac } from "node:crypto";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor, within } from "./harness";
import { parsePaystackTestWebhook } from "../../api-server/src/providers/paystack";
import { receivePaystackEvent, replayProviderEvent } from "../../api-server/src/providers/paystack-inbox";
let api: FakeApi;
beforeEach(()=>{ api=installFakeApi({now:"2026-09-22T08:00:00.000Z"}); });
afterEach(()=>api.uninstall());

it("keeps loading and failed source reads distinct from empty profiles, batches and connection status",async()=>{
  const user=userEvent.setup(), release=api.hold(/^\/v1\/sources$/);
  api.failNext(/^\/v1\/sources$/, "offline", "GET");
  renderApp("/sources?businessDate=2026-09-22");
  await screen.findByText("Loading data sources…");
  expect(screen.queryByText(/No source profiles yet/)).toBeNull();
  expect(screen.queryByText(/No saved batches yet/)).toBeNull();
  expect(screen.queryByText("Not connected")).toBeNull();
  expect(screen.queryByRole("button",{name:"Simulate a Paystack payment"})).toBeNull();
  release();
  await screen.findByText("We could not load source profiles. Select Try again above.");
  expect(screen.getByRole("alert").textContent).toMatch(/^We could not load data sourcesValo Pay could not be reached\. Check your connection and try again\./);
  expect(screen.getByText("We could not load saved batches. Select Try again above.")).toBeTruthy();
  expect(screen.getByText("Connection status not loaded")).toBeTruthy();
  expect(screen.queryByText(/No source profiles yet/)).toBeNull();
  expect(screen.queryByText(/No saved batches yet/)).toBeNull();
  expect(screen.queryByText("Not connected")).toBeNull();
  await user.click(screen.getByRole("button",{name:"Try again"}));
  await screen.findByText("No source profiles yet. Add one below, then reuse it in Import batches.");
  expect(screen.getByText(/No saved batches yet/)).toBeTruthy();
  expect(screen.getByText("Not connected")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  await waitFor(()=>expect(document.activeElement).toBe(screen.getByText("Source information reloaded.")));
  const releaseNextDate=api.hold(/^\/v1\/sources$/);
  fireEvent.change(screen.getByLabelText("Business date (WAT)"),{target:{value:"2026-09-23"}});
  await screen.findByText("Loading data sources…");
  expect(screen.queryByText("Source information reloaded.")).toBeNull();
  releaseNextDate();
  await screen.findByText("No source profiles yet. Add one below, then reuse it in Import batches.");
  expect(screen.queryByText("Source information reloaded.")).toBeNull();
});

it.each(["Read-only", "Compliance reviewer"])("gives %s users an actionable source-profile handoff instead of a hidden creation form",async role=>{
  api.role=role;renderApp("/sources");
  await screen.findByText("No source profiles yet. Ask an Admin, Operations or Finance team member to add a source profile.");
  expect(screen.queryByText(/Add one below/)).toBeNull();
  expect(screen.queryByRole("button",{name:"Add source profile"})).toBeNull();
  expect(screen.queryByRole("button",{name:"Save changes"})).toBeNull();
});

it("retains loaded source profiles and counts when refreshing fails",async()=>{
  api.mutate((state,ctx)=>{state.records.push({id:'cached-profile',merchantId:state.merchant.id,kind:'source-profiles',name:'Previously loaded feed',status:'active',reference:'',amountKobo:0,customerId:'',createdAt:ctx.now,updatedAt:ctx.now,data:{source:'cached-source',kind:'customers',mapping:{},identityColumn:'source_row_id',amountUnit:'naira',firstExpectedAt:'2026-09-20T07:00:00.000Z',cadenceHours:24,graceMinutes:0}});});
  renderApp("/sources");
  await screen.findByRole("heading",{name:"Previously loaded feed"});
  const lateCount=screen.getByText("Late sources").parentElement!;
  expect(lateCount.textContent).toBe("Late sources1");
  api.failNext(/^\/v1\/sources$/, "offline", "GET");
  await act(()=>queryClient.refetchQueries({predicate:query=>query.queryKey[0]==="pilot"&&String(query.queryKey.at(-1)).startsWith("/sources?")}));
  await screen.findByText("Showing the last loaded source information. Try again to check for updates.");
  expect(screen.getByRole("heading",{name:"Previously loaded feed"})).toBeTruthy();
  expect(lateCount.textContent).toBe("Late sources1");
  expect(screen.queryByText(/No source profiles yet/)).toBeNull();
});

it("declares dated source files with control totals and keeps a missing delivery visible",async()=>{
  const user=userEvent.setup();renderApp("/sources?businessDate=2026-09-22");
  await user.click(await screen.findByRole("button",{name:"Add expected file"}));
  await user.type(screen.getByLabelText("File 1 source name"),"loan-system");
  await user.type(screen.getByLabelText("File 1 source batch ID"),"customers-2026-09-22");
  await user.clear(screen.getByLabelText("File 1 row count"));await user.type(screen.getByLabelText("File 1 row count"),"2");
  await user.type(screen.getByLabelText("Reason for this list"),"The source owner confirmed the complete customer delivery list.");
  await user.type(screen.getByLabelText("Evidence reference"),"Source control report CONTROL-22.");
  await user.click(screen.getByRole("button",{name:"Save expected files"}));
  await screen.findByRole("heading",{name:"Change the expected files"});
  expect(screen.getByText("File incomplete · customers-2026-09-22")).toBeTruthy();
  expect(screen.getByText(/0 of 1 expected files complete/)).toBeTruthy();
  const manifest=api.state().records.find(record=>record.kind==='source-manifests')!;
  expect(manifest.data.businessDate).toBe("2026-09-22");expect(manifest.data.files[0].expectedRows).toBe(2);
  expect(screen.getByRole("link",{name:"Import expected file"}).getAttribute("href")).toContain("expectation=");
});

it("parses declared naira totals exactly and blocks malformed amounts before submitting",async()=>{
  const user=userEvent.setup();renderApp("/sources?businessDate=2026-09-22");
  await user.click(await screen.findByRole("button",{name:"Add expected file"}));
  await user.type(screen.getByLabelText("File 1 source name"),"settlement-feed");
  await user.type(screen.getByLabelText("File 1 source batch ID"),"payments-22");
  await user.selectOptions(screen.getByLabelText("File 1 record type"),"observations");
  await user.type(screen.getByLabelText("Reason for this list"),"The source control report confirms this expected settlement file.");
  await user.type(screen.getByLabelText("Evidence reference"),"Source control report CONTROL-22.");
  const amount=screen.getByLabelText("File 1 total (₦)");await user.clear(amount);await user.type(amount,"12.345");await user.tab();
  expect(screen.getByRole("alert").textContent).toMatch(/no more than 2 decimal places/);
  await user.click(screen.getByRole("button",{name:"Save expected files"}));
  expect(api.calls.filter(call=>call.method==='POST'&&call.path==='/v1/sources/manifests')).toHaveLength(0);
  await user.clear(amount);await user.type(amount,"12.50");
  await user.click(screen.getByRole("button",{name:"Save expected files"}));
  await screen.findByRole("heading",{name:"Change the expected files"});
  expect(api.state().records.find(record=>record.kind==='source-manifests')!.data.files[0].expectedAmountKobo).toBe(1250);
  expect((screen.getByLabelText("File 1 total (₦)") as HTMLInputElement).value).toBe("12.50");
});

it("reuses a saved source mapping and opens its committed batch from a direct link",async()=>{
  const user=userEvent.setup();renderApp("/sources");
  await user.type(await screen.findByLabelText("Profile name"),"Pilot loan feed");
  await user.type(screen.getByLabelText("Source name"),"synthetic-lms");
  await user.type(screen.getByLabelText("Expected rows (optional)"),"1");
  await user.click(screen.getByRole("button",{name:"Add source profile"}));
  await screen.findByRole("button",{name:"Edit Pilot loan feed"});
  const profile=api.state().records.find(r=>r.kind==='source-profiles')!;
  cleanup();renderApp(`/imports?profile=${profile.id}`);
  await waitFor(()=>expect((screen.getByLabelText("Source name") as HTMLInputElement).value).toBe("synthetic-lms"));
  await user.type(screen.getByLabelText("Batch name"),"Mapped customer delivery");
  await user.type(screen.getByLabelText("Source batch ID"),"batch-001");
  await user.type(screen.getByLabelText("CSV content"),"source_row_id,name,reference,consentProvenance\nrow-1,Sample customer,MAP-C-001,Synthetic consent");
  await user.click(screen.getByRole("button",{name:"Save and check batch"}));
  await screen.findByRole("heading",{name:"Source quality checks"});
  await user.click(screen.getByRole("button",{name:"Import checked batch"}));
  await screen.findByRole("heading",{name:"Batch imported"});
  const batch=api.state().records.find(r=>r.kind==='import-batches')!;
  expect(batch.data.sourceQuality.profileId).toBe(profile.id);
  cleanup();renderApp(`/imports?batch=${batch.id}`);
  await screen.findByRole("heading",{name:"Batch imported"});
  expect((screen.getByLabelText("Source batch ID") as HTMLInputElement).value).toBe("batch-001");
});

it("takes a source profile's expected total in naira, saves exact kobo and shows it back in naira",async()=>{
  const user=userEvent.setup();renderApp("/sources");
  await user.type(await screen.findByLabelText("Profile name"),"Naira totals feed");
  await user.type(screen.getByLabelText("Source name"),"naira-total-source");
  const total=screen.getByLabelText("Expected total (₦, optional)");
  await user.type(total,"1,250.505");await user.tab();
  expect(screen.getByRole("alert").textContent).toMatch(/no more than 2 decimal places/);
  await user.click(screen.getByRole("button",{name:"Add source profile"}));
  expect(api.calls.filter(call=>call.method==="POST"&&call.path.startsWith("/v1/sources/profiles"))).toHaveLength(0);
  await user.clear(total);await user.type(total,"1,250.50");
  await user.click(screen.getByRole("button",{name:"Add source profile"}));
  await user.click(await screen.findByRole("button",{name:"Edit Naira totals feed"}));
  const profile=api.state().records.find(record=>record.kind==="source-profiles")!;
  expect(profile.data.expectedAmountKobo).toBe(125050);
  expect((screen.getByLabelText("Expected total (₦, optional)") as HTMLInputElement).value).toBe("1250.50");
  // Saved unchanged, the total stays exactly the same kobo; cleared, the profile has no expected total.
  await user.click(screen.getByRole("button",{name:"Save changes"}));
  await user.click(await screen.findByRole("button",{name:"Edit Naira totals feed"}));
  expect(api.state().records.find(record=>record.id===profile.id)!.data.expectedAmountKobo).toBe(125050);
  await user.clear(screen.getByLabelText("Expected total (₦, optional)"));
  await user.click(screen.getByRole("button",{name:"Save changes"}));
  await waitFor(()=>expect(api.state().records.find(record=>record.id===profile.id)!.data.expectedAmountKobo).toBeNull());
});

it("keeps incomplete delivery edits recoverable and converts valid WAT dates including native seconds",async()=>{
  const user=userEvent.setup();renderApp("/sources");
  await user.type(await screen.findByLabelText("Profile name"),"Editable delivery schedule");
  await user.type(screen.getByLabelText("Source name"),"delivery-date-test");
  let delivery=screen.getByLabelText("First delivery expected (WAT)") as HTMLInputElement;
  for (const value of ["", "2026-09-", "2026-02-30T07:30"]) {
    fireEvent.change(delivery,{target:{value}});fireEvent.blur(delivery);
    expect(screen.getByRole("alert").textContent).toMatch(/full date and time of the first delivery, in WAT/);
    expect(delivery.getAttribute("aria-invalid")).toBe("true");
    fireEvent.submit(delivery.closest("form")!);
    expect(api.calls.filter(call=>call.method==="POST"&&call.path.startsWith("/v1/sources/profiles"))).toHaveLength(0);
    expect(screen.getByRole("heading",{name:"Data sources"})).toBeTruthy();
  }
  fireEvent.change(delivery,{target:{value:"2026-09-24T07:30"}});
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(screen.getByRole("button",{name:"Add source profile"}));
  await user.click(await screen.findByRole("button",{name:"Edit Editable delivery schedule"}));
  let profile=api.state().records.find(record=>record.kind==="source-profiles")!;
  expect(profile.data.firstExpectedAt).toBe("2026-09-24T06:30:00.000Z");
  delivery=screen.getByLabelText("First delivery expected (WAT)") as HTMLInputElement;
  expect(delivery.value).toBe("2026-09-24T07:30");
  // Native datetime-local controls can include seconds and fractional seconds.
  // Appending ':00' to this value used to throw and unmount the Sources page.
  fireEvent.change(delivery,{target:{value:"2026-09-24T07:30:45.250"}});
  fireEvent.blur(delivery);
  await user.click(screen.getByRole("button",{name:"Save changes"}));
  await waitFor(()=>expect(api.state().records.find(record=>record.id===profile.id)!.data.firstExpectedAt).toBe("2026-09-24T06:30:45.250Z"));
  await user.click(screen.getByRole("button",{name:"Edit Editable delivery schedule"}));
  await user.type(screen.getByLabelText("Profile name")," revised");
  await user.click(screen.getByRole("button",{name:"Save changes"}));
  await screen.findByRole("button",{name:"Edit Editable delivery schedule revised"});
  profile=api.state().records.find(record=>record.id===profile.id)!;
  expect(profile.data.firstExpectedAt).toBe("2026-09-24T06:30:45.250Z");
});

it("labels offline Paystack fixtures and preserves conflicting receipts without recording payments",async()=>{
  const user=userEvent.setup();renderApp("/sources");
  await screen.findByText("Not connected");
  const count=api.state().records.filter(r=>r.kind==='payments').length;
  await user.click(screen.getByRole("button",{name:"Simulate a Paystack payment"}));
  await screen.findAllByText(/Practice message/);
  await user.click(screen.getByRole("button",{name:"Simulate the same payment again"}));
  await waitFor(()=>expect(api.state().records.filter(r=>r.kind==='provider-events')).toHaveLength(1));
  await user.click(screen.getByRole("button",{name:"Simulate the same payment with a different amount"}));
  await screen.findByText(/Practice message.*Held for review/i);
  expect(api.state().records.filter(r=>r.kind==='payments')).toHaveLength(count);
  expect(screen.getByText(/do not contact Paystack/)).toBeTruthy();
});

it("offers Recheck message only for messages the service can recheck, and counts rechecks apart from verification checks",async()=>{
  const user=userEvent.setup(),key=["sk","test","OFFLINE","FIXTURE","0".repeat(20)].join("_");
  const [verified,awaiting]=api.mutate((state,ctx)=>{
    const signed=(id:string,reference:string)=>{const raw=Buffer.from(JSON.stringify({event:"charge.success",data:{id,domain:"test",status:"success",reference,amount:250000,currency:"NGN",channel:"direct_debit"}}));return parsePaystackTestWebhook(raw,createHmac("sha512",key).update(raw).digest("hex"),key);};
    const connection={connectionId:"a".repeat(64),mode:"test" as const};
    const check=(result:string,named:string,kind:string)=>({at:ctx.now,actor:"System · Paystack test verification",reason:"Explicit operator read-only test verification",result,check:named,kind,outcome:{outcome:"unknown",reason:"authentication",nextAction:"verify_same_reference",reissue:false}});
    const verified=receivePaystackEvent(state,ctx,signed("9990001","SYNTHETIC-VERIFIED-001"),connection).event;
    verified.status="verified";verified.data.message="Independently verified sample receipt.";
    verified.data.replayHistory=[check("awaiting_verification","credentials_refused","independent_transaction_check"),{...check("verified","verified","independent_transaction_verification"),observationId:"sample-observation"}];
    const awaiting=receivePaystackEvent(state,ctx,signed("9990002","SYNTHETIC-AWAITING-002"),connection).event;
    awaiting.data.message="Sample receipt awaiting verification.";
    awaiting.data.replayHistory=[check("awaiting_verification","credentials_refused","independent_transaction_check")];
    return [verified,awaiting];
  });
  // The service refuses to replay verified evidence and replays a receipt still awaiting verification.
  const finance={actor:"Sandbox Finance",role:"Finance",now:api.now};
  expect(()=>replayProviderEvent(structuredClone(api.state()),finance,verified.id,verified.updatedAt,"Recheck the saved receipt")).toThrow(/already checked and recorded as payment evidence/);
  expect(replayProviderEvent(structuredClone(api.state()),finance,awaiting.id,awaiting.updatedAt,"Recheck the saved receipt").status).toBe("awaiting_verification");
  api.role="Finance";renderApp("/sources");
  const card=(message:string)=>screen.getByText(message).closest("article")!;
  await screen.findByText("Independently verified sample receipt.");
  expect(within(card("Independently verified sample receipt.")).queryByRole("button",{name:"Recheck message"})).toBeNull();
  expect(card("Independently verified sample receipt.").textContent).toContain("0 rechecks");
  expect(card("Sample receipt awaiting verification.").textContent).toContain("0 rechecks");
  await user.type(within(card("Sample receipt awaiting verification.")).getByLabelText("Reason for rechecking this message"),"Recheck the saved receipt");
  await user.click(within(card("Sample receipt awaiting verification.")).getByRole("button",{name:"Recheck message"}));
  await waitFor(()=>expect(api.state().records.find(record=>record.id===awaiting.id)!.data.replayHistory).toHaveLength(2));
  await waitFor(()=>expect(screen.getAllByText(/1 recheck ·/)).toHaveLength(1));
});

it("shows missing feeds and omits change controls for a read-only user",async()=>{
  api.mutate((state,ctx)=>{state.records.push({id:'late-profile',merchantId:state.merchant.id,kind:'source-profiles',name:'Overdue feed',status:'active',reference:'',amountKobo:0,customerId:'',createdAt:ctx.now,updatedAt:ctx.now,data:{source:'late-source',kind:'customers',mapping:{},identityColumn:'source_row_id',amountUnit:'naira',firstExpectedAt:'2026-09-20T07:00:00.000Z',cadenceHours:24,graceMinutes:0}});});
  api.role='Read-only';renderApp("/sources");
  await screen.findByRole("heading",{name:"Overdue feed"});
  expect(screen.queryByRole("button",{name:"Add source profile"})).toBeNull();
  expect(screen.queryByRole("button",{name:"Save changes"})).toBeNull();
  expect(screen.queryByRole("button",{name:"Simulate a Paystack payment"})).toBeNull();
  expect(screen.getByText("Late",{exact:true})).toBeTruthy();
});

it("tells every role to check a Paystack test payment before using it as evidence, and keeps the set-up steps for Admins",async()=>{
  const warning="Before you use a Paystack test payment as evidence, check it with Paystack yourself.";
  api.role='Finance';renderApp("/sources");
  await screen.findByText("Not connected");
  expect(screen.getByText(warning)).toBeTruthy();
  expect(screen.getByText("The practice buttons simulate messages from Paystack, signed the way Paystack signs them. They do not contact Paystack, activate mandates or create payments.")).toBeTruthy();
  expect(screen.queryByText("Technical setup")).toBeNull();
  cleanup(); queryClient.clear();
  api.role='Admin';renderApp("/sources");
  await screen.findByText("Not connected");
  expect(screen.getByText(warning).closest("details")).toBeNull();
  const setup=screen.getByText("Technical setup").closest("details")!;
  expect(setup.open).toBe(false);
  expect(within(setup).getAllByRole("listitem")).toHaveLength(2);
});
