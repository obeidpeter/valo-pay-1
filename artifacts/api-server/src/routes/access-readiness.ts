import { Router } from 'express';
import { inWorkspace, verifyWorkspaceEncryption, protectWorkspacePayloads, runtimeIsolationVerified, type StoreContext } from '../lib/valo-pay-1-store';
import { payloadEncryptionKey } from '../lib/protected-payloads';
import { accessReadinessSchema, encryptionVerificationSchema, payloadProtectionSchema } from '@workspace/valo-pay-1-schema';
import { contractAnswer } from '../lib/contract';
import { staffMode, staffPolicy } from '../lib/staff-access';
import { routerOptions } from './router-options';
const router=Router(routerOptions);
/** The readiness checks for one workspace transaction. The database check is this transaction's own:
 * a set that differs from the reviewed one refuses the request before this runs, and a transaction that
 * recorded no check reports none, whatever the configuration says. */
export async function readinessChecks(ctx:StoreContext){
  const staff=staffMode(),policy=staffPolicy(),isolated=runtimeIsolationVerified(ctx);let encryptionConfigured=false;
  try{encryptionConfigured=!!payloadEncryptionKey();}catch{/* report incomplete configuration without secrets */}
  return {syntheticOnly:true,canCommission:ctx.role==='Admin',checkedAt:ctx.now,checks:[
    {id:'identity',name:'Team member sign-in',state:staff?'verified_this_request':'not_configured',detail:staff?'Checked for this request: your sign-in, your organisation and your membership.':'Not set up. The Valo Pay 1 team sets up sign-in and the first Admin for a pilot.'},
    {id:'mfa',name:'Two-step verification',state:ctx.accessMode==='staff'?'verified_this_request':'not_configured',detail:ctx.accessMode==='staff'?'Checked for this request. A change needs two-step verification within the last 10 minutes.':'Demo roles do not check a team member or two-step verification.'},
    {id:'origin',name:'Allowed web addresses',state:staff&&policy.authorisedParties.length?'configured':'not_configured',detail:'Team members can make changes only from the address set up for the pilot.'},
    {id:'database',name:'Restricted database access',state:isolated?'verified_this_request':'not_configured',detail:isolated?'Checked for this request: restricted database access, with the reviewed rules that keep each workspace’s records apart.':'Not set up. The Valo Pay 1 team sets up restricted database access for a pilot.'},
    {id:'encryption',name:'Data encryption',state:encryptionConfigured?'configured_not_verified':'not_configured',detail:encryptionConfigured?'An encryption key is set up. Check that it works, then encrypt saved import files and requests.':'Not set up. The Valo Pay 1 team sets up an encryption key. No key is stored on this page.'},
  ]};
}
router.get('/v1/team/readiness',async(req,res)=>res.json(await inWorkspace(req,res,async ctx=>contractAnswer(accessReadinessSchema,await readinessChecks(ctx)),'read')));
router.post('/v1/team/readiness/encryption',async(req,res)=>res.json(await inWorkspace(req,res,async ctx=>contractAnswer(encryptionVerificationSchema,await verifyWorkspaceEncryption(ctx)),'team')));
router.post('/v1/team/readiness/protect',async(req,res)=>res.json(await inWorkspace(req,res,async ctx=>contractAnswer(payloadProtectionSchema,await protectWorkspacePayloads(ctx)),'team')));
export default router;
