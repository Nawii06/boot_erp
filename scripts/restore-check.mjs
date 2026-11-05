import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { adminConfig, backupId, clientFor, collectState, compareState, loadManifest, postgresTools, privateDirectory, restoreName, runTool, toolEnvironment } from './backup-config.mjs';

export async function cleanupDisposable(admin, { database, role, createdDatabase, createdRole }) {
  restoreName(database);
  if (role !== database.replace('boot_erp_restore_', 'boot_erp_restore_role_') || (createdDatabase && !createdRole)) throw new Error('Invalid disposable cleanup scope');
  if (createdDatabase) await admin.query(`DROP DATABASE ${database}`);
  // If the DB drop failed, execution stops and the role is preserved with its owned DB.
  if (createdRole) await admin.query(`DROP ROLE ${role}`);
}

export async function restoreCheck(id) {
  backupId(id);
  const directory = await privateDirectory();
  const { manifest, archive } = await loadManifest(directory, id);
  const tools = await postgresTools();
  const admin = await clientFor(await adminConfig());
  const suffix = randomUUID().replaceAll('-', '');
  const database = restoreName('boot_erp_restore_' + suffix), role = 'boot_erp_restore_role_' + suffix;
  const password = randomBytes(32).toString('hex');
  let createdDatabase = false, createdRole = false, result, failed = false, cleanupFailed = false;
  try {
    const server = (await admin.query("SELECT current_setting('server_version') AS version,inet_server_port() AS port")).rows[0];
    if (server.version !== '18.6' || server.port !== 55432) throw new Error();
    const existing = await admin.query('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS db,EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$2) AS role', [database, role]);
    if (existing.rows[0].db || existing.rows[0].role) throw new Error();
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    createdRole = true;
    await admin.query(`CREATE DATABASE ${database} OWNER ${role} TEMPLATE template0`);
    createdDatabase = true;
    await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await admin.query(`ALTER DATABASE ${database} SET timezone TO 'UTC'`);
    const config = { host: '127.0.0.1', port: 55432, user: role, password, database, connectionTimeoutMillis: 3000 };
    // Restoration itself uses the disposable restricted owner, never the cluster superuser.
    await runTool(tools.pg_restore, ['--single-transaction', '--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', '--dbname=' + database, archive], toolEnvironment(config));
    const restored = await clientFor(config);
    try {
      await restored.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      compareState(manifest.state, await collectState(restored));
      await restored.query('COMMIT');
    } finally { await restored.end(); }
    result = { status: 'restore_verified', id, source: manifest.source, tables: Object.keys(manifest.state.counts).length };
  } catch { failed = true; }
  finally {
    try {
      // Only names generated and successfully created by this invocation can be removed.
      await cleanupDisposable(admin, { database, role, createdDatabase, createdRole });
    } catch { cleanupFailed = true; }
    await admin.end();
  }
  if (cleanupFailed) throw new Error(`Disposable restore cleanup incomplete: ${suffix}`);
  if (failed) throw new Error('Isolated restore verification failed; tool output suppressed');
  return { ...result, cleanup: 'complete' };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 3) throw new Error();
    console.log(JSON.stringify(await restoreCheck(process.argv[2])));
  } catch (error) {
    const cleanup = /^Disposable restore cleanup incomplete: [0-9a-f]{32}$/.test(error.message) ? error.message : 'Local restore verification unavailable or failed.';
    console.error(cleanup + ' No credential values or PostgreSQL output logged.'); process.exitCode = 1;
  }
}
