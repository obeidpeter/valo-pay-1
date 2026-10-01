import { useQuery } from '@tanstack/react-query';
import { staffDirectorySchema, type StaffDirectory } from '@workspace/valopay-schema';
import { useWorkspace } from '@/lib/workspace-context';
import { pilotRequest } from '@/lib/pilot';
import { formatDate } from '@/lib/formatters';

/** From how many days before an administrator's access ends the console warns. */
export const ADMINISTRATOR_EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What an administrator should be told about the end of administrator access
 * (memberships last 90 days, and only the operator renews an administrator,
 * with provision-pilot --renew): their own access ending within 14 days, and
 * the access of the administrator who stays longest ending within 14 days,
 * after which nobody can invite, change or renew staff. Nothing to say when
 * neither is close, or for anyone but an active administrator.
 */
export function administratorExpiryWarnings(directory: StaffDirectory, now: number): string[] {
  // An administrator's directory carries every expiry; one without (another person's, seen by someone else) is left out.
  const active = directory.members.flatMap((member) => member.role === 'Admin' && member.status === 'active' && member.expiresAt && Date.parse(member.expiresAt) > now ? [{ ...member, expiresAt: member.expiresAt }] : []);
  const own = active.find((member) => member.actor === directory.actor);
  if (directory.mode !== 'staff' || !own) return [];
  const soon = (at: string) => Date.parse(at) - now <= ADMINISTRATOR_EXPIRY_WARNING_DAYS * DAY_MS;
  const last = active.reduce((latest, member) => (Date.parse(member.expiresAt) > Date.parse(latest.expiresAt) ? member : latest));
  const warnings: string[] = [];
  if (soon(last.expiresAt) && Date.parse(own.expiresAt) >= Date.parse(last.expiresAt)) {
    return [`Your Admin access ends on ${formatDate(own.expiresAt)}, and no other Admin’s access lasts longer. After that, nobody can invite, change or renew team members. Before then, ask the Valo Pay team to renew your access or add another Admin.`];
  }
  if (soon(own.expiresAt)) warnings.push(`Your Admin access ends on ${formatDate(own.expiresAt)}. You cannot renew it yourself. Before then, ask the Valo Pay team to renew it.`);
  if (soon(last.expiresAt)) warnings.push(`Every Admin’s access ends by ${formatDate(last.expiresAt)}. After that, nobody can invite, change or renew team members. Before then, ask the Valo Pay team to renew an Admin’s access or add another Admin.`);
  return warnings;
}

/**
 * The warning above every console page for a staff administrator whose own
 * access, or the last administrator's, ends within 14 days. It reads the team
 * directory the Team & access page reads (the same cached query), and only
 * for a staff administrator.
 */
export function AdministratorExpiry() {
  const { merchantId, workspace } = useWorkspace();
  const staffAdministrator = workspace?.accessMode === 'staff' && workspace.role === 'Admin';
  const { data } = useQuery({
    queryKey: ['pilot', workspace?.actor, merchantId, '/team'],
    enabled: staffAdministrator,
    queryFn: ({ signal }) => pilotRequest('/team', staffDirectorySchema, { signal }),
  });
  const warnings = staffAdministrator && data ? administratorExpiryWarnings(data, Date.now()) : [];
  if (!warnings.length) return null;
  return (
    <section role="status" aria-label="Administrator access" className="mb-6 space-y-1 rounded-lg border border-warning-border bg-warning/10 p-4 text-sm print:hidden">
      <h2 className="font-semibold">Admin access is ending</h2>
      {warnings.map((warning) => <p key={warning}>{warning}</p>)}
    </section>
  );
}
