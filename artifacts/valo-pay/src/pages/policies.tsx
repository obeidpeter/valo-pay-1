import React, { useEffect, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { Loading } from '@/components/loading';
import { LoadProblem } from '@/components/load-problem';
import { useWorkspace } from '@/lib/workspace-context';
import { useListRecords, getListRecordsQueryKey } from '@workspace/api-client-react';
import { Shield, FileText, CheckCircle } from 'lucide-react';
import { PermissionButton as Button } from '@/components/permission-button';
import { formatCount, formatDate } from '@/lib/formatters';
import { RecordDialog } from '@/components/record-dialog';
import { StatusBadge, readableLabel } from '@/components/record-label';
import { PolicyReview, TemplatePreview, TemplateReview } from '@/components/policy-review';

/** Each dialog's title, named by the same verb and object as the button that opens it. */
const dialogTitles: Readonly<Record<string, string>> = {
  create_policy: 'Draft a policy', edit_policy: 'Edit policy draft', submit_policy: 'Submit policy for review', approve_policy: 'Approve policy',
  reject_policy: 'Reject policy', new_policy_version: 'Draft next version', backtest_policy: 'Test this version',
  create_template: 'Draft a template', edit_template: 'Edit template', submit_template: 'Submit template for review',
  approve_template: 'Approve template', reject_template: 'Request changes', new_template_version: 'Draft next version',
};

/** Submit buttons that repeat the opening button's words; the rest keep the dialog's own action names. */
const submitLabels: Readonly<Record<string, string>> = {
  create_policy: 'Draft a policy', create_template: 'Draft a template', edit_policy: 'Save changes', edit_template: 'Save changes',
  new_policy_version: 'Draft next version', new_template_version: 'Draft next version', backtest_policy: 'Test this version', reject_template: 'Request changes',
};

/** A number of hours, counted ("1 hour", "48 hours"), or "Not set" when the policy has none. */
function hours(value: unknown): string {
  return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) ? formatCount(Number(value), 'hour') : 'Not set';
}

export default function PoliciesPage() {
  const { merchantId } = useWorkspace();
  const [selectedRecord, setSelectedRecord] = useState<any>(null);
  const [actionKind, setActionKind] = useState<string>('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  
  const { data: policies, isLoading, error: policyError, refetch: retryPolicies, isFetching: fetchingPolicies } = useListRecords(
    'policies',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('policies', { merchantId: merchantId! }) } }
  );

  const { data: templates, isLoading: isLoadingTemplates, error: templateError, refetch: retryTemplates, isFetching: fetchingTemplates } = useListRecords(
    'templates',
    { merchantId: merchantId! },
    { query: { enabled: !!merchantId, queryKey: getListRecordsQueryKey('templates', { merchantId: merchantId! }) } }
  );

  useEffect(() => { setIsDialogOpen(false); setSelectedRecord(null); }, [merchantId]);

  const handleAction = (record: any, kind: string) => {
    setSelectedRecord(record);
    setActionKind(kind);
    setIsDialogOpen(true);
  };

  if (!merchantId) return null;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Policies and templates</h1>
        <p className="text-muted-foreground mt-1">Set retry policies and review the messages customers receive.</p>
      </header>

      {/* Policies */}
      <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            <h2 className="font-semibold text-lg">Retry policies</h2>
          </div>
          <Button size="sm" action="create_policy" record={null} onClick={() => handleAction(null, 'create_policy')}>Draft a policy</Button>
        </div>
        <div className="divide-y">
          {isLoading ? (
            <Loading what="policies" />
          ) : policyError ? (
            <LoadProblem what="retry policies" error={policyError} retry={() => { void retryPolicies(); }} busy={fetchingPolicies} />
          ) : !policies || policies.items.length === 0 ? (
            <EmptyState title="No retry policies yet" action={<Button size="sm" variant="outline" action="create_policy" record={null} onClick={() => handleAction(null, 'create_policy')}>Draft a policy</Button>}>
              A retry policy sets how many times and how often you can try to collect, and how much notice customers get. Select Draft a policy, then submit it. A Compliance reviewer must approve it before it can be used.
            </EmptyState>
          ) : (
            policies.items.map(policy => (
              <div key={policy.id} className="p-6 flex flex-col md:flex-row md:items-center justify-between gap-6">
                <div className="space-y-2 flex-1">
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-bold">{policy.name} · version {String(policy.data?.version || '1')}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${
                      policy.status === 'approved' ? 'bg-success/10 text-success border-success/20' : 
                      policy.status === 'submitted' ? 'bg-warning text-warning-foreground border-warning-border' :
                      'bg-secondary text-secondary-foreground'
                    }`}>
                      {readableLabel(policy.status)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                    <div>Maximum attempts: <span className="font-medium text-foreground">{String(policy.data?.maxAttempts ?? 'Not set')}</span></div>
                    <div>Time between attempts: <span className="font-medium text-foreground">{hours(policy.data?.spacingHours)}</span></div>
                    <div>Notice before first attempt: <span className="font-medium text-foreground">{hours(policy.data?.firstNoticeHours)}</span></div>
                    <div>Allows collecting part of an instalment: <span className="font-medium text-foreground">{policy.data?.partialAllowed ? 'Yes' : 'No'}</span></div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Author: {String(policy.data?.author || 'Not recorded')} · Last updated: {formatDate(policy.updatedAt)}
                  </div>
                </div>
                
                <div className="flex flex-col gap-2 shrink-0">
                  {policy.status === 'draft' && (
                    <>
                      <Button variant="outline" size="sm" action="edit_policy" record={policy} onClick={() => handleAction(policy, 'edit_policy')}>Edit draft</Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        action="submit_policy" record={policy} onClick={() => handleAction(policy, 'submit_policy')}
                      >
                        Submit for review
                      </Button>
                    </>
                  )}
                  {policy.status === 'submitted' && (
                    <>
                      <Button 
                        className="bg-success hover:bg-success/90 text-success-foreground"
                        size="sm"
                        action="approve_policy" record={policy} onClick={() => handleAction(policy, 'approve_policy')}
                      >
                        <CheckCircle className="mr-2 h-4 w-4" /> Approve policy
                      </Button>
                      <Button 
                        variant="destructive"
                        size="sm"
                        action="reject_policy" record={policy} onClick={() => handleAction(policy, 'reject_policy')}
                      >
                        Reject policy
                      </Button>
                    </>
                  )}
                  {policy.status === 'approved' && (
                    <>
                    <div className="flex items-center gap-2 text-success text-sm font-medium">
                      <Shield className="h-4 w-4" /> Approved version
                    </div>
                    <Button variant="outline" size="sm" action="new_policy_version" record={policy} onClick={() => handleAction(policy, 'new_policy_version')}>Draft next version</Button>
                    </>
                  )}
                  {/* A simulation: a draft or submitted version is tried on the instalments its policy governs, as if approved. */}
                  <Button variant="ghost" size="sm" action="backtest_policy" record={policy} onClick={() => handleAction(policy, 'backtest_policy')}>Test this version</Button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Templates */}
      <section className="bg-card border rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b bg-secondary/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <h2 className="font-semibold text-lg">Message templates</h2>
          </div>
          <Button size="sm" action="create_template" record={null} onClick={() => handleAction(null, 'create_template')}>Draft a template</Button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
          {isLoadingTemplates ? (
            <Loading what="message templates" className="col-span-2" />
          ) : templateError ? (
            <div className="md:col-span-2"><LoadProblem what="message templates" error={templateError} retry={() => { void retryTemplates(); }} busy={fetchingTemplates} /></div>
          ) : !templates || templates.items.length === 0 ? (
            <EmptyState className="col-span-2" title="No message templates yet">Templates hold the wording of customer messages. A Compliance reviewer must approve each version before it can be used. Messages here are simulated and never sent. Select Draft a template to write the first one.</EmptyState>
          ) : (
            templates.items.map(template => (
              <div key={template.id} className="border rounded-lg p-4 bg-secondary/5 relative">
                <div className="flex justify-between items-start mb-3">
                  <h3 className="font-medium">{template.data?.purpose ? readableLabel(template.data.purpose) : template.name}</h3>
                  {/* A reviewer's rejection asks the author for changes, so it reads as that. */}
                  <StatusBadge status={template.status === 'rejected' ? 'changes_requested' : template.status} />
                </div>
                <TemplatePreview text={template.data?.text} />
                {template.status === 'rejected' && <p className="mt-3 rounded-md border border-warning-border bg-warning/20 p-3 text-sm"><strong>Changes requested:</strong> {String(template.data?.rejectionReason || 'Read the reason in the audit log.')} Edit this version and submit it again.</p>}
                <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">Message with placeholders</summary><p className="mt-2 font-mono whitespace-pre-wrap break-words">{String(template.data?.text || 'No message written yet')}</p></details>
                <div className="mt-3 flex justify-between items-center text-xs text-muted-foreground">
                  <span>Version {String(template.data?.version || '1')}</span>
                  {['draft', 'rejected'].includes(template.status) && (
                    <div className="flex gap-2">
                      <Button variant="link" size="sm" className="h-auto min-h-6 p-0" action="edit_template" record={template} onClick={() => handleAction(template, 'edit_template')}>Edit template</Button>
                      <Button variant="link" size="sm" className="h-auto min-h-6 p-0" action="submit_template" record={template} onClick={() => handleAction(template, 'submit_template')}>Submit for review</Button>
                    </div>
                  )}
                  {template.status === 'submitted' && (
                    <div className="flex gap-3"><Button variant="link" size="sm" className="h-auto min-h-6 p-0 text-success" action="approve_template" record={template} onClick={() => handleAction(template, 'approve_template')}>Approve template</Button><Button variant="link" size="sm" className="h-auto min-h-6 p-0 text-destructive" action="reject_template" record={template} onClick={() => handleAction(template, 'reject_template')}>Request changes</Button></div>
                  )}
                  {template.status === 'approved' && <Button variant="link" size="sm" className="h-auto min-h-6 p-0" action="new_template_version" record={template} onClick={() => handleAction(template, 'new_template_version')}>Draft next version</Button>}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <RecordDialog
        key={merchantId}
        kind={actionKind.includes('policy') ? 'policies' : 'templates'}
        record={selectedRecord}
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title={dialogTitles[actionKind] || 'Action'}
        submitLabel={submitLabels[actionKind]}
        actionMutation={actionKind.includes('create') || actionKind.includes('edit') ? undefined : actionKind}
        context={actionKind === 'create_template' || actionKind === 'edit_template'
          ? values => <TemplatePreview text={values.text} />
          : selectedRecord && actionKind !== 'edit_policy'
            ? actionKind.includes('policy')
              ? <PolicyReview record={selectedRecord} records={policies?.items ?? []} />
              : <TemplateReview record={selectedRecord} records={templates?.items ?? []} />
            : undefined}
        fields={
          actionKind === 'create_policy' || actionKind === 'edit_policy' ? [
            { name: 'name', label: 'Policy name', type: 'text', required: true },
            { name: 'status', label: 'Status', type: 'select', options: [{label: 'Draft', value: 'draft'}], required: true },
            { name: 'maxAttempts', label: 'Maximum attempts', type: 'number', isData: true, required: true },
            { name: 'spacingHours', label: 'Time between attempts (hours)', type: 'number', isData: true, required: true },
            { name: 'firstNoticeHours', label: 'Notice before first attempt (hours)', type: 'number', isData: true, required: true },
            { name: 'retryNoticeHours', label: 'Notice before each retry (hours)', type: 'number', isData: true, required: true },
             { name: 'partialAllowed', label: 'Allow collecting part of an instalment', type: 'checkbox', isData: true },
             { name: 'complianceMapping', label: 'How this policy meets each required rule', type: 'textarea', isData: true, required: true }
          ] :
          actionKind === 'create_template' || actionKind === 'edit_template' ? [
            { name: 'name', label: 'Template name', type: 'text', required: true },
            { name: 'purpose', label: 'Purpose', type: 'text', isData: true, required: true },
            { name: 'text', label: 'Message', type: 'textarea', isData: true, required: true, help: 'Include {{amount}}, {{date}}, {{lender}} and {{contact}}. {{lender}} inserts the lender’s name. {{merchant}} still works in its place.' }
          ] :
          []
        }
        defaultValues={actionKind === 'create_policy' ? { status: 'draft' } : actionKind === 'create_template' ? { status: 'draft' } : {}}
      />
    </div>
  );
}
