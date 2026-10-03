import React, { useEffect, useRef, useState } from 'react';
import { keyboardShortcuts, useFocusWhenLost } from '@/lib/focus';
import { themeChoices, useTheme } from '@/lib/theme';
import { Loading } from '@/components/loading';
import { DailyCloseStatus } from '@/components/daily-close-status';
import { useWorkspace } from '@/lib/workspace-context';
import { permissionReason } from '@/lib/permissions';
import { useGetSettings, getGetSettingsQueryKey } from '@workspace/valo-pay-1-api-client-react';
import { useSafeUpdateSettings as useUpdateSettings, useSafePerformAction as usePerformAction, submissionFingerprint, outcomeIsUnconfirmed } from '@/lib/safe-mutations';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import { useQueryClient } from '@tanstack/react-query';
import { Settings as SettingsIcon, Shield, PowerOff, AlertTriangle } from 'lucide-react';
import { authorisationModes, closeRules, executionWindow, isCloseTime } from '@workspace/valo-pay-1-schema';
import { FieldError, FormAlert, focusField, invalidProps } from '@/components/form-field';
import { formatDate, formatKobo } from '@/lib/formatters';
import { koboToNaira, nairaToKobo } from '@/lib/money-input';
import { notifyDone, notifyProblem, saidBy } from '@/lib/notify';
import { PermissionButton as Button } from '@/components/permission-button';
import { RecordDialog } from '@/components/record-dialog';
import { HandBackContext, handBackResult } from '@/components/hand-back-context';
import { LoadProblem, RefreshProblem } from '@/components/load-problem';
import { DiscardOriginalRequest, DISCARD_ORIGINAL_WARNING } from '@/components/discard-original-request';
import { KEPT_IN_OPERATIONS, OpenOperations } from '@/components/pilot-ui';

/** The writing standard's words for a request whose answer was lost (docs/design/writing.md, Notices). */
const NOT_CONFIRMED = 'We do not know yet whether Valo Pay 1 saved this. Check the original request before you change anything.';
/** Said when Valo Pay 1 refused a request without giving its own words. */
const NO_REASON = 'Valo Pay 1 gave no reason. Try again.';
/** A toast's words for a request that failed: the unconfirmed pattern when its answer was lost, otherwise `refused`. */
const problemWords = (error: unknown, refused: string): [string, string] => outcomeIsUnconfirmed(error) ? ['Request not confirmed', saidBy(error, NOT_CONFIRMED)] : [refused, saidBy(error, NO_REASON)];
/** Each way of approving instructions, in the same words in the form and on the page. */
const approvalWords = { batch: 'Daily approval: Finance or Admin approves each day’s instructions', standing: 'Standing approval: instructions follow the signed settings' } as const;
/** An hour of the collection window as the standard writes times: two digits, 24-hour, in WAT ("08:00 WAT"). */
const watHour = (hour: unknown) => `${String(hour).padStart(2, '0')}:00 WAT`;

export default function SettingsPage() {
  const { merchantId, workspace } = useWorkspace();
  const [role, setRole] = useState(workspace?.role || 'Admin');
  const [killReason, setKillReason] = useState('');
  const [isHandBackOpen, setIsHandBackOpen] = useState(false);
  const { choice: themeChoice, theme, setChoice: setThemeChoice } = useTheme();
  
  const [isEditingExec, setIsEditingExec] = useState(false);
  const [execSettings, setExecSettings] = useState<any>({});
  const [execBaseline, setExecBaseline] = useState('');
  const execRevision = useRef<string | undefined>(undefined);
  const visit = useRef({ merchantId, generation: 0 });
  if (visit.current.merchantId !== merchantId) visit.current = { merchantId, generation: visit.current.generation + 1 };
  const execSession = useRef(0);
  const queryClient = useQueryClient();
  const dirtyExec = isEditingExec && submissionFingerprint(execSettings) !== execBaseline;
  const { confirmDiscard: confirmExecDiscard } = useUnsavedChanges(dirtyExec);
  useUnsavedChanges(Boolean(killReason) || role !== (workspace?.role || 'Admin'));
  const captureVisit = () => { const submitted = visit.current; return () => visit.current === submitted; };
  
  const settingsQuery = useGetSettings(
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, refetchInterval: 60_000, queryKey: getGetSettingsQueryKey({ merchantId: merchantId! }) } }
  );
  const { data: settings, isLoading, error: settingsError, isFetching: fetchingSettings, refetch } = settingsQuery;

  const changedData = () => { void queryClient.invalidateQueries(); };
  const updateRole = usePerformAction({ mutation: { onSuccess: changedData } }, merchantId);
  const killSwitch = usePerformAction({ mutation: { onSuccess: changedData } }, merchantId);
  const requestInstruction = usePerformAction(undefined, merchantId);
  // A pilot lifts the emergency stop only with a second administrator (approve_kill_switch_off); the sandbox's one person lifts it at once.
  const approveStop = usePerformAction({ mutation: { onSuccess: changedData } }, merchantId);
  useUnsavedChanges(approveStop.isPending || approveStop.hasUnconfirmedOutcome);
  useEffect(() => { approveStop.reset(); }, [merchantId]);
  // One stop request at a time: while one runs, or its answer was lost, nothing that could reverse it is sent, only its retry.
  const stopPending = killSwitch.isPending || approveStop.isPending;
  // What the last stop request did, in the service's words, on the page. Approve turning it off and Keep the stop on take
  // their box away when they succeed, so focus then goes to this rather than to the page body; a lost answer's notice,
  // with its retry, takes it the same way.
  const [stopResult, setStopResult] = useState('');
  const stopResultMessage = useRef<HTMLParagraphElement>(null), stopNotice = useRef<HTMLDivElement>(null), approvalNotice = useRef<HTMLDivElement>(null);
  // The controls that send the stop and the approval: a discarded request's notice gives the focus back to the one that sent it.
  const stopButton = useRef<HTMLButtonElement>(null), keepButton = useRef<HTMLButtonElement>(null), approveButton = useRef<HTMLButtonElement>(null);
  useFocusWhenLost(stopResultMessage, stopResult);
  useFocusWhenLost(stopNotice, killSwitch.hasUnconfirmedOutcome);
  useFocusWhenLost(approvalNotice, approveStop.hasUnconfirmedOutcome);
  const updateExecSettings = useUpdateSettings({ mutation: { onSuccess: changedData } }, `${merchantId}:${isEditingExec}`);
  const otherOutcomeUnconfirmed = killSwitch.hasUnconfirmedOutcome || requestInstruction.hasUnconfirmedOutcome || updateExecSettings.hasUnconfirmedOutcome;
  const otherActionPending = killSwitch.isPending || requestInstruction.isPending || updateExecSettings.isPending;
  useUnsavedChanges(updateRole.isPending || updateRole.hasUnconfirmedOutcome || otherActionPending || otherOutcomeUnconfirmed);

  const changeRole = async () => {
    if (!merchantId || updateRole.isPending || otherActionPending || otherOutcomeUnconfirmed || (!updateRole.hasUnconfirmedOutcome && !confirmExecDiscard())) return;
    const isCurrent = captureVisit();
    try {
      await (updateRole.hasUnconfirmedOutcome ? updateRole.retryUnconfirmed() : updateRole.mutateAsync({ data: { action: 'set_role', data: { role } }, params: { merchantId } }));
      if (isCurrent()) { setIsEditingExec(false); setKillReason(''); notifyDone('Demo role changed', 'Permissions now follow your new demo role.'); }
    } catch (error) { if (isCurrent()) notifyProblem(...problemWords(error, 'Demo role not changed')); }
  };
  const changeStop = async (enabled = !settings?.merchant.killSwitch) => {
    if (!merchantId || !settings || stopPending || approveStop.hasUnconfirmedOutcome) return;
    const blocked = permissionReason(workspace, { action: 'kill_switch' });
    if (blocked) { notifyProblem('Emergency stop not changed', blocked); return; }
    const isCurrent = captureVisit();
    setStopResult('');
    try {
      const data = await (killSwitch.hasUnconfirmedOutcome ? killSwitch.retryUnconfirmed() : killSwitch.mutateAsync({ data: { action: 'kill_switch', reason: killReason, data: { enabled } }, params: { merchantId } }));
      if (isCurrent()) { setKillReason(''); setStopResult(data.message); }
    } catch (error) { if (isCurrent()) notifyProblem(...problemWords(error, 'Emergency stop not changed')); }
  };
  const approveRelease = async () => {
    if (!merchantId || stopPending || killSwitch.hasUnconfirmedOutcome) return;
    const blocked = permissionReason(workspace, { action: 'approve_kill_switch_off' });
    if (blocked) { notifyProblem('Emergency stop not changed', blocked); return; }
    const isCurrent = captureVisit();
    setStopResult('');
    try {
      const data = await (approveStop.hasUnconfirmedOutcome ? approveStop.retryUnconfirmed() : approveStop.mutateAsync({ data: { action: 'approve_kill_switch_off', reason: killReason, data: {} }, params: { merchantId } }));
      if (isCurrent()) { setKillReason(''); setStopResult(data.message); }
    } catch (error) { if (isCurrent()) notifyProblem(...problemWords(error, 'Emergency stop not turned off')); }
  };
  const testInstruction = async () => {
    if (!merchantId || requestInstruction.isPending) return;
    const isCurrent = captureVisit();
    try {
      const data = await (requestInstruction.hasUnconfirmedOutcome ? requestInstruction.retryUnconfirmed() : requestInstruction.mutateAsync({ data: { action: 'request_instruction' }, params: { merchantId } }));
      if (isCurrent()) notifyDone('Block test sent', data.message);
    } catch (error) { if (isCurrent()) notifyProblem(...problemWords(error, 'Live instruction blocked')); }
  };

  // Edit, Cancel and Save each remove themselves, so focus goes into the form on Edit and back to Edit when
  // editing ends by Cancel, a save or a refresh, rather than falling to the page body.
  const editButton = useRef<HTMLButtonElement>(null);
  const focusAfterEdit = useRef<'form' | 'edit' | null>(null);
  useEffect(() => {
    const target = focusAfterEdit.current;
    focusAfterEdit.current = null;
    if (target === 'form') focusField('settings-authorisationMode');
    else if (target === 'edit') editButton.current?.focus();
  }, [isEditingExec]);
  const [execErrors, setExecErrors] = useState<Record<string, string>>({});
  const [execAlert, setExecAlert] = useState('');
  const [execConflict, setExecConflict] = useState(false);
  const [refreshingLatest, setRefreshingLatest] = useState(false);
  const pendingErrorFocus = useRef<string | null>(null);
  useEffect(() => { if (!updateExecSettings.isPending && pendingErrorFocus.current) { focusField(`settings-${pendingErrorFocus.current}`); pendingErrorFocus.current = null; } }, [updateExecSettings.isPending, execErrors]);
  useEffect(() => { execSession.current += 1; setIsEditingExec(false); setExecErrors({}); setExecAlert(''); setExecConflict(false); setRefreshingLatest(false); setKillReason(''); setStopResult(''); setRole(workspace?.role || 'Admin'); setIsHandBackOpen(false); updateRole.reset(); killSwitch.reset(); requestInstruction.reset(); updateExecSettings.reset(); }, [merchantId]);
  useEffect(() => () => { visit.current = { merchantId: null, generation: visit.current.generation + 1 }; }, []);
  useEffect(() => { if (workspace?.role) setRole(workspace.role); }, [workspace?.role]);
  const execKeys = ['closeTime', 'unallocatedAlertThreshold', 'notificationCostAlertKobo'] as const;
  /** The server's rule messages begin with the key they concern, so the message goes under that field. */
  const rejectExec = (err: any) => {
    if (outcomeIsUnconfirmed(err)) { setExecConflict(false); setExecErrors({}); setExecAlert('We do not know yet whether Valo Pay 1 saved your settings. Keep this draft as it is, and check the original request before you change anything.'); return; }
    setExecConflict(err?.status === 409);
    const message = String(err?.data?.error || err?.message || 'The change was not saved.');
    const key = execKeys.find(candidate => message.startsWith(candidate));
    const fieldMessages = {
      closeTime: 'Enter the close time as HH:MM in West Africa Time, for example 07:00.',
      unallocatedAlertThreshold: 'Enter a whole number, 0 or more.',
      notificationCostAlertKobo: 'Enter an amount in naira with no more than 2 decimal places.',
    };
    setExecErrors(key ? { [key]: fieldMessages[key] } : {});
    setExecAlert(key ? 'The settings were not saved. Check the field marked below.' : saidBy(err, 'The settings were not saved. Check your connection and try again.'));
    if (key) pendingErrorFocus.current = key;
  };
  const saveExec = async () => {
    if (!merchantId || updateExecSettings.isPending || refreshingLatest) return;
    const blocked = permissionReason(workspace, { action: 'update_settings' });
    if (blocked) { setExecAlert(blocked); return; }
    const errors: Record<string, string> = {};
    if (execSettings.closeTime !== undefined && !isCloseTime(execSettings.closeTime)) errors.closeTime = 'Enter the close time as HH:MM in West Africa Time, for example 07:00.';
    for (const key of ['unallocatedAlertThreshold'] as const) {
      const value = execSettings[key];
      if (value !== undefined && (!Number.isInteger(Number(value)) || Number(value) < 0)) errors[key] = 'Enter a whole number, 0 or more.';
    }
    let notificationCostAlertKobo: number | undefined;
    try { notificationCostAlertKobo = nairaToKobo(String(execSettings.notificationCostAlertKobo ?? '8.00')); }
    catch (error) { errors.notificationCostAlertKobo = (error as Error).message; }
    setExecErrors(errors); setExecAlert('');
    const first = execKeys.find(key => errors[key]);
    if (first) { focusField(`settings-${first}`); return; }
    const isCurrentVisit = captureVisit();
    const submittedSession = execSession.current;
    const isCurrent = () => isCurrentVisit() && submittedSession === execSession.current;
    try {
      await (updateExecSettings.hasUnconfirmedOutcome ? updateExecSettings.retryUnconfirmed() : updateExecSettings.mutateAsync({ data: { ...execSettings, notificationCostAlertKobo, expectedRevision: execRevision.current }, params: { merchantId } }));
      if (isCurrent()) { focusAfterEdit.current = 'edit'; setIsEditingExec(false); notifyDone('Settings saved', 'Recorded in the audit log. Automatic closes follow these settings while the close service is running.'); }
    } catch (error) { if (isCurrent()) rejectExec(error); }
  };
  const cancelExec = () => { if (updateExecSettings.isPending || updateExecSettings.hasUnconfirmedOutcome) return; if (confirmExecDiscard()) { execSession.current += 1; focusAfterEdit.current = 'edit'; setIsEditingExec(false); setExecErrors({}); setExecAlert(''); setExecConflict(false); } };
  const refreshLatest = async () => {
    if (updateExecSettings.isPending || refreshingLatest) return;
    // Refreshing discards the draft; while the original save is unconfirmed it also discards that request, after its own warning.
    if (updateExecSettings.hasUnconfirmedOutcome) {
      if (!window.confirm(DISCARD_ORIGINAL_WARNING)) return;
      updateExecSettings.abandonUnconfirmed();
    } else if (!confirmExecDiscard()) return;
    const isCurrentVisit = captureVisit();
    const submittedSession = execSession.current;
    setRefreshingLatest(true);
    try {
      const response = await refetch({ throwOnError: true });
      if (isCurrentVisit() && submittedSession === execSession.current && response.data) { execSession.current += 1; focusAfterEdit.current = 'edit'; setIsEditingExec(false); setExecErrors({}); setExecAlert(''); setExecConflict(false); }
    } catch (error) { if (isCurrentVisit() && submittedSession === execSession.current) setExecAlert('We could not load the latest settings. Your draft is still here. Try refreshing again.'); }
    finally { if (isCurrentVisit()) setRefreshingLatest(false); }
  };
  const startEditExec = () => {
    execSession.current += 1;
    updateExecSettings.reset();
    const initial = { ...settings?.settings, notificationCostAlertKobo: koboToNaira(Number(settings?.settings?.notificationCostAlertKobo ?? 800)) };
    setExecSettings(initial); setExecBaseline(submissionFingerprint(initial));
    execRevision.current = (settings as typeof settings & { revision?: string })?.revision;
    setExecErrors({}); setExecAlert(''); setExecConflict(false);
    focusAfterEdit.current = 'form';
    setIsEditingExec(true);
  };

  if (!merchantId) return null;
  const staffPilot = workspace?.accessMode === 'staff';
  const release = (settings?.settings as { emergencyStopReleases?: { lender?: { requestedBy: string; requestedAt: string; reason: string } } } | undefined)?.emergencyStopReleases?.lender;

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1">Manage this lender’s settings.{workspace?.accessMode !== 'staff' && ' In the sandbox, you can also switch demo roles to test access.'}</p>
      </header>

      <section className="bg-card border rounded-xl p-6" aria-labelledby="paystack-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="paystack-heading" className="font-semibold text-lg">Paystack test connection</h2>
          <span className="rounded-full border px-3 py-1 text-xs font-medium">Not connected</span>
        </div>
        <p className="text-sm text-muted-foreground mt-3">Valo Pay 1 is ready to test with Paystack. Testing needs a Paystack test key and a successful connection check.</p>
        <p className="text-sm text-muted-foreground mt-2">This sandbox uses sample records. No Paystack payments or mandates are created here. Direct-debit support must also be confirmed for your Paystack account.</p>
      </section>

      {/* Staff roles are assigned through Team and access, never this demo switch. */}
      {workspace?.accessMode !== 'staff' && <section className="bg-card border rounded-xl shadow-sm p-6">
        <div className="flex items-center gap-2 mb-4">
          <Shield className="h-5 w-5 text-primary" />
          <h2 className="font-semibold text-lg">Demo role</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Switch demo roles to test permissions and approvals. This changes only your sandbox role; it does not grant real access. Live instructions are always blocked here.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
          <label htmlFor="persona" className="sr-only">Demo role</label>
          <select 
            id="persona"
            className="w-full sm:min-w-48 sm:max-w-xs sm:flex-1 bg-background border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            value={role}
            disabled={updateRole.isPending || updateRole.hasUnconfirmedOutcome || otherActionPending || otherOutcomeUnconfirmed}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="Admin">Admin</option>
            <option value="Operations">Operations</option>
            <option value="Finance">Finance</option>
            <option value="Compliance reviewer">Compliance reviewer</option>
            <option value="Read-only">Read-only</option>
          </select>
          <Button 
            onClick={() => { void changeRole(); }}
            disabled={(!updateRole.hasUnconfirmedOutcome && role === workspace?.role) || otherActionPending || otherOutcomeUnconfirmed}
            busy={updateRole.isPending}
            busyLabel={updateRole.hasUnconfirmedOutcome ? 'Checking original request…' : 'Switching role…'}
          >
            {updateRole.hasUnconfirmedOutcome ? 'Check original request' : 'Switch role'}
          </Button>
          
          <Button
            variant="outline"
            className="sm:ml-auto"
            onClick={() => { void testInstruction(); }}
            busy={requestInstruction.isPending}
            busyLabel={requestInstruction.hasUnconfirmedOutcome ? 'Checking original request…' : 'Testing…'}
          >
            {requestInstruction.hasUnconfirmedOutcome ? 'Check original request' : 'Test live-instruction block'}
          </Button>
        </div>
        {updateRole.hasUnconfirmedOutcome && <div role="alert" className="text-sm mt-3"><p>We do not know yet whether Valo Pay 1 changed your role. Check the original request before you choose another role.</p><DiscardOriginalRequest disabled={updateRole.isPending} onDiscard={updateRole.abandonUnconfirmed} /></div>}
        {requestInstruction.hasUnconfirmedOutcome && <div role="alert" className="text-sm mt-3"><p>We do not know yet whether Valo Pay 1 received the block test. Check the original request before you change anything. Live instructions stay blocked either way. {KEPT_IN_OPERATIONS}</p><div className="flex flex-wrap items-center gap-3"><OpenOperations /><DiscardOriginalRequest disabled={requestInstruction.isPending} onDiscard={requestInstruction.abandonUnconfirmed} /></div></div>}
        {otherOutcomeUnconfirmed && <p className="text-sm text-muted-foreground mt-3">Check the unconfirmed request on this page before you change roles.</p>}
      </section>}

      {/* Collection settings: a failed refresh keeps them, and any draft, on the page with a notice. */}
      <RefreshProblem what="the collection settings" shown="settings" query={settingsQuery} />
      {isLoading ? (
        <Loading what="settings" className="bg-card border rounded-xl" />
      ) : !settings ? (
        <LoadProblem what="collection settings" error={settingsError} retry={() => { void refetch(); }} busy={fetchingSettings} />
      ) : settings ? (
        <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <SettingsIcon className="h-5 w-5 text-primary" />
              <h2 className="font-semibold text-lg">Collection settings</h2>
            </div>
            {!isEditingExec ? (
              <Button ref={editButton} size="sm" variant="outline" action="update_settings" onClick={startEditExec}>Edit</Button>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={cancelExec} disabled={updateExecSettings.isPending || updateExecSettings.hasUnconfirmedOutcome}>Cancel</Button>
                <Button size="sm" action="update_settings" onClick={saveExec} disabled={refreshingLatest} busy={updateExecSettings.isPending} busyLabel={updateExecSettings.hasUnconfirmedOutcome ? 'Checking original request…' : 'Saving changes…'}>{updateExecSettings.hasUnconfirmedOutcome ? 'Check original request' : 'Save changes'}</Button>
              </div>
            )}
          </div>
          {execAlert && <div className="px-6 pt-6"><FormAlert title={updateExecSettings.hasUnconfirmedOutcome ? 'Request not confirmed' : 'Settings not saved'}>{execAlert}{updateExecSettings.hasUnconfirmedOutcome && <><p className="mt-2">{KEPT_IN_OPERATIONS}</p><div className="mt-2 flex flex-wrap items-center gap-3"><OpenOperations /><DiscardOriginalRequest disabled={updateExecSettings.isPending || refreshingLatest} onDiscard={() => { updateExecSettings.abandonUnconfirmed(); setExecAlert(''); setExecConflict(false); }} /></div></>}{execConflict && <><p className="mt-2">Your draft is still here. Refresh to review the latest settings before editing again.</p><Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { void refreshLatest(); }} busy={refreshingLatest} busyLabel="Refreshing…">Discard draft and refresh</Button></>}</FormAlert></div>}
          <div className="p-6 space-y-6">
            <fieldset disabled={updateExecSettings.isPending || updateExecSettings.hasUnconfirmedOutcome || refreshingLatest} className="grid grid-cols-1 md:grid-cols-2 print:grid-cols-2 gap-6">
              <div>
                <label htmlFor="settings-authorisationMode" className="text-sm font-medium block mb-1">Instruction approval</label>
                {isEditingExec ? (
                  <select 
                    id="settings-authorisationMode"
                    className="w-full bg-background border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    value={execSettings.authorisationMode || authorisationModes[0]}
                    onChange={(e) => setExecSettings({...execSettings, authorisationMode: e.target.value})}
                  >
                    {authorisationModes.map(mode => <option key={mode} value={mode}>{approvalWords[mode === 'standing' ? 'standing' : 'batch']}</option>)}
                  </select>
                ) : (
                  <div className="font-mono text-sm p-2 bg-secondary/50 rounded border">
                    {approvalWords[settings.settings?.authorisationMode === 'standing' ? 'standing' : 'batch']}
                  </div>
                )}
              </div>
              <div>
                <label className="text-sm font-medium block mb-1">New consent for policy changes</label>
                {isEditingExec ? (
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={execSettings.policyChangeRequiresConsent === true} onChange={(e) => setExecSettings({...execSettings, policyChangeRequiresConsent: e.target.checked})} /> The lender's terms require new consent before a changed policy applies to a customer</label>
                ) : (
                  <div className="font-mono text-sm p-2 bg-secondary/50 rounded border">{settings.settings?.policyChangeRequiresConsent === true ? 'Required: notice and new consent' : 'Not required: notice still needed'}</div>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="settings-unallocatedAlertThreshold" className="text-sm font-medium block mb-1">Alert threshold: unmatched payments over 24 hours old</label>
                  {isEditingExec ? (
                    <><input id="settings-unallocatedAlertThreshold" {...invalidProps('settings-unallocatedAlertThreshold', execErrors.unallocatedAlertThreshold)} type="number" min={0} className="w-full bg-background border rounded-md px-3 py-2 text-sm" value={execSettings.unallocatedAlertThreshold ?? 10} onChange={(e) => setExecSettings({...execSettings, unallocatedAlertThreshold: Number(e.target.value)})} />
                    <FieldError id="settings-unallocatedAlertThreshold" message={execErrors.unallocatedAlertThreshold} /></>
                  ) : (
                    <div className="font-mono text-sm p-2 bg-secondary/50 rounded border">{String(settings.settings?.unallocatedAlertThreshold ?? 10)}</div>
                  )}
                </div>
                <div>
                  <label htmlFor="settings-notificationCostAlertKobo" className="text-sm font-medium block mb-1">Notification cost alert (₦ per collection)</label>
                  {isEditingExec ? (
                    <><input id="settings-notificationCostAlertKobo" {...invalidProps('settings-notificationCostAlertKobo', execErrors.notificationCostAlertKobo)} type="text" inputMode="decimal" className="w-full bg-background border rounded-md px-3 py-2 text-sm" value={execSettings.notificationCostAlertKobo ?? '8.00'} onChange={(e) => setExecSettings({...execSettings, notificationCostAlertKobo: e.target.value})} />
                    <FieldError id="settings-notificationCostAlertKobo" message={execErrors.notificationCostAlertKobo} /></>
                  ) : (
                    <div className="font-mono text-sm p-2 bg-secondary/50 rounded border">{formatKobo(Number(settings.settings?.notificationCostAlertKobo ?? 800))}</div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="settings-closeTime" className="text-sm font-medium block mb-1">Daily close time (WAT)</label>
                  {isEditingExec ? (
                    <><input id="settings-closeTime" aria-describedby="settings-closeTime-help" {...invalidProps('settings-closeTime', execErrors.closeTime)} type="text" inputMode="numeric" placeholder={closeRules.defaultTime} className="w-full bg-background border rounded-md px-3 py-2 text-sm font-mono" value={execSettings.closeTime ?? closeRules.defaultTime} onChange={(e) => setExecSettings({...execSettings, closeTime: e.target.value})} />
                    <p id="settings-closeTime-help" className="mt-1 text-xs text-muted-foreground">24-hour time, for example 07:00.</p>
                    <FieldError id="settings-closeTime" message={execErrors.closeTime} /></>
                  ) : (
                    <div className="font-mono text-sm p-2 bg-secondary/50 rounded border">{String(settings.settings?.closeTime ?? closeRules.defaultTime)} WAT</div>
                  )}
                </div>
                <div>
                  <label className="text-sm font-medium block mb-1">Automatic daily close</label>
                  {isEditingExec ? (
                    <div className="space-y-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={execSettings.scheduledCloseEnabled !== false} onChange={(e) => setExecSettings({...execSettings, scheduledCloseEnabled: e.target.checked})} /> Request an automatic close at this time every day.</label><p className="text-xs text-muted-foreground">When this is on, Valo Pay 1 runs the daily close at this time each day. Saving this does not run a close now. A missed close runs as soon as Valo Pay 1 can.</p><DailyCloseStatus value={settings.closeSchedule} /></div>
                  ) : (
                    <div className="p-3 bg-secondary/50 rounded border"><DailyCloseStatus value={settings.closeSchedule} showHistory /></div>
                  )}
                </div>
              </div>
              <div>
                <label htmlFor="settings-contactRoute" className="text-sm font-medium block mb-1">Lender contact details for customer notices</label>
                {isEditingExec ? (
                  <input 
                    id="settings-contactRoute"
                    type="text"
                    className="w-full bg-background border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    value={execSettings.contactRoute || ''}
                    onChange={(e) => setExecSettings({...execSettings, contactRoute: e.target.value})}
                  />
                ) : (
                  <div className="font-mono text-sm p-2 bg-secondary/50 rounded border">
                    {String(settings.settings?.contactRoute || 'Not set')}
                  </div>
                )}
              </div>
              <div>
                <label htmlFor="settings-executionWindowStart" className="text-sm font-medium block mb-1">Collection window starts (WAT)</label>
                {isEditingExec ? (<>
                  <input 
                    id="settings-executionWindowStart"
                    type="number"
                    min={executionWindow.earliestHour}
                    max={executionWindow.latestHour - 1}
                    className="w-full bg-background border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    value={execSettings.executionStart ?? executionWindow.defaultStartHour}
                    aria-describedby="settings-executionWindowStart-help"
                    onChange={(e) => setExecSettings({...execSettings, executionStart: Number(e.target.value)})}
                  />
                  <p id="settings-executionWindowStart-help" className="mt-1 text-xs text-muted-foreground">Enter a whole hour from {executionWindow.earliestHour} to {executionWindow.latestHour - 1}, for example 8 for {watHour(8)}. The window must end by {watHour(executionWindow.latestHour)}.</p>
                </>) : (
                  <div className="font-mono text-sm p-2 bg-secondary/50 rounded border">
                    {watHour(settings.settings?.executionStart ?? executionWindow.defaultStartHour)}
                  </div>
                )}
              </div>
              <div>
                <label htmlFor="settings-executionWindowEnd" className="text-sm font-medium block mb-1">Collection window ends (WAT)</label>
                {isEditingExec ? (<>
                  <input 
                    id="settings-executionWindowEnd"
                    type="number"
                    min={executionWindow.earliestHour + 1}
                    max={executionWindow.latestHour}
                    className="w-full bg-background border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    value={execSettings.executionEnd ?? executionWindow.defaultEndHour}
                    aria-describedby="settings-executionWindowEnd-help"
                    onChange={(e) => setExecSettings({...execSettings, executionEnd: Number(e.target.value)})}
                  />
                  <p id="settings-executionWindowEnd-help" className="mt-1 text-xs text-muted-foreground">Enter a whole hour from {executionWindow.earliestHour + 1} to {executionWindow.latestHour}, for example 18 for {watHour(18)}.</p>
                </>) : (
                  <div className="font-mono text-sm p-2 bg-secondary/50 rounded border">
                    {watHour(settings.settings?.executionEnd ?? executionWindow.defaultEndHour)}
                  </div>
                )}
              </div>
            </fieldset>
            
            <div className="pt-4 border-t">
              <h3 className="font-medium mb-4 text-destructive flex items-center gap-2">
                <PowerOff className="h-4 w-4" /> Emergency controls
              </h3>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
                <div className="min-w-0 flex-1">
                  <label htmlFor="kill-reason" className="text-sm font-medium block mb-1">Reason for changing the emergency stop</label>
                  <input 
                    id="kill-reason"
                    type="text" 
                    placeholder="Explain why you are turning the stop on or off"
                    aria-describedby="kill-reason-help"
                    value={killReason}
                    disabled={stopPending || killSwitch.hasUnconfirmedOutcome || approveStop.hasUnconfirmedOutcome}
                    onChange={(e) => setKillReason(e.target.value)}
                    className="w-full bg-background border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <p id="kill-reason-help" className="mt-1 text-xs text-muted-foreground">Enter a reason. The change and your reason will be recorded in the audit log.</p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                {/* While a request to lift the stop waits, its box offers the answers to it; a stop request whose answer was lost is retried here all the same. */}
                {(!release || killSwitch.hasUnconfirmedOutcome) && <Button 
                  ref={stopButton}
                  variant="destructive"
                  action="kill_switch" onClick={() => { void changeStop(); }}
                  disabled={(!killReason && !killSwitch.hasUnconfirmedOutcome) || approveStop.isPending || approveStop.hasUnconfirmedOutcome}
                  busy={killSwitch.isPending}
                  busyLabel={killSwitch.hasUnconfirmedOutcome ? 'Checking original request…' : settings.merchant.killSwitch ? (staffPilot ? 'Asking…' : 'Turning off…') : 'Turning on…'}
                >
                  {killSwitch.hasUnconfirmedOutcome ? 'Check original request' : settings.merchant.killSwitch ? (staffPilot ? 'Ask to turn off emergency stop' : 'Turn off emergency stop') : 'Turn on emergency stop'}
                </Button>}
                
                <Button 
                  variant="outline"
                   action="hand_back" onClick={() => setIsHandBackOpen(true)}
                >
                  Return collection
                </Button>
                </div>
              </div>
              {killSwitch.hasUnconfirmedOutcome && <div ref={stopNotice} role="alert" className="text-sm mt-3"><p>We do not know yet whether Valo Pay 1 changed the emergency stop. Check the original request before you change anything. Until then, do not switch the stop the other way. {KEPT_IN_OPERATIONS}</p><div className="flex flex-wrap items-center gap-3"><OpenOperations /><DiscardOriginalRequest disabled={killSwitch.isPending} onDiscard={killSwitch.abandonUnconfirmed} next={() => keepButton.current ?? stopButton.current} /></div></div>}
              {settings.merchant.killSwitch && (
                <p className="text-xs text-destructive mt-2 flex items-center gap-1 font-bold">
                  <AlertTriangle className="h-3 w-3" /> Emergency stop is on. No instructions can be sent to a provider or bank.
                </p>
              )}
              {release ? (
                <div role="status" className="mt-3 space-y-2 rounded-lg border p-3 text-sm">
                  <p>{release.requestedBy} asked to turn the emergency stop off on {formatDate(release.requestedAt)}: “{release.reason}”. The stop stays on until another Admin approves, giving a reason in the box above.</p>
                  <div className="flex flex-wrap gap-2">
                    {release.requestedBy === workspace?.actor ? <p className="self-center text-xs text-muted-foreground">You asked for this, so another Admin must approve it.</p> : (
                      <Button ref={approveButton} variant="destructive" size="sm" action="approve_kill_switch_off" onClick={() => { void approveRelease(); }} disabled={!killReason || approveStop.hasUnconfirmedOutcome || killSwitch.isPending || killSwitch.hasUnconfirmedOutcome} busy={approveStop.isPending} busyLabel="Approving…">Approve turning it off</Button>
                    )}
                    <Button ref={keepButton} variant="outline" size="sm" action="kill_switch" onClick={() => { void changeStop(true); }} disabled={!killReason || killSwitch.hasUnconfirmedOutcome || approveStop.isPending || approveStop.hasUnconfirmedOutcome} busy={killSwitch.isPending} busyLabel="Keeping it on…">Keep the stop on</Button>
                  </div>
                </div>
              ) : settings.merchant.killSwitch && (
                <p className="mt-2 text-xs text-muted-foreground">{staffPilot ? 'Turning the stop off needs two Admins. Your request waits until another Admin approves it.' : 'In a pilot, turning the stop off needs a second Admin’s approval. In this sandbox one person plays every role, so it takes effect at once.'}</p>
              )}
              {/* Outside the box: a refetch that shows the request settled, as a lost approval may have settled it, takes the box away. */}
              {approveStop.hasUnconfirmedOutcome && <div ref={approvalNotice} role="alert" className="mt-3 space-y-2 text-sm"><p>We do not know yet whether Valo Pay 1 turned the stop off. Check the original request before you change anything. {KEPT_IN_OPERATIONS}</p><div className="flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" action="approve_kill_switch_off" onClick={() => { void approveRelease(); }} busy={approveStop.isPending} busyLabel="Checking original request…">Check original request</Button><OpenOperations /><DiscardOriginalRequest disabled={approveStop.isPending} onDiscard={approveStop.abandonUnconfirmed} next={() => approveButton.current ?? stopButton.current} /></div></div>}
              {stopResult && <p ref={stopResultMessage} role="status" className="mt-3 text-sm">{stopResult}</p>}
            </div>
          </div>
        </section>
      ) : null}
      <RecordDialog
        kind="cutovers"
        isOpen={isHandBackOpen}
        onOpenChange={setIsHandBackOpen}
        title="Return collection to the previous owner?"
        actionMutation="hand_back"
        fields={[]}
        context={<HandBackContext merchantId={merchantId} />}
        onDone={response => {
          // The service switched the emergency stop on: show it at once, before the refetch the write started returns.
          queryClient.setQueryData<typeof settings>(getGetSettingsQueryKey({ merchantId }), current => current && { ...current, merchant: { ...current.merchant, killSwitch: true } });
          setStopResult('');
          notifyDone('Collection returned', handBackResult(response));
        }}
      />

      {/* Appearance: light or dark for this browser. It follows the device unless chosen here, and it is not a
          workspace setting, so it needs no account and no request (Nielsen 3: control; 7: personalisation). */}
      <section className="bg-card border rounded-xl shadow-sm p-6 print:hidden" aria-labelledby="appearance-title">
        <h2 id="appearance-title" className="font-semibold text-lg">Appearance</h2>
        <p className="text-sm text-muted-foreground mt-1">Choose a theme for this browser. Other people and devices keep their own choice.</p>
        <fieldset className="mt-4">
          <legend className="text-sm font-medium">Theme</legend>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:gap-6">
            {themeChoices.map(option => (
              <label key={option.value} className="inline-flex items-center gap-2 text-sm">
                <input type="radio" name="theme" value={option.value} checked={themeChoice === option.value} onChange={() => setThemeChoice(option.value)} className="h-4 w-4 accent-primary" />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          {themeChoice === 'system' ? `Following your device (currently ${theme === 'dark' ? 'Dark' : 'Light'}).` : `${theme === 'dark' ? 'Dark' : 'Light'} until you change it here.`}
        </p>
      </section>

      {/* Keyboard: listed so the shortcuts can be found rather than guessed (Nielsen 7: accelerators; 10: help focused on the task). */}
      <section className="bg-card border rounded-xl shadow-sm overflow-hidden print:hidden" aria-labelledby="keyboard-title">
        <div className="p-4 border-b bg-secondary/20">
          <h2 id="keyboard-title" className="font-semibold text-lg">Keyboard</h2>
          <p className="text-sm text-muted-foreground mt-1">Use these shortcuts to move around Valo Pay 1 without a mouse.</p>
        </div>
        <dl className="divide-y">
          {keyboardShortcuts.map(shortcut => (
            <div key={shortcut.keys} className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-4 px-6 py-3 text-sm">
              <dt><kbd className="rounded border bg-secondary px-1.5 py-0.5 font-mono text-xs">{shortcut.keys}</kbd></dt>
              <dd className="text-muted-foreground">{shortcut.does}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

