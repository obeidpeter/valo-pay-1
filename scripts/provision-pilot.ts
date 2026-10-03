// Run only against the intended synthetic staging database. No HTTP bootstrap.
// Needs that database's DATABASE_URL and VALO_PAY_1_STAFF_ACCESS=staging. The
// arguments and the staff setting are checked before the store, and with it
// the database pool, is loaded, so a mistake here never opens a connection.
// Three modes (docs/pilot-workflow-release.md, "Pilot administrators"):
// provision an organisation with its first administrator, add another
// administrator, or renew an administrator's 90 days. Each can be run again:
// it says where things stand instead of failing on a duplicate.
const command = "VALO_PAY_1_STAFF_ACCESS=staging pnpm --filter @workspace/valo-pay-1-scripts exec tsx ./provision-pilot.ts --synthetic-staging";
const usage = [
  `Usage: ${command} org_ID user_ID "Workspace name"`,
  `       ${command} --add-administrator org_ID user_ID "Display name"`,
  `       ${command} --renew org_ID user_ID`,
].join("\n");
const given = process.argv.slice(2);
// A leading `--` is skipped, as the other operator commands skip it.
const args = given[0] === "--" ? given.slice(1) : given;
const [confirmation, ...rest] = args;
const mode = rest[0] === "--add-administrator" ? "add" : rest[0] === "--renew" ? "renew" : "provision";
const operands = mode === "provision" ? rest : rest.slice(1);
const [organisation, administrator, name] = operands;
if (
  confirmation !== "--synthetic-staging" ||
  operands.length !== (mode === "renew" ? 2 : 3) ||
  operands.some((value) => !value || value.startsWith("--"))
) {
  console.error(usage);
  process.exit(1);
}
if (process.env.VALO_PAY_1_STAFF_ACCESS !== "staging") {
  console.error(
    "Set VALO_PAY_1_STAFF_ACCESS=staging: a pilot workspace is provisioned only for staging staff access.",
  );
  process.exit(1);
}
// The store's own pool; the scripts package does not depend on @workspace/valo-pay-1-db.
const { provisionStaffWorkspace, addStaffAdministrator, renewStaffAdministrator, closeDatabase, verifyProductDatabaseBinding } = await import(
  "../artifacts/api-server/src/lib/valo-pay-1-store"
);
try {
  await verifyProductDatabaseBinding();
  const result =
    mode === "add" ? await addStaffAdministrator(organisation!, administrator!, name!)
    : mode === "renew" ? await renewStaffAdministrator(organisation!, administrator!)
    : await provisionStaffWorkspace(organisation!, administrator!, name!);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // A refusal is said in its own words; anything else by its message alone, never with a stack or the database's detail.
  const refusal = typeof (error as { status?: unknown }).status === "number";
  console.error(refusal ? (error as Error).message : `Provisioning failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
export {}; // A module, so the awaits above may stand at the top level.
