import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { pilotRequest } from "@/lib/pilot";
import { invitationAcceptedSchema } from "@workspace/valopay-schema";
import { StaffSession } from "@/components/staff-session";
import { PilotError, PilotHeading, PilotPanel } from "@/components/pilot-ui";
import { Button } from "@/components/ui/button";
import { useSessionUser } from "@/lib/auth";
import { ContextualHelp } from "@/components/contextual-help";

/** Shown when the acceptance got no answer: team changes are not in Operations, so the pilot workspace shows whether it took effect. */
const ACCEPTANCE_PROBLEM =
  "We did not receive confirmation that your invitation was accepted. Open the pilot workspace to check whether your membership is active before accepting again.";
/** Shown when the acceptance's answer is not the confirmation its schema describes: the membership may already be active. */
const UNCONFIRMED_ACCEPTANCE =
  "The service returned an incomplete confirmation. Open the pilot workspace to check whether your membership is active before accepting again.";

export default function TeamInvitePage() {
  const [token] = useState(() => window.location.hash.slice(1)),
    { userId } = useSessionUser();
  const completeLink = /^[a-f0-9]{64}$/.test(token);
  // Outside the console's layout, which names each page, so the page names itself.
  useEffect(() => {
    document.title = "Join your pilot workspace · Valo Pay";
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
        Valo Pay
      </Link>
      <PilotHeading title="Join your pilot workspace">
        Accept an invitation using its intended email address. Organisation
        membership and Valo Pay permissions are checked separately.
      </PilotHeading>
      <PilotPanel title="Confirm your access">
        {!completeLink ? (
          <div id="invitation-link-problem" role="alert" className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <p className="font-medium">This invitation link is incomplete or invalid.</p>
            <p>Reopen the complete link your administrator sent you. If it still does not work, ask them for a new invitation.</p>
          </div>
        ) : (
          <>
            {userId ? (
              <StaffSession />
            ) : (
              <p className="text-sm">
                Sign in, then reopen your invitation link.{" "}
                <Link href="/sign-in" className="text-primary underline">
                  Sign in
                </Link>
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Choose the organisation your administrator invited you to and verify
              both authentication factors. Joining does not enable real payments or
              customer data.
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
              Open pilot workspace
            </Link>
          </p>
        )}
      </PilotPanel>
      <ContextualHelp topic="access" returnTo="/team-invite" />
    </main>
  );
}
