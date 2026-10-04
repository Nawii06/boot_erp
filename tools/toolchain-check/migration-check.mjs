import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { runner } from 'node-pg-migrate';

const config = JSON.parse(await readFile(join(process.env.LOCALAPPDATA, 'boot_erp', 'postgres', 'connections.json'), 'utf8'));
const connection = config.test_migration;
assert.equal(connection.host, '127.0.0.1');
assert.equal(connection.port, 55432);
assert.equal(connection.database, 'boot_erp_test');
const schema = `toolchain_${randomUUID().replaceAll('-', '')}`;
const dir = await mkdtemp(join(tmpdir(), 'boot-erp-migration-'));
const file = join(dir, '1000000000000_probe.sql');
const client = new pg.Client({ ...connection, connectionTimeoutMillis: 5000 });
let created = false;
try {
  await writeFile(file, '-- Up Migration\nCREATE TABLE probe (amount bigint NOT NULL);\n-- Down Migration\nDROP TABLE probe;\n');
  await client.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  const options = { dbClient: client, dir, schema, migrationsSchema: schema, migrationsTable: 'migration_history', checkOrder: true, singleTransaction: true, log: () => {} };
  assert.equal((await runner({ ...options, direction: 'up' })).length, 1);
  assert.equal((await runner({ ...options, direction: 'up' })).length, 0);
  assert.equal((await runner({ ...options, direction: 'down', count: 1 })).length, 1);
  const result = await client.query('select to_regclass($1) is null as absent', [`${schema}.probe`]);
  assert.equal(result.rows[0].absent, true);
  console.log('node-pg-migrate: isolated SQL up, repeat without duplicate execution, down PASS');
} finally {
  // Only the uniquely named schema created by this invocation is eligible for cleanup.
  if (created) {
    await client.query(`DROP TABLE IF EXISTS "${schema}".probe`);
    await client.query(`DROP TABLE IF EXISTS "${schema}".migration_history`);
    await client.query(`DROP SCHEMA "${schema}"`);
  }
  await client.end();
  await unlink(file);
  await rmdir(dir);
}
