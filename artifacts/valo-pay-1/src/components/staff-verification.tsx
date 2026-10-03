import { useState } from "react";
import {
  OrganizationSwitcher,
  useClerk,
  useReverification,
} from "@clerk/react";
import { Button } from "./ui/button";
import { PilotError } from "./pilot-ui";
import { answerProblem, readAnswer, UNREADABLE_ANSWER } from "@/lib/answers";

/** Clerk's organisation switcher, account security and re-verification for a signed-in staff member (StaffSession renders it under Clerk's provider). */
export function VerifiedSession() {
  const clerk = useClerk(),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const verify = useReverification(() =>
    fetch("/api/v1/team/verify", {
      method: "POST",
      credentials: "same-origin",
    }),
  );
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Choose your organisation. Select Open account security to set up
        two-step verification. Then select Verify identity before you make a
        change.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <OrganizationSwitcher hidePersonal />
        <Button variant="outline" onClick={() => clerk.openUserProfile()}>
          Open account security
        </Button>
        <Button
          variant="outline"
          busy={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            setMessage("");
            void verify()
              .then(async (response) => {
                if (!response) return;
                const result = await response.json().catch(() => undefined);
                if (!response.ok)
                  throw new Error(
                    result?.error || "Identity not verified.",
                  );
                // Only the confirmation the contract describes counts as verified. The
                // schemas load with the pages that use them: this component is also
                // part of the shell's workspace failure notice, which stays small.
                const { messageSchema } = await import("@workspace/valo-pay-1-schema");
                if (!readAnswer(messageSchema, result))
                  throw answerProblem(UNREADABLE_ANSWER);
                setMessage("Identity verified. You can continue now.");
              })
              .catch(setError)
              .finally(() => setBusy(false));
          }}
        >
          Verify identity
        </Button>
      </div>
      <PilotError error={error} fallback="Identity not verified. Select Verify identity to try again." />
      <p role="status" className="text-sm">
        {message}
      </p>
    </div>
  );
}
