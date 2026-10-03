import assert from "node:assert/strict";
import { probeSandboxCookieName } from "./sandbox-cookie-name.mjs";
assert.equal(probeSandboxCookieName({}), "__Host-valo-pay-1_development_sandbox");
for (const environment of ["development", "test", "staging", "production"]) {
  assert.equal(probeSandboxCookieName({ VALO_PAY_1_ENVIRONMENT: environment }), `__Host-valo-pay-1_${environment}_sandbox`);
}
for (const environment of [{ NODE_ENV: "production" }, { REPLIT_DEPLOYMENT: "1" }, { VALO_PAY_1_ENVIRONMENT: "future" }]) {
  assert.throws(() => probeSandboxCookieName(environment), /explicitly/);
}
console.log("Sandbox probe cookie checks: 8 passed.");
