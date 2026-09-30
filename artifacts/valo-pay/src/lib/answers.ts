import type { z, ZodError, ZodTypeAny } from "zod";

/** Shown instead of a read whose answer the page's schema does not describe. */
export const UNREADABLE_ANSWER = "Valo Pay’s answer was incomplete, so nothing from it is shown. Try again. If this keeps happening, contact the Valo Pay team.";
/**
 * Shown for a write whose answer is not the confirmation its schema describes: the write may have been saved. The
 * same next step as every request not confirmed (safe-mutations uses these words too).
 */
export const INCOMPLETE_CONFIRMATION = "Valo Pay’s answer was incomplete. We do not know yet whether Valo Pay saved this. Check the original request before you change anything.";

type Definition = { typeName?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny; type?: ZodTypeAny; in?: ZodTypeAny; getter?: () => ZodTypeAny };
const definition = (schema: ZodTypeAny) => schema._def as Definition & Record<string, any>;

/** The schema inside the wrappers that leave an answer's shape as it is: optional, nullable, a default, a refinement and their kin. */
function unwrapped(schema: ZodTypeAny): ZodTypeAny {
  let current = schema;
  for (let depth = 0; depth < 32; depth++) {
    const def = definition(current);
    const inner = ["ZodOptional", "ZodNullable", "ZodDefault", "ZodCatch", "ZodReadonly"].includes(def.typeName ?? "") ? def.innerType
      : def.typeName === "ZodEffects" ? def.schema
      : def.typeName === "ZodBranded" ? def.type
      : def.typeName === "ZodPipeline" ? def.in
      : def.typeName === "ZodLazy" ? def.getter?.()
      : undefined;
    if (!inner) return current;
    current = inner;
  }
  return current;
}

/** Whether an alternative could read an object or array value at all, so that an unrecognised key there might be its. */
function couldRead(option: ZodTypeAny, value: unknown): boolean {
  const kind = definition(unwrapped(option)).typeName ?? "";
  if (["ZodAny", "ZodUnknown", "ZodUnion", "ZodDiscriminatedUnion", "ZodIntersection"].includes(kind)) return true;
  return Array.isArray(value) ? ["ZodArray", "ZodTuple", "ZodSet"].includes(kind) : ["ZodObject", "ZodRecord", "ZodMap"].includes(kind);
}

/**
 * Whether the schema itself chose the shape that holds an unrecognised key:
 * the path to it passes only objects, arrays and records, a discriminated
 * union's option by its discriminator, or a union with one alternative that
 * could read the value there. zod reports only the unrecognised keys of the
 * first alternative that fails by nothing else, so under a union of two object
 * shapes an addition may belong to an alternative the answer was never meant
 * to be, one whose required fields it happens to carry: that is not a field a
 * newer service added.
 */
function chosenShape(schema: ZodTypeAny, value: unknown, path: ReadonlyArray<string | number>): boolean {
  let node = unwrapped(schema), at = value, index = 0;
  for (let steps = 0; steps < 256; steps++) {
    const def = definition(node);
    if (def.typeName === "ZodUnion") {
      const readable = (def.options as ZodTypeAny[]).filter((option) => couldRead(option, at));
      if (readable.length !== 1) return false;
      node = unwrapped(readable[0]!);
      continue;
    }
    if (def.typeName === "ZodDiscriminatedUnion") {
      const option = at && typeof at === "object" ? (def.optionsMap as Map<unknown, ZodTypeAny>).get((at as Record<string, unknown>)[def.discriminator as string]) : undefined;
      if (!option) return false;
      node = unwrapped(option);
      continue;
    }
    // The end of the path is the object that holds the unrecognised keys.
    if (index >= path.length) return def.typeName === "ZodObject";
    const key = path[index++]!;
    at = at && typeof at === "object" ? (at as Record<string | number, unknown>)[key] : undefined;
    let next: ZodTypeAny | undefined;
    if (def.typeName === "ZodObject") next = (def.shape() as Record<string, ZodTypeAny>)[key] ?? (definition(def.catchall).typeName === "ZodNever" ? undefined : def.catchall);
    else if (def.typeName === "ZodArray") next = def.type;
    else if (def.typeName === "ZodRecord") next = def.valueType;
    else if (def.typeName === "ZodTuple") next = def.items[key as number] ?? def.rest ?? undefined;
    if (!next) return false;
    node = unwrapped(next);
  }
  return false;
}

/** Only fields a newer service added: every issue is an unrecognised key, in a shape the schema chose for the answer. */
function onlyAdditions(schema: ZodTypeAny, value: unknown, error: ZodError): boolean {
  return error.issues.every((issue) => issue.code === "unrecognized_keys" && chosenShape(schema, value, issue.path));
}

/**
 * An answer read through the shared schema the API checked it with
 * (lib/valopay-schema). A field a newer service added is accepted, so an open
 * page keeps working across a deployment; a missing, mistyped or impossible
 * field is not: the answer is undefined, and the caller shows a problem (a
 * read) or holds the outcome as unconfirmed (a write), never the data. An
 * addition counts only within the shape the schema chose, never in one
 * alternative of a union the answer might match by accident. Where an answer's
 * shape depends on the request, as a connected action's does on its action,
 * the caller chooses the schema first (connectedActionResultFor).
 */
export function readAnswer<S extends ZodTypeAny>(schema: S, value: unknown): z.output<S> | undefined {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  return onlyAdditions(schema, value, parsed.error) ? (value as z.output<S>) : undefined;
}

/** An error the console shows in these words (saidBy reads data.error); it carries no status, so a read is not repeated and a write stays unconfirmed. */
export function answerProblem(message: string): Error {
  return Object.assign(new Error(message), { data: { error: message } });
}
