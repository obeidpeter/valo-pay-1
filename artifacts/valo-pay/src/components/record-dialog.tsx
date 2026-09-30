import React, { useState, useEffect, useRef, ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from './ui/button';
import { FieldError, FormAlert, FormErrorLinks, attentionTitle, focusField, formErrorMessage, invalidProps, isStaleRecordError, missingMessage, serverFieldErrors } from './form-field';
import { useSafeCreateRecord as useCreateRecord, useSafeUpdateRecord as useUpdateRecord, useSafePerformAction as usePerformAction, submissionFingerprint } from '@/lib/safe-mutations';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import { useDialogFocusReturn } from '@/lib/focus';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@/lib/workspace-context';
import { readableLabel } from './record-label';
import { formatDate } from '@/lib/formatters';
import { majorToMinor, minorToMajor, moneyFieldLabel } from '@/lib/money-input';
import { currencyMinorUnit } from '@workspace/valopay-schema';
import { permissionReason } from '@/lib/permissions';
import { referenceOf } from '@/lib/notify';
import { KEPT_IN_OPERATIONS, OpenOperations } from './pilot-ui';
import { Link } from 'wouter';
import { fromImportBatch } from '@workspace/valopay-schema';

const actionLabels: Record<string, string> = {
  mandate_suspend: 'Suspend mandate', mandate_cancel: 'Cancel mandate', mandate_reinstate: 'Resume mandate',
  mandate_reissue: 'Reissue mandate', activation_reminder: 'Record activation reminder',
  notify_policy_change: 'Record policy change notice', apply_policy_version: 'Apply policy version',
  submit_policy: 'Submit for review', approve_policy: 'Approve policy', reject_policy: 'Reject policy',
  new_policy_version: 'Draft next version', submit_template: 'Submit for review', approve_template: 'Approve template',
  reject_template: 'Reject template', new_template_version: 'Draft next version',
  confirm_allocation: 'Confirm match', reject_allocation: 'Reject match', manual_allocate: 'Allocate payment',
  review_allocation: 'Save review', resolve_exception: 'Resolve exception', record_refund: 'Record external refund', release_dispute: 'Release from dispute',
  simulate_failure: 'Simulate failure', backtest_policy: 'Test policy',
  preregister_experiment: 'Register experiment plan', hand_back: 'Return collection', issue_invoice: 'Issue invoice', confirm_discount_terms: 'Confirm discount dates',
};

type FieldDef = {
  name: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'textarea' | 'checkbox' | 'date';
  options?: { label: string; value: string }[];
  isData?: boolean; // if true, placed in record.data
  required?: boolean;
  help?: string;
};

type RecordDialogProps = {
  kind: string;
  record?: any; // If provided, edit mode. Otherwise, create mode.
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  fields: FieldDef[];
  title: string;
  defaultValues?: any;
  actionMutation?: string; // If provided, calls performAction with this action name instead of create/update
  actionRecordId?: string; // An action can target a related record while the dialog keeps the review context.
  context?: ReactNode | ((values: Record<string, any>) => ReactNode);
  validate?: (values: Record<string, any>) => Record<string, string>;
  /** The service's answer to a confirmed write, given before the dialog closes so the page can announce the result. */
  onDone?: (response: any) => void;
  /** Where the page shows that answer: focus goes there when the dialog closes and the control that opened it has gone. */
  answer?: () => HTMLElement | null | undefined;
  /**
   * The data field holding the ISO 4217 code the money fields are in, such as a settlement batch's currency: they are
   * entered and shown in that currency's major unit with its decimals. Taken from the form when it is one of the
   * fields, else from the record; naira without it.
   */
  currencyField?: string;
};

export function RecordDialog({ kind, record, isOpen, onOpenChange, fields: sourceFields, title, defaultValues = {}, actionMutation, actionRecordId, context, validate, onDone, answer, currencyField }: RecordDialogProps) {
  const isMoney = (field: FieldDef) => field.type === 'number' && /Kobo$/.test(field.name);
  const [formData, setFormData] = useState<any>({});
  // The currency the money fields are in: the form's currency field, else the record's, else naira.
  const currencyIn = (values: Record<string, any>) => String((currencyField && (sourceFields.some(f => f.name === currencyField) ? values[currencyField] : record?.data?.[currencyField])) || 'NGN').trim().toUpperCase();
  const moneyCurrency = currencyIn(formData);
  const fields = sourceFields.map(field => isMoney(field) ? { ...field, label: moneyFieldLabel(field.label, currencyMinorUnit(moneyCurrency) === undefined ? 'NGN' : moneyCurrency) } : field);
  const { merchantId, workspace } = useWorkspace();
  // A batch-imported record changes only through a reviewed correction; a quick import's stays editable (fromImportBatch).
  const importedEdit = !actionMutation && fromImportBatch(record) ? record!.data.importIdentity as { batchId: string } : undefined;
  const blockedReason = permissionReason(workspace, { action: actionMutation, kind, record }) || (importedEdit ? 'You cannot edit an imported record here. To change a supported field, make a reviewed correction in Import batches. For anything else, use the button for that task.' : undefined);
  const queryClient = useQueryClient();
  const [result,setResult]=useState<any>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [conflict, setConflict] = useState(false);
  const [refreshingLatest, setRefreshingLatest] = useState(false);
  const session = useRef(0);
  const request = useRef(0);
  const currentScope = useRef('');
  const originalRecord = useRef(record);
  const pendingErrorFocus = useRef<string | null>(null);
  const restoreOpenerFocus = useDialogFocusReturn(isOpen, answer);
  const dialogTitle = useRef<HTMLHeadingElement | null>(null);
  const [initialForm, setInitialForm] = useState('');
  const scope = JSON.stringify([merchantId, kind, record?.id, actionMutation, actionRecordId, isOpen]);
  currentScope.current = scope;
  const { confirmDiscard } = useUnsavedChanges(isOpen && initialForm !== '' && submissionFingerprint(formData) !== initialForm);
  const changeOpen = (open: boolean) => {
    if (!open && isPending) return;
    if (!open && hasUnconfirmedOutcome) {
      if (window.confirm('We do not know yet whether Valo Pay saved this. Closing does not cancel the request, and you cannot check it from this form again. If Valo Pay received it, you can check it in Request history. Close anyway?')) onOpenChange(false);
      return;
    }
    if (open || confirmDiscard()) onOpenChange(open);
  };
  const fieldId = (name: string) => `record-${name}`;
  const fieldProps = (field: FieldDef) => {
    const props = invalidProps(fieldId(field.name), fieldErrors[field.name]);
    return { ...props, 'aria-describedby': [props['aria-describedby'], field.help ? `${fieldId(field.name)}-help` : undefined].filter(Boolean).join(' ') || undefined };
  };
  /** The server names a field by its path in the body; a data field arrives as data.<name>. */
  const resolveField = (path: string): string | null => {
    const name = path.replace(/^data\./, '');
    return fields.some(f => f.name === name) || (actionMutation && name === 'reason') ? name : null;
  };
  const firstNamed = (errors: Record<string, string>) => fields.find(f => errors[f.name])?.name ?? (errors.reason ? 'reason' : undefined);
  const applyServerError = (error: unknown) => {
    setConflict(isStaleRecordError(error));
    const { fields: named, general } = serverFieldErrors(error, resolveField);
    setFieldErrors(named); setFormErrors(general.map(message => formErrorMessage(message, fields)));
    const first = firstNamed(named);
    if (first) pendingErrorFocus.current = first;
  };
  
  useEffect(() => {
    session.current += 1;
    if (isOpen) {
      originalRecord.current = record;
      setResult(null); setFieldErrors({}); setFormErrors([]); setConflict(false); setRefreshingLatest(false);
      create.reset();update.reset();perform.reset();
      const initial: any = record ? { name: record.name, status: record.status, reference: record.reference, amountKobo: record.amountKobo, customerId: record.customerId, ...defaultValues } : { ...defaultValues };
      if (record) {
        fields.forEach(f => {
          // A field the record does not carry keeps its default instead of becoming undefined.
          if (f.isData && record.data && record.data[f.name] !== undefined) {
            initial[f.name] = record.data[f.name];
          }
        });
      }
      const stored = String(record?.data?.[currencyField ?? ''] || 'NGN'), storedCurrency = currencyMinorUnit(stored) === undefined ? 'NGN' : stored;
      fields.forEach(field => {
        if (isMoney(field) && initial[field.name] !== undefined && initial[field.name] !== '') initial[field.name] = minorToMajor(Number(initial[field.name]), currencyField ? storedCurrency : 'NGN');
      });
      setFormData(initial);
      setInitialForm(submissionFingerprint(initial));
    }
    // Closing, changing records/lenders, or unmounting ends this form session.
    return () => { session.current += 1; };
  // Initialise once per opening/record. Inline field arrays must not reset typing.
  }, [isOpen, merchantId, record?.id, kind, actionMutation, actionRecordId]);

  // A completed write still refreshes data even when its original form is gone.
  // Form feedback below is scoped separately, so it cannot affect a newer dialog.
  const invalidateChangedData = () => { void queryClient.invalidateQueries(); };
  const create = useCreateRecord({ mutation: { onSuccess: invalidateChangedData } }, scope);
  const update = useUpdateRecord({ mutation: { onSuccess: invalidateChangedData } }, scope);
  const perform = usePerformAction({ mutation: { onSuccess: invalidateChangedData } }, scope);

  const isPending = create.isPending || update.isPending || perform.isPending || refreshingLatest;
  const hasUnconfirmedOutcome = create.hasUnconfirmedOutcome || update.hasUnconfirmedOutcome || perform.hasUnconfirmedOutcome;
  const supportReference = referenceOf(perform.error || update.error || create.error);
  const retryUnconfirmed = async () => {
    const submittedSession = session.current;
    try {
      const response = actionMutation ? await perform.retryUnconfirmed() : record ? await update.retryUnconfirmed() : await create.retryUnconfirmed();
      if (submittedSession !== session.current || currentScope.current !== scope) return;
      if (actionMutation === 'backtest_policy') { setResult(response); setFormErrors([]); return; }
      onDone?.(response);
      onOpenChange(false);
    } catch (error) {
      if (submittedSession === session.current && currentScope.current === scope) applyServerError(error);
    }
  };
  useEffect(() => {
    if (!isPending && pendingErrorFocus.current) { focusField(fieldId(pendingErrorFocus.current)); pendingErrorFocus.current = null; }
  }, [isPending, fieldErrors]);

  const refreshLatest = async () => {
    if (!confirmDiscard() || refreshingLatest) return;
    const submittedSession = session.current;
    setRefreshingLatest(true);
    try {
      await queryClient.invalidateQueries(undefined, { throwOnError: true });
      if (submittedSession === session.current && currentScope.current === scope) onOpenChange(false);
    } catch (error) {
      if (submittedSession === session.current && currentScope.current === scope) setFormErrors(['We could not load the latest records. Your draft is still here. Try refreshing again.']);
    } finally {
      if (submittedSession === session.current && currentScope.current === scope) setRefreshingLatest(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!merchantId || isPending || hasUnconfirmedOutcome) return;
    if (blockedReason) { setFormErrors([blockedReason]); return; }
    // Every field is checked here first, so a missing value is named at the field and never costs a request.
    const errors: Record<string, string> = {};
    fields.forEach(f => {
      const value = formData[f.name];
      const empty = value === undefined || value === null || String(value).trim() === '';
      if (f.required && f.type === 'checkbox' && value !== true) errors[f.name] = `Tick “${f.label}” before saving.`;
      else if (f.required && empty) errors[f.name] = missingMessage(f.label, f.type);
      else if (f.name === currencyField && !empty && currencyMinorUnit(String(value)) === undefined) errors[f.name] = 'Enter a three-letter currency code, such as NGN or USD.';
      else if (isMoney(f) && !empty && currencyMinorUnit(moneyCurrency) !== undefined) {
        try { majorToMinor(String(value), moneyCurrency); } catch (error) { errors[f.name] = (error as Error).message; }
      }
      else if (f.type === 'number' && !empty && !Number.isFinite(Number(value))) errors[f.name] = `Enter ${f.label} as a number.`;
    });
    if (!Object.keys(errors).length && validate) Object.assign(errors, validate(formData));
    if (actionMutation && !String(formData.reason || '').trim()) errors.reason = 'Enter a reason. It is saved in the audit log.';
    setFieldErrors(errors); setFormErrors([]);
    const first = firstNamed(errors);
    if (first) { focusField(fieldId(first)); return; }

    // An edit merges data (a merge patch): it sends only the fields this dialog shows, so what the service recorded
    // beside them, such as a settlement batch's line lists, stays as stored and never travels back in the request.
    const payload: any = { data: { ...(defaultValues.data || {}) } };
    if (record && !actionMutation) payload.expectedUpdatedAt = originalRecord.current?.updatedAt;
    fields.forEach(f => {
      let val = formData[f.name];
      // A checkbox always submits a boolean: an untouched box is false, never a missing field.
      if (f.type === 'checkbox') val = Boolean(val);
      else if (val === undefined) return;
      else if (val === '' && !f.required && f.type !== 'textarea') {
        // An optional field left empty is left out, except on an edit that emptied a stored value: that value is
        // sent as null, which removes it; left out, the merge would keep it.
        if (!(record && !actionMutation && f.isData && originalRecord.current?.data?.[f.name] !== undefined)) return;
        payload.data[f.name] = null;
        return;
      }
      if (isMoney(f)) val = majorToMinor(String(val), moneyCurrency);
      else if (f.name === currencyField) val = String(val).trim().toUpperCase();
      else if (f.type === 'number') val = Number(val);
      if(['consentGaps','linePaymentIds','confirmedJobs'].includes(f.name)&&typeof val==='string')val=val.split(/[|,]/).map(s=>s.trim()).filter(Boolean);
      if(f.name==='correct'&&typeof val==='string')val=val==='true';
      if (f.isData) {
        payload.data[f.name] = val;
      } else {
        payload[f.name] = val;
      }
    });

    const submittedSession = session.current;
    const submittedRequest = ++request.current;
    const isCurrent = () => session.current === submittedSession && request.current === submittedRequest && currentScope.current === scope;
    try {
      let response: unknown;
      if (actionMutation) {
        response = await perform.mutateAsync({
          data: { action: actionMutation, recordId: actionRecordId ?? record?.id, data: payload.data, reason: formData.reason, ...(originalRecord.current?.updatedAt && (!actionRecordId || actionRecordId === record?.id) ? { expectedUpdatedAt: originalRecord.current.updatedAt } : {}) },
          params: { merchantId }
        });
        if (!isCurrent()) return;
        if (actionMutation === 'backtest_policy') { setResult(response); return; }
      } else if (record) {
        response = await update.mutateAsync({ kind, id: record.id, data: payload, params: { merchantId } });
      } else {
        response = await create.mutateAsync({ kind, data: payload, params: { merchantId } });
      }
      if (isCurrent()) { onDone?.(response); onOpenChange(false); }
    } catch (error) {
      if (isCurrent()) applyServerError(error);
    }
  };

  const handleChange = (name: string, value: any) => {
    setFormData((prev: any) => ({ ...prev, [name]: value }));
    // A field being corrected drops its message at once.
    setFieldErrors(prev => { if (!prev[name]) return prev; const next = { ...prev }; delete next[name]; return next; });
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={changeOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 z-50" />
        <Dialog.Content onOpenAutoFocus={event => { if (context) { event.preventDefault(); dialogTitle.current?.focus(); } }} onCloseAutoFocus={restoreOpenerFocus} className="fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] -translate-y-[50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg max-h-[90vh] overflow-y-auto">
          <div className="flex flex-col space-y-1.5 text-center sm:text-left">
            <Dialog.Title ref={dialogTitle} tabIndex={context ? -1 : undefined} className="text-lg font-semibold leading-none tracking-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{title}</Dialog.Title>
            <Dialog.Description className="text-xs text-muted-foreground">Use sample data only. This action cannot collect money or send a customer message. Fields marked * are required.</Dialog.Description>
          </div>
          
          <form noValidate onSubmit={handleSubmit} className="space-y-4 py-4">
            {blockedReason && <p role="status" className="rounded-lg border bg-secondary/30 p-3 text-sm">{blockedReason}</p>}
            {importedEdit?.batchId && <Link href={`/imports?batch=${encodeURIComponent(importedEdit.batchId)}`} onClick={()=>onOpenChange(false)} className="inline-flex min-h-11 items-center text-sm text-primary underline">Open this batch in Import batches</Link>}
            {hasUnconfirmedOutcome && <div role="alert" className="space-y-2 rounded-lg border border-warning-border bg-warning/20 p-3 text-sm">
              <p className="font-semibold">Request not confirmed</p>
              <p>We do not know yet whether Valo Pay saved this. Check the original request before you change anything. Keep this form open to check it here. {KEPT_IN_OPERATIONS}</p>
              {formErrors.length > 0 && <div><p className="font-medium">Latest response</p>{formErrors.map((message, index) => <p key={index}>{message}</p>)}</div>}
              {supportReference && <p>Support reference: {supportReference}</p>}
              <div className="flex flex-wrap items-center gap-3"><Button type="button" variant="outline" busy={isPending} busyLabel="Checking original request…" onClick={() => { void retryUnconfirmed(); }}>Check original request</Button><OpenOperations /></div>
            </div>}
            <fieldset disabled={isPending || hasUnconfirmedOutcome || !!blockedReason} className="contents">
            {typeof context === 'function' ? context(formData) : context}
            {!hasUnconfirmedOutcome && (formErrors.length > 0 || Object.keys(fieldErrors).length > 0) && (
              <FormAlert title={formErrors[0] ?? attentionTitle(Object.keys(fieldErrors).length)}>
                {formErrors.slice(1).map(message => <p key={message}>{message}</p>)}
                <FormErrorLinks errors={fieldErrors} fields={[...fields, ...(actionMutation ? [{ name: 'reason', label: 'Reason' }] : [])]} prefix="record" />
                {conflict && <><p className="mt-2">Your draft is still here. Refresh to review the latest record before editing again.</p><Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { void refreshLatest(); }} busy={refreshingLatest} busyLabel="Refreshing…">Discard draft and refresh</Button></>}
              </FormAlert>
            )}
            {fields.map(f => (
              <div key={f.name} className="flex flex-col gap-2">
                <label htmlFor={`record-${f.name}`} className="text-sm font-medium">{f.label} {f.required && '*'}</label>
                {f.type === 'textarea' ? (
                  <textarea 
                    id={`record-${f.name}`}
                    className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" 
                    value={Array.isArray(formData[f.name])?formData[f.name].join(" | "):(formData[f.name]??'')} 
                    onChange={e => handleChange(f.name, e.target.value)} 
                    required={f.required} 
                    {...fieldProps(f)}
                  />
                ) : f.type === 'select' ? (
                  <select 
                    id={`record-${f.name}`}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" 
                    value={formData[f.name] || ''} 
                    onChange={e => handleChange(f.name, e.target.value)} 
                    required={f.required}
                    {...fieldProps(f)}
                  >
                    <option value="">Choose an option</option>
                    {f.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : f.type === 'checkbox' ? (
                  <input 
                    id={`record-${f.name}`}
                    type="checkbox" 
                    checked={!!formData[f.name]} 
                    onChange={e => handleChange(f.name, e.target.checked)} 
                    required={f.required}
                    {...fieldProps(f)}
                  />
                ) : (
                  <input 
                    id={`record-${f.name}`}
                    type={isMoney(f) ? 'text' : f.type === 'number' ? 'number' : f.type==='date'?'date':'text'}
                    inputMode={isMoney(f) ? 'decimal' : undefined}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" 
                    value={Array.isArray(formData[f.name])?formData[f.name].join(" | "):(formData[f.name]??'')} 
                    onChange={e => handleChange(f.name, e.target.value)} 
                    required={f.required} 
                    {...fieldProps(f)}
                  />
                )}
                {f.help && <p id={`${fieldId(f.name)}-help`} className="text-xs text-muted-foreground">{f.help}</p>}
                <FieldError id={`record-${f.name}`} message={fieldErrors[f.name]} />
              </div>
            ))}

            {actionMutation && (
              <div className="flex flex-col gap-2">
                <label htmlFor="record-reason" className="text-sm font-medium">Reason *</label>
                <input 
                  type="text" 
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" 
                  id="record-reason" {...invalidProps('record-reason', fieldErrors.reason)} value={formData.reason || ''} 
                  onChange={e => handleChange('reason', e.target.value)} 
                  required 
                />
                <FieldError id="record-reason" message={fieldErrors.reason} />
              </div>
            )}
            
            {result&&<section className="space-y-2 rounded border p-3"><p className="font-medium">{result.message}</p>
              {result.data?.decisions?.length===0&&<p>No instalments use this policy yet.</p>}
              {result.data?.decisions?.map((decision:any)=><div key={decision.dueItemId} className="border-t pt-2 text-sm"><span className="font-mono text-xs">{decision.dueItemId}</span><p className="font-semibold">{readableLabel(decision.decision)}</p><p>{decision.reason}</p>{decision.nextAt&&<p>Next possible attempt: {formatDate(decision.nextAt)}</p>}</div>)}
            </section>}
            </fieldset>
            <div className="flex justify-end gap-2 mt-4 pt-4 border-t">
              <Button type="button" variant="outline" disabled={isPending} onClick={() => changeOpen(false)}>{hasUnconfirmedOutcome ? 'Close' : 'Cancel'}</Button>
              <Button type="submit" disabled={!!blockedReason || hasUnconfirmedOutcome} busy={isPending} busyLabel={actionMutation ? 'Working…' : 'Saving…'}>{actionMutation ? actionLabels[actionMutation] || 'Confirm action' : 'Save'}</Button>
            </div>
          </form>

          <Dialog.Close asChild>
            <button disabled={isPending} className="absolute right-3 top-3 inline-flex h-6 w-6 items-center justify-center rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
