import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Pool, Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as tables from '../src/server/schema.ts';
import { assertRuntimeRole } from '../src/server/db.ts';
import { authorizeProject } from '../src/server/access.ts';
import { transaction, auditedCommand } from '../src/server/transaction.ts';
import { migrate } from '../scripts/migrate.mjs';
import { assertLocalDatabase, requiredUrl } from '../scripts/db-config.mjs';

test('real PostgreSQL foundation integration (isolated disposable schema)', async t => {
  const ownerUrl = assertLocalDatabase(requiredUrl('TEST_MIGRATION_DATABASE_URL'), 'boot_erp_test', 'owner');
  const appUrl = assertLocalDatabase(requiredUrl('TEST_DATABASE_URL'), 'boot_erp_test', 'app');
  const schema = `foundation_test_${randomUUID().replaceAll('-', '')}`;
  const owner = new Client({ connectionString: ownerUrl });
  const pool = new Pool({ connectionString: appUrl, max: 4, options: `-c search_path=${schema},public` });
  let created = false;
  await owner.connect();
  try {
    await owner.query(`CREATE SCHEMA ${schema}`); created = true;
    await t.test('foundation then auth migration preserves an existing user; repeat is a no-op', async () => {
      assert.equal(await migrate(ownerUrl, schema, 1), 1);
      const legacy = randomUUID();
      await owner.query(`INSERT INTO ${schema}.users(id,role) VALUES($1,'researcher')`, [legacy]);
      assert.equal(await migrate(ownerUrl, schema), 1);
      assert.deepEqual((await owner.query(`SELECT role,active,auth_subject FROM ${schema}.users WHERE id=$1`, [legacy])).rows,
        [{ role: 'researcher', active: false, auth_subject: null }]);
      assert.equal((await owner.query(`SELECT count(*)::int AS n FROM ${schema}.login_accounts`)).rows[0].n, 0);
      assert.equal(await migrate(ownerUrl, schema), 0);
    });
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO boot_erp_test_app`);
    await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO boot_erp_test_app`);
    await owner.query(`REVOKE ALL ON TABLE ${schema}.migration_history FROM boot_erp_test_app`);
    await owner.query(`SET search_path TO ${schema},public`);
    const actor = randomUUID(), researcher = randomUUID(), pi = randomUUID();
    const project = randomUUID(), otherProject = randomUUID(), budget = randomUUID();
    await owner.query("INSERT INTO users(id,role,active) VALUES($1,'staff',true),($2,'researcher',true),($3,'principal_investigator',true)", [actor, researcher, pi]);
    await owner.query("INSERT INTO projects(id,code,name,kind) VALUES($1,'TEST-A','0','research'),($2,'TEST-B','synthetic','program')", [project, otherProject]);
    await owner.query('INSERT INTO project_memberships(id,project_id,user_id,starts_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP-INTERVAL \'1 day\'),($4,$2,$5,CURRENT_TIMESTAMP-INTERVAL \'1 day\')', [randomUUID(), project, researcher, randomUUID(), pi]);
    await owner.query("INSERT INTO budget_lines(id,project_id,internal_label,original_amount) VALUES($1,$2,'synthetic',9007199254740993)", [budget, project]);

    await t.test('Drizzle schema: all columns, types, nullability, PK, unique, FK and check counts match SQL', async () => {
      const normalize = (type: string) => type.replace('timestamp with time zone','timestamptz');
      for (const table of Object.values(tables)) {
        const config = getTableConfig(table);
        const actual = await owner.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [schema, config.name]);
        assert.deepEqual(actual.rows.map(r => [r.column_name, normalize(r.data_type), r.is_nullable === 'NO']),
          config.columns.map(c => [c.name, normalize(c.getSQLType()), c.notNull]), config.name);
        const constraints = await owner.query(`SELECT contype, count(*)::int AS n FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
          JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname=$1 AND r.relname=$2 AND contype IN ('p','u','f','c') GROUP BY contype`, [schema, config.name]);
        const counts = Object.fromEntries(constraints.rows.map(r => [r.contype, r.n]));
        assert.equal(counts.p ?? 0, config.primaryKeys.length + config.columns.filter(c => c.primary).length, `${config.name} PK`);
        assert.equal(counts.u ?? 0, config.uniqueConstraints.length + config.columns.filter(c => c.isUnique).length, `${config.name} unique`);
        assert.equal(counts.f ?? 0, config.foreignKeys.length, `${config.name} FK`);
        assert.equal(counts.c ?? 0, config.checks.length, `${config.name} check`);
      }
      const data = await drizzle(pool).select().from(tables.budgetLines).where(eq(tables.budgetLines.id, budget));
      assert.equal(data[0].originalAmount, 9007199254740993n);
    });
    await t.test('runtime role cannot create tables or connect to dev DB', async () => {
      await assertRuntimeRole(pool);
      await assert.rejects(pool.query('CREATE TABLE forbidden_probe(id int)'), { code: '42501' });
      await assert.rejects(pool.query('DELETE FROM migration_history'), { code: '42501' });
      const wrongUrl = new URL(appUrl); wrongUrl.pathname = '/boot_erp_dev';
      const wrong = new Client({ connectionString: wrongUrl.toString() });
      try { await assert.rejects(wrong.connect(), { code: '42501' }); } finally { await wrong.end(); }
    });
    await t.test('FK blocks cross-project budget association; amount and role checks reject invalid data', async () => {
      await assert.rejects(pool.query('INSERT INTO spend_cases(id,project_id,applicant_id,budget_line_id) VALUES($1,$2,$3,$4)', [randomUUID(), otherProject, actor, budget]), { code: '23503' });
      await assert.rejects(pool.query("INSERT INTO budget_lines(id,project_id,internal_label,original_amount) VALUES($1,$2,'synthetic',-1)", [randomUUID(), project]), { code: '23514' });
      await assert.rejects(pool.query("INSERT INTO users(id,role) VALUES($1,'owner')", [randomUUID()]), { code: '23514' });
      await assert.rejects(pool.query("UPDATE budget_lines SET original_amount=0 WHERE id=$1", [budget]), { code: '55000' });
    });
    await t.test('server uses current assignment and account status; PI cannot write', async () => {
      await transaction(pool, c => authorizeProject(c, researcher, project, 'project.read'));
      await assert.rejects(transaction(pool, c => authorizeProject(c, researcher, otherProject, 'project.read')), { code: 'FORBIDDEN' });
      await assert.rejects(transaction(pool, c => authorizeProject(c, pi, project, 'project.write')), { code: 'FORBIDDEN' });
      await assert.rejects(transaction(pool, c => authorizeProject(c, actor, project, 'system.manage')), { code: 'FORBIDDEN' });
      await owner.query('UPDATE project_memberships SET active=false WHERE user_id=$1', [researcher]);
      await assert.rejects(transaction(pool, c => authorizeProject(c, researcher, project, 'project.read')), { code: 'FORBIDDEN' });
      await owner.query('UPDATE project_memberships SET active=true,ends_at=CURRENT_TIMESTAMP-INTERVAL \'1 hour\' WHERE user_id=$1', [researcher]);
      await assert.rejects(transaction(pool, c => authorizeProject(c, researcher, project, 'project.read')), { code: 'FORBIDDEN' });
      await owner.query('UPDATE users SET active=false WHERE id=$1', [pi]);
      await assert.rejects(transaction(pool, c => authorizeProject(c, pi, project, 'project.read')), { code: 'FORBIDDEN' });
    });
    const command = (requestId = randomUUID()) => ({ actorId: actor, projectId: project, requestId, action: 'foundation.probe', reason: 'synthetic integration check', input: { amount: '1' } });
    await t.test('concurrent same request executes once; changed payload conflicts; audit is append-only', async () => {
      const cmd = command(); let calls = 0;
      const work = async (client: import('pg').PoolClient) => {
        calls++;
        await client.query("INSERT INTO spend_cases(id,project_id,applicant_id,budget_line_id) VALUES($1,$2,$3,$4)", [randomUUID(), project, actor, budget]);
        return { result: { amount: 9007199254740993n }, before: {}, after: { created: true } };
      };
      const outputs = await Promise.all([auditedCommand(pool, cmd, work), auditedCommand(pool, cmd, work)]);
      assert.equal(calls, 1); assert.deepEqual(outputs[0], outputs[1]);
      assert.deepEqual(outputs[0], { amount: '9007199254740993' });
      await assert.rejects(auditedCommand(pool, { ...cmd, input: { amount: '2' } }, work), { code: 'CONFLICT' });
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM audit_events WHERE request_id=$1', [cmd.requestId])).rows[0].n, 1);
      for (const table of ['audit_events', 'command_receipts']) {
        await assert.rejects(pool.query(`DELETE FROM ${table}`), { code: '55000' });
        await assert.rejects(pool.query(`UPDATE ${table} SET request_id=request_id`), { code: '55000' });
        await assert.rejects(pool.query(`TRUNCATE ${table} CASCADE`), { code: '42501' });
      }
    });
    await t.test('callback or audit insert failure rolls back business row, receipt and audit together', async () => {
      for (const auditFailure of [false, true]) {
        const cmd = command(), spendId = randomUUID();
        await assert.rejects(auditedCommand(pool, cmd, async client => {
          await client.query('INSERT INTO spend_cases(id,project_id,applicant_id) VALUES($1,$2,$3)', [spendId, project, actor]);
          if (!auditFailure) throw new Error('synthetic rollback');
          return { result: {}, before: undefined, after: {} };
        }));
        assert.equal((await pool.query('SELECT 1 FROM spend_cases WHERE id=$1', [spendId])).rowCount, 0);
        assert.equal((await pool.query('SELECT 1 FROM command_receipts WHERE request_id=$1', [cmd.requestId])).rowCount, 0);
        assert.equal((await pool.query('SELECT 1 FROM audit_events WHERE request_id=$1', [cmd.requestId])).rowCount, 0);
      }
    });
    await t.test('independent requests lock a shared row and commit serially without lost updates', async () => {
      const work = async (client: import('pg').PoolClient) => {
        const before = (await client.query('SELECT name FROM projects WHERE id=$1 FOR UPDATE', [project])).rows[0].name;
        const after = (BigInt(before) + 1n).toString();
        await client.query('UPDATE projects SET name=$1 WHERE id=$2', [after, project]);
        return { result: { counter: after }, before: { counter: before }, after: { counter: after } };
      };
      await Promise.all([auditedCommand(pool, command(), work), auditedCommand(pool, command(), work)]);
      assert.equal((await pool.query('SELECT name FROM projects WHERE id=$1', [project])).rows[0].name, '2');
    });
    const identity = randomUUID();
    await t.test('pre-registered email and provider subject uniqueness; no automatic activation', async () => {
      await pool.query("INSERT INTO login_accounts(user_id,email) VALUES($1,'researcher@example.invalid'),($2,'staff@example.invalid')", [researcher, actor]);
      await assert.rejects(pool.query("INSERT INTO login_accounts(user_id,email) VALUES($1,'researcher@example.invalid')", [pi]), { code: '23505' });
      await assert.rejects(pool.query("INSERT INTO login_accounts(user_id,email) VALUES($1,'Mixed@example.invalid')", [pi]), { code: '23514' });
      await pool.query("INSERT INTO auth_identities(id,user_id,provider_key,issuer,subject,linked_by) VALUES($1,$2,'google','https://accounts.google.com','synthetic-subject',$3)", [identity, researcher, actor]);
      assert.equal((await pool.query('SELECT enabled FROM auth_identities WHERE id=$1', [identity])).rows[0].enabled, false);
      await assert.rejects(pool.query("INSERT INTO auth_identities(id,user_id,provider_key,issuer,subject,linked_by) VALUES($1,$2,'google','https://accounts.google.com','synthetic-subject',$3)", [randomUUID(), actor, actor]), { code: '23505' });
    });
    await t.test('manual ownership history survives email change and rejects rewriting', async () => {
      const proof = randomUUID();
      await pool.query("INSERT INTO email_ownership_checks(id,user_id,email,outcome,method,checked_by) VALUES($1,$2,'researcher@example.invalid','verified','synthetic manual check',$3)", [proof, researcher, actor]);
      await assert.rejects(pool.query("UPDATE email_ownership_checks SET outcome='rejected' WHERE id=$1", [proof]), { code: '55000' });
      await assert.rejects(pool.query('DELETE FROM email_ownership_checks WHERE id=$1', [proof]), { code: '55000' });
      await pool.query("UPDATE login_accounts SET email='changed@example.invalid' WHERE user_id=$1", [researcher]);
      assert.equal((await pool.query('SELECT email FROM email_ownership_checks WHERE id=$1', [proof])).rows[0].email, 'researcher@example.invalid');
      assert.equal((await pool.query('SELECT 1 FROM email_ownership_checks c JOIN login_accounts a ON a.user_id=c.user_id AND a.email=c.email WHERE a.user_id=$1', [researcher])).rowCount, 0);
    });
    await t.test('concurrent session slots cap at two, reject cross-user identity and preserve revoked history', async () => {
      const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
      const insert = (slot: number, userId = researcher, hours = 8, token = hash()) => pool.query(
        "INSERT INTO auth_sessions(token_hash,user_id,identity_id,slot,auth_version,expires_at) VALUES($1,$2,$3,$4,0,CURRENT_TIMESTAMP+($5 * INTERVAL '1 hour'))", [token, userId, identity, slot, hours]);
      const results = await Promise.allSettled([insert(1), insert(2), insert(1)]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
      assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === '23505').length, 1);
      await assert.rejects(insert(3), { code: '23514' });
      await assert.rejects(insert(1, actor), { code: '23503' });
      await assert.rejects(insert(1, researcher, 9), { code: '23514' });
      await assert.rejects(insert(1, researcher, 8, 'raw-session-token'), { code: '23514' });
      await pool.query('UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND slot=1', [researcher]);
      await insert(1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id=$1', [researcher])).rows[0].n, 3);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL', [researcher])).rows[0].n, 2);
    });
    await t.test('account audit needs no project, is append-only, and fails atomically with account updates', async () => {
      const requestId = randomUUID();
      const addAudit = (client: import('pg').PoolClient, reason: string) => client.query(
        "INSERT INTO account_audit_events(id,actor_id,target_user_id,request_id,action,reason,before_state,after_state) VALUES($1,$2,$3,$4,'account.probe',$5,'{}','{}')", [randomUUID(), actor, researcher, requestId, reason]);
      await assert.rejects(transaction(pool, async client => {
        await client.query('UPDATE login_accounts SET auth_version=1 WHERE user_id=$1', [researcher]);
        await addAudit(client, '');
      }), { code: '23514' });
      assert.equal((await pool.query('SELECT auth_version FROM login_accounts WHERE user_id=$1', [researcher])).rows[0].auth_version, '0');
      await transaction(pool, client => addAudit(client, 'synthetic audit'));
      await assert.rejects(transaction(pool, client => addAudit(client, 'duplicate')), { code: '23505' });
      await assert.rejects(pool.query('DELETE FROM account_audit_events'), { code: '55000' });
      await assert.rejects(pool.query("UPDATE account_audit_events SET reason='changed'"), { code: '55000' });
      await assert.rejects(pool.query('TRUNCATE account_audit_events'), { code: '42501' });
    });
    await t.test('migration rerun on populated schema preserves data', async () => {
      const before = await owner.query('SELECT (SELECT count(*) FROM audit_events) AS audits,(SELECT count(*) FROM spend_cases) AS spends');
      assert.equal(await migrate(ownerUrl, schema), 0);
      assert.deepEqual((await owner.query('SELECT (SELECT count(*) FROM audit_events) AS audits,(SELECT count(*) FROM spend_cases) AS spends')).rows, before.rows);
    });
  } finally {
    await pool.end();
    if (created) {
      // Only this invocation's random schema, explicit objects, no shared tables or CASCADE.
      for (const table of ['account_audit_events','auth_sessions','auth_identities','email_ownership_checks','login_accounts','audit_events','command_receipts','spend_cases','budget_lines','project_memberships','projects','users','people','migration_history']) await owner.query(`DROP TABLE IF EXISTS ${schema}.${table}`);
      await owner.query(`DROP FUNCTION IF EXISTS ${schema}.reject_foundation_rewrite()`);
      await owner.query(`DROP SCHEMA ${schema}`);
    }
    await owner.end();
  }
});
