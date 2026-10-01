/**
 * Refusals in the words the writing standard sets (docs/design/writing.md, "Messages from Valo Pay"). A role refusal
 * has one shape, "Only {roles} can {action}.", with the specific reason where there is one. A person in the sandbox is
 * told where to change their demo role; a team member never reads sandbox or demo wording.
 */

/**
 * Roles as a refusal lists them: exactly as the role chip shows them, with no article, as the console's refusals do.
 * "Admin", "Admin or Finance", "Admin, Operations or Finance". A sentence about one person keeps its article ("a
 * second Admin").
 */
export function roleList(roles: readonly string[]): string {
  const [first = "", ...rest] = roles;
  if (!rest.length) return first;
  return `${[first, ...rest.slice(0, -1)].join(", ")} or ${rest.at(-1)}`;
}

/** Where a person in the sandbox changes their demo role, as a sentence to add; nothing for a team member. */
export function demoRoleHint(accessMode: string | undefined): string {
  return accessMode === "staff" ? "" : " Change your demo role in Settings.";
}

/**
 * A role refusal: "Only Admin or Operations can grant permissions." with the specific reason, when there is one, and
 * in the sandbox where to change the demo role.
 */
export function onlyRoles(roles: readonly string[], action: string, accessMode: string | undefined, reason = ""): string {
  return `Only ${roleList(roles)} can ${action}.${reason ? ` ${reason}` : ""}${demoRoleHint(accessMode)}`;
}

/** A lender the request names that the person's workspace does not hold, or no longer does. */
export const LENDER_NOT_FOUND = "Lender not found. Reload the page and choose a lender from the list.";

/** A request checked with another role than the one that sent it: a team member cannot change role; a person in the
 * sandbox changes back to the demo role that sent it. */
export function sentWithAnotherRole(accessMode: string | undefined): string {
  return accessMode === "staff"
    ? "This request was sent with a different role, so you cannot check it with yours."
    : "This request was sent with a different demo role. Change your demo role in Settings, then check it.";
}

/** Something the request names that is missing, as the writing standard words it: "Customer not found. It may have
 * been deleted, or it belongs to another lender." */
export function notFound(thing: string): string {
  return `${thing} not found. It may have been deleted, or it belongs to another lender.`;
}

/** A demo role the sandbox does not have. */
export const UNKNOWN_DEMO_ROLE = "Choose one of the demo roles.";

/** How a pilot with one Admin gets the second one that a second-person approval needs. */
export const ONE_ADMIN = "If your pilot has only one Admin, ask the Valo Pay team to add a second.";
