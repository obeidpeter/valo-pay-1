import {
  paystackVerificationUsage,
  runPaystackEventVerification,
} from "../../artifacts/api-server/src/lib/paystack-verification";

const usage =
  "Use: verify-paystack-event --connection-id OPAQUE_TEST_CONNECTION --event-id SAVED_TEST_EVENT";
const given = process.argv.slice(2),
  args = given[0] === "--" ? given.slice(1) : given;
if (args.length === 1 && args[0] === "--help") {
  console.log(usage);
  process.exit(0);
}
const flags = new Map<string, string>();
let usable = true;
for (let index = 0; index < args.length && usable; index += 2) {
  const name = args[index]!;
  usable =
    ["--connection-id", "--event-id"].includes(name) &&
    !flags.has(name) &&
    !!args[index + 1] &&
    !args[index + 1]!.startsWith("--");
  if (usable) flags.set(name, args[index + 1]!);
}
const connectionId = flags.get("--connection-id") ?? "",
  eventId = flags.get("--event-id") ?? "";
// The configuration, the mapping and the database are checked in that order, so
// a refusal before then opens no database. Keys are never read from arguments,
// and neither the output nor the log line repeats an identifier.
const report =
  usable &&
  /^[a-f0-9]{64}$/.test(connectionId) &&
  /^[A-Za-z0-9_-]{1,100}$/.test(eventId)
    ? await runPaystackEventVerification(connectionId, eventId)
    : paystackVerificationUsage(usage);
// Exit 0 verified; 2 not verified yet, check the same event later; 1 fix or review first.
(report.exitCode === 0 ? console.log : console.error)(
  JSON.stringify(report, null, 2),
);
process.exitCode = report.exitCode;
