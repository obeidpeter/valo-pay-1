import type { z } from 'zod';
import { connectedViewSchema, recordDataSchemas } from '@workspace/valopay-schema';

/** Reuse the shared record fields instead of widening consent and checkout data to any. */
export const consoleConnectedViewSchema = connectedViewSchema.extend({
  consents: connectedViewSchema.shape.consents.element.extend({
    data: recordDataSchemas['connected-consents'],
  }).array(),
  payments: connectedViewSchema.shape.payments.extend({
    intents: connectedViewSchema.shape.payments.shape.intents.element.extend({
      data: recordDataSchemas['connected-intents'],
    }).array(),
  }),
});

export type ConnectedView = z.output<typeof consoleConnectedViewSchema>;
export type ConnectedRecord = ConnectedView['payments']['intents'][number];
