import { useState } from 'react';
import { render, cleanup, renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSafePerformAction, useSafeImportRecords, useSafeCreateRecord, useSafeUpdateRecord, useSafeUpdateSettings, useSafeCreateExport, useSafeRetryExportJob, definitiveRefusal, outcomeIsUnconfirmed, requestClosed, savedAnswerWithheld } from '@/lib/safe-mutations';
import { installFakeApi, type FakeApi } from './fake-api';
import { screen, userEvent, waitFor } from './harness';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => { cleanup(); api.uninstall(); });

function Action({ action, recordId, merchantId }: { action: string; recordId: string; merchantId: string }) {
  const [reason, setReason] = useState('Synthetic retry check');
  const [session, setSession] = useState(0);
  const mutation = useSafePerformAction(undefined, session);
  return <><input aria-label="Reason" value={reason} onChange={e => setReason(e.target.value)} />
    <button onClick={() => mutation.mutate({ params: { merchantId }, data: { action, recordId, reason, data: { consentEvidence: 'fresh sample consent' } } })}>Submit</button>
    <button onClick={() => { setSession(s => s + 1); mutation.reset(); }}>New form</button>
    {mutation.hasUnconfirmedOutcome && <button onClick={() => { void mutation.retryUnconfirmed().catch(() => {}); }}>Retry original request</button>}
    {mutation.isError && <p role="alert">Response was lost; retry this submission.</p>}
    {mutation.isSuccess && <p role="status">Completed</p>}</>;
}

describe('safe mutation intentions', () => {
  it.each(['mandate_reissue', 'new_policy_version'])('replays an unchanged %s after a committed response is lost, then gives a new intention a new key', async action => {
    const user = userEvent.setup();
    const record = api.state().records.find(r => action === 'mandate_reissue' ? r.kind === 'mandates' : r.kind === 'policies')!;
    api.mutate(state => { state.records.find(r => r.id === record.id)!.status = action === 'mandate_reissue' ? 'cancelled' : 'approved'; });
    const originalFetch = globalThis.fetch;
    const committed = new Map<string, Response>();
    const keys: string[] = [];
    let loseResponse = true;
    globalThis.fetch = async (input, options) => {
      const key = new Headers(options?.headers).get('Idempotency-Key')!;
      keys.push(key);
      if (committed.has(key)) return committed.get(key)!.clone();
      const response = await originalFetch(input, options);
      if (response.ok) committed.set(key, response.clone());
      if (response.ok && loseResponse) { loseResponse = false; throw new TypeError('Connection dropped after commit'); }
      return response;
    };
    const initial = api.state().records.filter(r => r.kind === record.kind).length;
    render(<QueryClientProvider client={new QueryClient()}><Action action={action} recordId={record.id} merchantId={api.merchantIds[0]!} /></QueryClientProvider>);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByRole('alert');
    expect(api.state().records.filter(r => r.kind === record.kind)).toHaveLength(initial + 1);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByRole('status');
    expect(keys[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(api.state().records.filter(r => r.kind === record.kind)).toHaveLength(initial + 1);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('allows a corrected request after a structured rejection or a new form session', async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    globalThis.fetch = async (_input, options) => { keys.push(new Headers(options?.headers).get('Idempotency-Key')!); return new Response(JSON.stringify({error:'Reason is required'}),{status:400,headers:{'content-type':'application/json'}}); };
    render(<QueryClientProvider client={new QueryClient()}><Action action="new_policy_version" recordId="sample-policy" merchantId={api.merchantIds[0]!} /></QueryClientProvider>);
    await user.click(screen.getByRole('button', { name: 'Submit' })); await screen.findByRole('alert');
    await user.type(screen.getByLabelText('Reason'), ' changed');
    await user.click(screen.getByRole('button', { name: 'Submit' })); await screen.findByRole('alert');
    expect(keys[1]).not.toBe(keys[0]);
    await user.click(screen.getByRole('button', { name: 'New form' }));
    await user.click(screen.getByRole('button', { name: 'Submit' })); await screen.findByRole('alert');
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('blocks changed input after an uncertain write and retries the exact original payload and key', async () => {
    const user = userEvent.setup();
    const requests: Array<{key:string; body:string}> = [];
    globalThis.fetch = async (_input, options) => {
      requests.push({key:new Headers(options?.headers).get('Idempotency-Key')!,body:String(options?.body)});
      if (requests.length === 1) throw new TypeError('Connection lost after commit');
      return new Response(JSON.stringify({message:'Replayed saved result',data:{}}),{status:200,headers:{'content-type':'application/json'}});
    };
    render(<QueryClientProvider client={new QueryClient()}><Action action="new_policy_version" recordId="sample-policy" merchantId={api.merchantIds[0]!} /></QueryClientProvider>);
    await user.click(screen.getByRole('button',{name:'Submit'}));
    await screen.findByRole('button',{name:'Retry original request'});
    await user.type(screen.getByLabelText('Reason'),' changed');
    await user.click(screen.getByRole('button',{name:'Submit'}));
    expect(requests).toHaveLength(1);
    await user.click(screen.getByRole('button',{name:'Retry original request'}));
    await screen.findByRole('status');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(screen.queryByRole('button',{name:'Retry original request'})).toBeNull();
  });

  it('does not lock a failed check-only import, but does lock a failed commit', async () => {
    globalThis.fetch = async () => { throw new TypeError('Offline'); };
    const wrapper = ({children}:{children:React.ReactNode}) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
    const {result} = renderHook(()=>useSafeImportRecords(),{wrapper});
    const variables = {params:{merchantId:api.merchantIds[0]!},data:{kind:'customers',csv:'reference,name\nSAMPLE-1,Sample',identityColumn:'reference',syntheticOnly:true,commit:false}};
    await act(async()=>{await result.current.mutateAsync(variables).catch(()=>{});});
    await waitFor(()=>expect(result.current.isError).toBe(true));
    expect(result.current.hasUnconfirmedOutcome).toBe(false);
    await act(async()=>{await result.current.mutateAsync({...variables,data:{...variables.data,commit:true}}).catch(()=>{});});
    await waitFor(()=>expect(result.current.hasUnconfirmedOutcome).toBe(true));
  });

  it('treats malformed successes, timeouts and server failures as uncertain',()=>{
    for(const error of [new TypeError('Offline'),{status:200},{status:408,data:{error:'Timeout'}},{status:503,data:{error:'Unavailable'}}]) expect(outcomeIsUnconfirmed(error)).toBe(true);
    for(const status of [400,401,403,409,422,429]) expect(outcomeIsUnconfirmed({status,data:{error:'Rejected'}})).toBe(false);
    expect(outcomeIsUnconfirmed({status:403})).toBe(true);
    // The server rolled the request back and says so: a 5xx with committed:false is a confirmed outcome.
    for(const status of [500,503]) expect(outcomeIsUnconfirmed({status,data:{error:'Nothing was saved',committed:false}})).toBe(false);
    expect(outcomeIsUnconfirmed({status:503,data:{error:'Unavailable',committed:true}})).toBe(true);
  });

  it.each([401,403,409])('keeps the original outcome unknown when its recovery is refused with %s',async status=>{
    const requests:string[]=[];
    globalThis.fetch=async(_input,options)=>{
      requests.push(new Headers(options?.headers).get('Idempotency-Key')!);
      if(requests.length===1) throw new TypeError('Committed response lost');
      return new Response(JSON.stringify({error:'Access changed before replay'}),{status,headers:{'content-type':'application/json'}});
    };
    const client=new QueryClient();
    const wrapper=({children}:{children:React.ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const {result}=renderHook(()=>useSafePerformAction(),{wrapper});
    const variables={params:{merchantId:api.merchantIds[0]!},data:{action:'new_policy_version',recordId:'sample-policy',reason:'Sample review'}};
    await act(async()=>{await result.current.mutateAsync(variables).catch(()=>{});});
    await waitFor(()=>expect(result.current.hasUnconfirmedOutcome).toBe(true));
    await act(async()=>{await result.current.retryUnconfirmed().catch(()=>{});});
    await waitFor(()=>expect(result.current.isError).toBe(true));
    expect(result.current.hasUnconfirmedOutcome).toBe(true);
    expect(requests[1]).toBe(requests[0]);
    await act(async()=>{await result.current.mutateAsync({...variables,data:{...variables.data,reason:'Changed'}}).catch(()=>{});});
    expect(requests).toHaveLength(2);
  });

  it.each(['action','create','update','settings','import','export','retry export'])('retains the original %s request until a complete receipt arrives',async operation=>{
    const merchantId=api.merchantIds[0]!;
    const record=api.state().records.find(item=>item.kind==='customers')!;
    const settings=await (await fetch(`/api/v1/settings?merchantId=${merchantId}`)).json();
    const descriptors: Record<string,{hook:Function;variables:unknown;receipt:unknown}>={
      action:{hook:useSafePerformAction,variables:{params:{merchantId},data:{action:'set_role',data:{role:'Admin'}}},receipt:{message:'Role updated',data:{}}},
      create:{hook:useSafeCreateRecord,variables:{kind:'customers',params:{merchantId},data:{name:'Sample customer'}},receipt:record},
      update:{hook:useSafeUpdateRecord,variables:{kind:'customers',id:record.id,params:{merchantId},data:{name:'Sample customer'}},receipt:record},
      settings:{hook:useSafeUpdateSettings,variables:{params:{merchantId},data:{defaultOwner:'Finance'}},receipt:settings},
      import:{hook:useSafeImportRecords,variables:{params:{merchantId},data:{kind:'customers',csv:'reference,name\nSAMPLE-1,Sample',syntheticOnly:true,commit:true}},receipt:{valid:1,invalid:0,imported:1,rows:[{row:2,status:'imported',message:'Imported'}]}},
      export:{hook:useSafeCreateExport,variables:{params:{merchantId},data:{kind:'billing',format:'csv'}},receipt:{id:'sample-export',downloadUrl:'/api/v1/exports/sample-export/download',status:'queued'}},
      'retry export':{hook:useSafeRetryExportJob,variables:{params:{merchantId},id:'sample-export'},receipt:{id:'sample-export',downloadUrl:'/api/v1/exports/sample-export/download',status:'queued'}},
    };
    const {hook,variables,receipt}=descriptors[operation]!;
    const requests:Array<{key:string|null;body:string}>=[];
    let successes=0;
    globalThis.fetch=async(_input,options)=>{
      requests.push({key:new Headers(options?.headers).get('Idempotency-Key'),body:String(options?.body)});
      return new Response(JSON.stringify(requests.length===1?{}:receipt),{status:200,headers:{'content-type':'application/json'}});
    };
    const client=new QueryClient();
    const wrapper=({children}:{children:React.ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const {result}=renderHook(()=>hook({mutation:{onSuccess:()=>{successes+=1;}}}),{wrapper});
    await act(async()=>{await result.current.mutateAsync(variables).catch(()=>{});});
    await waitFor(()=>expect(result.current.hasUnconfirmedOutcome).toBe(true));
    expect(successes).toBe(0);
    await act(async()=>{await result.current.retryUnconfirmed();});
    await waitFor(()=>expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasUnconfirmedOutcome).toBe(false);
    expect(requests[1]).toEqual(requests[0]);
    expect(successes).toBe(1);
  });

  it('releases the controls and uses a new key after a server failure that saved nothing', async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    globalThis.fetch = async (_input, options) => {
      keys.push(new Headers(options?.headers).get('Idempotency-Key')!);
      return keys.length === 1
        ? new Response(JSON.stringify({ error: 'Private export storage is not configured. Contact the workspace administrator.', committed: false, requestId: 'r1' }), { status: 503, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ message: 'Saved', data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    render(<QueryClientProvider client={new QueryClient()}><Action action="new_policy_version" recordId="sample-policy" merchantId={api.merchantIds[0]!} /></QueryClientProvider>);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Retry original request' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByRole('status');
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  const jsonAnswer=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  const hookFor=()=>{const client=new QueryClient();const wrapper=({children}:{children:React.ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;return renderHook(()=>useSafePerformAction(),{wrapper});};
  const actionVariables=(reason='Sample review')=>({params:{merchantId:api.merchantIds[0]!},data:{action:'new_policy_version',recordId:'sample-policy',reason}});

  it('releases an unconfirmed request when the service says its journal entry is cancelled',async()=>{
    const keys:string[]=[];
    globalThis.fetch=async(_input,options)=>{
      keys.push(new Headers(options?.headers).get('Idempotency-Key')!);
      if(keys.length===1) throw new TypeError('Failed to fetch');
      if(keys.length===2) return jsonAnswer(409,{error:'The workspace changed. Refresh and review before trying again.',operation:'cancelled',requestId:'r2'});
      return jsonAnswer(200,{message:'Saved',data:{}});
    };
    const {result}=hookFor();
    await act(async()=>{await result.current.mutateAsync(actionVariables()).catch(()=>{});});
    await waitFor(()=>expect(result.current.hasUnconfirmedOutcome).toBe(true));
    await act(async()=>{await result.current.retryUnconfirmed().catch(()=>{});});
    await waitFor(()=>expect(result.current.isError).toBe(true));
    expect(result.current.hasUnconfirmedOutcome).toBe(false);
    expect(keys[1]).toBe(keys[0]);
    await act(async()=>{await result.current.mutateAsync(actionVariables('Changed after review'));});
    expect(keys).toHaveLength(3);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it.each([403,404,409])('gives an identical resubmission a new key after a definitive %s refusal',async status=>{
    const keys:string[]=[];
    globalThis.fetch=async(_input,options)=>{keys.push(new Headers(options?.headers).get('Idempotency-Key')!);return jsonAnswer(status,{error:'Refused',requestId:'r'});};
    const {result}=hookFor();
    for(let attempt=0;attempt<2;attempt+=1) await act(async()=>{await result.current.mutateAsync(actionVariables()).catch(()=>{});});
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect(result.current.hasUnconfirmedOutcome).toBe(false);
  });

  it('keeps the key when a refusal says a request with it was saved',async()=>{
    const keys:string[]=[];
    globalThis.fetch=async(_input,options)=>{keys.push(new Headers(options?.headers).get('Idempotency-Key')!);return jsonAnswer(409,{error:'Refused by the current rules',operation:'completed',requestId:'r'});};
    const {result}=hookFor();
    for(let attempt=0;attempt<2;attempt+=1) await act(async()=>{await result.current.mutateAsync(actionVariables()).catch(()=>{});});
    expect(keys[1]).toBe(keys[0]);
  });

  it('holds a request the service says is still running, and retries it with the same key',async()=>{
    const keys:string[]=[];
    globalThis.fetch=async(_input,options)=>{
      keys.push(new Headers(options?.headers).get('Idempotency-Key')!);
      return keys.length===1?jsonAnswer(503,{error:'This request is still running. Wait a moment, then check the original request to see its result.',operation:'running',requestId:'r1'}):jsonAnswer(200,{message:'Saved',data:{}});
    };
    const {result}=hookFor();
    await act(async()=>{await result.current.mutateAsync(actionVariables()).catch(()=>{});});
    await waitFor(()=>expect(result.current.hasUnconfirmedOutcome).toBe(true));
    await act(async()=>{await result.current.retryUnconfirmed();});
    await waitFor(()=>expect(result.current.isSuccess).toBe(true));
    expect(keys[1]).toBe(keys[0]);
    expect(result.current.hasUnconfirmedOutcome).toBe(false);
  });

  it.each([401,429])('keeps the key after a %s, which the service does not treat as final',async status=>{
    const keys:string[]=[];
    globalThis.fetch=async(_input,options)=>{keys.push(new Headers(options?.headers).get('Idempotency-Key')!);return jsonAnswer(status,{error:'Wait',requestId:'r'});};
    const {result}=hookFor();
    for(let attempt=0;attempt<2;attempt+=1) await act(async()=>{await result.current.mutateAsync(actionVariables()).catch(()=>{});});
    expect(keys[1]).toBe(keys[0]);
  });

  it('discards an unconfirmed request on request',async()=>{
    const keys:string[]=[];
    globalThis.fetch=async(_input,options)=>{
      keys.push(new Headers(options?.headers).get('Idempotency-Key')!);
      if(keys.length===1) throw new TypeError('Failed to fetch');
      return jsonAnswer(200,{message:'Saved',data:{}});
    };
    const {result}=hookFor();
    await act(async()=>{await result.current.mutateAsync(actionVariables()).catch(()=>{});});
    await waitFor(()=>expect(result.current.hasUnconfirmedOutcome).toBe(true));
    act(()=>{result.current.abandonUnconfirmed();});
    await waitFor(()=>expect(result.current.hasUnconfirmedOutcome).toBe(false));
    expect(result.current.isError).toBe(false);
    await act(async()=>{await result.current.mutateAsync(actionVariables('A new request after discarding'));});
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('marks only a structured refusal carrying the cancelled marker as closed',()=>{
    expect(requestClosed({status:409,data:{error:'Changed',operation:'cancelled'}})).toBe(true);
    expect(requestClosed({status:503,data:{error:'Busy',committed:false,operation:'cancelled'}})).toBe(true);
    expect(requestClosed({status:409,data:{error:'Changed'}})).toBe(false);
    expect(requestClosed({status:200,data:{error:'x',operation:'cancelled'}})).toBe(false);
    expect(requestClosed({status:409,data:{operation:'cancelled'}})).toBe(false);
    expect(outcomeIsUnconfirmed({status:503,data:{error:'Busy',operation:'cancelled'}})).toBe(false);
  });

  it('treats a money refusal as final for its key',()=>{
    for(const data of [{error:'This calculation cannot be completed.',code:'MONEY_OUT_OF_RANGE',operation:'cancelled'},{error:'This calculation cannot be completed.',code:'INVALID_MONEY_RATE'}])
      expect(definitiveRefusal({status:422,data})).toBe(true);
    expect(outcomeIsUnconfirmed({status:422,data:{error:'This calculation cannot be completed.'}})).toBe(false);
  });

  it('marks only a refusal of a request saved earlier, whose answer is withheld, as the end of it',()=>{
    for(const status of [403,409,410]) expect(savedAnswerWithheld({status,data:{error:'This request already completed.',operation:'completed'}})).toBe(true);
    // A failure may still give the saved answer on a retry; any other state is not a completed request.
    expect(savedAnswerWithheld({status:500,data:{error:'This request was saved.',operation:'completed'}})).toBe(false);
    expect(savedAnswerWithheld({status:409,data:{error:'Changed',operation:'pending'}})).toBe(false);
    expect(savedAnswerWithheld({status:403,data:{operation:'completed'}})).toBe(false);
  });

  it.each(['null','empty','invalid JSON'])('does not treat a %s successful body as a confirmed action',async body=>{
    globalThis.fetch=async()=>body==='empty'?new Response(null,{status:204}):new Response(body==='null'?'null':'{',{status:200,headers:{'content-type':'application/json'}});
    const client=new QueryClient();
    const wrapper=({children}:{children:React.ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const {result}=renderHook(()=>useSafePerformAction(),{wrapper});
    await act(async()=>{await result.current.mutateAsync({params:{merchantId:api.merchantIds[0]!},data:{action:'set_role',data:{role:'Admin'}}}).catch(()=>{});});
    await waitFor(()=>expect(result.current.hasUnconfirmedOutcome).toBe(true));
    expect(result.current.isSuccess).toBe(false);
  });
});
