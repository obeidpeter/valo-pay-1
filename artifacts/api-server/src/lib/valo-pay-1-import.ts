import { parse } from "csv-parse/sync";
import { canonicalDigest } from './digests';
import { assertNoRealBankDetails, makeRecord, validateRecord } from "../domain";
import type { ValidationProblem } from "../domain/validation";
import type { Context, DomainState } from "../domain/types";
import { counted, csvAmountToKobo, defaultStatus, importBooleanFields, importFieldLabel, importFieldsOf, importKinds as sharedImportKinds, importNumericFields, recordTypeTitle, suggestImportField, observationEventKey, observationProviderKey } from "@workspace/valo-pay-1-schema";
import { importRowError } from "./import-row-errors";

const importKinds:readonly string[]=sharedImportKinds;
const topFields=new Set(["name","status","reference","amountKobo","customerId"]);
const numeric=importNumericFields;
const boolean=importBooleanFields;
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
/**
 * The source of every quick import's rows (POST /v1/imports): one for the lender, so a row ID is recognised
 * whichever file brings it again. Import batches name their own source.
 */
export const QUICK_IMPORT_SOURCE = "Quick import";
const ROW_ID_RULE = "Choose the column that holds each row’s source row ID: every row needs a different, non-empty value, up to 160 characters, so that a later import recognises the row.";
/**
 * Each row's source row ID, from the identity column: a different, non-empty value on every row, up to 160 characters,
 * or the file is refused (400). The ID is kept with the record, so it is screened for bank details under its header.
 */
export function sourceRowIds(rows: Record<string, string>[], identityColumn: string | undefined, columns: string[]): string[] {
  if (!identityColumn?.trim()) fail(`Map a row ID column. ${ROW_ID_RULE}`);
  if (!columns.includes(identityColumn)) fail(`Map a row ID column. The file has no column named “${identityColumn}”. ${ROW_ID_RULE}`);
  try { assertNoRealBankDetails(rows.map((row) => ({ [identityColumn]: row[identityColumn] }))); }
  catch (error) { fail(error instanceof Error ? error.message : "The source row IDs could not be checked."); }
  const ids = rows.map((row) => String(row[identityColumn] || "").trim());
  if (ids.some((id) => !id || id.length > 160) || new Set(ids).size !== ids.length) fail("Choose a source row ID column with a different, non-empty value on every row (up to 160 characters).");
  return ids;
}
/** A quick import's body with its row ID column: one sent without it is refused by importCsv in plain words, naming what to map, rather than as a missing property. */
export const withRowIdColumn = (body: unknown): unknown => body && typeof body === "object" && !Array.isArray(body) ? { identityColumn: "", ...body } : body;
const unsafeKey = (key: string) => ["__proto__", "constructor", "prototype"].includes(key);
/**
 * A warning for each displayed value that fell back while a column went unused: a name taken from the reference
 * (or the row number) and a generated reference. A column is unused when it is skipped or names no field of the
 * kind, so the importer keeps it only as extra detail that nothing reads; the row identity column is metadata,
 * unless it looks like the field that fell back (a reference chosen as the row ID fills no reference unless mapped).
 * Without an unused column a fallback is taken as intended: the source simply has no such value.
 */
function fallbackWarnings(kind: string, columns: string[], targets: string[], identityColumn: string | undefined, fallbacks: { name: number; reference: number }): string[] {
  const fields = new Set(importFieldsOf(kind));
  const warnings: string[] = [];
  for (const field of ["name", "reference"] as const) {
    const rows = fallbacks[field], one = rows === 1, label = field === "name" ? "Name" : "Reference";
    const unused = columns.filter((column, index) => targets[index] ? !fields.has(targets[index]!) : column !== identityColumn || suggestImportField(kind, column) === field);
    if (!rows || !unused.length) continue;
    const fallback = field === "name"
      ? targets.includes(field) ? `${one ? "its name is" : "their names are"} taken from ${one ? "its reference (or its row number" : "their references (or their row numbers"} without one)` : "each record’s name is taken from its reference (or its row number without one)"
      : targets.includes(field) ? `${one ? "it gets a generated reference" : "they get generated references"}` : "each record gets a generated reference";
    const what = targets.includes(field) ? `${label} is blank on ${counted(rows, "row")}, so ${fallback}.` : `No column is mapped to ${label}, so ${fallback}.`;
    const list = unused.map((column) => suggestImportField(kind, column) === field ? `${column}, which looks like the ${field}` : column).join("; ");
    warnings.push(`${what} Not mapped to a field: ${list}. Map the column that holds the ${field}, or import anyway to save the fallback.`);
  }
  return warnings;
}
/**
 * Checks or commits a synthetic CSV of one kind, all rows or none. Every row carries a source row ID (a batch's own,
 * or the identity column's for a quick import), and a row already imported under its source and row ID is skipped
 * when its data is the same and refused when it differs. An invalid row reports every failing rule, worded for the
 * operator's columns (importRowError), with the record API's words as its detail.
 */
export function importCsv(state:DomainState,ctx:Context,input:{kind:string;csv:string;syntheticOnly:boolean;commit:boolean;mapping?:Record<string,unknown>;amountUnit?:'naira'|'kobo'; identityColumn?: string; identities?: { source: string; batchId?: string; ids: string[] }}){
  if(!input.syntheticOnly)fail("Only sample data can be imported. Real data is not accepted yet.",403);
  if(!importKinds.includes(input.kind))fail("You cannot import a CSV file for this type of record.");
  const amountUnit = input.amountUnit ?? 'kobo';
  if (!['naira', 'kobo'].includes(amountUnit)) fail('Choose Naira or Kobo for the source amounts.');
  if(new TextEncoder().encode(input.csv).length>1500000)fail("A file must have between 1 and 500 rows and be no larger than 1.5 MB.");
  let parsed:Record<string,string>[];
  let columns: string[] = [];
  let headerProblem = '';
  try{parsed=parse(input.csv,{columns:(headers: string[]) => {
    columns = headers;
    if (headers.some(header => !header || unsafeKey(header)) || new Set(headers).size !== headers.length) {
      headerProblem = 'Give every column a different, non-empty header. Some names, such as ‘constructor’, cannot be used.';
      throw new Error(headerProblem);
    }
    return headers;
  },skip_empty_lines:true,bom:true,trim:true,max_record_size:20000});}
  catch{fail(headerProblem || "Valo Pay 1 could not read this CSV file. Use a header row, the same number of columns on every row, and quotes around values that contain commas.");}
  if(parsed.length>500||!parsed.length)fail("A file must have between 1 and 500 rows and be no larger than 1.5 MB.");
  if (input.mapping && (Array.isArray(input.mapping) || Object.entries(input.mapping).some(([key, target]) => !columns.includes(key) || unsafeKey(key) || typeof target !== 'string' || unsafeKey(target)))) fail('Choose a field, or Skip column, for each column in the file.');
  const destination = (key: string) => {
    // The row ID column is the row's identity: it fills a field only when mapped to one, or when it is the reference or event ID itself.
    const chosen = input.mapping && Object.hasOwn(input.mapping, key) ? String(input.mapping[key]).trim() : key === input.identityColumn && !['reference', 'eventId'].includes(key) ? '' : key;
    return chosen === 'amount' ? 'amountKobo' : chosen;
  };
  const targets = columns.map(destination);
  if (new Set(targets.filter(Boolean)).size !== targets.filter(Boolean).length) fail('Map each field only once. Choose Skip column for the columns you do not need.');
  const identities = input.identities ?? { source: QUICK_IMPORT_SOURCE, ids: sourceRowIds(parsed, input.identityColumn, columns) };
  // The column a field is read from, which a row error names.
  const columnOf = (field: string) => columns.find((_column, index) => targets[index] === field);
  // Amounts in major units take the decimals of the row's own currency (ISO 4217), naira when the row names none. Only
  // a kind with a currency field (payment evidence) has one: elsewhere a column headed currency is extra detail.
  const currencyColumn = importFieldsOf(input.kind).includes('currency') ? columns.find((column) => destination(column) === 'currency') : undefined;
  const working=structuredClone(state), rows:{row:number;status:string;message:string;detail?:string}[]=[];
  const amounts = new Map<number, number>();
  let valid=0,invalid=0,imported=0;
  // Imported rows whose name or reference came from a fallback rather than the file.
  const fallbacks={name:0,reference:0};
  for(const [index,raw] of parsed.entries()){
    // Every failing rule of the row, from reading its cells and from validation, so one check shows all there is to fix.
    const problems: ValidationProblem[] = [];
    try{
      const record:Record<string,any>={data:{synthetic:true}}, blankAsZero:Record<string,number>={};
      for(const [key,value] of Object.entries(raw)){
        const target=destination(key);
        if (!target) continue;
        if (unsafeKey(target)) throw new Error('One of these column names cannot be used. Rename the column and try again.');
        // A blank number is absent. Only the amount, which every kind but customers needs, is still refused when blank.
        // Quoted spaces are kept by the parser's trim, so a cell of spaces counts as blank too.
        if (numeric.has(target) && !value.trim() && !(target === 'amountKobo' && input.kind !== 'customers')) {
          // Earlier builds read a blank number other than an amount as 0, and the fingerprints of the rows they imported include it.
          if (!target.endsWith('Kobo')) blankAsZero[target] = 0;
          continue;
        }
        let decoded:unknown=value;
        if (numeric.has(target) && target.endsWith('Kobo')) {
          try { decoded = csvAmountToKobo(value, amountUnit, currencyColumn ? raw[currencyColumn] : undefined, input.kind); }
          catch (error) { problems.push({ field: target, message: error instanceof Error ? error.message : 'Check this amount.' }); continue; }
          if (target === 'amountKobo') amounts.set(index + 2, decoded as number);
        } else if(numeric.has(target))decoded=Number(value);
        if(boolean.has(target)) {
          if (!['true', 'false', ''].includes(value)) { problems.push({ field: target, message: `${importFieldLabel(input.kind, target)}: enter true or false.`, rule: { type: 'boolean' } }); continue; }
          decoded=value==="true";
        }
        if(target==="consentGaps")decoded=value?value.split("|"):[];
        if(topFields.has(target))record[target]=decoded;else record.data[target]=decoded;
      }
      const identity = { source: identities.source, rowId: identities.ids[index]!, ...(identities.batchId ? { batchId: identities.batchId } : {}) };
      // Stored in the row's import identity and compared when the row is imported again: its first form.
      const identityFingerprint = canonicalDigest({ ...record, data: { ...record.data, ...blankAsZero } }, 'legacy-en-us-replacer');
      // A row with a cell that could not be read is not compared with its saved row, nor as payment evidence, whose details
      // include its amounts: it is not yet what the file means. Its other conflicts are reported with every other rule.
      const readable = !problems.length;
      const prior = working.records.find(r => r.kind === input.kind && r.data.importIdentity?.source === identity.source && r.data.importIdentity?.rowId === identity.rowId);
      if (prior && readable) {
        if (prior.data.importIdentity.fingerprint === identityFingerprint) { rows.push({ row: index + 2, status: 'duplicate', message: 'This source row ID was imported before with the same data; nothing is changed.' }); continue; }
        problems.push({ message: 'This source row ID was already imported with different data. Review the existing record; it cannot be replaced by importing again.' });
      }
      const named=Boolean(record.name),referenced=Boolean(record.reference);
      record.name ||= record.reference || `${recordTypeTitle(input.kind)} from row ${index + 2}`;
      record.status ||= defaultStatus[input.kind as keyof typeof defaultStatus];
      if(record.customerId&&!working.records.some(r=>r.id===record.customerId&&r.kind==="customers")){
        const customers=working.records.filter(r=>r.kind==="customers"&&r.reference===record.customerId);
        if(customers.length>1) problems.push({field:'customerId',message:'This customer reference matches more than one customer. Use the customer record ID, and ask an Admin to correct the duplicate references.'});
        else if(customers[0])record.customerId=customers[0].id;
      }
      for(const [key,kind] of [["mandateId","mandates"],["dueItemId","due-items"]]){
        const candidate=record.data[key!];
        const related=working.records.find(r=>r.kind===kind&&(r.id===candidate||r.reference===candidate));
        if(related)record.data[key!]=related.id;
      }
      if(input.kind==="due-items")record.data.outstandingKobo=record.amountKobo;
      if(input.kind==="attempts"){record.data.source="external";record.data.simulated=true;}
      if(input.kind==="mandates"){record.data.origin="imported";record.data.consentGaps ||= [];}
      // Payment evidence is the same when its source event is or, without event IDs, when its source, reference, payer,
      // amounts, currency, connection and batch are. Evidence that only shares a reference is new: reconciliation
      // merges it into its payment or holds it as a conflict, and never loses its money. The row's own saved record is
      // no other record.
      const sameDetails=(saved:{reference:string;customerId:string;amountKobo:number;data:Record<string,any>})=>saved.reference===record.reference&&saved.customerId===(record.customerId||"")&&saved.amountKobo===record.amountKobo
        &&["grossAmountKobo","feeKobo","batchReference","currency","provider","providerConnection"].every(key=>saved.data[key]===record.data[key]);
      const eventKey=observationEventKey(record.data);
      const savedEvidence=input.kind==="observations"&&readable?working.records.find(r=>r!==prior&&r.kind==="observations"&&(eventKey!==undefined||observationEventKey(r.data)!==undefined?eventKey!==undefined&&observationEventKey(r.data)===eventKey:r.data.source===record.data.source&&observationProviderKey(r.data)===observationProviderKey(record.data)&&sameDetails(r))):undefined;
      if(savedEvidence&&!sameDetails(savedEvidence))problems.push({ message: 'This source event is already saved with different details. Review the saved payment evidence; it cannot be replaced by importing again.' });
      // A new row ID never takes over a saved record: a conflicting row is refused, not silently skipped.
      else if(record.reference&&(input.kind==="observations"?savedEvidence:working.records.some(r=>r!==prior&&r.kind===input.kind&&r.reference===record.reference))){
        problems.push({ field: 'reference', message: 'This reference belongs to another saved record. Check the row’s source row ID before you import. A conflicting row is refused, never skipped.' });
      }
      try { validateRecord(working,ctx,input.kind,record,false,problems); }
      catch (error) { problems.push({ message: error instanceof Error ? error.message : 'Valo Pay 1 could not check this row.' }); }
      if (problems.length) { invalid++; rows.push({ row: index + 2, status: 'invalid', ...importRowError(problems, { kind: input.kind, unit: amountUnit, columnOf }) }); continue; }
      record.data.importIdentity = { ...identity, fingerprint: identityFingerprint };
      makeRecord(working,input.kind,{...record,createdAt:ctx.now,updatedAt:ctx.now});
      valid++;rows.push({row:index+2,status:"valid",message:input.commit?"Sample record imported.":"Checked and ready to import."});
      if(!named)fallbacks.name++;if(!referenced)fallbacks.reference++;
    }catch(error){invalid++;const message=error instanceof Error?error.message:"Valo Pay 1 could not check this row.";rows.push({row:index+2,status:"invalid",message,detail:message});}
  }
  // All-or-nothing: review every error before committing.
  if(input.commit&&invalid===0){state.records=working.records;imported=valid;}
  else if(input.commit&&invalid>0)rows.forEach(r=>{if(r.status==="valid")r.message="Not imported: resolve all row errors first.";});
  const warnings=fallbackWarnings(input.kind,columns,targets,input.identityColumn,fallbacks);
  return {valid,invalid,imported,skipped:rows.filter(row=>row.status==='duplicate').length,rows,columns,preview:parsed.slice(0,10).map((values,index)=>({row:index+2,values,...(amounts.has(index+2)?{amountKobo:amounts.get(index+2)}:{})})),...(warnings.length?{warnings}:{})};
}
