const fs = require("node:fs");
const str = { type: "string" }, num = { type: "integer" }, bool = { type: "boolean" };
const ref = (s) => ({ $ref: `#/components/schemas/${s}` });
const arr = (s) => ({ type: "array", items: ref(s) });
const obj = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required });
const schemas = {
  HealthStatus: obj({ status: str, build: str, startedAt: str, uptimeSeconds: num, scheduler: ref("SchedulerStatus") }),
  BackgroundJobs: obj({ closes: bool, backlog: bool, exports: bool, cleanup: bool }),
  CleanupPassResult: obj({ attempted: { type: "integer", minimum: 0 }, removed: { type: "integer", minimum: 0 }, deferred: { type: "integer", minimum: 0 }, pendingFailures: { type: "integer", minimum: 0 } }),
  BackgroundCleanup: obj({ state: { type: "string", enum: ["disabled", "pending", "ok", "failed", "stale"] }, intervalMs: { type: ["integer", "null"] }, staleAfterMs: { type: ["integer", "null"] }, lastCheckedAt: { type: ["string", "null"] }, lastSuccessAt: { type: ["string", "null"] }, lastErrorAt: { type: ["string", "null"] }, lastResult: { oneOf: [ref("CleanupPassResult"), { type: "null" }] } }),
  BackgroundStatus: obj({ state: { type: "string", enum: ["not_started", "starting", "running", "restarting", "stale", "stopping", "stopped"] }, jobs: ref("BackgroundJobs"), heartbeatIntervalMs: { type: "integer", minimum: 1 }, staleAfterMs: { type: "integer", minimum: 1 }, startedAt: { type: ["string", "null"] }, lastHeartbeatAt: { type: ["string", "null"] }, crashCount: { type: "integer", minimum: 0 }, restartCount: { type: "integer", minimum: 0 }, lastCrashAt: { type: ["string", "null"] }, cleanup: ref("BackgroundCleanup") }),
  SchedulerRun: obj({ runId: str, at: str, durationMs: num, initialised: num, examined: num, closed: num, skipped: num, failed: num }),
  SchedulerBacklog: obj({ checkedAt: str, overdue: { type: "integer", minimum: 0 }, failing: { type: "integer", minimum: 0 }, lateAfterMinutes: num }),
  SchedulerPublicSandboxes: obj({ overdue: { type: "integer", minimum: 0 }, failing: { type: "integer", minimum: 0 } }),
  SchedulerStatus: obj({ state: { type: "string", enum: ["not_started", "running", "off", "external", "stopped"], description: "running: this process schedules the daily closes. off: it schedules none (VALO_PAY_1_CLOSE_SCHEDULER=off). external: it schedules none because a separate scheduled job runs them with the one-shot close pass (VALO_PAY_1_CLOSE_SCHEDULER=external), whose runs this process cannot observe; it reads the lenders still owed a close itself instead, every intervalMs (backlog). not_started and stopped: the scheduler has not started yet, or has stopped." }, intervalMs: { type: ["integer", "null"], description: "How often this process looks: its scheduler's tick, or with external how often it reads the backlog; null in a process that does neither. Builds before the external read report null with external." }, ticks: num, lastTickAt: { type: ["string", "null"] }, lastRun: { oneOf: [ref("SchedulerRun"), { type: "null" }] } }),
  DatabaseCheck: obj({ status: { type: "string", enum: ["ok", "failed"] }, latencyMs: num }),
  SchemaCheck: obj({ status: { type: "string", enum: ["ok", "indexes_missing", "incomplete", "unchecked"], description: "ok: every table, column, unique index, check constraint and read index this build needs is present, and no guard it replaced remains. indexes_missing: ready, but a read index a migration adds is missing, so some reads are slower until it is applied. incomplete: a table, column, unique index or check constraint is missing, or a guard this build replaced is still in place, so the instance is not ready. unchecked: the database did not answer. The server log names what is missing and where it comes from, and a replaced guard and the schema to migrate." } }),
  ReadinessStatus: obj({ status: { type: "string", enum: ["ok", "degraded"] }, build: str, checks: obj({ database: ref("DatabaseCheck"), schema: ref("SchemaCheck") }) }),
  RecordData: { type: "object", additionalProperties: {} },
  ValopayRecord: obj({ id: str, merchantId: str, kind: str, name: str, status: str, reference: str, amountKobo: num, customerId: str, createdAt: str, updatedAt: str, data: ref("RecordData") }),
  RecordInput: obj({ name: str, status: str, reference: str, amountKobo: {type:"integer", minimum:0}, customerId: str, data: ref("RecordData") }, ["name"]),
  RecordUpdate: obj({ name: str, status: str, reference: str, amountKobo: {type:"integer", minimum:0}, customerId: str, data: ref("RecordData"), expectedUpdatedAt: { type: "string", minLength: 1, description: "Required: the updatedAt of the record as the edit read it. A request without it is refused (400, naming it); a record changed since is 409. Compared as an instant." } }, ["expectedUpdatedAt"]),
  Merchant: obj({ id: str, name: str, shortName: str, segment: str, mode: str, status: str, provider: str, monthlyVolume: num, killSwitch: bool, preDataReady: bool, preLiveReady: bool }),
  Workspace: obj({ name: str, environment: str, actor: str, role: str, authenticated: bool, merchants: arr("Merchant"), roles: {type:"array",items:str}, productionEnabled: bool }),
  Metric: obj({ key: str, label: str, value: {type:"number"}, unit: str, detail: str }),
  Alert: obj({ key: str, severity: str, title: str, detail: str, count: num, since: str, linkedRecordId: str }, ["key","severity","title","detail"]),
  Overview: obj({ metrics: arr("Metric"), queues: arr("Metric"), activity: arr("ValopayRecord"), upcoming: arr("ValopayRecord"), mode: str, environment: str, lastClose: str, nextClose: str, closeTime: str, alerts: arr("Alert") }),
  RecordList: obj({ items: arr("ValopayRecord"), total: num, nextOffset: num }, ["items","total"]),
  ActionInput: obj({ action: str, recordId: str, reason: str, data: ref("RecordData"), expectedUpdatedAt: str }, ["action"]),
  ActionResult: obj({ message: str, record: ref("ValopayRecord"), data: ref("RecordData") }, ["message","data"]),
  ImportInput: obj({ kind: str, csv: str, syntheticOnly: bool, commit: bool, mapping: ref("RecordData"), amountUnit: { type: "string", enum: ["naira", "kobo"], description: "Unit used by source amount values; defaults to kobo for existing API clients. The console requires an explicit choice." }, identityColumn: { type: "string", maxLength: 100, description: "Required: the CSV header of the column that holds each row's source row ID, a different, non-empty value of up to 160 characters on every row. A file without that column, or a value blank or repeated, is refused (400) naming what to map. The row ID is kept with the record, so it is screened under its column's header: a raw account number is refused (400), as in a saved batch. The column is the row's identity and fills no field unless the mapping maps it to one or it is headed reference or eventId. Rows are recognised across quick imports by the lender's one quick-import source and the row ID: a row imported before with the same data is skipped as a duplicate, and one with different data is a row error." } }, ["kind","csv","syntheticOnly","commit","identityColumn"]),
  ImportRow: obj({ row: num, status: str, message: str }),
  ImportResult: obj({ valid: num, invalid: num, imported: num, rows: arr("ImportRow") }),
  InvoiceRateComparison: obj({ invoiceId: str, invoiceReference: str, period: str, status: { type: "string", enum: ["agrees", "different", "awaiting_confirmation", "no_applicable_terms"] }, commercialId: { type: ["string", "null"] }, commercialName: { type: ["string", "null"] }, explanation: str }),
  RateComparisonCoverage: obj({ totalInvoices: { type: "integer", minimum: 0 }, checked: { type: "integer", minimum: 0, description: "Invoices compared, including both agreeing and differing rates." }, different: { type: "integer", minimum: 0 }, awaitingConfirmation: { type: "integer", minimum: 0, description: "Invoices not compared because their design-partner terms are not ready. Each invoice gives the actual cause." }, noApplicableTerms: { type: "integer", minimum: 0 }, invoices: arr("InvoiceRateComparison") }),
  ReportBilling: { allOf: [ref("RecordData"), obj({ rateComparisonCoverage: ref("RateComparisonCoverage") }, [])] },
  Report: obj({ metrics: arr("Metric"), billing: ref("ReportBilling"), experiment: ref("RecordData"), operational: ref("RecordData"), closes: arr("ValopayRecord") }),
  Gate: obj({ id: str, title: str, description: str, status: str, evidence: str, due: str }),
  Gates: obj({ prerequisites: arr("Gate"), decisions: arr("Gate"), limitations:{type:"array", items:str}, cashKobo:num, burnKobo:num }),
  OtherCurrencies: { type: "object", additionalProperties: obj({ count: num, amount: num }) },
  CustomerPosition: obj({ obligationsKobo: num, allocatedKobo: num, outstandingKobo: num, unallocatedKobo: num, unallocatedOtherCurrencies: ref("OtherCurrencies"), note: str }, ["obligationsKobo", "allocatedKobo", "outstandingKobo", "unallocatedKobo", "note"]),
  Timeline: obj({ customer: ref("ValopayRecord"), position: ref("CustomerPosition"), events: arr("ValopayRecord"), mandates: arr("ValopayRecord"), dueItems: arr("ValopayRecord"), payments: arr("ValopayRecord") }),
  Settings: obj({ merchant: ref("Merchant"), settings: ref("RecordData"), permissions: ref("RecordData"), integrations: arr("ValopayRecord"), members: arr("ValopayRecord"), calendar: arr("ValopayRecord") }),
  SettingsInput: obj({ executionStart: num, executionEnd: num, authorisationMode: str, contactRoute: str, minimumTicketKobo:num, defaultOwner: str, policyChangeRequiresConsent: bool, unallocatedAlertThreshold: num, notificationCostAlertKobo: num, closeTime: str, scheduledCloseEnabled: bool }, []),
  ExportInput: obj({ kind: str, customerId: str, closeReviewId: str, format: {type:"string", enum:["json","csv","pdf"]} }, ["kind","format"]),
  ExportResult: obj({ id:str, downloadUrl: str, status:{type:'string',enum:['queued','running','ready','failed']}, stage:{type:'string',enum:['queued','checking','rendering','uploading','confirming','ready','failed']}, lastProgressAt:str, stalled:bool, retryAllowed:bool, recoveryAt:str, expiredAt:str, retentionRunId:str, kind:str, format:str, customerId:str, requestedAt:str, attempts:num, checksum:str, generatedAt:str, byteLength:num, generationMs:num, error:str }, ['id','downloadUrl']),
  EffectiveCloseSchedule: obj({
    time: str, enabled: bool, automatic: bool, nextAt: { type: ["string", "null"] },
    runtimeState: { type: "string", enum: ["not_started", "running", "off", "external", "stopped"], description: "The close service as this process sees it (the health answer's scheduler state). With external a separate scheduled job runs the closes: nothing is advertised as automatic, but a close that job has not run is still missed." },
    serviceIssue: { type: ["string", "null"], enum: ["starting", "delayed", "failed", null] },
    missed: bool, overdueMinutes: num, lateAfterMinutes: num,
    lastAt: { type: ["string", "null"] }, lastTrigger: { type: ["string", "null"] },
    lastCheckedAt: { type: ["string", "null"] }, lastErrorAt: { type: ["string", "null"] },
  }),
};
// Additive metadata remains optional for clients reading an older service response.
schemas.HealthStatus.properties.background = ref("BackgroundStatus");
schemas.Report.properties.billing.description = "Billing statement and invoice history. Additive pricingReady/pricingExplanation and nextInvoicePricingReady/nextInvoicePricingExplanation distinguish a statement or next invoice held until signed design-partner terms can price it; the explanation names the actual cause (the full-price terms not recorded as signed, dates or reference missing or invalid, dates changed since they were proposed or confirmed, a proposal awaiting a second person's confirmation, or unreadable stored evidence) in the words the 409 of issue_invoice uses. While held, totalKobo and revenue-derived unitEconomics values are null, not zero, and unitEconomics.note names the cause too; existing issued invoices are unchanged. Additive rateDiscrepancies lists each issued invoice charged at another rate than the terms billing reads for its month now give (the lender's signed terms in effect by the month's end, whichever terms billed it; ordinary terms give the full public price, and design-partner terms count once their discount dates are confirmed, so while those in effect are not, the month's invoices are not compared): invoiceId, invoiceReference, period, commercialId (the terms compared with), chargedRate, agreedRate and an explanation naming those terms, when they took effect and the whole-month rule. rateDiscrepancyGuidance says what to do, since an issued invoice is never changed and has no correction path, including the adjustment lines later invoices carry for its collections at the same rate. Additive rateComparisonCoverage counts all issued invoices, those checked (agreeing plus different), differences, those awaiting confirmed design-partner terms and those without applicable signed terms. Its invoices list gives every invoice identity, comparison status, effective commercial record ID/name when present and the reason, so zero differences never conceals incomplete checks. Older responses may omit this metadata.";
schemas.RecordInput.properties.data.description = "Per-kind fields validated by the shared record schema. Commercial design-partner terms may supply discountStartDate and fullPriceStartDate as first-of-month dates, discountTermsReference and signedFullPriceTerms. Saving signed design-partner terms with the full-price terms signed and all three proposes the dates: the service alone records discountReview (who proposed them, which person and when); a different Admin or Finance user must then confirm them with confirm_discount_terms before they price an invoice. A discountReview in the request is refused (400). Legacy records without dates remain readable but cannot issue a new design-partner invoice.";
schemas.RecordUpdate.properties.data.description = "Per-kind update fields, merged with the stored record after the expectedUpdatedAt check. A commercial edit that changes signed, signedFullPriceTerms, designPartner, the dates or the reference proposes them afresh (discountReview, recorded by the service) and drops any confirmation; any other edit keeps the proposal and its confirmation. A client cannot supply or change discountReview (400). Issued invoice records are immutable.";
for (const field of ["lastSuccessAt", "lastErrorAt"]) schemas.SchedulerStatus.properties[field] = { type: ["string", "null"] };
schemas.SchedulerStatus.properties.backlog = { oneOf: [ref("SchedulerBacklog"), { type: "null" }], description: "What this process last read from the database as still owed: at the end of each pass or, with external, every intervalMs; null until its first read, and kept as last read while the scheduler is stopped or failing, or a read fails, so its checkedAt ages. Absent from builds before it was added, which report only lastRun; builds before the external read report null with external." };
// Optional too: a build from before public sandboxes were counted apart reports none, and counts them among the lenders.
schemas.SchedulerBacklog.properties.publicSandboxes = ref("SchedulerPublicSandboxes");
// Optional too: a build from before files were parked for review counts them among pendingFailures.
schemas.CleanupPassResult.properties.parked = { type: "integer", minimum: 0 };
// Optional too: a settings answer stored as an idempotency receipt by an earlier build is parsed again on replay.
Object.assign(schemas.EffectiveCloseSchedule.properties, { failedAttempts: num, retryAt: { type: ["string", "null"] }, pausedForInactivityAt: { type: ["string", "null"] } });
Object.assign(schemas.SchedulerRun.properties, { paused: num, batches: num });
for (const name of ["Overview", "Settings"]) schemas[name].properties.closeSchedule = ref("EffectiveCloseSchedule");
const paths = {};
schemas.Settings.properties.revision = str;
schemas.Workspace.properties.accessMode = { type: "string", enum: ["sandbox", "staff"], description: "Whether the server authorises a demo persona or a provisioned staff membership." };
schemas.Workspace.properties.viewerScope = { type: "string", description: "Opaque workspace/user scope for browser preferences; never an authorisation credential." };
schemas.SettingsInput.properties.expectedRevision = { type: "string", minLength: 1, description: "Required: the revision of the settings as the edit read them (GET /v1/settings). A request without it is refused (400, naming it); settings changed since are 409." };
schemas.SettingsInput.required = ["expectedRevision"];
schemas.ImportResult.properties.columns = { type: "array", items: str };
schemas.ImportResult.properties.preview = { type: "array", items: obj({ row: num, values: ref("RecordData"), amountKobo: num }, ["row", "values"]) };
schemas.ImportResult.properties.skipped = num;
schemas.ImportResult.properties.warnings = { type: "array", items: str };
schemas.ImportRow.properties.detail = { type: "string", description: "An invalid row's problems in the record API's words, field names included, beside the message's words for the operator's columns." };
// An operation and its success answer. The refusals and failures it can answer are listed by
// listErrorAnswers at the end, from what its route does, with the error body they carry.
function add(path, method, id, response, body, params = []) {
 const op = {operationId:id, tags:["valopay"], parameters:params, responses:{"200":{description:"Success",content:{"application/json":{schema:ref(response)}}}}};
 if(body)op.requestBody={required:true,content:{"application/json":{schema:ref(body)}}};
 (paths[path]??={})[method]=op;
}
// The Idempotency-Key header as a route takes it: required, or optional (the write runs without one).
// A key the operations journal records makes its request answer 410 once retention has removed its stored result.
const journaled = new WeakSet();
const journal = (parameter) => { journaled.add(parameter); return parameter; };
const keyRules = "8 to 200 characters, one per unchanged intention. The same key with different input is refused (409). A key whose request was refused cannot run again: its journal entry is closed. A repeat after a lost answer returns the original result, checked before the version; once the lender's retention policy has removed that stored result, the repeat is refused (410). A repeat while the request is still running is answered 503 with Retry-After and operation running, and leaves it to finish. The result is kept with the request's journal entry, so a key names one request of the person who sent it, in its lender.";
const requiredKey = journal({ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 200 }, description: `Required: a request without one is refused (400, naming the header). ${keyRules}` });
const optionalKey = (detail = "") => journal({ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", minLength: 8, maxLength: 200 }, description: `Optional: without one the write still runs, but a lost answer cannot be recovered and a repeat may apply twice. With one, the request is journaled in Operations and repeatable. ${keyRules}${detail ? ` ${detail}` : ""}` });
/** A new lender's key: it names the lender, and the journal does not record the request. */
const lenderKey = { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 200 }, description: "Required: a request without one is refused (400, naming the header). 8 to 200 characters, one per new lender. The key names the lender it creates: a repeat returns that lender, and the same key with different details is refused (409). The request is not recorded in Operations, so a request refused before the lender was created (by the caller's role, or at the sandbox's five-lender limit) may be sent again with the same key once the refusal no longer applies." };
const pathDescriptions = { kind: "Record kind: one of the shared schema's recordKinds (customers, mandates, due-items, attempts, observations, payments, ...).", id: "The record's id.", provider: "Provider name; this generic address refuses every provider (the Paystack test ingress has its own address)." };
/** The id an address names: 1 to 100 characters, refused (400, naming id) otherwise, as every route checks it (pathIdSchema). */
const idSchema = { type: "string", minLength: 1, maxLength: 100 };
const pathParam = (name) => ({name,in:"path",required:true,schema:name==="id"?idSchema:str,description:pathDescriptions[name]});
const merchant = {name:"merchantId",in:"query",required:true,schema:{type:"string",minLength:1,maxLength:100},description:"The lender (a merchant in the API) the request is scoped to; one of the caller's workspace merchants. Missing or empty, the request is refused with 400 naming merchantId, on every operation."};
const search = {name:"search",in:"query",schema:str,description:"Text matched, ignoring case and accents, against the record's name, its reference and the text and number values in its data, nested ones included; never a field's name, true, false or null. An audit log entry is also matched by the name in words its list shows for its action."};
const status = {name:"status",in:"query",schema:str,description:"Only records in this status; omitted or \"all\" for every status. Saved exports (kind exports) also take \"expired\", which is derived rather than stored: the exports whose file an approved retention run removed (fileDeletedAt), whatever their job's status. \"ready\" and \"failed\" then list only the exports whose file remains."};
const limit = {name:"limit",in:"query",schema:{type:"integer",minimum:1,maximum:500},description:"Page size, from 1 to 500; a value outside that range is refused (400). Omitted, a kind that grows with history (audit, closes, exports, notifications, retry-decisions) returns its newest 500 with nextOffset to page on, and any other kind its whole filtered set, for existing relationship and balance views."};
const offset = {name:"offset",in:"query",schema:{type:"integer",minimum:0},description:"Rows to skip in the newest-first order."};
const updatedSince = {name:"updatedSince",in:"query",schema:str,description:"An RFC 3339 date and time with Z or an offset, such as 2026-09-18T08:00:00+01:00; only records updated at or after that instant (incremental sync). A number, a date without a time, a time without Z or an offset, or a year outside 0001 to 9999 is refused (400, naming updatedSince)."};
const customerId = {name:"customerId",in:"query",schema:str,description:"Only records directly linked to this customer, in the selected lender."};
const recordId = {name:"id",in:"query",schema:str,description:"Only this exact record ID, in the selected kind and lender."};
const allocatable = {name:"allocatable",in:"query",schema:{type:"string",enum:["true","false"]},description:"Instalments (due-items) only. true lists just the instalments that can take an allocation now: those that still owe an amount, are not cancelled, closed or in dispute and are not held for a renewed review of an earlier reversal decision (a non-empty data.legacyReversalReviewIds, whatever their status), and with paymentId only those a manual allocation of that payment accepts (none for a payment held for a renewed reversal review, which takes no allocation), so total counts the choices. Omitted or false lists every instalment. Refused (400) for any other kind."};
const allocationPaymentId = {name:"paymentId",in:"query",schema:idSchema,description:"With allocatable=true, the payment whose choices are listed: the instalments a manual allocation of it accepts, by the payer rule that allocation applies. A payment with a recorded payer takes only its payer's instalments; one whose evidence named no payer but names an instalment takes only that instalment's customer's; one that names neither takes any customer's. A payment in another currency than naira, whose money went back or with nothing left to allocate takes none, so the list is empty. A payment the lender does not have is a 404; without allocatable=true, paymentId is refused (400)."};
add("/healthz","get","healthCheck","HealthStatus");
add("/readyz","get","readinessCheck","ReadinessStatus");
const describe = (path, method, summary, description) => Object.assign(paths[path][method], { summary, description });
paths["/readyz"].get.responses["503"]={description:"Not ready: the database cannot be reached within the check's time limit, or lacks a table, column, unique index or check constraint this build needs, or still holds a guard it replaced",content:{"application/json":{schema:ref("ReadinessStatus")}}};
add("/v1/workspace","get","getWorkspace","Workspace");
add("/v1/overview","get","getOverview","Overview",null,[merchant]);
add("/v1/records/{kind}","get","listRecords","RecordList",null,[pathParam("kind"),merchant,search,status,limit,offset,updatedSince,customerId,recordId,allocatable,allocationPaymentId]);
add("/v1/records/{kind}","post","createRecord","ValopayRecord","RecordInput",[pathParam("kind"),merchant,optionalKey()]);
add("/v1/records/{kind}/{id}","patch","updateRecord","ValopayRecord","RecordUpdate",[pathParam("kind"),pathParam("id"),merchant,optionalKey()]);
add("/v1/actions","post","performAction","ActionResult","ActionInput",[merchant,optionalKey("A set_role change is repeatable with its key but is not recorded in Operations, so a refused one may be sent again and retention never removes its result. Its result is kept apart from the journal's, so a journaled write sent with the same key is a separate request. confirm_discount_terms requires one: without it the request is refused (400, naming the header).")]);
add("/v1/imports","post","importRecords","ImportResult","ImportInput",[merchant,optionalKey("Only a commit (commit true) uses it: a preview writes nothing.")]);
add("/v1/customers/{id}/timeline","get","getCustomerTimeline","Timeline",null,[pathParam("id"),merchant]);
add("/v1/reports","get","getReports","Report",null,[merchant]);
add("/v1/gates","get","getGates","Gates",null,[merchant]);
add("/v1/settings","get","getSettings","Settings",null,[merchant]);
add("/v1/settings","patch","updateSettings","Settings","SettingsInput",[merchant,optionalKey()]);
add("/v1/exports","post","createExport","ExportResult","ExportInput",[merchant,optionalKey()]);
add('/v1/exports/{id}','get','getExportJob','ExportResult',null,[pathParam('id'),merchant]);
add('/v1/exports/{id}/retry','post','retryExportJob','ExportResult',null,[pathParam('id'),merchant,optionalKey()]);
paths["/v1/exports/{id}/download"]={get:{operationId:"downloadExport",tags:["valopay"],parameters:[pathParam("id"),merchant],responses:{"200":{description:"Private verified export bytes",content:{"application/octet-stream":{schema:{type:"string",format:"binary"}}}},"404":{description:"Export not found in tenant"}}}};
paths["/v1/openapi.json"]={get:{operationId:"getOpenApiDocument",tags:["valopay"],responses:{"200":{description:"Versioned public API specification",content:{"application/json":{schema:{type:"object",additionalProperties:true}}}}}}};
paths["/v1/webhooks/{provider}"]={post:{operationId:"disabledProviderWebhook",tags:["valopay"],parameters:[pathParam("provider")],responses:{"403":{description:"Disabled until a provider-specific signed adapter is configured. No events are processed."}}}};
describe("/healthz","get","Liveness: the process answers, with its build, uptime and scheduler state","Never touches the database, so a database outage does not read as a dead process: the scheduler's backlog is what the process last read, at the end of a pass or, where a scheduled job runs the closes, at the scheduler's interval, counted without naming a lender. Needs no sandbox or sign-in, and answers whether or not Clerk is configured. At most 120 health checks a minute per client network, both health addresses together (an IPv6 client's network is its /64).");
describe("/readyz","get","Readiness: one bounded round trip to the database, which also checks its schema","Answers 503 with status degraded while the database does not answer within the check's time limit, or lacks a table, column, unique index or check constraint this build needs, or still holds a guard it replaced. A missing read index leaves the answer ready, with checks.schema.status indexes_missing, since every request still works, only slower. The log names what is missing and where it comes from, and any connection error; the answer does not. Probes share one check: while it runs every probe waits for it, and its answer is reused for a second after it finishes, so a burst makes one database round trip. Needs no sandbox or sign-in, and answers whether or not Clerk is configured. At most 120 health checks a minute per client network, both health addresses together.");
describe("/v1/workspace","get","The caller's workspace: its lenders, roles and actor","On a first visit an anonymous caller gets a new synthetic sandbox with two lenders, and the sandbox cookie that names it on every later request (components.securitySchemes.sandboxCookie); a signed-in person gets their own workspace. New sandboxes are limited per client network (20 an hour; an IPv6 client's network is its /64, and a /48 starts at most 60) and per server (300 an hour, which hold back only a network that has already started one in its hour: a network's first is never refused because of others). A browser that sends two different sandbox cookies is refused (400) rather than guessed between.");
describe("/v1/overview","get","The operations overview for one lender","Metrics, queues, recent activity (the eight latest audit entries), upcoming due items, the last and next daily close, and the alerts feed (NFR-OBS-02), whose audit check covers the entries since the last one verified, or since the chain's head once the lender keeps a break. The last one verified stays before the first entry that breaks the chain. This read stores nothing: once a completed write, verify_audit or the daily check that follows the lender's first daily close of the day has recorded a break, the lender keeps it, and it stays in the feed after any later write until a check of the whole chain (verify_audit or the daily check) finds the chain valid again. A break only this check has found clears if the chain is repaired before one of them records it.");
describe("/v1/records/{kind}","get","Records of one kind for one lender, newest first","Filtered by status and by a search that ignores case and accents; paged with limit and offset; updatedSince for incremental sync; allocatable for the instalments that can take an allocation, and with paymentId the ones a manual allocation of that payment accepts. Closes are listed, and searched, as their summaries, as the reports have earlier closes: without operational and metrics, and with the report reduced to its unallocated and exceptions totals; GET /v1/close-history/{id} returns a close whole.");
describe("/v1/records/{kind}","post","Create a record of an editable kind","Validated against the kind's data schema; a status only a domain action may set is refused.");
describe("/v1/records/{kind}/{id}","patch","Update a record","Editable kinds only; an approved, preregistered or closed version is immutable. data is merged over the stored data as a merge patch: a field left out keeps its value and a field sent as null is removed, which is how an edit clears an optional field. expectedUpdatedAt is required: the updatedAt of the record the edit was made on. A request without it is refused (400, naming it) and saves nothing; a record changed since is 409, leaving the edit unapplied. An identical successful Idempotency-Key replay returns its original result before checking the version.");
describe("/v1/actions","post","Run a domain action on the lender's state","Every action is audited, most require a reason, and the persona's role applies; the catalogue of actions is in docs/frontend-contract.md. confirm_allocation and reject_allocation require data.proposalId and data.proposalUpdatedAt (AllocationDecisionData), with recordId the payment: a request without either is refused (400, naming it) and saves nothing. A proposal another has replaced, or that has changed since it was read, is 409; a payment with no proposal left to decide is refused (400). confirm_discount_terms requires an Idempotency-Key and data.discountStartDate, data.fullPriceStartDate and data.discountTermsReference (DiscountConfirmationData), with recordId the commercial terms: the confirmer must be a different person from the proposer (403), and terms with nothing awaiting confirmation, or a proposal that differs from the data, are 409. expectedUpdatedAt is optional, except for resolve_exception on a coordinated case; sent, it is the updatedAt of the record recordId names, and a record changed since is 409.");
describe("/v1/imports","post","Preview or commit a synthetic CSV import","commit=false validates every row and reports each; commit=true persists all rows or none. syntheticOnly must be true: no real lender data. Every row needs a source row ID from the identityColumn column; a row already imported with the same data is skipped, and one with different data is refused. An invalid row reports every failing rule, naming the operator's column, with the record API's words in detail.");
describe("/v1/customers/{id}/timeline","get","A customer's position and complete timeline","Every event, mandate, due item and payment, with each retry decision as it was recorded.");
describe("/v1/reports","get","Reports for one lender","Metrics, the billing statement and invoices, the recovery experiment, operational measurement (Test 5) and the daily closes with their REC-07 reports.");
describe("/v1/gates","get","Production readiness gates","Prerequisites and decisions, always unproven on synthetic data, and the limitations the sandbox cannot remove.");
describe("/v1/settings","get","A lender's settings, permissions, integrations, members and calendar","Permissions are those of the caller's current persona.");
describe("/v1/settings","patch","Change a lender's execution settings","Admin only. expectedRevision is required: the revision of the settings originally opened. A request without it is refused (400, naming it) and saves nothing; 409 leaves outdated edits unapplied. The revision covers editable preferences and is unaffected by scheduler cursor changes. An identical successful Idempotency-Key replay returns its original result before checking the version.");
describe("/v1/exports","post","Queue a private export","Durably saves a queued export job and returns immediately. Poll its status before downloading. Rendering and private storage run outside the database transaction; retries use the same immutable object key. A record kind, gate pack, billing statement or customer dispute pack supports JSON, CSV or PDF. A dispute pack (either name), the customer register or the audit trail is queued only by an Admin, Finance or Compliance reviewer (403 otherwise).");
describe('/v1/exports/{id}','get','Check a saved export','Tenant-authorised status, safe failure reason and checksum/download details once ready. Older immediate export records remain downloadable.');
describe('/v1/exports/{id}/retry','post','Retry a saved export','Requeues a failed or expired job while preserving its identity and private object key. Running and ready jobs are returned unchanged; retries cannot overwrite a completed file. A dispute pack, the customer register or the audit trail is retried only by an Admin, Finance or Compliance reviewer (403 otherwise).');
describe("/v1/exports/{id}/download","get","Download an export","The bytes are read from private storage and checked against the recorded SHA-256 before any are sent. A dispute pack (either name), the customer register or the audit trail is downloaded only by an Admin, Finance or Compliance reviewer (403 otherwise); every role may read a job's status.");
describe("/v1/openapi.json","get","This specification","The versioned public contract the console and the generated clients are built from.");
describe("/v1/webhooks/{provider}","post","Generic provider webhook address, always refused","Always 403: no event is processed here. Paystack test events go to POST /v1/providers/paystack/{connectionId}/events.");
const schemaDescriptions = {
  HealthStatus: "The liveness answer: the build, when the process started, its uptime, close scheduler and background worker observations. Background status is optional for older builds. Liveness stays ok while a worker fails; the monitor separately raises worker incidents.",
  BackgroundStatus: "This instance's worker, independently of scheduler mode. The main thread timestamps heartbeats received every 10 seconds; starting or running becomes stale after 45 seconds without one. restartCount counts new start attempts after the first; crashCount includes failed starts and unexpected exits. Both reset with the API process, not after a steady worker run. No tenant identities or error bodies are exposed.",
  BackgroundJobs: "Which jobs this instance configured in its worker. Enabled describes configuration, not evidence of a successful job. Restricted tenant runtimes leave service cleanup disabled.",
  BackgroundCleanup: "The worker's most recent bounded cleanup pass and aggregate queue read. Empty polls count as success only when no persisted failed or parked tombstones remain. A rejected pass/read, deferred removal, or pendingFailures or parked above zero is failed; lastSuccessAt remains the last successful check. Null lastResult means no check or a rejected check. After a restart, pending until this worker checks; older timestamps remain evidence. Stale after three intervals plus 15 seconds without a completed check. This is not proof all queued files were deleted; ordinary leases or delayed work can remain.",
  CleanupPassResult: "Attempted, removed and deferred counts from one bounded pass, plus two counts of durable cleanup tombstones: pendingFailures, those whose last attempt failed and that wait for a retry, including leased or delayed retries; and parked, those whose stored file's ownership, generation or checksum metadata did not match, parked for an operator's review with no further automatic attempt. A quiet poll or another file's success clears neither. parked is absent from builds before files were parked, which count such files among pendingFailures. No storage paths or tenant identities. Use the operator cleanup status command for full backlog depth and age, and to release or re-queue a parked file.",
  SchedulerRun: "The last scheduler pass that found work: its id, when it ran, how long it took, how many batches it read and what it did, including idle sandboxes whose automatic close it paused.",
  SchedulerStatus: "Whether closes are scheduled in this process, how often it looks, when it last looked, its last pass with work and what it last read as still owed.",
  SchedulerBacklog: "The lenders still owed a scheduled close, as this process last read them from the database, counted without naming any: overdue, those whose automatic close is on and whose pending close is more than lateAfterMinutes past its time; failing, those with a failed scheduled attempt at their pending time, which only that lender's own close, or a change to its schedule, ends: not other lenders' closes, nor a restart. Neither counts public anonymous sandboxes, whose own counts are publicSandboxes. checkedAt is when they were read, on the API host's clock.",
  SchedulerPublicSandboxes: "The same counts for public anonymous sandboxes, the synthetic lenders a visitor's sandbox is seeded with or creates, whose own data can make a close fail: counted apart from the lenders, so they never raise an incident or fail the one-shot close pass. Absent from builds before they were counted apart, which count them among the lenders.",
  DatabaseCheck: "One round trip to the database and how long it took.",
  SchemaCheck: "Whether the database holds every table, column, unique index, check constraint and read index this build needs, and no guard it replaced: ok, indexes_missing (ready, some reads slower), incomplete (not ready) or unchecked while the database does not answer. The server log, not the answer, names what is missing or replaced.",
  ReadinessStatus: "The readiness answer: ok, or degraded while the database does not answer, lacks a table, column, unique index or check constraint this build needs, or still holds a guard it replaced.",
  RecordData: "A record's data: the fields the kind's schema declares, and anything else a caller stored.",
  ValopayRecord: "A stored record of any kind, with its lender, status, reference, amount and data. amountKobo is in kobo, except where a kind with a currency field (a payment, payment evidence, or an exception about money in another currency) names another currency in data.currency: it then holds that currency's minor units (cents for USD). A data.currency on any other kind, such as a currency column an import kept as detail on an instalment, is not the amount's currency: that amount is in kobo.",
  RecordInput: "A new record: only the name is required, and it cannot be empty; the kind's default status applies when none is given. A status is at most 100 characters, a reference 200 and a customerId 100.",
  RecordUpdate: "The fields to change on a record, with the version they were made on (expectedUpdatedAt, required); omitted fields keep their values. In data, a field sent as null is removed. A name cannot be empty, and a status, reference or customerId is bounded as a new record's is.",
  Merchant: "A lender: its mode (observation or instruction), provider, volume, kill switch and readiness flags.",
  Workspace: "The caller's workspace: who is acting, in which role, whether they signed in, and the lenders and roles available.",
  Metric: "A named measurement with its unit and the basis it was derived from.",
  Alert: "An NFR-OBS-02 alert: what condition holds, how severe it is, since when and the record it points at.",
  Overview: "The overview: metrics, queues, recent activity, upcoming due items, the close schedule and the alerts.",
  RecordList: "One page of records with the filtered total; nextOffset is present while more rows remain.",
  ActionInput: "An action to run: its name, the record it applies to, the reason for it and any data it needs. For confirm_allocation and reject_allocation, data is an AllocationDecisionData, and for confirm_discount_terms a DiscountConfirmationData: all of their fields are required.",
  ActionResult: "What an action did, in words, with the record it produced or changed and any data it returns.",
  ImportInput: "A synthetic CSV to preview or commit for one kind, with its source row ID column and an optional column mapping.",
  ImportRow: "The outcome of one imported row: valid, invalid or duplicate (already imported). An invalid row's message names each failing rule's column in the operator's words; detail keeps the record API's words.",
  ImportResult: "How many rows were valid, invalid and imported, and each row's outcome. warnings, when present, says which name or reference came from a fallback (the reference, a row number or a generated reference) while a column was left unused, and the check and the commit are not refused for it.",
  Report: "The reports: metrics, billing, the experiment, operational measurement and the daily closes.",
  ReportBilling: "Billing statement and invoice history, preserving the existing free-form fields and optionally reporting historical rate-comparison coverage.",
  InvoiceRateComparison: "One issued invoice's rate-check result, its effective agreement when present, and the reason it agrees, differs or cannot yet be compared.",
  RateComparisonCoverage: "Coverage of historical invoice rate checks: checked includes agreeing and differing invoices; unchecked invoices remain visible with their identities and causes.",
  Gate: "One readiness gate: what it needs, its status and the evidence recorded.",
  Gates: "The prerequisites and decisions, the sandbox's limitations, and the cash and burn figures used for the funding decision.",
  OtherCurrencies: "Money in currencies other than naira, by currency code: how many payments hold it and their amount in that currency's minor unit (cents for USD). It is never added to a naira total.",
  CustomerPosition: "A customer's position (REC-05), derived from every related record: the naira obligations, allocations, outstanding balance and unapplied credit (unallocatedKobo, naira only), and, only when the customer's payments in another currency hold unapplied money, that money by currency beside it (unallocatedOtherCurrencies), as the dispute pack lists it.",
  Timeline: "A customer, their derived position, and every related event, mandate, due item and payment.",
  Settings: "A lender's settings and the caller's permissions, with integrations, members and the business calendar.",
  SettingsInput: "The execution settings to change, with the revision they were made on (expectedRevision, required); every other field is optional.",
  ExportInput: "What to export (a record kind, gate-pack, billing, dispute-pack or customer-pack with a customerId) and in which format.",
  ExportResult: "Saved export job identity, status and retry details. Checksum, generatedAt and file size appear only when ready; the download route rejects unfinished jobs. expiredAt appears only after an approved retention run deleted the job's file, and is the time of that deletion, not a scheduled expiry: the download and the retry then answer 410, and a ready job keeps its checksum. retentionRunId names that run, whose deletion receipt an administrator opens with GET /v1/lifecycle/runs/{id}. No answer gives a ready file an expiry date, because a file is removed only by an approved retention run, apart from an idle anonymous sandbox, which the expiry sweep deletes whole with its files (docs/deployment.md); a hold or an evidence link can keep a file for longer than the lender's retention period. Optional status retains compatibility with older immediate-export responses.",
  EffectiveCloseSchedule: "Lender schedule combined with the actual scheduler service status. nextAt is present only when automatic closes are available; run history belongs only to this lender. failedAttempts and retryAt describe failed automatic attempts at the pending time (retryAt only while automatic closes are available); pausedForInactivityAt says when the scheduler switched off the automatic close of a sandbox nobody changed. Answers from earlier builds may lack these three fields.",
};
for (const [name, description] of Object.entries(schemaDescriptions)) schemas[name].description = description;
// Priority queues keep complete counts while returning only a bounded page and its linked records.
schemas.QueuePage = {
  "type": "object",
  "required": [
    "items",
    "related",
    "total",
    "offset",
    "counts",
    "owners",
    "types",
    "asOf"
  ],
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "$ref": "#/components/schemas/ValopayRecord"
      }
    },
    "related": {
      "type": "array",
      "items": {
        "$ref": "#/components/schemas/ValopayRecord"
      }
    },
    "total": {
      "type": "integer",
      "minimum": 0
    },
    "offset": {
      "type": "integer",
      "minimum": 0
    },
    "counts": {
      "type": "object",
      "additionalProperties": {
        "type": "integer",
        "minimum": 0
      }
    },
    "owners": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "types": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "asOf": {
      "type": "string"
    }
  },
  "description": "A bounded priority queue page with complete filter counts, available owners and types, the applied offset and lender-scoped linked records. Counts are calculated before pagination. asOf is the timestamp used to determine overdue and due-today states: a deadline written as a day alone (YYYY-MM-DD) is due all that West Africa Time day and overdue once it ends, one with a time passes at that instant, and one that is not a real date is no deadline."
};
paths["/v1/queues/{queue}"] = {
  "get": {
    "operationId": "listQueue",
    "tags": [
      "valopay"
    ],
    "summary": "A priority-sorted, lender-scoped queue with complete filter counts and page-specific linked records",
    "parameters": [
      {
        "name": "queue",
        "in": "path",
        "required": true,
        "schema": {
          "type": "string",
          "enum": [
            "exceptions",
            "mandates",
            "collections"
          ]
        },
        "description": "Priority queue to read: exceptions, mandates or collections."
      },
      {
        "name": "merchantId",
        "in": "query",
        "required": true,
        "schema": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "description": "The active lender, belonging to the caller’s workspace. Missing or empty, the request is refused with 400 naming merchantId."
      },
      {
        "name": "view",
        "in": "query",
        "required": false,
        "schema": {
          "type": "string",
          "maxLength": 200
        },
        "description": "A supported view for the queue. Defaults to open for exceptions and all for mandates and collections."
      },
      {
        "name": "owner",
        "in": "query",
        "required": false,
        "schema": {
          "type": "string",
          "maxLength": 200
        },
        "description": "Exact owner filter. Omit for every owner."
      },
      {
        "name": "type",
        "in": "query",
        "required": false,
        "schema": {
          "type": "string",
          "maxLength": 200
        },
        "description": "Exact exception type filter. Omit for every type."
      },
      {
        "name": "record",
        "in": "query",
        "required": false,
        "schema": {
          "type": "string",
          "maxLength": 200
        },
        "description": "Select this exact record in the queue instead of applying its view, within the active lender."
      },
      {
        "name": "target",
        "in": "query",
        "required": false,
        "schema": {
          "type": "string",
          "maxLength": 200
        },
        "description": "Locate the page containing this record among the filtered results. Does not bypass filters."
      },
      {
        "name": "limit",
        "in": "query",
        "required": false,
        "schema": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        },
        "description": "Page size, default 25 and maximum 100."
      },
      {
        "name": "offset",
        "in": "query",
        "required": false,
        "schema": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2147483647
        },
        "description": "Rows to skip after filtering and priority ordering. Clamped to the last available page if results shrink."
      }
    ],
    "responses": {
      "200": {
        "description": "Success",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/QueuePage"
            }
          }
        }
      },
    },
    "description": "Filters and priority order are applied before pagination. Counts cover the full filtered queue. Related records only support the current page and remain in the same lender. A target locates the page containing a linked record; an unavailable or filtered-out target leaves the requested page unchanged. Dates use West Africa Time and the returned asOf timestamp."
  }
};

const queueOperation = paths['/v1/queues/{queue}'].get;
queueOperation.parameters.push({name:'q',in:'query',schema:{type:'string',maxLength:200},description:'Literal accent-insensitive customer name, customer reference or queue record name/reference search, applied before counting and paging.'});
schemas.ReconciliationPage = obj({items:arr('ValopayRecord'),related:arr('ValopayRecord'),total:num,offset:num,asOf:str,precision:ref('RecordData')},['items','related','total','offset','asOf']);
schemas.ReconciliationPage.description = 'A database-filtered reconciliation queue page, with complete count and lender-scoped linked evidence. Precision metadata describes the complete seeded monthly sample.';
const pageParams = [{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:100},description:'Page size; defaults to 25.'},{name:'offset',in:'query',schema:{type:'integer',minimum:0,maximum:2147483647},description:'Rows to skip; clamped when the result shrinks.'}];
add('/v1/reconciliation/{queue}','get','listReconciliation','ReconciliationPage',null,[merchant,{name:'queue',in:'path',required:true,schema:{type:'string',enum:['proposals','duplicates','payments','observations','audit','batches']},description:'Reconciliation work queue.'},{name:'dueItem',in:'query',schema:{type:'string',maxLength:200},description:'Optional instalment focus; payment queues are restricted to its customer, proposals to its exact instalment.'},...pageParams]);
describe('/v1/reconciliation/{queue}','get','Page a reconciliation work queue','Filters and counts in PostgreSQL before paging. Linked payment, instalment and customer records belong to the same lender. Audit uses the reproducible previous-month sample including superseded reviewed matches.');
schemas.CloseHistoryPage = obj({items:arr('ValopayRecord'),total:num,allTotal:num,offset:num,first:ref('ValopayRecord'),latest:ref('ValopayRecord')},['items','total','allTotal','offset']);
schemas.CloseHistoryPage.description = 'Paged close summaries and first/latest closing positions for the entire WAT date range; full REC-07 evidence is fetched separately.';
add('/v1/close-history','get','listCloseHistory','CloseHistoryPage',null,[merchant,...['from','to'].map(name=>({name,in:'query',schema:{type:'string',maxLength:10},description:'Inclusive date in YYYY-MM-DD format, in West Africa Time.'})),...pageParams]);
describe('/v1/close-history','get','Page recorded daily closes','Newest first, with complete range counts and whole-range comparison endpoints. Missing historical measures remain absent. Invalid dates or reversed ranges are rejected.');
add('/v1/close-history/{id}','get','getCloseDetail','ValopayRecord',null,[merchant,{name:'id',in:'path',required:true,schema:idSchema,description:'Close record in the active lender.'}]);
describe('/v1/close-history/{id}','get','Read the evidence for one recorded close','Returns the full immutable close report on demand within the current lender.');
paths['/v1/reports'].get.parameters.push({name:'includeCloses',in:'query',schema:{type:'string',enum:['true','false']},description:'Default true for compatibility: the close array, where closes more than a week before the latest carry their summary (GET /v1/close-history/{id} returns any close whole). The console passes false and loads paged close summaries separately.'});

paths['/v1/reconciliation/{queue}'].get.parameters.push({name:'q',in:'query',schema:{type:'string',maxLength:200},description:'Literal case- and accent-insensitive customer, payment or instalment name/reference search before counting and paging. Audit sample metadata remains unfiltered.'});
const historySections=['events','mandates','dueItems','payments'];
schemas.CustomerHistoryCounts=obj(Object.fromEntries(historySections.map(key=>[key,num])),historySections);
schemas.CustomerHistoryCounts.description='Complete counts or actual offsets for the four customer-history sections.';
schemas.CustomerHistory=obj({...schemas.Timeline.properties,totals:ref('CustomerHistoryCounts'),offsets:ref('CustomerHistoryCounts'),focusedRecord:ref('ValopayRecord')},[...schemas.Timeline.required,'totals','offsets']);
schemas.CustomerHistory.description='Bounded pages of customer records with balances derived from every related record, full section counts and an optional lender-scoped selected record.';
add('/v1/customers/{id}/history','get','getCustomerHistory','CustomerHistory',null,[merchant,{name:'id',in:'path',required:true,schema:idSchema,description:'Customer in the active lender.'},{name:'record',in:'query',schema:{type:'string',maxLength:200},description:'Optional selected history record; must belong to this customer and lender.'},...historySections.flatMap(section=>pageParams.map(p=>({...p,name:section+p.name[0].toUpperCase()+p.name.slice(1)})))]);
describe('/v1/customers/{id}/history','get','Page a customer history with complete balances','Each section is independently paged in SQL, newest first with stable ID ordering. Counts and monetary aggregates are calculated before paging; no partial state may be written. Unknown customers return 404. The existing timeline endpoint retains its full-history contract.');
// ---- Console-facing operations: shapes from the shared zod definitions ----
// Their request and response shapes are the shared zod definitions in lib/valo-pay-1-schema,
// translated here, so the contract cannot drift from what the routes validate and the console
// reads: the API checks every answer against them before it is sent.
require("tsx/cjs");
const shared = require("../lib/valo-pay-1-schema/src/index.ts");
/** zod definitions already written as a component: a later definition that uses one refers to it. */
const named = new Map();
/** Hand-described components with a zod twin: open objects, so a definition that extends one is allOf the component and its own fields. */
const twins = new Set();
function fromZod(schema, self) {
  if (schema !== self && named.has(schema)) return ref(named.get(schema));
  const def = schema._def, kind = def.typeName, described = (out) => schema.description ? { ...out, description: schema.description } : out;
  switch (kind) {
    case "ZodObject": {
      const shape = def.shape();
      for (const base of twins) {
        if (base === schema || base._def.typeName !== "ZodObject") continue;
        const baseShape = base._def.shape(), keys = Object.keys(baseShape);
        if (Object.keys(shape).length > keys.length && keys.every((key) => shape[key] === baseShape[key])) {
          const properties = {}, required = [];
          for (const [key, value] of Object.entries(shape)) if (!(key in baseShape)) { properties[key] = fromZod(value); if (!value.isOptional()) required.push(key); }
          return described({ allOf: [ref(named.get(base)), { type: "object", properties, ...(required.length ? { required } : {}) }] });
        }
      }
      const properties = {}, required = [];
      for (const [key, value] of Object.entries(shape)) { properties[key] = fromZod(value); if (!value.isOptional()) required.push(key); }
      const out = { type: "object", properties, ...(required.length ? { required } : {}) };
      if (def.unknownKeys === "strict") out.additionalProperties = false;
      else if (def.catchall && def.catchall._def.typeName !== "ZodNever") out.additionalProperties = fromZod(def.catchall);
      return described(out);
    }
    case "ZodString": {
      const out = { type: "string" };
      for (const check of def.checks) {
        if (check.kind === "min") out.minLength = check.value; else if (check.kind === "max") out.maxLength = check.value;
        else if (check.kind === "length") out.minLength = out.maxLength = check.value; else if (check.kind === "regex") out.pattern = check.regex.source;
        else if (check.kind === "datetime") out.format = "date-time"; else if (check.kind === "email") out.format = "email";
        else if (check.kind === "uuid") out.format = "uuid"; else if (check.kind === "url") out.format = "uri";
        else if (check.kind === "startsWith") out.pattern = `^${check.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
      }
      return described(out);
    }
    case "ZodNumber": {
      const out = { type: def.checks.some((check) => check.kind === "int") ? "integer" : "number" };
      for (const check of def.checks) {
        if (check.kind === "min") out[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value;
        else if (check.kind === "max") out[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value;
      }
      return described(out);
    }
    case "ZodBoolean": return described({ type: "boolean" });
    case "ZodNull": return described({ type: "null" });
    case "ZodDate": return described({ type: "string", format: "date-time" });
    case "ZodLiteral": return described({ type: def.value === null ? "null" : typeof def.value === "boolean" ? "boolean" : typeof def.value === "number" ? (Number.isInteger(def.value) ? "integer" : "number") : "string", const: def.value });
    case "ZodEnum": return described({ type: "string", enum: [...def.values] });
    case "ZodNativeEnum": return described({ enum: Object.values(def.values) });
    case "ZodArray": {
      const out = { type: "array", items: fromZod(def.type) };
      if (def.exactLength) out.minItems = out.maxItems = def.exactLength.value;
      else { if (def.minLength) out.minItems = def.minLength.value; if (def.maxLength) out.maxItems = def.maxLength.value; }
      return described(out);
    }
    case "ZodTuple": return described({ type: "array", prefixItems: def.items.map((item) => fromZod(item)), minItems: def.items.length, maxItems: def.items.length });
    case "ZodRecord": return described({ type: "object", additionalProperties: fromZod(def.valueType) });
    case "ZodUnion": return described({ anyOf: def.options.map((option) => fromZod(option)) });
    case "ZodDiscriminatedUnion": return described({ oneOf: [...(def.options.values ? def.options.values() : def.options)].map((option) => fromZod(option)) });
    case "ZodIntersection": return described({ allOf: [fromZod(def.left), fromZod(def.right)] });
    case "ZodNullable": {
      const inner = fromZod(def.innerType);
      return described(typeof inner.type === "string" && !inner.enum && inner.const === undefined ? { ...inner, type: [inner.type, "null"] } : { anyOf: [inner, { type: "null" }] });
    }
    case "ZodOptional": return described(fromZod(def.innerType));
    case "ZodDefault": return described({ ...fromZod(def.innerType), default: def.defaultValue() });
    case "ZodEffects": return described(fromZod(def.schema));
    case "ZodPipeline": return described(fromZod(def.in));
    case "ZodBranded": case "ZodReadonly": case "ZodCatch": return described(fromZod(def.type ?? def.innerType));
    case "ZodLazy": return described(fromZod(def.getter()));
    case "ZodAny": case "ZodUnknown": return described({});
    default: throw new Error(`The contract generator cannot describe a ${kind}; extend fromZod.`);
  }
}
// A component from a shared zod definition, and one described by hand. Both carry a description (documentation check).
const derived = (name, zodSchema, description) => { schemas[name] = { ...fromZod(zodSchema, zodSchema), description }; named.set(zodSchema, name); return ref(name); };
const described = (name, schema, description) => { schemas[name] = { ...schema, description }; return ref(name); };
/** A hand-described component the shared definitions also describe: the two must agree field for field, and later definitions refer to the component. */
function twin(name, zodSchema) {
  const plain = (value) => {
    if (Array.isArray(value)) return value.map(plain);
    if (!value || typeof value !== "object") return value;
    if (value.$ref) return plain(schemas[value.$ref.replace("#/components/schemas/", "")]);
    // A nullable enum is written either way: as a type list with null among its values, or as anyOf the enum and null.
    if (Array.isArray(value.type) && value.type.includes("null") && Array.isArray(value.enum) && value.enum.includes(null)) {
      const types = value.type.filter((type) => type !== "null");
      return plain({ anyOf: [{ ...value, type: types.length === 1 ? types[0] : types, enum: value.enum.filter((item) => item !== null) }, { type: "null" }] });
    }
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description" && key !== "additionalProperties").map(([key, item]) => [key, plain(item)]));
  };
  const written = plain(schemas[name]), translated = plain(fromZod(zodSchema, zodSchema));
  if (JSON.stringify(written) !== JSON.stringify(translated)) throw new Error(`${name} and its shared zod definition disagree:\n${JSON.stringify(written)}\n${JSON.stringify(translated)}`);
  named.set(zodSchema, name);
  twins.add(zodSchema);
}
twin("RecordData", shared.recordDataSchema);
twin("ValopayRecord", shared.valopayRecordSchema);
twin("Merchant", shared.merchantSchema);
// The record API's confirmations, which the console checks with these shared twins rather than the generated contract.
twin("ActionResult", shared.actionResultSchema);
twin("ImportRow", shared.importRowSchema);
twin("ImportResult", shared.importResultSchema);
twin("EffectiveCloseSchedule", shared.effectiveCloseScheduleSchema);
twin("Settings", shared.settingsViewSchema);
twin("ExportResult", shared.exportResultSchema);
// A record's name is never empty, and its indexed text is bounded (recordTextLimits): an over-long value is refused, naming its field, before anything is saved.
for (const name of ["RecordInput", "RecordUpdate"]) {
  schemas[name].properties.name = { type: "string", minLength: 1 };
  for (const field of ["status", "reference", "customerId"]) schemas[name].properties[field] = { type: "string", maxLength: shared.recordTextLimits[field] };
}
const journalOffset = { name: "offset", in: "query", schema: { type: "integer", minimum: 0, maximum: 100000 }, description: "Rows to skip in the newest-first order; pages hold 25 rows." };
const operation = (path, method, id, response, body, params, summary, description) => { add(path, method, id, response, body, params); describe(path, method, summary, description); };

// The data an allocation decision requires, as the domain validates it; ActionInput's data stays open for the other actions.
derived("AllocationDecisionData", shared.allocationDecisionDataSchema, "The data confirm_allocation and reject_allocation require (POST /v1/actions, recordId the payment): the proposed allocation the decision was made on, by its id and the updatedAt it was read with. Both are required: a request without either is refused (400, naming data.proposalId or data.proposalUpdatedAt) and saves nothing. A proposal another has replaced, or that has changed since it was read, is 409; a payment with no proposal left to decide is refused (400). Other fields are ignored.");
derived("DiscountConfirmationData", shared.discountConfirmationDataSchema, "The data confirm_discount_terms requires (POST /v1/actions, recordId the commercial terms, with an Idempotency-Key): the proposed discount dates and signed agreement reference the confirmer checked against the signed agreement. All three are required: a request without one is refused (400, naming it) and saves nothing. The confirmer must be an Admin or Finance user other than the person who proposed the dates, whatever demo role they switch to (403). Terms whose dates await no confirmation, or whose proposal differs from these values, are 409 with the reason. Other fields are ignored.");

// The error body every refusal and failure carries.
derived("ErrorDetail", shared.errorDetailSchema, "One field a request got wrong: its dotted path (a query value or header by its name) and what is wrong with it.");
derived("ErrorBody", shared.errorBodySchema, "The body of every refusal and failure: what happened in plain words and the request's reference, with the fields validation refused (at most 20, and how many there were), the staff-access or money refusal code, whether nothing was saved (committed false) and the state of the request's journal entry (operation).");

// Connected workspace: the Credit Desk and Cash Desk documents, the workspace and its actions.
derived("CreditAssessmentResult", shared.creditAssessmentResultSchema, "An illustrative synthetic credit assessment: evidence, features, rule score, affordability and policy recommendation. Never a probability of default or a lending decision; features, score and affordability are null when the evidence or authority does not allow them.");
derived("CreditReview", shared.creditReviewViewSchema, "A recorded sandbox review of one assessment version; never an actual lending decision and never moves funds.");
derived("CreditDesk", shared.creditViewSchema, "The Credit Desk: the current permissions of each applicant holding any (the applicants are the workspace's customers, listed once; one not listed here holds neither), assessments with their reviews, the illustrative rulecard and the closed credit gate.");
derived("CashForecast", shared.cashForecastSchema, "Base and downside cash forecasts from approved commitments: a planning estimate, not an available balance.");
derived("ErpManifest", shared.erpManifestSchema, "A reviewed accounting export: what an ERP would receive. The service never posts it.");
derived("VatSchedule", shared.vatScheduleSchema, "A VAT evidence review schedule reconciled to the ledger control: never a filed return or a payment.");
derived("PayrollPlan", shared.payrollPlanSchema, "A funding plan for an approved net-pay run: maker, checker, funding state and each item's state. It pays nobody.");
derived("PayrollManifest", shared.payrollManifestSchema, "An approved payroll bank export: the unsent items and their totals. It does not reserve funds or prove payment.");
derived("CashDesk", shared.cashViewSchema, "The Cash Desk: a separate sample SME's accounts, positions, commitments, forecast, accounting drafts, VAT schedules and payroll plans, as its permissions allow.");
derived("ConnectedWorkspace", shared.connectedViewSchema, "Synthetic connected workspace: granular consents with their effective state, bound sample payment intents, the Credit and Cash Desks and the live gates, every one closed. payments.heldForReversalReview names the instalments offered or named by a checkout that reconciliation holds for a renewed review of an earlier reversal decision: creating or authorising a checkout for one is refused (409) until that review is resolved and reconciliation runs. No read creates sample records.");
derived("ConnectedActionInput", shared.connectedActionInputSchema, "Action-specific data is validated by the server. Names use consent, payment, credit or cash prefixes. Every action requires the workspace's current revision and a reason: the revision changes with anything the workspace shows or its actions read (the lender and its settings, customers, the instalments it offers, a checkout names or a receipt was applied to and their attempts, connected records, and pay-by-bank receipts with their allocations), not with the lender's history (closes, the audit trail, exports, settled instalments or other payments). No input can enable live routes.");
derived("CashActionOutcome", shared.cashActionOutcomeSchema, "What a Cash Desk action did: its message, the record it saved or changed, and any export it prepared.");
derived("ConnectedActionResult", shared.connectedActionResultSchema, "Committed sample operation, in the shape its action gives (connectedActionResultFor in lib/valo-pay-1-schema): a cash.* action answers its outcome with the Cash Desk record it saved or changed (absent only when the Cash Desk was already set up) and, for an export, the manifest it prepared; every other action answers the record it produced or changed, of the lender the request named: a consent for consent.*, a checkout for payment.*, an assessment for credit.assess and a review for credit.review. A receipt is evidence from the server simulator only.");
operation("/v1/connected", "get", "getConnectedWorkspace", "ConnectedWorkspace", null, [merchant], "Read the connected workspace", "Same-origin, private and tenant scoped. Returns granular consent state, bound sample payment intents, explained credit assessments, independent SME cash planning and closed live gates.");
operation("/v1/connected/actions", "post", "performConnectedAction", "ConnectedActionResult", "ConnectedActionInput", [merchant, requiredKey], "Perform a synthetic connected-workspace action", "Runs inside the existing merchant transaction and audit boundary. Role, purpose, subject, expiry, ownership and version checks apply. Unknown payment outcomes hold retries. A repeat with the same key is answered before the revision is checked. No bank, credit bureau, accounting or tax endpoint is called.");

// Operations journal (the recovery middleware and the pilot router).
derived("Message", shared.messageSchema, "A confirmation in plain words; nothing else changed that the caller needs to read back.");
derived("OperationSummary", shared.operationSummarySchema, "What an entry asked, safe to show: the action or route in plain words, the kind and ID of the record it names, and at most three short fields the request named (an action, a decision, a status, a kind or a format). Read from the stored request by field, never whole; it never holds a name, reference, reason, amount or file.");
derived("OperationView", shared.operationViewSchema, "One journal entry: what was asked, by whom, in which role, and whether the service confirmed it. Original request bodies stay private; `summary` says what the request asked, and is null when payload encryption sealed the request or retention removed its payload. A completed entry names the record it produced (`recordId` and `recordKind`, the kind of that record: `exports` for an export, whatever kind it exports). A refused entry is cancelled and its message says why.");
derived("OperationList", shared.operationListSchema, "The caller's journal for one lender, newest first, 25 rows a page.");
derived("PendingOperations", shared.pendingOperationsSchema, "How many of the caller's requests in the lender wait for confirmation.");
derived('OperationLookupInput', shared.operationLookupInputSchema, 'Opaque request identity retained by the browser for same-form reload recovery. No request body.');
derived('OperationLookup', shared.operationLookupSchema, 'The exact journal entry for this caller and original role, or null if not yet received.');
operation('/v1/operations/lookup', 'post', 'lookupOwnOperation', 'OperationLookup', 'OperationLookupInput', [merchant], 'Check an interrupted submission', 'Read-only lookup of the caller’s exact key in this lender and role. Absence does not prove a delayed request cannot arrive.');
operation('/v1/operations/cancel-unreceived', 'post', 'cancelOwnOperation', 'Message', 'OperationLookupInput', [merchant], 'Cancel an interrupted submission safely', 'Refuses a completed request or existing receipt. If not yet received, records a terminal fence so a delayed copy cannot execute.');
derived("OperationReplayResult", shared.operationReplaySchema, "The original route's answer, recovered or re-run under the current validation and authorisation; its shape is that route's response.");
operation("/v1/operations", "get", "listOperations", "OperationList", null, [merchant, journalOffset], "List the caller's recovery journal", "Every keyed, recoverable request the caller made in this lender, with its confirmation state. Read-only; private to the person who made the requests.");
operation("/v1/operations/pending", "get", "countPendingOperations", "PendingOperations", null, [merchant], "Count the caller's unconfirmed requests", "How many of the caller's journal entries in this lender are pending: requests the service received whose outcome was never confirmed. Read-only; the console shows it on the Operations link.");
operation("/v1/operations/{id}/retry", "post", "retryOperation", "OperationReplayResult", null, [pathParam("id"), merchant], "Recover or repeat a journaled request", "Re-enters the original route with the stored request and key under the current rules, so it can answer anything that route answers. A completed entry returns its saved result; a cancelled or refused one is refused (409); a different role cannot repeat it (403); a request whose stored payload expired under retention is gone (410).");
operation("/v1/operations/{id}/cancel", "post", "cancelOperation", "Message", null, [pathParam("id"), merchant], "Cancel an unconfirmed request", "Confirms with the server that the request never completed and closes it, so its key cannot run again. A completed entry, or one whose receipt already exists, is refused (409); one whose stored payload expired under retention is gone (410).");

// Pilot journey, import batches and case handover.
derived("JourneyCounts", shared.journeyCountsSchema, "Record counts that place the lender on the pilot journey: customers, committed batches, receipts, open and unassigned cases, closes and ready exports.");
derived("PilotJourney", shared.pilotJourneySchema, "The lender, the caller's access mode and the counts behind the journey view. Synthetic throughout.");
derived("ImportBatchList", shared.importBatchListSchema, "Import batches newest first, 25 a page, with their source identity, quality totals and check counts but not their rows. A batch saved before check summaries were stored is listed without check counts while the key service cannot open its check.");
derived("ImportBatchDetail", shared.importBatchDetailSchema, "One batch with its source rows (import operator roles only) and every saved revision.");
derived("BatchVersion", shared.batchVersionInputSchema, "The batch version being committed; a stale version is refused (409).");
derived("ImportBatchInput", shared.batchInputSchema, "A synthetic source batch: source, source batch ID, record kind, mapping, identity column, amount unit and up to 500 CSV rows. syntheticOnly must be true; raw bank details are refused.");
derived("Assignee", shared.assigneeSchema, "A person who can own a case or review a close: demo roles in the sandbox, active staff with lender access on a staff host.");
derived("EvidenceLink", shared.evidenceLinkSchema, "A record the case can cite as evidence.");
derived("CaseDetail", shared.caseDetailSchema, "One exception with the people it can be handed to, its handover events and the records it can cite.");
derived("CaseInput", shared.caseInputSchema, "A case handover or update: assignee, next action and its time, note and evidence, with the version being changed.");
derived("PilotLenderInput", shared.lenderInputSchema, "A new synthetic lender: name and segment. A sandbox workspace holds at most five lenders, the two samples included.");
operation("/v1/pilot/journey", "get", "getPilotJourney", "PilotJourney", null, [merchant], "Read the pilot journey counts", "Counts of the records each pilot step needs, for the journey page. No record is created by reading.");
operation("/v1/pilot/lenders", "post", "createPilotLender", "Merchant", "PilotLenderInput", [lenderKey], "Create a synthetic lender", "An administrator: on a staff host with recent MFA; in a sandbox, the demo Administrator. A sandbox workspace holds at most five lenders, the two samples included, and a sixth is refused (409). The key makes creation repeatable; the same key with different details is refused. A name that matches a lender already in the workspace, ignoring letter case and surrounding or repeated spaces, is refused (409) with an error naming that lender, in the sandbox and on a staff host alike, so a creation whose answer was lost and is sent again with a new key cannot make a second lender.");
operation("/v1/pilot/batches", "get", "listImportBatches", "ImportBatchList", null, [merchant, journalOffset], "List import batches", "Newest first, 25 a page, without source rows.");
operation("/v1/pilot/batches/{id}", "get", "getImportBatch", "ImportBatchDetail", null, [pathParam("id"), merchant], "Open an import batch", "The batch with its source rows and revisions. Import operator roles only (403); unknown batches are 404.");
operation("/v1/pilot/batches", "post", "saveImportBatch", "ValopayRecord", "ImportBatchInput", [merchant, optionalKey()], "Save a source batch", "Parses and checks the rows, screens them for raw bank details, and records the batch as ready or needing correction. A batch with the same source identity is refused (409).");
operation("/v1/pilot/batches/{id}/save", "post", "saveImportBatchRevision", "ValopayRecord", "ImportBatchInput", [pathParam("id"), merchant, optionalKey()], "Correct an uncommitted batch", "Saves a revision of the batch, keeping its source identity. A committed batch or a stale version is refused (409).");
operation("/v1/pilot/batches/{id}/commit", "post", "commitImportBatch", "ValopayRecord", "BatchVersion", [pathParam("id"), merchant, optionalKey()], "Commit a checked batch", "Imports the checked rows in one transaction and records the original source totals. A batch that is not ready, or a stale version, is refused (409).");
operation("/v1/pilot/cases/{id}", "get", "getCase", "CaseDetail", null, [pathParam("id"), merchant], "Open a case", "The exception with its possible assignees, handover history and citable evidence.");
operation("/v1/pilot/cases/{id}", "post", "coordinateCase", "ValopayRecord", "CaseInput", [pathParam("id"), merchant, optionalKey()], "Hand over or update a case", "Records the assignee, next action and evidence, with the version being changed. The next action must be in the future.");

// Team and readiness.
derived("StaffMember", shared.staffMemberSchema, "A staff membership: its role, state, expiry and version.");
derived("StaffAccess", shared.staffAccessSchema, "A membership's role and state, before or after a change.");
derived("StaffChangeRequest", shared.staffChangeRequestSchema, "A membership change that grants Admin, Finance or Compliance reviewer and waits for a second administrator: who asked, when and why. Approving it applies exactly this change; a later change to the membership leaves it out of date, and it is no longer listed.");
derived("StaffMemberChange", shared.staffChangeResultSchema, "A membership change's answer: the membership as it now stands, what happened in plain words, and the waiting request when the change needs a second administrator (the membership is then unchanged).");
derived("StaffDirectoryMember", shared.staffDirectoryMemberSchema, "A membership in the team directory, with the lenders it may open; an administrator opens every lender and lists none. A viewer who is not an administrator sees only the colleagues who share a lender with them, only the lenders they share, and no one's expiry but their own (expiresAt null).");
derived("StaffInvitation", shared.staffInvitationSchema, "A pending, accepted or revoked invitation, who sent it and whether it waits for, or has, the second administrator's approval an Admin, Finance or Compliance reviewer invitation needs; the token is shown once, at creation.");
derived("StaffEvent", shared.staffEventSchema, "One entry of the team's access history.");
derived("StaffDirectory", shared.staffDirectorySchema, "The team as the caller may see it: members as StaffDirectoryMember describes; lenders, invitations, changes awaiting a second administrator and history for administrators. In the sandbox every list, lenders included, is empty and the message says why.");
derived("InvitationInput", shared.invitationInputSchema, "An invitation: email address and pilot role.");
derived("InvitationCreated", shared.invitationCreatedSchema, "The invitation, its one-time acceptance token and whether it waits for a second administrator's approval; no email is sent.");
derived("AcceptInvitationInput", shared.acceptInvitationInputSchema, "The acceptance token from the invitation link.");
derived("InvitationAccepted", shared.invitationAcceptedSchema, "Confirmation of the new membership and its role.");
derived("MembershipInput", shared.membershipInputSchema, "A membership change: role, state, the version being changed and the reason.");
derived("StaffLenderAccessInput", shared.staffLenderAccessInputSchema, "The lenders a non-administrator membership may open, with the version being changed and the reason.");
derived("StaffLenderAccess", shared.staffLenderAccessSchema, "The membership with its saved lender access.");
derived("ReadinessCheck", shared.readinessCheckSchema, "One readiness control (identity, MFA, origins, database isolation, encryption) with its state on this host and what it means.");
derived("AccessReadiness", shared.accessReadinessSchema, "The staff-access and encryption controls as this request observed them. Describes configuration; never reveals secrets.");
derived("EncryptionVerification", shared.encryptionVerificationSchema, "The result of sealing and opening a synthetic payload with the configured managed key.");
derived("PayloadProtection", shared.payloadProtectionSchema, "How many stored payloads one bounded run protected, and whether another run is needed.");
described("ReverificationRequired", { type: "object", properties: { clerk_error: { type: "object", properties: { type: { type: "string", const: "forbidden" }, reason: { type: "string", const: "reverification-error" }, metadata: { type: "object", properties: { reverification: { type: "string" } }, required: ["reverification"] } }, required: ["type", "reason", "metadata"] } }, required: ["clerk_error"] }, "The identity provider's instruction to verify a second factor again; the console's sign-in component answers it.");
operation("/v1/team/verify", "post", "verifyStaffIdentity", "Message", null, [], "Verify staff identity with a fresh second factor", "Staff hosts only (403 elsewhere). Requires a signed-in session with an enrolled second factor used recently; otherwise answers 403 with the identity provider's re-verification instruction.");
operation("/v1/team", "get", "getTeam", "StaffDirectory", null, [], "Read the team directory", "Members, lenders, invitations and access history as the caller's role allows. In the sandbox every list is empty.");
operation("/v1/team/invitations", "post", "inviteStaff", "InvitationCreated", "InvitationInput", [], "Invite a staff member", "Administrator with recent MFA. Replaces any pending invitation for the same address; the token expires in seven days and is never emailed by the service.");
operation("/v1/team/invitations/{id}/revoke", "post", "revokeInvitation", "Message", null, [pathParam("id")], "Revoke an invitation", "Administrator with recent MFA. A revoked token cannot be accepted; an invitation that is no longer pending is refused (409).");
operation("/v1/team/invitations/{id}/approve", "post", "approveInvitation", "Message", null, [pathParam("id")], "Approve an invitation as the second administrator", "Administrator with recent MFA, other than the one who sent it (403); the approval is recorded in the access history. Only a pending Admin, Finance or Compliance reviewer invitation waits for one: any other, or one already approved, is refused (409). The invited person can accept it afterwards.");
operation("/v1/team/members/{id}", "patch", "updateStaffMember", "StaffMemberChange", "MembershipInput", [pathParam("id")], "Change a membership", "Administrator with recent MFA; nobody changes their own membership. Records the reason in the access history. A change that leaves the membership active as Admin, Finance or Compliance reviewer when it was not (a new role, or a reactivation) is saved as a request for a second administrator: the answer names it (pendingChange), the membership stays as it is until another administrator approves it, and the same request again answers the same waiting request. Every other change takes effect at once.");
operation("/v1/team/changes/{id}/approve", "post", "approveStaffChange", "StaffMemberChange", null, [pathParam("id")], "Approve a membership change as the second administrator", "Administrator with recent MFA, other than the one who asked and other than the person changed (403). Applies exactly the requested change and records who asked and who approved. A request already approved or declined, or whose membership changed since it was made, is refused (409).");
operation("/v1/team/changes/{id}/decline", "post", "declineStaffChange", "Message", null, [pathParam("id")], "Decline or withdraw a membership change", "Administrator with recent MFA, other than the person changed (403); the administrator who asked withdraws it the same way. Recorded in the access history; the membership is unchanged. A request already approved or declined is refused (409).");
operation("/v1/team/members/{id}/lenders", "patch", "updateStaffLenders", "StaffLenderAccess", "StaffLenderAccessInput", [pathParam("id")], "Set a member's lender access", "Administrator with recent MFA. Non-administrators open only the lenders named here; sessions pick the change up on their next request.");
operation("/v1/team/accept", "post", "acceptInvitation", "InvitationAccepted", "AcceptInvitationInput", [], "Accept an invitation", "The signed-in person's verified email must match the invitation. Creates a 90-day membership. An Admin, Finance or Compliance reviewer invitation is refused (403) until a second administrator has approved it.");
operation("/v1/team/readiness", "get", "getAccessReadiness", "AccessReadiness", null, [], "Read the access readiness checks", "What this host has configured and verified for real staff access, from the request's own checks.");
operation("/v1/team/readiness/encryption", "post", "verifyEncryption", "EncryptionVerification", null, [], "Verify managed payload encryption", "Administrator with recent MFA. Seals and opens a synthetic payload with the configured key (503 when none is configured).");
operation("/v1/team/readiness/protect", "post", "protectPayloads", "PayloadProtection", null, [], "Protect stored payloads", "Administrator with recent MFA. Seals one bounded batch of unprotected import rows and recovery payloads; run until none remain (503 when no key is configured).");

// Close review and pilot progress.
derived("ProgressStep", shared.pilotProgressStepSchema, "One pilot step with its state, the evidence behind that state and what is still missing.");
derived("PilotAccess", shared.pilotAccessSchema, "Whether real staff access is enabled on this host and what demo progress does not establish.");
derived("PilotProgress", shared.pilotProgressSchema, "The lender's progress through onboarding, ingestion, reconciliation, exceptions, close review and export, derived from its records.");
derived("CloseReviewIssue", shared.closeReviewIssueSchema, "A discrepancy or unresolved item the preparer must answer, and whether it remains open at the close.");
derived("CloseReviewRecord", shared.closeReviewRecordSchema, "A close review record with whether its snapshot still matches the close and its source evidence.");
derived("CloseReviewEntry", shared.closeReviewEntrySchema, "One close with the discrepancies a reviewer must answer, why it cannot be reviewed now (if so), pending financial corrections and its reviews.");
derived("CloseReviewList", shared.closeReviewListSchema, "The 25 newest closes with their reviews, the Finance reviewers available and who the caller is, so the console can enforce separation of duties.");
derived('CloseReviewHistory', shared.closeReviewHistorySchema, 'Bounded searchable close history without full reports or frozen review snapshots.');
derived('CloseReviewDetail', shared.closeReviewDetailSchema, 'One historical close, full recorded report, reviews, assignment events and pending correction links, scoped to the lender.');
derived('ReassignCloseReviewInput', shared.reassignCloseReviewSchema, 'Administrator reassignment of a pending review with its current version and an audit reason.');
derived("PrepareCloseReviewInput", shared.prepareCloseReviewSchema, "A close review preparation: the close and its version, an independent Finance reviewer, the preparation note and a response to every discrepancy.");
derived("DecideCloseReviewInput", shared.decideCloseReviewSchema, "A review decision: approve or reject with the version being decided, a note and an answer to every source exception.");
operation("/v1/pilot/progress", "get", "getPilotProgress", "PilotProgress", null, [merchant], "Read the pilot progress steps", "Derived from the lender's records on every read; nothing is written.");
operation("/v1/pilot/close-reviews", "get", "listCloseReviews", "CloseReviewHistory", null, [merchant, {name:'offset',in:'query',schema:{type:'integer',minimum:0,maximum:1000000},description:'Zero-based offset into the filtered history.'}, {name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:25},description:'Maximum number of close summaries on this page; defaults to 25.'}, {name:'search',in:'query',schema:{type:'string',maxLength:200},description:'Literal close name, reference or business-date search.'}], "Search close history", "Paged history summaries. Open any historical close by its own detail route, regardless of this page.");
operation('/v1/pilot/close-reviews/{id}', 'get', 'getCloseReview', 'CloseReviewDetail', null, [pathParam('id'),merchant], 'Read a historical close', 'Full recorded financial evidence, decisions and assignments for one lender-scoped close. Historical access does not relax approval currency checks.');
operation('/v1/pilot/close-reviews/{id}/reassign', 'post', 'reassignCloseReview', 'ValopayRecord', 'ReassignCloseReviewInput', [pathParam('id'),merchant,requiredKey], 'Reassign a pending close review', 'Admin only; active independent Finance reviewer, current version and reason required. Prepared evidence remains immutable.');
operation("/v1/pilot/close-reviews/prepare", "post", "prepareCloseReview", "ValopayRecord", "PrepareCloseReviewInput", [merchant, requiredKey], "Prepare a close for review", "Snapshots the close with its source-completeness basis and assigns an independent Finance reviewer. A close with an open review, a stale version or an unanswered discrepancy is refused.");
operation("/v1/pilot/close-reviews/{id}/decision", "post", "decideCloseReview", "ValopayRecord", "DecideCloseReviewInput", [pathParam("id"), merchant, requiredKey], "Approve or reject a close review", "Only the named reviewer decides, and only while the snapshot is current; a changed close or source declaration must be prepared again. One browser switching demo roles is one person, so a sandbox cannot decide its own preparation (403).");

// Import corrections.
derived("ImportCorrectionPreviewInput", shared.importCorrectionPreviewInputSchema, "The batch, the imported record with its version, and the supported field changes to compare.");
derived("ImportCorrectionPreview", shared.importCorrectionPreviewSchema, "The before/after comparison, the records the change touches, any blockers and the digest a proposal must quote.");
derived("ImportCorrectionProposalInput", shared.importCorrectionProposalInputSchema, "A proposal quoting the preview digest, naming an independent Finance reviewer, with the reason and evidence.");
derived("ImportCorrectionDecisionInput", shared.importCorrectionDecisionInputSchema, "Approve, reject or withdraw, quoting the proposal digest, with a reason.");
derived('ImportCorrectionRecoveryInput', shared.importCorrectionRecoveryInputSchema, 'Administrator reassignment with proposal digest, current assignment event, independent reviewer and reason.');
derived("ImportCorrectionView", shared.importCorrectionViewSchema, "A proposal with its preview, its decision if any, and whether the comparison is still current.");
derived("ImportCorrectionList", shared.importCorrectionsResponseSchema, "The batch's imported records, its proposals and the Finance reviewers available.");
const batchIdParam = { name: "batchId", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 100 }, description: "The committed import batch whose records may be corrected." };
operation("/v1/pilot/import-corrections", "get", "listImportCorrections", "ImportCorrectionList", null, [merchant, batchIdParam], "List import corrections for a batch", "The batch's imported records and every proposal with its current state.");
operation("/v1/pilot/import-corrections/preview", "post", "previewImportCorrection", "ImportCorrectionPreview", "ImportCorrectionPreviewInput", [merchant], "Compare a proposed correction", "Shows what would change, which closes and financial records it touches, and what blocks it. Nothing is written.");
operation("/v1/pilot/import-corrections", "post", "proposeImportCorrection", "ImportCorrectionView", "ImportCorrectionProposalInput", [merchant, requiredKey], "Propose an import correction", "Records the comparison as evidence for an independent Finance reviewer. A changed comparison, a missing reviewer or an open proposal on the same record is refused.");
operation("/v1/pilot/import-corrections/{id}/decision", "post", "decideImportCorrection", "ImportCorrectionView", "ImportCorrectionDecisionInput", [pathParam("id"), merchant, requiredKey], "Decide an import correction", "Only the named reviewer approves or rejects; the proposer may withdraw. Approval applies the change only while the comparison is current.");
operation('/v1/pilot/import-corrections/{id}/recovery', 'post', 'recoverImportCorrection', 'ImportCorrectionView', 'ImportCorrectionRecoveryInput', [pathParam('id'),merchant,requiredKey], 'Reassign an import correction', 'Administrator records a reason and assigns active independent Finance without changing the proposal or its evidence. Stale assignments are refused.');

// Sources: profiles, manifests, completeness and the Paystack test inbox.
derived("SourceProfileInput", shared.sourceProfileInputSchema, "A reusable synthetic source contract: mapping, identity column, amount unit, first expected delivery, cadence, grace and expected totals.");
derived("SourceManifestInput", shared.sourceManifestInputSchema, "The files and control totals expected for one WAT business date, or an explicit no-file declaration, with reason and evidence; a revision names the declaration it replaces.");
derived("SourceCompleteness", shared.sourceCompletenessSchema, "Whether the declared source files for a business date arrived complete, with each file's state, the profiles that expect a delivery by that date, undeclared batches and the issues Finance must answer. A declared total is in naira and is compared with the file's naira rows (receivedAmountKobo); money in other currencies is listed beside it (receivedOtherCurrencies, only when there is some), never added to it, and leaves the file incomplete. A file whose batch was committed by an earlier build is compared with the total it was committed with, which may add rows in other currencies.");
derived("SourceBatchQuality", shared.sourceBatchQualitySchema, "The original committed totals and checks of a source batch. sourceAmountKobo and importedAmountKobo sum the naira rows only (a row that names no currency is naira); money in other currencies is listed beside each (sourceOtherCurrencies, importedOtherCurrencies: by code, the rows and their amount in that currency's minor unit, only when there are some), never added to it. A batch committed by an earlier build keeps the totals it was committed with, which may add rows in other currencies.");
derived("PaystackFixtureInput", shared.paystackFixtureInputSchema, "A recorded Paystack test scenario to deliver to the inbox.");
derived("ProviderReplayInput", shared.providerReplayInputSchema, "A replay of a stored provider event, with its version and the reason.");
derived("SourceDelivery", shared.sourceDeliverySchema, "Where a profile stands against its cadence: missed deliveries, the next expected time and the last committed batch.");
derived("SourceProfile", shared.sourceProfileViewSchema, "A source profile record with its delivery state.");
derived("SourceBatchSummary", shared.sourceBatchSummarySchema, "A batch as the sources page lists it, with its original quality totals.");
derived("SourceSummary", shared.sourceSummarySchema, "Counts that need attention: late sources, duplicate and conflicting rows, batches needing review.");
derived("ProviderEvent", shared.providerEventViewSchema, "A stored provider event: fixture or test mode, how often it was delivered and replayed (replayCount counts rechecks, not the operator's verification checks), and the guarantee that it created no financial record.");
derived("PaystackInbox", shared.paystackInboxSchema, "The read-only Paystack test inbox: its fixed test-only state, the stored events and how many were quarantined or duplicated.");
derived("SourcesView", shared.sourcesViewSchema, "Everything the sources page shows for one lender and business date.");
derived("PaystackFixtureResult", shared.paystackFixtureResultSchema, "Whether the fixture was accepted or recognised as a duplicate, and the stored event.");
const businessDateParam = { name: "businessDate", in: "query", schema: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, description: "The WAT business date to report completeness for; defaults to the current one." };
operation("/v1/sources", "get", "getSources", "SourcesView", null, [merchant, businessDateParam], "Read the sources page", "Completeness for the business date, profiles with delivery state, batches with quality totals and the Paystack test inbox.");
operation("/v1/sources/profiles", "post", "createSourceProfile", "ValopayRecord", "SourceProfileInput", [merchant, optionalKey()], "Create a source profile", "One profile per source and record kind (409 otherwise). Import operator roles only.");
operation("/v1/sources/profiles/{id}/save", "post", "saveSourceProfile", "ValopayRecord", "SourceProfileInput", [pathParam("id"), merchant, optionalKey()], "Change a source profile", "Saves a new version of the profile; batches keep the version they were checked against.");
operation("/v1/sources/manifests", "post", "saveSourceManifest", "ValopayRecord", "SourceManifestInput", [merchant, requiredKey], "Declare the expected source files", "Records what must arrive for a business date. A revision must name the current declaration; a source batch declared for another date is refused.");
operation("/v1/sources/paystack/fixtures", "post", "runPaystackFixture", "PaystackFixtureResult", "PaystackFixtureInput", [merchant, optionalKey()], "Deliver a recorded Paystack scenario", "Runs a test-only fixture through the inbox. No external call is made and no financial record is created.");
operation("/v1/sources/events/{id}/replay", "post", "replayProviderEvent", "ProviderEvent", "ProviderReplayInput", [pathParam("id"), merchant, optionalKey()], "Replay a stored provider event", "Re-processes the event with the reason recorded; duplicates are recognised and counted.");
// The Paystack test ingress: the address an operator registers with a Paystack test account, not a console call.
described("PaystackTestEvent", obj({ event: str, data: { type: "object", additionalProperties: {}, description: "The event's payload as Paystack sent it." } }), "A Paystack test event exactly as Paystack signed it. The signature covers these bytes, so the body is authenticated before it is parsed. charge.success and the two direct-debit authorisation events are recorded; any other signed event is acknowledged and recorded as ignored.");
described("PaystackDeliveryReceipt", obj({ accepted: { type: "boolean", const: true }, duplicate: bool }), "The acknowledgement Paystack receives: the signed event is saved in the mapped lender's inbox, or recognised as a repeat delivery of one already saved.");
const connectionIdParam = { name: "connectionId", in: "path", required: true, schema: { type: "string", pattern: "^[a-f0-9]{64}$" }, description: "The opaque ID an operator mapped to one synthetic lender in VALO_PAY_1_PAYSTACK_CONNECTIONS; it alone selects the lender, and it is not a credential." };
const paystackSignature = { name: "x-paystack-signature", in: "header", required: true, schema: { type: "string", pattern: "^[a-fA-F0-9]{128}$" }, description: "HMAC-SHA512, under the configured test secret key and in hexadecimal, of the body's exact bytes: the JSON as sent, or, for a body sent with Content-Encoding gzip, deflate or br, the JSON bytes after decompression (not the compressed bytes); any other encoding is refused (415)." };
operation("/v1/providers/paystack/{connectionId}/events", "post", "receivePaystackTestEvent", "PaystackDeliveryReceipt", "PaystackTestEvent", [connectionIdParam, paystackSignature], "Receive a signed Paystack test event", "The address to register as the webhook URL of a Paystack test account. Off unless the host sets VALO_PAY_1_PAYSTACK_INGRESS to test. The signature is checked on the body's bytes, decompressed first when its Content-Encoding is gzip, deflate or br, before any lender is locked or read, so a forged or tampered delivery gets 401 and nothing else. A verified event is saved as test-mode evidence only: it creates no payment, allocation, debit or mandate authority, and still needs independent verification. Not a console call: no sandbox, sign-in or Idempotency-Key. At most 120 deliveries a minute per client network and, once signed, 60 a minute per connection. A repeat of a saved event is acknowledged without an audit entry, and its delivery count is written at most once a minute.");
Object.assign(paths["/v1/providers/paystack/{connectionId}/events"].post.responses, {
  "400": { description: "The body is not JSON bytes, the connection ID is malformed, or the signed event is inconsistent or from live mode" },
  "401": { description: "The signature does not match the body's bytes (decompressed first, when the body is compressed) under the configured test key; nothing was locked, read or saved" },
  "403": { description: "With the lender locked, the mapping names another workspace, or the lender is not a synthetic lender in sandbox or observation mode with its kill switch on" },
  "404": { description: "No lender is mapped to this connection ID, or, when the lender cannot be locked, it is not in the mapped workspace (removed, or the mapping names the wrong lender or workspace); correct the connection mapping, since delivering again will not help" },
  "413": { description: "The body is larger than 256 KiB" },
  "429": { description: "More than 120 deliveries a minute from this client network, or more than 60 signed deliveries a minute to this connection; retry after the Retry-After seconds" },
  "503": { description: "The ingress is off or misconfigured, or the mapped lender is in its workspace but busy; Paystack delivers again" },
});

// Personal work.
derived("PersonalWorkView", shared.personalWorkViewSchema, "The caller's (or, for administrators, the team's) cases, handovers, reviews and notifications, paged and counted.");
derived("WorkReceiptInput", shared.workReceiptInputSchema, "The item being acknowledged, with its version.");
derived("WorkReceipt", shared.workReceiptSchema, "The recorded acknowledgement: who, what, and when.");
const workParams = [merchant,
  { name: "scope", in: "query", schema: { type: "string", enum: ["mine", "team"], default: "mine" }, description: "The caller's own work, or (administrators) the whole team's." },
  { name: "filter", in: "query", schema: { type: "string", enum: ["all", "overdue", "handover", "review", "unread"], default: "all" }, description: "Only overdue items, handovers, reviews or unread notifications." },
  { name: "offset", in: "query", schema: { type: "integer", minimum: 0, maximum: 100000 }, description: "Rows to skip." },
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 }, description: "Page size; defaults to 25." }];
operation("/v1/work", "get", "getPersonalWork", "PersonalWorkView", null, workParams, "Read personal work", "Derived from cases, reviews and notifications on every read; bounded and lender scoped.");
operation("/v1/work/notifications/read", "post", "readNotification", "WorkReceipt", "WorkReceiptInput", [merchant, requiredKey], "Mark a notification read", "Records who read it and when; the server supplies the recipient.");
operation("/v1/work/handovers/acknowledge", "post", "acknowledgeHandover", "WorkReceipt", "WorkReceiptInput", [merchant, requiredKey], "Acknowledge a handover", "Records that the assignee took the case over; a stale version is refused.");

// Retention and lifecycle (administrators only).
derived("LifecycleView", shared.lifecycleViewSchema, "The lender's retention policy, the shortest periods it may set (minimumDays) and whether a second administrator approves runs (secondApprover), holds, bounded inventory of what the policy would touch, and saved retention runs.");
derived("LifecycleRunView", shared.lifecycleRunViewSchema, "One retention run: its reviewed manifest, who prepared it, approval state and per-item receipts.");
derived("RetentionPolicyInput", shared.retentionPolicyInputSchema, "The retention periods per kind, with the version being changed and the reason.");
derived("RetentionHoldInput", shared.retentionHoldInputSchema, "A hold on one item, or its release, with the reason.");
derived("LifecyclePreviewInput", shared.lifecyclePreviewInputSchema, "Which kinds to preview and the reason for the run.");
derived("LifecycleApproveInput", shared.lifecycleApproveInputSchema, "Approval of a previewed run, quoting its manifest digest.");
derived("LifecycleExecuteInput", shared.lifecycleExecuteInputSchema, "Execution of an approved run, quoting its manifest digest, in bounded batches.");
operation("/v1/lifecycle", "get", "getLifecycle", "LifecycleView", null, [merchant, journalOffset], "Read retention controls", "Administrators only (403). Policy, holds, inventory and runs for the lender.");
operation("/v1/lifecycle/runs/{id}", "get", "getLifecycleRun", "LifecycleRunView", null, [pathParam("id"), merchant], "Read a retention run", "Administrators only. The run's manifest and receipts.");
operation("/v1/lifecycle/policy", "post", "saveRetentionPolicy", "LifecycleView", "RetentionPolicyInput", [merchant, requiredKey], "Change the retention policy", "Administrators only. Keeps every previous policy version with its reason. A period shorter than the workspace's minimum (minimumDays: 30 days in the sandbox; in a staff pilot, six years for original source files and export files and a year for recovery payloads) is refused (400).");
operation("/v1/lifecycle/holds", "post", "setRetentionHold", "LifecycleView", "RetentionHoldInput", [merchant, requiredKey], "Place or release a hold", "Administrators only. A held item is never deleted by a run.");
operation("/v1/lifecycle/runs", "post", "previewLifecycleRun", "LifecycleRunView", "LifecyclePreviewInput", [merchant, requiredKey], "Preview a retention run", "Administrators only. Records the exact manifest of what would be deleted; nothing is deleted. With nothing old enough to delete, the preview is refused (400).");
operation("/v1/lifecycle/runs/{id}/approve", "post", "approveLifecycleRun", "LifecycleRunView", "LifecycleApproveInput", [pathParam("id"), merchant, requiredKey], "Approve a retention run", "Administrators only; in a staff pilot, an administrator other than the one who prepared the preview (403). The manifest digest must match the preview; a changed inventory must be previewed again.");
operation("/v1/lifecycle/runs/{id}/execute", "post", "executeLifecycleRun", "LifecycleRunView", "LifecycleExecuteInput", [pathParam("id"), merchant, requiredKey], "Execute an approved run", "Administrators only. Removes as many of the run's sources as fit in a two-second budget under the lender lock, each checked again just before it is deleted and given a receipt. A blocked source, or a deletion that cannot be confirmed, stops the run with its reason (status attention) and the sources after it wait; nothing is skipped silently. Send it again to continue until the status is completed: sources not yet attempted go first.");

// ---- The refusals and failures each operation can answer ----
/** A money calculation the request needs cannot be done exactly (lib/error-handler.ts): the operations that compute money. */
const moneyRefusal = "Refused: a money calculation this request needs cannot be done exactly within the supported limits, and code says why: INVALID_MONEY_AMOUNT (an amount that is not a safe whole number of minor units), INVALID_MONEY_RATE (a rate outside its bounds) or MONEY_OUT_OF_RANGE (a result beyond the safe-integer minor-unit range). The same request would be refused again.";
const computesMoney = new Set(["GET /v1/overview", "GET /v1/reports", "GET /v1/customers/{id}/timeline", "GET /v1/customers/{id}/history", "GET /v1/connected", "POST /v1/actions", "POST /v1/connected/actions", "POST /v1/operations/{id}/retry"]);
// Listed from what its route does: the /api/v1 middleware (the origin rule and the request
// limits), the body parser, the workspace transaction and its database limits, the lender
// scope, the journal and the route's own refusals. Every one carries ErrorBody (lib/error-handler.ts
// and the app's own refusals) except readiness's 503 and the identity provider's re-verification.
const failures = {
  400: "Refused: a parameter, header or body field failed validation (details names at most 20 of them, detailCount how many there were), the path's percent-encoding cannot be decoded, the body is not valid JSON, is nested more than 32 levels deep (refused from its bytes before it is parsed) or holds a NUL character or an unpaired surrogate, or a rule refused the request in its own words. Nothing was saved.",
  401: "Sign-in required: a staff host answers only a signed-in pilot staff session.",
  403: "Refused: another origin, or the caller's role, membership, lender access, recent MFA or a readiness gate does not allow it.",
  404: "Not found in the caller's workspace: the lender, or a record the path or the body names (an action's recordId, a customerId, a linked record, an export's close review, a retention run).",
  409: "Conflict: what the request names changed since it was read, its Idempotency-Key belongs to another request or its journal entry is cancelled, or the change conflicts with saved records. Nothing was saved.",
  410: "Gone: a request with this Idempotency-Key already completed, and the lender's retention policy has since removed its stored result, so it cannot run again. Its entry in Operations remains.",
  413: "The body is larger than 2 MB, or holds more than 10,000 values (every object, list, text, number, true, false and null in it), counted from its bytes before it is parsed.",
  415: "The body is not JSON (a form or text body is refused), its character set is not UTF-8, or it is compressed (any Content-Encoding but identity, refused before it is read, with Accept-Encoding: identity); send uncompressed UTF-8 JSON as application/json.",
  422: `${moneyRefusal} Nothing was saved, and a request with an Idempotency-Key is refused for good: its journal entry is closed, and the same key cannot run again.`,
  429: "Too many requests: more than 300 a minute for this client (a signed-in person, a sandbox this server has served, or otherwise the client's network: an IPv4 address or an IPv6 /64), more than 1,200 a minute from its network, or too many new sandboxes from its network or on this server (try again in an hour).",
  500: "The service failed. With committed false nothing was saved (for a request with an Idempotency-Key, nothing sent with the key); with operation completed a request with the key was saved; otherwise the outcome is unconfirmed: check Operations, or repeat the same request with its Idempotency-Key.",
  502: "Private storage answered with an error; nothing was sent.",
  503: "Busy or unavailable: a database limit turned the request away (a busy lender or workspace, a lock or statement past its limit, a lost or unavailable connection), the same request is still running (operation running), or a service it needs is unavailable or not configured: the key service, or private storage or the identity provider out of reach. committed false says nothing was saved (for a request with an Idempotency-Key, nothing sent with the key); operation completed says a request with the key was saved.",
  504: "Private storage did not answer in time; nothing was sent.",
};
const retryAfter = (description) => ({ "Retry-After": { description, schema: { type: "integer", minimum: 1 } } });
/** The journal entry a keyed request is recorded under, on every answer once the entry exists (lib/operation-recovery.ts); each answer refers to the one component. */
const headers = { "X-Valopay-Operation": { description: "The id of this request's entry in the operations journal: GET /v1/operations lists it, and POST /v1/operations/{id}/retry and /cancel take it. Sent on every answer, success, refusal or failure, to a request whose Idempotency-Key the journal records, once the entry exists; absent without a key, when the key itself is refused, and for a demo role switch, which the journal does not record.", schema: { type: "string" } } };
const operationHeader = { "X-Valopay-Operation": { $ref: "#/components/headers/X-Valopay-Operation" } };
const outsideWorkspace = new Set(["GET /healthz", "GET /readyz", "GET /v1/openapi.json", "POST /v1/webhooks/{provider}", "POST /v1/team/verify", "POST /v1/team/accept", "POST /v1/providers/paystack/{connectionId}/events"]);
/** Statuses a route answers beyond what its traits imply. */
const ownStatuses = {
  "POST /v1/webhooks/{provider}": [400, 403, 413, 415],
  "POST /v1/team/verify": [401, 403],
  "POST /v1/team/accept": [401, 403, 409, 503],
  "POST /v1/operations/{id}/retry": [400, 401, 403, 404, 409, 410, 429, 503],
  "POST /v1/operations/{id}/cancel": [410],
  "GET /v1/exports/{id}/download": [409, 410, 502, 503, 504],
  "POST /v1/exports/{id}/retry": [410],
  "POST /v1/providers/paystack/{connectionId}/events": [400, 401, 403, 404, 413, 429, 503],
  "GET /healthz": [429],
  "GET /readyz": [429],
};
const exportQueue = "the lender already has ten exports waiting or running (Retry-After 30, about the time one takes to finish)";
const expiredRequest = "Gone: the stored request expired under the lender's retention policy and cannot run again.";
/** What a status means where the operation gives it a meaning of its own. */
const ownDescriptions = {
  "POST /v1/operations/{id}/retry": { 410: `${expiredRequest.replace(/\.$/, "")}; or the request it repeats is gone itself, as an export whose file retention deleted is.`, 429: `${failures[429].replace(/\.$/, "")}, or, repeating an export, ${exportQueue}.` },
  "POST /v1/operations/{id}/cancel": { 410: expiredRequest },
  "POST /v1/exports": { 429: `Too many requests: ${exportQueue}, more than 300 requests came from this client or 1,200 from its network in a minute, or too many new sandboxes came from its network or were started on this server (try again in an hour).` },
  "POST /v1/providers/paystack/{connectionId}/events": { 415: "The body is compressed with a Content-Encoding other than gzip, deflate or br; nothing was read." },
  "GET /healthz": { 429: "More than 120 health checks a minute from this client network; retry after the Retry-After seconds." },
  "GET /readyz": { 429: "More than 120 health checks a minute from this client network; retry after the Retry-After seconds." },
  "GET /v1/exports/{id}/download": { 410: "Gone: the lender's retention policy removed this export's file. Its checksum and deletion receipt are kept; start a new export if current evidence is needed." },
  "POST /v1/exports/{id}/retry": { 410: "Gone: the lender's retention policy removed this export's file, so it cannot be generated again under the same identity (start a new export); or a request with this Idempotency-Key already completed and retention has since removed its stored result." },
};
/** What a 429's Retry-After says: the request limit's minute, the new-sandbox limit's hour and, where the export queue applies, about the time a queued export takes. */
function retryAfter429(name) {
  if (name === "POST /v1/providers/paystack/{connectionId}/events") return retryAfter("Seconds to wait: 60, the delivery limit's window.");
  if (name === "GET /healthz" || name === "GET /readyz") return retryAfter("Seconds to wait: 60, the health limit's window.");
  const queue = name === "POST /v1/exports" || name === "POST /v1/operations/{id}/retry" ? ", and 30 when the lender's export queue is full" : "";
  return retryAfter(`Seconds to wait: 60 after the request limit, 3600 after the new-sandbox limit${queue}.`);
}
function listErrorAnswers(path, method, op) {
  const name = `${method.toUpperCase()} ${path}`, params = op.parameters ?? [], statuses = new Set([500, ...(ownStatuses[name] ?? [])]);
  const include = (...list) => list.forEach((status) => statuses.add(status));
  if (path.startsWith("/v1/") && !path.startsWith("/v1/providers/")) include(403, 429); // the origin rule and the request limit
  if (method === "post" || method === "patch") include(400, 413, 415); // the body parser reads every POST and PATCH, whether or not the operation takes a body
  if (!outsideWorkspace.has(name)) include(401, 403, 409, 429, 503); // the workspace transaction: sign-in, membership, conflicts, a new sandbox's limit, database limits
  if (params.some((item) => item.name === "merchantId" && item.required)) include(400, 404); // the lender scope
  if (params.some((item) => item.in === "path" && ["id", "kind", "queue"].includes(item.name))) include(400, 404); // what the path names
  if (params.some((item) => item.name === "Idempotency-Key")) include(400, 403, 409); // the key and the journal
  if (params.some((item) => journaled.has(item))) include(410); // a repeat whose stored result retention removed
  if (method !== "get" && !outsideWorkspace.has(name)) include(400, 403, 409); // a write: its rules, role and version
  if (computesMoney.has(name)) include(422); // a calculation of money: billing, reconciliation, a close, a report, a customer's position, the Cash Desk
  for (const status of [...statuses].sort((a, b) => a - b)) {
    const read = method === "get" && status === 500 ? "The service could not prepare this answer; a read changes nothing, so it can be tried again." : method === "get" && status === 422 ? `${moneyRefusal} A read saves nothing either way.` : undefined;
    const answer = (op.responses[status] ??= { description: ownDescriptions[name]?.[status] ?? read ?? failures[status] });
    if (name === "GET /readyz" && status === 503) continue; // readiness answers its own body
    answer.content = { "application/json": { schema: name === "POST /v1/team/verify" && status === 403 ? { anyOf: [ref("ErrorBody"), ref("ReverificationRequired")] } : ref("ErrorBody") } };
    if (status === 429) answer.headers = retryAfter429(name);
    // A compressed body is refused unread, naming the one coding the parser reads (RFC 9110); the Paystack test ingress inflates its own.
    if (status === 415 && name !== "POST /v1/providers/paystack/{connectionId}/events") answer.headers = { "Accept-Encoding": { description: "identity: sent when the body was refused for its Content-Encoding, naming the one coding the service reads.", schema: { type: "string", enum: ["identity"] } } };
    if (status === 503) answer.headers = retryAfter("Seconds to wait before trying again: sent when a database limit turned the request away, the same request is still running, or private storage or the identity provider could not be reached or said it is unavailable; absent when a service it needs is not configured, or the key service cannot open protected data.");
  }
  // A journaled request names its journal entry on every answer; a retry re-enters the entry it names.
  if (params.some((item) => journaled.has(item)) || name === "POST /v1/operations/{id}/retry") for (const answer of Object.values(op.responses)) answer.headers = { ...(answer.headers ?? {}), ...operationHeader };
  op.responses = Object.fromEntries(Object.entries(op.responses).sort(([a], [b]) => Number(a) - Number(b)));
}
for (const [path, methods] of Object.entries(paths)) for (const [method, op] of Object.entries(methods)) listErrorAnswers(path, method, op);

// How a caller is identified: an anonymous sandbox by its cookie, which the service sets on the first visit and renews on every answer; a staff host by a signed-in session instead.
const securitySchemes = {
  sandboxCookie: { type: "apiKey", in: "cookie", name: "__Host-valo-pay-1_production_sandbox", description: "The anonymous sandbox's cookie: a 32-byte random token in hexadecimal that the service sets on the first visit (GET /v1/workspace) and renews on every answer, HttpOnly, SameSite=Lax and lasting 30 days from the last visit. Behind TLS it is __Host-valo-pay-1_<environment>_sandbox (Secure, Path=/, no Domain), where environment is the explicitly configured development, test, staging or production environment; this scheme names production. Plain HTTP local runs omit __Host-. A missing or malformed token starts a new sandbox; two different current tokens are refused (400). Only during an explicitly enabled, bounded transition on the exact retained HTTPS origin can the former host-only secure cookie transfer its token; the old name is then expired. Plain legacy cookies and cookies for another generation or environment never select a sandbox. The sandbox is found by the token's digest, never by the token, which is never stored or logged. A staff host identifies a signed-in session instead." },
};
fs.writeFileSync("lib/api-spec/openapi.json",JSON.stringify({openapi:"3.1.0",info:{title:"Valo Pay 1 sandbox API",version:"1.1.0",description:"Valo Pay 1 collections and connected banking sandbox API. All monetary fields are integer minor units (NGN kobo). Real data and all outbound provider instructions are disabled in connected modules."},servers:[{url:"/api"}],paths,components:{schemas,headers,securitySchemes}},null,2));
