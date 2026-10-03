import { useState } from 'react';
import { usePilotQuery, useTypedPilotMutation } from '@/lib/pilot';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import { accessReadinessSchema, messageSchema } from '@workspace/valo-pay-1-schema';
import { PilotError, RecoveryNotice } from './pilot-ui';
import { Button } from './ui/button';
/** Each server check's state in words. */
const stateWords: Record<string, string> = { verified_this_request: 'Checked on this request', configured_not_verified: 'Set up · check needed', configured: 'Set up' };
/** The server's setup for named staff accounts: it is for the people who run Valo Pay 1, so Team and access shows it to Admins, closed. */
export function AccessReadiness(){
  const query=usePilotQuery('/team/readiness',accessReadinessSchema,false),[message,setMessage]=useState('');
  const mutation=useTypedPilotMutation(messageSchema,result=>setMessage(result.message));
  // Request history does not record these checks: while one is unanswered, leaving or reloading would lose the only check.
  useUnsavedChanges(mutation.isPending||mutation.hasUnconfirmedOutcome);
  return <details className="rounded-xl border bg-card p-5 sm:p-6"><summary className="cursor-pointer"><h2 className="inline text-lg font-semibold">Technical setup</h2></summary><div className="mt-4 space-y-4"><p className="text-sm text-muted-foreground">These checks are about this server only. A practice run here does not prove that live sign-in, database access or encryption keys are set up.</p><PilotError error={query.error} what="the set-up checks" retry={()=>void query.refetch()}/>
    <dl className="divide-y">{query.data?.checks.map((check)=><div className="grid gap-2 py-3 sm:grid-cols-[1fr_2fr]" key={check.id}><dt className="text-sm font-semibold">{check.name}<span className="block text-xs font-normal text-muted-foreground">{stateWords[check.state] ?? 'Not set up'}</span></dt><dd className="text-sm text-muted-foreground">{check.detail}</dd></div>)}</dl>
    {query.data?.canCommission && <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={mutation.isPending||mutation.hasUnconfirmedOutcome||!query.data.checks.some((c)=>c.id==='encryption'&&c.state==='configured_not_verified')} onClick={()=>mutation.mutate({path:'/team/readiness/encryption',lender:false})}>Check the encryption key</Button><Button variant="outline" disabled={mutation.isPending||mutation.hasUnconfirmedOutcome||!query.data.checks.some((c)=>c.id==='encryption'&&c.state==='configured_not_verified')} onClick={()=>mutation.mutate({path:'/team/readiness/protect',lender:false})}>Encrypt saved data</Button></div>}
    <RecoveryNotice mutation={mutation} persistent={false}/>{message&&<p role="status" className="text-sm">{message}</p>}
  </div></details>;
}
