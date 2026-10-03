import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { pilotRequest } from "@/lib/pilot";
import { invitationAcceptedSchema } from "@workspace/valo-pay-1-schema";
import { StaffSession } from "@/components/staff-session";
import { PilotError, PilotPanel } from "@/components/pilot-ui";
import { Button } from "@/components/ui/button";
import { useSessionUser } from "@/lib/auth";
import { ContextualHelp } from "@/components/contextual-help";

/** Shown when the acceptance got no answer: team changes are not in Request history, so Pilot journey shows whether it took effect. */
const ACCEPTANCE_PROBLEM =
  "We do not know yet whether Valo Pay 1 accepted your invitation. Open Pilot journey to check whether you are a team member before you accept it again.";
/** Shown when the acceptance's answer is not the confirmation its schema describes: the membership may already be active. */
const UNCONFIRMED_ACCEPTANCE =
  "Valo Pay 1’s confirmation was incomplete, so your invitation may already be accepted. Open Pilot journey to check whether you are a team member before you accept it again.";

export default function TeamInvitePage() {
  const [token] = useState(() => window.location.hash.slice(1)),
    { userId } = useSessionUser();
  const completeLink = /^[a-f0-9]{64}$/.test(token);
  // Outside the console's layout, which names each page, so the page names itself.
  useEffect(() => {
    document.title = "Accept your invitation · Valo Pay 1";
  }, []);
  const accept = useMutation({
    mutationFn: () =>
      pilotRequest("/team/accept", invitationAcceptedSchema, {
        method: "POST",
        body: JSON.stringify({ token }),
      }, UNCONFIRMED_ACCEPTANCE),
    onSuccess: () => {
      window.history.replaceState(null, "", window.location.pathname);
    },
  });
  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-2xl space-y-6 px-5 py-12">
      <Link href="/" className="text-sm text-primary underline">
        Valo Pay 1
      </Link>
      {/* The page's name, with nothing above it (docs/design/writing.md). */}
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          Accept your invitation
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Sign in with the email address the invitation is for. Valo Pay 1 checks
          your organisation membership and your role separately.
        </p>
      </header>
      <PilotPanel title="Confirm your access">
        {!completeLink ? (
          <div id="invitation-link-problem" role="alert" className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <p className="font-medium">This invitation link is incomplete or invalid.</p>
            <p>Open the full link again, exactly as the Admin sent it. If it still does not work, ask them for a new invitation.</p>
          </div>
        ) : (
          <>
            {userId ? (
              <StaffSession />
            ) : (
              <p className="text-sm">
                Sign in first, then open your invitation link again.{" "}
                <Link href="/sign-in" className="text-primary underline">
                  Sign in
                </Link>
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Choose the organisation the Admin invited you to. Then confirm your
              identity with two-step verification. Joining gives no access to
              real customer data. Live payments and bank connections are
              switched off.
            </p>
          </>
        )}
        <Button
          disabled={
            !userId || !completeLink || accept.isSuccess
          }
          aria-describedby={!completeLink ? "invitation-link-problem" : undefined}
          busy={accept.isPending}
          onClick={() => accept.mutate()}
        >
          Accept invitation
        </Button>
        <PilotError error={accept.error} fallback={ACCEPTANCE_PROBLEM} />
        {accept.isSuccess && (
          <p role="status" className="text-sm">
            {accept.data.message}{" "}
            <Link href="/pilot" className="text-primary underline">
              Open Pilot journey
            </Link>
          </p>
        )}
      </PilotPanel>
      <ContextualHelp topic="access" returnTo="/team-invite" />
    </main>
  );
}
