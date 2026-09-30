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
  await screen.findByText("Loading source controls…");
  expect(screen.queryByText(/No source profiles yet/)).toBeNull();
  expect(screen.queryByText(/Saved batches will appear here/)).toBeNull();
  expect(screen.queryByText("External connection not verified")).toBeNull();
  expect(screen.queryByRole("button",{name:"Receive sample payment"})).toBeNull();
  release();
  await screen.findByText("Source profiles could not be loaded. Try again above.");
  expect(screen.getByRole("alert").textContent).toMatch(/could not be loaded.*try again/i);
  expect(screen.getByText("Saved batches could not be loaded. Try again above.")).toBeTruthy();
  expect(screen.getByText("Connection status unavailable")).toBeTruthy();
  expect(screen.queryByText(/No source profiles yet/)).toBeNull();
  expect(screen.queryByText(/Saved batches will appear here/)).toBeNull();
  expect(screen.queryByText("External connection not verified")).toBeNull();
  await user.click(screen.getByRole("button",{name:"Try again"}));
  await screen.findByText("No source profiles yet. Add one below, then reuse it in Import batches.");
  expect(screen.getByText(/Saved batches will appear here/)).toBeTruthy();
  expect(screen.getByText("External connection not verified")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  await waitFor(()=>expect(document.activeElement).toBe(screen.getByText("Source information reloaded.")));
  const releaseNextDate=api.hold(/^\/v1\/sources$/);
  fireEvent.change(screen.getByLabelText("Business date (WAT)"),{target:{value:"2026-09-23"}});
  await screen.findByText("Loading source controls…");
  expect(screen.queryByText("Source information reloaded.")).toBeNull();
  releaseNextDate();
  await screen.findByText("No source profiles yet. Add one below, then reuse it in Import batches.");
  expect(screen.queryByText("Source information reloaded.")).toBeNull();
});

it.each(["Read-only", "Compliance reviewer"])("gives %s users an actionable source-profile handoff instead of a hidden creation form",async role=>{
  api.role=role;renderApp("/sources");
  await screen.findByText("No source profiles yet. Ask an Admin, Operations or Finance team member to add a source profile.");
  expect(screen.queryByText(/Add one below/)).toBeNull();
  expect(screen.queryByRole("button",{name:"Save source profile"})).toBeNull();
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
  await user.type(screen.getByLabelText("Expected file source 1"),"loan-system");
  await user.type(screen.getByLabelText("Expected source batch ID 1"),"customers-2026-09-22");
  await user.clear(screen.getByLabelText("Declared row count 1"));await user.type(screen.getByLabelText("Declared row count 1"),"2");
  await user.type(screen.getByLabelText("Declaration reason"),"The source owner confirmed the complete customer delivery list.");
  await user.type(screen.getByLabelText("Supporting source evidence"),"Source control report CONTROL-22.");
  await user.click(screen.getByRole("button",{name:"Save source declaration"}));
  await screen.findByRole("heading",{name:"Revise the expected source files"});
  expect(screen.getByText("Source file incomplete · customers-2026-09-22")).toBeTruthy();
  expect(screen.getByText(/0 of 1 expected files complete/)).toBeTruthy();
  const manifest=api.state().records.find(record=>record.kind==='source-manifests')!;
  expect(manifest.data.businessDate).toBe("2026-09-22");expect(manifest.data.files[0].expectedRows).toBe(2);
  expect(screen.getByRole("link",{name:"Import expected file"}).getAttribute("href")).toContain("expectation=");
});

it("parses declared naira totals exactly and blocks malformed amounts before submitting",async()=>{
  const user=userEvent.setup();renderApp("/sources?businessDate=2026-09-22");
  await user.click(await screen.findByRole("button",{name:"Add expected file"}));
  await user.type(screen.getByLabelText("Expected file source 1"),"settlement-feed");
  await user.type(screen.getByLabelText("Expected source batch ID 1"),"payments-22");
  await user.selectOptions(screen.getByLabelText("Expected record type 1"),"observations");
  await user.type(screen.getByLabelText("Declaration reason"),"The source control report confirms this expected settlement file.");
  await user.type(screen.getByLabelText("Supporting source evidence"),"Source control report CONTROL-22.");
  const amount=screen.getByLabelText("Declared total (₦) 1");await user.clear(amount);await user.type(amount,"12.345");await user.tab();
  expect(screen.getByRole("alert").textContent).toMatch(/no more than 2 decimal places/);
  await user.click(screen.getByRole("button",{name:"Save source declaration"}));
  expect(api.calls.filter(call=>call.method==='POST'&&call.path==='/v1/sources/manifests')).toHaveLength(0);
  await user.clear(amount);await user.type(amount,"12.50");
  await user.click(screen.getByRole("button",{name:"Save source declaration"}));
  await screen.findByRole("heading",{name:"Revise the expected source files"});
  expect(api.state().records.find(record=>record.kind==='source-manifests')!.data.files[0].expectedAmountKobo).toBe(1250);
  expect((screen.getByLabelText("Declared total (₦) 1") as HTMLInputElement).value).toBe("12.50");
});

it("reuses a saved source mapping and opens its committed batch from a direct link",async()=>{
  const user=userEvent.setup();renderApp("/sources");
  await user.type(await screen.findByLabelText("Profile name"),"Pilot loan feed");
  await user.type(screen.getByLabelText("Source name"),"synthetic-lms");
  await user.type(screen.getByLabelText("Expected source rows (optional)"),"1");
  await user.click(screen.getByRole("button",{name:"Save source profile"}));
  await screen.findByRole("button",{name:"Edit Pilot loan feed"});
  const profile=api.state().records.find(r=>r.kind==='source-profiles')!;
  cleanup();renderApp(`/imports?profile=${profile.id}`);
  await waitFor(()=>expect((screen.getByLabelText("Source name") as HTMLInputElement).value).toBe("synthetic-lms"));
  await user.type(screen.getByLabelText("Batch name"),"Mapped customer delivery");
  await user.type(screen.getByLabelText("Source batch ID"),"batch-001");
  await user.type(screen.getByLabelText("CSV content"),"source_row_id,name,reference,consentProvenance\nrow-1,Sample customer,MAP-C-001,Synthetic consent");
  await user.click(screen.getByRole("button",{name:"Save and check batch"}));
  await screen.findByRole("heading",{name:"Source quality checks"});
  await user.click(screen.getByRole("button",{name:"Commit checked batch"}));
  await screen.findByRole("heading",{name:"Import complete"});
  const batch=api.state().records.find(r=>r.kind==='import-batches')!;
  expect(batch.data.sourceQuality.profileId).toBe(profile.id);
  cleanup();renderApp(`/imports?batch=${batch.id}`);
  await screen.findByRole("heading",{name:"Import complete"});
  expect((screen.getByLabelText("Source batch ID") as HTMLInputElement).value).toBe("batch-001");
});

it("keeps incomplete delivery edits recoverable and converts valid WAT dates including native seconds",async()=>{
  const user=userEvent.setup();renderApp("/sources");
  await user.type(await screen.findByLabelText("Profile name"),"Editable delivery schedule");
  await user.type(screen.getByLabelText("Source name"),"delivery-date-test");
  let delivery=screen.getByLabelText("First delivery expected (WAT)") as HTMLInputElement;
  for (const value of ["", "2026-09-", "2026-02-30T07:30"]) {
    fireEvent.change(delivery,{target:{value}});fireEvent.blur(delivery);
    expect(screen.getByRole("alert").textContent).toMatch(/complete, valid delivery date and time.*UTC\+01:00/);
    expect(delivery.getAttribute("aria-invalid")).toBe("true");
    fireEvent.submit(delivery.closest("form")!);
    expect(api.calls.filter(call=>call.method==="POST"&&call.path.startsWith("/v1/sources/profiles"))).toHaveLength(0);
    expect(screen.getByRole("heading",{name:"Data sources"})).toBeTruthy();
  }
  fireEvent.change(delivery,{target:{value:"2026-09-24T07:30"}});
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(screen.getByRole("button",{name:"Save source profile"}));
  await user.click(await screen.findByRole("button",{name:"Edit Editable delivery schedule"}));
  let profile=api.state().records.find(record=>record.kind==="source-profiles")!;
  expect(profile.data.firstExpectedAt).toBe("2026-09-24T06:30:00.000Z");
  delivery=screen.getByLabelText("First delivery expected (WAT)") as HTMLInputElement;
  expect(delivery.value).toBe("2026-09-24T07:30");
  // Native datetime-local controls can include seconds and fractional seconds.
  // Appending ':00' to this value used to throw and unmount the Sources page.
  fireEvent.change(delivery,{target:{value:"2026-09-24T07:30:45.250"}});
  fireEvent.blur(delivery);
  await user.click(screen.getByRole("button",{name:"Save source profile"}));
  await waitFor(()=>expect(api.state().records.find(record=>record.id===profile.id)!.data.firstExpectedAt).toBe("2026-09-24T06:30:45.250Z"));
  await user.click(screen.getByRole("button",{name:"Edit Editable delivery schedule"}));
  await user.type(screen.getByLabelText("Profile name")," revised");
  await user.click(screen.getByRole("button",{name:"Save source profile"}));
  await screen.findByRole("button",{name:"Edit Editable delivery schedule revised"});
  profile=api.state().records.find(record=>record.id===profile.id)!;
  expect(profile.data.firstExpectedAt).toBe("2026-09-24T06:30:45.250Z");
});

it("labels offline Paystack fixtures and preserves conflicting receipts without recording payments",async()=>{
  const user=userEvent.setup();renderApp("/sources");
  await screen.findByText("External connection not verified");
  const count=api.state().records.filter(r=>r.kind==='payments').length;
  await user.click(screen.getByRole("button",{name:"Receive sample payment"}));
  await screen.findAllByText(/Synthetic fixture/);
  await user.click(screen.getByRole("button",{name:"Repeat delivery"}));
  await waitFor(()=>expect(api.state().records.filter(r=>r.kind==='provider-events')).toHaveLength(1));
  await user.click(screen.getByRole("button",{name:"Rehearse amount conflict"}));
  await screen.findByText(/Synthetic fixture.*Quarantined/i);
  expect(api.state().records.filter(r=>r.kind==='payments')).toHaveLength(count);
  expect(screen.getByText(/do not contact Paystack/)).toBeTruthy();
});

it("offers Recheck saved receipt only for receipts the service can replay, and counts replays apart from verification checks",async()=>{
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
  expect(within(card("Independently verified sample receipt.")).queryByRole("button",{name:"Recheck saved receipt"})).toBeNull();
  expect(card("Independently verified sample receipt.").textContent).toContain("0 replays");
  expect(card("Sample receipt awaiting verification.").textContent).toContain("0 replays");
  await user.type(within(card("Sample receipt awaiting verification.")).getByLabelText("Reason to recheck this receipt"),"Recheck the saved receipt");
  await user.click(within(card("Sample receipt awaiting verification.")).getByRole("button",{name:"Recheck saved receipt"}));
  await waitFor(()=>expect(api.state().records.find(record=>record.id===awaiting.id)!.data.replayHistory).toHaveLength(2));
  await waitFor(()=>expect(screen.getAllByText(/1 replay ·/)).toHaveLength(1));
});

it("shows missing feeds and omits change controls for a read-only user",async()=>{
  api.mutate((state,ctx)=>{state.records.push({id:'late-profile',merchantId:state.merchant.id,kind:'source-profiles',name:'Overdue feed',status:'active',reference:'',amountKobo:0,customerId:'',createdAt:ctx.now,updatedAt:ctx.now,data:{source:'late-source',kind:'customers',mapping:{},identityColumn:'source_row_id',amountUnit:'naira',firstExpectedAt:'2026-09-20T07:00:00.000Z',cadenceHours:24,graceMinutes:0}});});
  api.role='Read-only';renderApp("/sources");
  await screen.findByRole("heading",{name:"Overdue feed"});
  expect(screen.queryByRole("button",{name:"Save source profile"})).toBeNull();
  expect(screen.queryByRole("button",{name:"Receive sample payment"})).toBeNull();
  expect(screen.getByText("Late",{exact:true})).toBeTruthy();
});
