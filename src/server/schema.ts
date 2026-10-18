import 'server-only';
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, timestamp, bigint, jsonb, smallint, integer, unique, uniqueIndex, primaryKey, foreignKey, check, index, date, customType } from 'drizzle-orm/pg-core';

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
  businessYear: integer('business_year'), version: bigint('version', { mode: 'bigint' }).notNull().default(0n),
}, t => [check('projects_name_check', sql`length(btrim(${t.name})) BETWEEN 1 AND 200`), check('projects_kind_check', sql`${t.kind} IN ('research','program')`),
  check('projects_year_check', sql`${t.businessYear} BETWEEN 2000 AND 2200`), check('projects_version_check', sql`${t.version} >= 0`)]);
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

export const loginAccounts = pgTable('login_accounts', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  email: text('email').notNull().unique(), authVersion: bigint('auth_version', { mode: 'bigint' }).notNull().default(0n),
  createdAt: createdAt(),
  bindingAllowed: boolean('binding_allowed').notNull().default(false),
  ownershipAfter: timestamp('ownership_after', { withTimezone: true }).notNull().defaultNow(),
}, t => [check('login_accounts_auth_version_check', sql`${t.authVersion} >= 0`),
  check('login_accounts_email_check', sql`${t.email} = lower(btrim(${t.email})) AND length(${t.email}) BETWEEN 3 AND 254 AND ${t.email} ~ '^[^[:space:]@]+@[^[:space:]@]+$'`)]);

export const emailOwnershipChecks = pgTable('email_ownership_checks', {
  id: uuid('id').primaryKey(), userId: uuid('user_id').notNull().references(() => loginAccounts.userId),
  email: text('email').notNull(), outcome: text('outcome').notNull(), method: text('method').notNull(),
  checkedBy: uuid('checked_by').notNull().references(() => users.id),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('ownership_user_time_idx').on(t.userId, t.checkedAt),
  check('ownership_outcome_check', sql`${t.outcome} IN ('verified','rejected')`),
  check('ownership_method_check', sql`length(btrim(${t.method})) BETWEEN 1 AND 500`),
  check('ownership_email_check', sql`${t.email} = lower(btrim(${t.email})) AND length(${t.email}) BETWEEN 3 AND 254 AND ${t.email} ~ '^[^[:space:]@]+@[^[:space:]@]+$'`)]);

export const authIdentities = pgTable('auth_identities', {
  id: uuid('id').primaryKey(), userId: uuid('user_id').notNull().references(() => loginAccounts.userId),
  providerKey: text('provider_key').notNull(), issuer: text('issuer').notNull(), subject: text('subject').notNull(),
  enabled: boolean('enabled').notNull().default(false), linkedBy: uuid('linked_by').notNull().references(() => users.id),
  createdAt: createdAt(),
}, t => [unique().on(t.providerKey, t.issuer, t.subject), unique().on(t.id, t.userId), index('identities_user_idx').on(t.userId),
  check('identity_provider_check', sql`length(btrim(${t.providerKey})) BETWEEN 1 AND 100`),
  check('identity_issuer_check', sql`length(btrim(${t.issuer})) BETWEEN 1 AND 1000`),
  check('identity_subject_check', sql`length(btrim(${t.subject})) BETWEEN 1 AND 500`)]);

export const authSessions = pgTable('auth_sessions', {
  tokenHash: text('token_hash').primaryKey(), userId: uuid('user_id').notNull().references(() => loginAccounts.userId),
  identityId: uuid('identity_id').notNull(), slot: smallint('slot').notNull(),
  authVersion: bigint('auth_version', { mode: 'bigint' }).notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }), stepUpAt: timestamp('step_up_at', { withTimezone: true }),
}, t => [foreignKey({ columns: [t.identityId, t.userId], foreignColumns: [authIdentities.id, authIdentities.userId] }),
  uniqueIndex('sessions_live_slot_idx').on(t.userId, t.slot).where(sql`${t.revokedAt} IS NULL`),
  check('session_hash_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`), check('session_slot_check', sql`${t.slot} IN (1,2)`),
  check('session_version_check', sql`${t.authVersion} >= 0`),
  check('session_expiry_check', sql`${t.expiresAt} > ${t.issuedAt} AND ${t.expiresAt} <= ${t.issuedAt} + INTERVAL '8 hours'`),
  check('session_seen_check', sql`${t.lastSeenAt} >= ${t.issuedAt} AND ${t.lastSeenAt} <= ${t.expiresAt}`),
  check('session_revoked_check', sql`${t.revokedAt} IS NULL OR ${t.revokedAt} >= ${t.issuedAt}`),
  check('session_step_up_check', sql`${t.stepUpAt} IS NULL OR (${t.stepUpAt} >= ${t.issuedAt} AND ${t.stepUpAt} <= ${t.expiresAt})`)]);

export const accountAuditEvents = pgTable('account_audit_events', {
  id: uuid('id').primaryKey(), actorId: uuid('actor_id').notNull().references(() => users.id),
  targetUserId: uuid('target_user_id').notNull().references(() => users.id), requestId: uuid('request_id').notNull(),
  action: text('action').notNull(), reason: text('reason').notNull(),
  beforeState: jsonb('before_state').notNull(), afterState: jsonb('after_state').notNull(), createdAt: createdAt(),
}, t => [unique().on(t.actorId, t.requestId), index('account_audit_target_time_idx').on(t.targetUserId, t.createdAt),
  check('account_audit_action_check', sql`length(btrim(${t.action})) BETWEEN 1 AND 200`),
  check('account_audit_reason_check', sql`length(btrim(${t.reason})) BETWEEN 1 AND 1000`),
  check('account_audit_before_check', sql`jsonb_typeof(${t.beforeState}) = 'object'`),
  check('account_audit_after_check', sql`jsonb_typeof(${t.afterState}) = 'object'`)]);

export const oauthFlows = pgTable('oauth_flows', {
  stateHash: text('state_hash').primaryKey(), browserHash: text('browser_hash').notNull(),
  verifier: text('verifier').notNull(), nonce: text('nonce').notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
export const otpCredentials = pgTable('otp_credentials', {
  userId: uuid('user_id').primaryKey().references(() => loginAccounts.userId), encryptedSecret: text('encrypted_secret').notNull(),
  confirmed: boolean('confirmed').notNull().default(false), lastCounter: bigint('last_counter', { mode: 'bigint' }).notNull().default(-1n),
  failures: integer('failures').notNull().default(0), lockedUntil: timestamp('locked_until', { withTimezone: true }), createdAt: createdAt(),
}, t => [check('otp_failures_check', sql`${t.failures} >= 0`)]);
export const workItems = pgTable('work_items', {
  id: uuid('id').primaryKey(), projectId: uuid('project_id').notNull().references(() => projects.id), title: text('title').notNull(),
  description: text('description').notNull(), assignedTo: uuid('assigned_to').references(() => users.id),
  createdBy: uuid('created_by').notNull().references(() => users.id), version: bigint('version', { mode: 'bigint' }).notNull().default(0n), createdAt: createdAt(),
}, t => [unique('work_project_unique').on(t.id,t.projectId), index('work_project_idx').on(t.projectId), index('work_assignee_idx').on(t.assignedTo),
  check('work_title_check', sql`length(btrim(${t.title})) BETWEEN 1 AND 200`), check('work_description_check', sql`length(${t.description}) <= 5000`), check('work_version_check', sql`${t.version} >= 0`)]);
export const workHistory = pgTable('work_history', {
  id: uuid('id').primaryKey(), workId: uuid('work_id').notNull().references(() => workItems.id), actorId: uuid('actor_id').notNull().references(() => users.id),
  reason: text('reason').notNull(), beforeState: jsonb('before_state').notNull(), afterState: jsonb('after_state').notNull(), createdAt: createdAt(),
}, t => [index('work_history_time_idx').on(t.workId, t.createdAt), check('work_history_reason_check', sql`length(btrim(${t.reason})) BETWEEN 1 AND 1000`)]);
export const projectHistory = pgTable('project_history', {
  id: uuid('id').primaryKey(), projectId: uuid('project_id').notNull().references(() => projects.id), actorId: uuid('actor_id').notNull().references(() => users.id),
  reason: text('reason').notNull(), beforeState: jsonb('before_state').notNull(), afterState: jsonb('after_state').notNull(), createdAt: createdAt(),
}, t => [index('project_history_time_idx').on(t.projectId, t.createdAt), check('project_history_reason_check', sql`length(btrim(${t.reason})) BETWEEN 1 AND 1000`)]);

// SQL migrations own triggers and the deferred audit FK; Drizzle mirrors storage columns/constraints.
export const budgetCodes = pgTable('budget_codes', {
  id: uuid('id').primaryKey(), code: text('code').notNull().unique(), level: smallint('level').notNull(),
}, t=>[check('budget_code_format',sql`${t.code} ~ '^N[0-9]{2}(\.[0-9]{2})?(\.[0-9]{3})?$'`),check('budget_code_level',sql`${t.level} BETWEEN 1 AND 3`)]);
export const budgetCodeVersions = pgTable('budget_code_versions', {
  id:uuid('id').primaryKey(),codeId:uuid('code_id').notNull().references(()=>budgetCodes.id),version:bigint('version',{mode:'bigint'}).notNull(),
  parentId:uuid('parent_id').references(()=>budgetCodes.id),name:text('name').notNull(),active:boolean('active').notNull(),
  effectiveOn:date('effective_on').notNull(),actorId:uuid('actor_id').notNull().references(()=>users.id),reason:text('reason').notNull(),createdAt:createdAt(),
},t=>[unique().on(t.codeId,t.version),check('budget_code_version',sql`${t.version} >= 0`),check('budget_code_name',sql`length(btrim(${t.name})) BETWEEN 1 AND 200`)]);
export const budgetAccounts = pgTable('budget_accounts', {
  lineId:uuid('line_id').primaryKey().references(()=>budgetLines.id),codeVersionId:uuid('code_version_id').notNull().references(()=>budgetCodeVersions.id),
  classificationSnapshot:jsonb('classification_snapshot').notNull(),businessName:text('business_name').notNull(),businessYear:integer('business_year').notNull(),academicYear:integer('academic_year').notNull(),
  periodStart:date('period_start').notNull(),periodEnd:date('period_end').notNull(),fund:text('fund').notNull(),
  currentAmount:bigint('current_amount',{mode:'bigint'}).notNull(),committedAmount:bigint('committed_amount',{mode:'bigint'}).notNull().default(0n),version:bigint('version',{mode:'bigint'}).notNull().default(0n),
},t=>[check('budget_period',sql`${t.periodEnd} >= ${t.periodStart}`),check('budget_fund',sql`length(btrim(${t.fund})) BETWEEN 1 AND 200`),check('budget_current',sql`${t.currentAmount} >= 0`),check('budget_commitment',sql`${t.committedAmount} >= 0 AND ${t.committedAmount} <= ${t.currentAmount}`),check('budget_version',sql`${t.version} >= 0`)]);
export const budgetChanges = pgTable('budget_changes', {
  id:uuid('id').primaryKey(),projectId:uuid('project_id').notNull().references(()=>projects.id),applicantId:uuid('applicant_id').notNull().references(()=>users.id),
  reason:text('reason').notNull(),kind:text('kind').notNull(),state:text('state').notNull().default('submitted'),version:bigint('version',{mode:'bigint'}).notNull().default(0n),
  supersedes:uuid('supersedes'),createdAt:createdAt(),
},t=>[foreignKey({columns:[t.supersedes],foreignColumns:[t.id]}),check('budget_change_reason',sql`length(btrim(${t.reason})) BETWEEN 1 AND 1000`),check('budget_change_kind',sql`${t.kind} IN ('transfer','total')`),check('budget_change_state',sql`${t.state} IN ('submitted','reviewing','confirmed','rejected','cancelled')`),check('budget_change_version',sql`${t.version} >= 0`),index('budget_changes_project_idx').on(t.projectId)]);
export const budgetChangeLines = pgTable('budget_change_lines', {
  changeId:uuid('change_id').notNull().references(()=>budgetChanges.id),lineId:uuid('line_id').notNull().references(()=>budgetAccounts.lineId),
  beforeAmount:bigint('before_amount',{mode:'bigint'}).notNull(),afterAmount:bigint('after_amount',{mode:'bigint'}).notNull(),expectedVersion:bigint('expected_version',{mode:'bigint'}).notNull(),
},t=>[primaryKey({columns:[t.changeId,t.lineId]}),check('change_before',sql`${t.beforeAmount} >= 0`),check('change_after',sql`${t.afterAmount} >= 0`),check('change_version',sql`${t.expectedVersion} >= 0`)]);
const bytea=customType<{data:Buffer}>({dataType:()=> 'bytea'});
export const budgetFiles = pgTable('budget_files', {
  id:uuid('id').primaryKey(),changeId:uuid('change_id').notNull().references(()=>budgetChanges.id),filename:text('filename').notNull(),sha256:text('sha256').notNull(),
  content:bytea('content').notNull(),version:integer('version').notNull().default(1),createdAt:createdAt(),
},t=>[check('budget_file_hash',sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),check('budget_file_size',sql`octet_length(${t.content}) BETWEEN 1 AND 5242880`),check('budget_file_version',sql`${t.version} > 0`),unique().on(t.changeId,t.version),index('budget_files_change_idx').on(t.changeId)]);
export const spendStates = pgTable('spend_states', {
  caseId:uuid('case_id').primaryKey(),projectId:uuid('project_id').notNull(),workId:uuid('work_id').notNull(),amount:bigint('amount',{mode:'bigint'}).notNull(),
  paidAmount:bigint('paid_amount',{mode:'bigint'}).notNull().default(0n),state:text('state').notNull().default('draft'),version:bigint('version',{mode:'bigint'}).notNull().default(0n),
  processingBy:uuid('processing_by').references(()=>users.id),processingAt:timestamp('processing_at',{withTimezone:true}),
},t=>[foreignKey({columns:[t.caseId,t.projectId],foreignColumns:[spendCases.id,spendCases.projectId]}),foreignKey({columns:[t.workId,t.projectId],foreignColumns:[workItems.id,workItems.projectId]}),
  check('spend_amount',sql`${t.amount} > 0`),check('spend_paid',sql`${t.paidAmount} >= 0 AND ${t.paidAmount} <= ${t.amount}`),check('spend_state',sql`${t.state} IN ('draft','submitted','reviewing','supplement','approved')`),check('spend_version',sql`${t.version} >= 0`),check('spend_paid_state',sql`${t.paidAmount}=0 OR ${t.state}='approved'`),check('spend_processing',sql`(${t.processingBy} IS NULL)=(${t.processingAt} IS NULL)`),index('spend_states_work_idx').on(t.workId)]);
export const budgetEvents = pgTable('budget_events', {
  id:uuid('id').primaryKey(),projectId:uuid('project_id').references(()=>projects.id),entityId:uuid('entity_id').notNull(),actorId:uuid('actor_id').notNull().references(()=>users.id),requestId:uuid('request_id').notNull(),
  action:text('action').notNull(),reason:text('reason').notNull(),beforeState:jsonb('before_state').notNull(),afterState:jsonb('after_state').notNull(),createdAt:createdAt(),
},t=>[foreignKey({columns:[t.actorId,t.requestId],foreignColumns:[commandReceipts.actorId,commandReceipts.requestId]}),check('budget_event_reason',sql`length(btrim(${t.reason})) BETWEEN 1 AND 1000`),index('budget_events_entity_idx').on(t.entityId,t.createdAt)]);
