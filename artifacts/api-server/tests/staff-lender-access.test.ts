import assert from "node:assert/strict";
import { validateLenderAccessChange } from "../src/lib/staff-lender-access";

const now = "2026-09-22T10:00:00.000Z", member = { userId: "worker", role: "Finance", status: "active", updatedAt: now, expiresAt: "2026-12-01T10:00:00.000Z" };
const input = { expectedUpdatedAt: now, lenderIds: ["lender-a"], reason: "Assigned to the Cedar Finance pilot team." };
assert.deepEqual(validateLenderAccessChange(input, member, "admin", ["lender-a", "lender-b"], now).lenderIds, ["lender-a"]);
assert.deepEqual(validateLenderAccessChange({ ...input, lenderIds: [] }, member, "admin", ["lender-a"], now).lenderIds, [], "An administrator may remove all explicit lender access.");
assert.throws(() => validateLenderAccessChange(input, member, "worker", ["lender-a"], now), /^Error: Ask another Admin to change your own lenders\.$/);
assert.throws(() => validateLenderAccessChange(input, { ...member, role: "Admin" }, "admin", ["lender-a"], now), /Admins work on every lender in this workspace/);
assert.throws(() => validateLenderAccessChange(input, { ...member, status: "revoked" }, "admin", ["lender-a"], now), /Only a team member whose access is active can be given lenders/);
assert.throws(() => validateLenderAccessChange(input, { ...member, expiresAt: now }, "admin", ["lender-a"], now), /Only a team member whose access is active can be given lenders/);
assert.throws(() => validateLenderAccessChange({ ...input, expectedUpdatedAt: "2026-09-21T10:00:00.000Z" }, member, "admin", ["lender-a"], now), /access changed after you opened it/);
assert.throws(() => validateLenderAccessChange({ ...input, lenderIds: ["foreign-lender"] }, member, "admin", ["lender-a"], now), /not in this workspace/);
assert.throws(() => validateLenderAccessChange({ ...input, lenderIds: ["lender-a", "lender-a"] }, member, "admin", ["lender-a"], now), /once/);
assert.throws(() => validateLenderAccessChange({ ...input, arbitraryAuthority: true } as any, member, "admin", ["lender-a"], now));
console.log("Staff lender access: explicit grants, self-escalation, tenant scope, stale changes, expiry and revocation policy passed.");
