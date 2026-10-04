import 'server-only';
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, timestamp, bigint, jsonb, unique, primaryKey, foreignKey, check, index } from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const people = pgTable('people', {
  id: uuid('id').primaryKey(), displayName: text('display_name').notNull(), createdAt: createdAt(),
}, t => [check('people_display_name_check', sql`length(btrim(${t.displayName})) BETWEEN 1 AND 200`)]);
export const users = pgTable('users', {
  id: uuid('id').primaryKey(), personId: uuid('person_id').references(() => people.id),
  authSubject: text('auth_subject').unique(), role: text('role').notNull(),
  active: boolean('active').notNull().default(false), createdAt: createdAt(),
}, t => [check('users_role_check', sql`${t.role} IN ('researcher','principal_investigator','staff','admin')`)]);
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey(), code: text('code').notNull().unique(), name: text('name').notNull(),
  kind: text('kind').notNull(), createdAt: createdAt(),
}, t => [check('projects_name_check', sql`length(btrim(${t.name})) BETWEEN 1 AND 200`), check('projects_kind_check', sql`${t.kind} IN ('research','program')`)]);
export const projectMemberships = pgTable('project_memberships', {
  id: uuid('id').primaryKey(), projectId: uuid('project_id').notNull().references(() => projects.id),
  userId: uuid('user_id').notNull().references(() => users.id), active: boolean('active').notNull().default(true),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(), endsAt: timestamp('ends_at', { withTimezone: true }),
}, t => [unique().on(t.projectId, t.userId), index('memberships_user_idx').on(t.userId), check('project_memberships_check', sql`${t.endsAt} IS NULL OR ${t.endsAt} > ${t.startsAt}`)]);
export const budgetLines = pgTable('budget_lines', {
  id: uuid('id').primaryKey(), projectId: uuid('project_id').notNull().references(() => projects.id),
  internalLabel: text('internal_label').notNull(), originalAmount: bigint('original_amount', { mode: 'bigint' }).notNull(), createdAt: createdAt(),
}, t => [unique().on(t.id, t.projectId), check('budget_lines_internal_label_check', sql`length(btrim(${t.internalLabel})) BETWEEN 1 AND 200`), check('budget_lines_original_amount_check', sql`${t.originalAmount} >= 0`)]);
export const spendCases = pgTable('spend_cases', {
  id: uuid('id').primaryKey(), projectId: uuid('project_id').notNull().references(() => projects.id),
  applicantId: uuid('applicant_id').notNull().references(() => users.id), budgetLineId: uuid('budget_line_id'), createdAt: createdAt(),
}, t => [unique().on(t.id, t.projectId), index('spend_cases_project_idx').on(t.projectId), foreignKey({ columns: [t.budgetLineId, t.projectId], foreignColumns: [budgetLines.id, budgetLines.projectId] })]);
export const commandReceipts = pgTable('command_receipts', {
  actorId: uuid('actor_id').notNull().references(() => users.id), requestId: uuid('request_id').notNull(),
  fingerprint: text('fingerprint').notNull(), result: jsonb('result').notNull(), createdAt: createdAt(),
}, t => [primaryKey({ columns: [t.actorId, t.requestId] }), check('command_receipts_fingerprint_check', sql`${t.fingerprint} ~ '^[0-9a-f]{64}$'`)]);
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey(), actorId: uuid('actor_id').notNull().references(() => users.id),
  projectId: uuid('project_id').notNull().references(() => projects.id), requestId: uuid('request_id').notNull(),
  action: text('action').notNull(), reason: text('reason').notNull(),
  beforeState: jsonb('before_state').notNull(), afterState: jsonb('after_state').notNull(), createdAt: createdAt(),
}, t => [unique().on(t.actorId, t.requestId), foreignKey({ columns: [t.actorId, t.requestId], foreignColumns: [commandReceipts.actorId, commandReceipts.requestId] }),
  index('audit_project_time_idx').on(t.projectId, t.createdAt), check('audit_events_action_check', sql`length(btrim(${t.action})) BETWEEN 1 AND 200`), check('audit_events_reason_check', sql`length(btrim(${t.reason})) BETWEEN 1 AND 1000`)]);
