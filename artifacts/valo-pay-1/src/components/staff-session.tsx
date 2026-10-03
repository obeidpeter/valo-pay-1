import { authEnabled, AuthShow, ClerkSlot, VerifiedSession } from "@/lib/auth";

/**
 * The signed-in team member's organisation, account security and two-step
 * verification. Its controls are Clerk's, so they render under Clerk's provider
 * through a ClerkSlot, and load only where sign-in is available.
 */
export function StaffSession() {
  return authEnabled ? (
    <AuthShow when="signed-in">
      <ClerkSlot>
        <VerifiedSession />
      </ClerkSlot>
    </AuthShow>
  ) : (
    <p className="text-sm text-muted-foreground">
      Sign-in is not available at this address, so team members cannot sign in
      here. If you were invited, ask the Admin who invited you which address to
      use.
    </p>
  );
}
