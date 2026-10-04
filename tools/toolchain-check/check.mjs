import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

// Credentials stay outside the repository and are never printed.
const config = JSON.parse(await readFile(join(process.env.LOCALAPPDATA, 'boot_erp', 'postgres', 'connections.json'), 'utf8'));
for (const name of ['dev', 'test']) {
  const connection = config[name];
  assert.equal(connection.host, '127.0.0.1');
  assert.equal(connection.port, 55432);
  assert.equal(connection.database, `boot_erp_${name}`);
  const pool = new pg.Pool({ ...connection, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const db = drizzle(pool);
    const info = await db.execute(sql`select current_database() as db, current_user as role, current_setting('server_version') as version`);
    assert.equal(info.rows[0].db, connection.database);
    const rights = await db.execute(sql`select rolsuper, rolcreatedb, rolcreaterole, has_schema_privilege(current_user, 'public', 'CREATE') as can_create from pg_roles where rolname=current_user`);
    for (const value of Object.values(rights.rows[0])) assert.equal(value, false);
    const money = await db.execute(sql`select (9007199254740993::bigint + 1)::text as amount`);
    assert.equal(money.rows[0].amount, '9007199254740994');
    const marker = new Error('intentional rollback');
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`create temporary table toolchain_probe (amount bigint not null)`);
        await tx.execute(sql`insert into toolchain_probe values (9007199254740993)`);
        const row = await tx.execute(sql`select amount::text as amount from toolchain_probe for update`);
        assert.equal(row.rows[0].amount, '9007199254740993');
        throw marker;
      });
    } catch (error) {
      if (error !== marker) throw error;
    }
    const rolledBack = await db.execute(sql`select to_regclass('pg_temp.toolchain_probe') is null as ok`);
    assert.equal(rolledBack.rows[0].ok, true);
    const tables = await db.execute(sql`select count(*)::int as count from information_schema.tables where table_schema='public'`);
    assert.equal(tables.rows[0].count, 0);
    console.log(`${name}: PostgreSQL ${info.rows[0].version}; limited role, exact bigint, Drizzle transaction/rollback and empty public schema PASS`);
  } finally {
    await pool.end();
  }
  const other = name === 'dev' ? 'test' : 'dev';
  const cross = new pg.Client({ ...connection, database: `boot_erp_${other}`, connectionTimeoutMillis: 5000 });
  let denied = false;
  try { await cross.connect(); } catch (error) { if (error.code !== '42501') throw error; denied = true; }
  finally { await cross.end(); }
  assert.equal(denied, true, 'Development and test roles must not cross-connect');
  console.log(`${name}: cross-database access denied PASS`);
  const migrationConnection = config[`${name}_migration`];
  assert.equal(migrationConnection.host, connection.host);
  assert.equal(migrationConnection.port, connection.port);
  assert.equal(migrationConnection.database, connection.database);
  const migration = new pg.Client({ ...migrationConnection, connectionTimeoutMillis: 5000 });
  try {
    await migration.connect();
    const rights = await migration.query("select rolsuper, rolcreatedb, rolcreaterole, has_schema_privilege(current_user, 'public', 'CREATE') as can_create from pg_roles where rolname=current_user");
    assert.deepEqual(rights.rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false, can_create: true });
    await migration.query('BEGIN');
    try {
      await migration.query('CREATE TABLE public.toolchain_migration_probe (amount bigint NOT NULL)');
    } finally { await migration.query('ROLLBACK'); }
    const result = await migration.query("select to_regclass('public.toolchain_migration_probe') is null as ok");
    assert.equal(result.rows[0].ok, true);
    console.log(`${name}: migration role DDL/rollback PASS`);
  } finally { await migration.end(); }
}
