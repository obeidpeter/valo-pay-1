import { staffLenderAccessInputSchema, type StaffLenderAccessInput } from "@workspace/valopay-schema";

function refuse(message: string, status: number): never { throw Object.assign(new Error(message), { status }); }
/** Pure policy shared by the transactional repository and focused tests. */
export function validateLenderAccessChange(input: StaffLenderAccessInput, target: { userId: string; role: string; status: string; updatedAt: string; expiresAt: string }, actorUserId: string, availableLenderIds: string[], now: string) {
  const parsed = staffLenderAccessInputSchema.parse(input);
  if (target.userId === actorUserId) refuse("Ask another Admin to change which lenders you can work on.", 403);
  if (target.role === "Admin") refuse("Admins work on every lender in this workspace. Give this person another role before you limit which lenders they can work on.", 409);
  if (target.status !== "active" || Date.parse(target.expiresAt) <= Date.parse(now)) refuse("Only a team member whose access is active can be given access to lenders.", 409);
  if (target.updatedAt !== parsed.expectedUpdatedAt) refuse("This team member’s access changed after you opened it. Reload the page and try again.", 409);
  if (parsed.lenderIds.some(id => !availableLenderIds.includes(id))) refuse("One or more of these lenders are not in this workspace. Reload the page and choose again.", 404);
  return parsed;
}
