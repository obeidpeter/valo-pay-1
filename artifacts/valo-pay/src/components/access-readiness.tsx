import { useState } from 'react';
import { usePilotQuery, useTypedPilotMutation } from '@/lib/pilot';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import { accessReadinessSchema, messageSchema } from '@workspace/valopay-schema';
import { PilotPanel, PilotError, RecoveryNotice } from './pilot-ui';
import { Button } from './ui/button';
export function AccessReadiness(){
  const query=usePilotQuery('/team/readiness',accessReadinessSchema,false),[message,setMessage]=useState('');
  const mutation=useTypedPilotMutation(messageSchema,result=>setMessage(result.message));
  // Operations does not record these checks: while one is unanswered, leaving or reloading would lose the only check.
  useUnsavedChanges(mutation.isPending||mutation.hasUnconfirmedOutcome);
  return <PilotPanel title="Staff pilot setup"><p className="text-sm text-muted-foreground">These checks describe this host. Local rehearsals do not establish that a live identity service, database role or managed key is configured.</p><PilotError error={query.error} retry={()=>void query.refetch()}/>
    <dl className="divide-y">{query.data?.checks.map((check)=><div className="grid gap-2 py-3 sm:grid-cols-[1fr_2fr]" key={check.id}><dt className="text-sm font-semibold">{check.name}<span className="block text-xs font-normal text-muted-foreground">{check.state==='verified_this_request'?'Verified for this request':check.state==='configured_not_verified'?'Configured · verification needed':check.state==='configured'?'Configured':'Setup needed'}</span></dt><dd className="text-sm text-muted-foreground">{check.detail}</dd></div>)}</dl>
    {query.data?.canCommission && <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={mutation.isPending||mutation.hasUnconfirmedOutcome||!query.data.checks.some((c)=>c.id==='encryption'&&c.state==='configured_not_verified')} onClick={()=>mutation.mutate({path:'/team/readiness/encryption',lender:false})}>Verify encryption access</Button><Button variant="outline" disabled={mutation.isPending||mutation.hasUnconfirmedOutcome||!query.data.checks.some((c)=>c.id==='encryption'&&c.state==='configured_not_verified')} onClick={()=>mutation.mutate({path:'/team/readiness/protect',lender:false})}>Protect existing payloads</Button></div>}
    <RecoveryNotice mutation={mutation} persistent={false}/>{message&&<p role="status" className="text-sm">{message}</p>}
  </PilotPanel>;
}
