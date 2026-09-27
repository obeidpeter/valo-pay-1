import { pgTable, text, jsonb, timestamp, bigint, integer, uniqueIndex, index, check, primaryKey, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";

export const workspaces = pgTable("valopay_workspaces", {
  id: text("id").primaryKey(),
  principalHash: text("principal_hash").notNull().unique(),
  role: text("role").notNull().default("Admin"),
  createdAt: timestamp("created_at", {withTimezone:true}).notNull().defaultNow(),
});
export const merchants = pgTable("valopay_merchants", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(()=>workspaces.id),
  info: jsonb("info").notNull(),
  settings: jsonb("settings").notNull(),
}, t => [
  // A workspace's lenders: listing and counting them, the expiry sweep, the staff directory and row-security scope (migration 007).
  index("valopay_merchants_workspace").on(t.workspaceId, t.id),
]);
export const records = pgTable("valopay_records", {
  id: text("id").primaryKey(),
  merchantId: text("merchant_id").notNull().references(()=>merchants.id),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  reference: text("reference").notNull().default(""),
  amountKobo: bigint("amount_kobo", {mode:"number"}).notNull().default(0),
  customerId: text("customer_id").notNull().default(""),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
  updatedAt: timestamp("updated_at",{withTimezone:true}).notNull().defaultNow(),
}, t => [
  index("valopay_records_lender_kind_page").on(t.merchantId, t.kind, t.createdAt, t.id),
  index("valopay_records_lender_kind_status_page").on(t.merchantId, t.kind, t.status, t.createdAt, t.id),
  index("valopay_records_lender_customer").on(t.merchantId, t.customerId, t.createdAt, t.id),
  index("valopay_records_lender_kind_updated").on(t.merchantId, t.kind, t.updatedAt),
  // The export worker's look-up: queued exports, and running ones whose lease has run out, oldest first (migration 008).
  index("valopay_records_export_queue").on(t.createdAt, t.id).where(sql`${t.kind} = 'exports' AND ${t.status} IN ('queued','running')`),
  uniqueIndex("valopay_unique_due_reference")
    .on(t.merchantId, t.reference)
    .where(sql`${t.kind} = 'due-items' AND ${t.reference} <> ''`),
  uniqueIndex("valopay_unique_customer_reference")
    .on(t.merchantId, t.reference)
    .where(sql`${t.kind} = 'customers' AND ${t.reference} <> ''`),
  // drizzle-kit reads every column of an index that has an expression back as an expression, so the lender column of
  // these two is declared as one too: declared as a plain column it never matched, and every push dropped and rebuilt
  // both guards. PostgreSQL builds the same index either way.
  uniqueIndex("valopay_unique_provider_event")
    .on(sql`${t.merchantId}`, sql`translate(coalesce(nullif(btrim(${t.data}->>'providerConnection'), ''), nullif(btrim(${t.data}->>'provider'), ''), ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`, sql`coalesce(${t.data}->>'source', '')`, sql`(${t.data}->>'eventId')`)
    .where(sql`${t.kind} = 'observations' AND ${t.data}->>'eventId' IS NOT NULL`),
  uniqueIndex("valopay_one_inflight")
    .on(sql`${t.merchantId}`, sql`(${t.data}->>'dueItemId')`)
    .where(sql`${t.kind} = 'attempts' AND ${t.status} IN ('scheduled','sent','unknown')`),
  check("valopay_money_integer", sql`${t.amountKobo} >= 0 AND ${t.amountKobo} <= 9007199254740991`),
  check("valopay_ticket_floor", sql`${t.kind} <> 'due-items' OR ${t.amountKobo} >= 500000`),
]);
export const idempotency = pgTable("valopay_idempotency", {
  id: text("id").primaryKey(),
  merchantId: text("merchant_id").notNull().references(()=>merchants.id),
  requestHash: text("request_hash").notNull(),
  response: jsonb("response").notNull(),
  createdAt: timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex("valopay_idempotency_tenant_key").on(t.merchantId,t.id)]);
export const insertValopayRecordSchema = createInsertSchema(records);
export type ValopayRecordRow = typeof records.$inferSelect;

/** Service-only deletion tombstones survive the sandbox they belong to. Never grant this table to tenant runtimes. */
export const exportCleanup = pgTable('valopay_export_cleanup', {
  id: text('id').primaryKey(), merchantId: text('merchant_id').notNull(), bucket: text('bucket').notNull(),
  objectName: text('object_name').notNull(), checksum: text('checksum'),
  attempts: integer('attempts').notNull().default(0), lastFailure: text('last_failure'),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  leaseToken: text('lease_token'), leaseUntil: timestamp('lease_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('valopay_export_cleanup_due').on(t.nextAttemptAt, t.id), check('valopay_export_cleanup_attempts', sql`${t.attempts} >= 0`)]);

/** Private recovery requests are never exposed through the generic records API. */
export const operations = pgTable('valopay_operations', {
  id: text('id').primaryKey(), merchantId: text('merchant_id').notNull().references(() => merchants.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(), actor: text('actor').notNull(), role: text('role').notNull(),
  requestKey: text('request_key').notNull(), requestHash: text('request_hash').notNull(), request: jsonb('request').notNull(),
  label: text('label').notNull(), status: text('status').notNull().default('pending'), receipt: jsonb('receipt'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('valopay_operations_owner_page').on(t.merchantId, t.owner, t.createdAt, t.id),
  // The pending-request limit counts only a person's pending entries (migration 007).
  index('valopay_operations_pending').on(t.merchantId, t.owner).where(sql`${t.status} = 'pending'`),
  check('valopay_operation_status', sql`${t.status} IN ('pending','completed','cancelled')`)]);

export const teams = pgTable('valopay_teams', {
  workspaceId: text('workspace_id').primaryKey().references(() => workspaces.id),
  organizationId: text('organization_id').notNull().unique(), name: text('name').notNull(),
});
// The foreign keys of memberships and invitations to their team, and of lender grants to their membership (below), are
// named here: the names Drizzle generates for them run past PostgreSQL's 63 characters, which cuts them short, so every
// push dropped and added them again. Migration 008 renames the cut names that earlier copies of 003 and 004 left.
export const staffMemberships = pgTable('valopay_staff_memberships', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull(),
  userId: text('user_id').notNull(), displayName: text('display_name').notNull(), role: text('role').notNull(),
  status: text('status').notNull().default('active'), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [foreignKey({ name: 'valopay_staff_memberships_workspace_id_fk', columns: [t.workspaceId], foreignColumns: [teams.workspaceId] }),
  uniqueIndex('valopay_staff_workspace_user').on(t.workspaceId, t.userId),
  check('valopay_staff_status', sql`${t.status} IN ('active','suspended','revoked')`),
  check('valopay_staff_role', sql`${t.role} IN ('Admin','Operations','Finance','Compliance reviewer','Read-only')`)]);
export const staffInvitations = pgTable('valopay_staff_invitations', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull(),
  email: text('email').notNull(), role: text('role').notNull(), tokenHash: text('token_hash').notNull().unique(),
  invitedBy: text('invited_by').notNull(), status: text('status').notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [foreignKey({ name: 'valopay_staff_invitations_workspace_id_fk', columns: [t.workspaceId], foreignColumns: [teams.workspaceId] }),
  check('valopay_invitation_status', sql`${t.status} IN ('pending','accepted','revoked')`)]);
export const staffEvents = pgTable('valopay_staff_events', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => teams.workspaceId),
  actor: text('actor').notNull(), action: text('action').notNull(), subject: text('subject').notNull(), detail: jsonb('detail').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** An active non-administrator membership has access only to named lenders. */
export const staffLenderAccess = pgTable('valopay_staff_lender_access', {
  membershipId: text('membership_id').notNull(),
  merchantId: text('merchant_id').notNull().references(() => merchants.id, { onDelete: 'cascade' }),
  grantedBy: text('granted_by').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.membershipId, table.merchantId] }),
  foreignKey({ name: 'valopay_staff_lender_access_membership_id_fk', columns: [table.membershipId], foreignColumns: [staffMemberships.id] }).onDelete('cascade'),
  index('valopay_staff_lender_access_lender').on(table.merchantId, table.membershipId)]);
