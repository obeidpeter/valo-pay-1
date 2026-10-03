import { z } from 'zod';
import { instantInputSchema, merchantIdSchema } from './api';

const identity = z.string().min(1).max(300);
const instant = z.string().datetime();
/** All work is scoped to the selected lender; team scope is authorised by the server. */
export const personalWorkQuerySchema = z.object({
  merchantId: merchantIdSchema,
  scope: z.enum(['mine', 'team']).default('mine'),
  filter: z.enum(['all', 'overdue', 'handover', 'review', 'unread']).default('all'),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
/** Bounded, lender-scoped personal or administrator queue query. */
export type PersonalWorkQuery = z.infer<typeof personalWorkQuerySchema>;

/** Reviewed source identity and version; the server supplies the acting recipient. */
export const workReceiptInputSchema = z.object({
  sourceId: identity,
  eventId: identity,
  expectedUpdatedAt: instantInputSchema,
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
/** Validated read or handover acknowledgement request. */
export type WorkReceiptInput = z.infer<typeof workReceiptInputSchema>;

/** Current saved assignment or review, with stable notification identity and status. */
export const personalWorkItemSchema = z.object({
  id: identity,
  eventId: identity,
  sourceId: identity,
  sourceVersion: instant,
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  type: z.enum(['case', 'handover', 'review', 'correction']),
  title: z.string(),
  nextAction: z.string(),
  assignee: identity,
  assigneeName: z.string(),
  waitingSince: instant.optional(),
  dueAt: instant.nullable(),
  overdue: z.boolean(),
  escalated: z.boolean(),
  escalationReason: z.string().nullable(),
  reviewCurrent: z.boolean().nullable(),
  href: z.string().startsWith('/'),
  readAt: instant.nullable(),
  canAcknowledge: z.boolean(),
  assignmentEventId: identity.nullable(),
  notice: z.string().nullable(),
}).strict();
/** One actionable assignment and its in-app notification state. */
export type PersonalWorkItem = z.infer<typeof personalWorkItemSchema>;

/** Authoritative recipient-owned read or acknowledgement receipt. */
export const workReceiptSchema = z.object({
  id: identity,
  merchantId: identity,
  action: z.enum(['read', 'acknowledge']),
  sourceId: identity,
  eventId: identity,
  actor: identity,
  at: instant,
  duplicate: z.boolean(),
  syntheticOnly: z.literal(true),
  financialStatusChanged: z.literal(false),
}).strict();
/** Saved work receipt; no financial status transition is implied. */
export type WorkReceipt = z.infer<typeof workReceiptSchema>;

/** Bounded personal queue, administrator workload and recipient-owned history. */
export const personalWorkViewSchema = z.object({
  merchantId: identity,
  lenderName: z.string(),
  actor: identity,
  role: z.string(),
  asOf: instant,
  syntheticOnly: z.literal(true),
  canViewTeam: z.boolean(),
  canWork: z.boolean(),
  scope: z.enum(['mine', 'team']),
  filter: personalWorkQuerySchema.shape.filter,
  items: z.array(personalWorkItemSchema).max(50),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(50),
  counts: z.object({ all: z.number().int().nonnegative(), overdue: z.number().int().nonnegative(), handover: z.number().int().nonnegative(), review: z.number().int().nonnegative(), unread: z.number().int().nonnegative(), escalated: z.number().int().nonnegative() }).strict(),
  workload: z.array(z.object({ actor: identity, name: z.string(), total: z.number().int().nonnegative(), overdue: z.number().int().nonnegative(), handovers: z.number().int().nonnegative(), reviews: z.number().int().nonnegative(), escalated: z.number().int().nonnegative() }).strict()).max(100),
  workloadTotal: z.number().int().nonnegative(),
  history: z.array(z.object({ id: identity, action: z.enum(['read', 'acknowledge']), sourceId: identity, summary: z.string(), at: instant, href: z.string().startsWith('/') }).strict()).max(10),
  escalationRule: z.string(),
}).strict();
/** Validated personal work response for one lender and actor. */
export type PersonalWorkView = z.infer<typeof personalWorkViewSchema>;
