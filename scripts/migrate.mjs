import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { fileURLToPath } from 'node:url';
import { requiredUrl, assertLocalDatabase } from './db-config.mjs';

export async function migrate(connectionString, schema = 'public') {
  const database = new URL(connectionString).pathname.slice(1);
  if (!['boot_erp_dev','boot_erp_test'].includes(database)) throw new Error('Invalid migration target');
  assertLocalDatabase(connectionString, database, 'owner');
  if (schema !== 'public' && !/^foundation_test_[0-9a-f]{32}$/.test(schema)) throw new Error('Invalid schema');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await runner({ dbClient: client, dir: fileURLToPath(new URL('../migrations', import.meta.url)),
      direction: 'up', schema, migrationsSchema: schema, migrationsTable: 'migration_history',
      checkOrder: true, singleTransaction: true, log: () => {} });
    // Phase 00 default grants must not let runtime users rewrite migration history.
    await client.query(`REVOKE ALL ON TABLE ${schema}.migration_history FROM ${database}_app`);
    return result.length;
  } finally { await client.end(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { console.log(`Migrations applied: ${await migrate(requiredUrl('MIGRATION_DATABASE_URL'))}`); }
  catch { console.error('Migration failed; verify the isolated DB target, owner role and SQL. Credentials are not logged.'); process.exitCode = 1; }
}
