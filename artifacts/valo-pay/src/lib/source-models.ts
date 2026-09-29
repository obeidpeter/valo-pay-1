import {
  importKinds,
  recordDataSchemas,
  sourceProfileViewSchema,
  sourcesViewSchema,
  valopayRecordSchema,
} from "@workspace/valopay-schema";
import { z } from "zod";

/** Sources and Imports read the same reusable mapping; older optional schedule fields stay optional. */
export const sourceProfileRecordSchema = valopayRecordSchema.extend({
  kind: z.literal("source-profiles"),
  status: z.enum(["active", "paused"]),
  data: recordDataSchemas["source-profiles"].extend({
    source: z.string(),
    kind: z.enum(importKinds),
    mapping: z.record(z.string()),
    amountUnit: z.enum(["naira", "kobo"]),
    identityColumn: z.string(),
  }),
});

/** Save receipts contain the profile record; only source-list responses include delivery state. */
export const consoleSourceProfileSchema = sourceProfileViewSchema.extend(
  sourceProfileRecordSchema.shape,
);
export const consoleSourcesViewSchema = sourcesViewSchema.extend({
  profiles: z.array(consoleSourceProfileSchema),
});

export type SourceProfile = z.output<typeof consoleSourceProfileSchema>;
export type SourcesView = z.output<typeof consoleSourcesViewSchema>;
export type ProviderEvent = SourcesView["paystack"]["events"][number];
