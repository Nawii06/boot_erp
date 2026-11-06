import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, lstat, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client, Pool } from 'pg';
import { localRoot } from './local-paths.mjs';
import { assertLocalDatabase } from './db-config.mjs';
import { migrate } from './migrate.mjs';
import { getPreviewConfig, previewRoles, type PreviewConfig } from '../src/lib/preview-config.ts';
import { populatePreview } from './preview-fixture.ts';
import { previewDirectory, readPreviewMarker, samePreview, validatePreviewState, writePrivateMarker } from './stop-preview.mjs';

export interface PreviewState { instanceId: string; schema: string; expiresAt: string; pid: number; startedAt: string }
class PreviewCleanupError extends Error {}
const repository = fileURLToPath(new URL('../', import.meta.url));
export async function assertPreviewEnvFilesAbsent(root = repository): Promise<void> {
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    try { await lstat(join(root, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    // Next loads these files itself after spawn; do not read, edit, or accidentally re-inject them.
    throw new Error('Preview requires a repository without runtime dotenv files; existing files were preserved');
  }
}
export function newPreviewState(): PreviewState {
  const now = Date.now(), instanceId = randomUUID().replaceAll('-', '');
  return { instanceId, schema: `boot_preview_${instanceId}`, expiresAt: new Date(now + 8 * 60 * 60 * 1000).toISOString(),
    pid: process.pid, startedAt: new Date(now).toISOString() };
}
export async function assertPreviewPortAvailable(): Promise<void> {
  await new Promise<void>((done, fail) => {
    const probe = createServer();
    probe.once('error', () => fail(new Error('Local port 3000 is occupied or unavailable; no existing server was stopped')));
    probe.listen({ host: '127.0.0.1', port: 3000, exclusive: true }, () => probe.close(error => error ? fail(error) : done()));
  });
}
async function localConnections() {
  const configs = JSON.parse(await readFile(join(localRoot(), 'postgres', 'connections.json'), 'utf8'));
  const url = (key: string, suffix: string) => {
    const c = configs[key];
    if (!c || !c.password) throw new Error('Local test configuration unavailable');
    return assertLocalDatabase(`postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}`, 'boot_erp_test', suffix);
  };
  return { owner: url('test_migration', 'owner'), app: url('test', 'app') };
}
export function previewChildEnvironment(databaseUrl: string, config: PreviewConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  // An allow-list avoids passing inherited owner/admin/libpq/Google/Node options to Next.
  const allowed = /^(systemroot|windir|comspec|path|pathext|temp|tmp|userprofile|localappdata|appdata|programfiles(?:\(x86\))?|number_of_processors|os|processor_architecture)$/i;
  for (const [key, value] of Object.entries(process.env)) if (allowed.test(key)) env[key] = value;
  Object.assign(env, { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', DATABASE_URL: databaseUrl,
    APP_ORIGIN: 'http://localhost:3000', BOOT_ERP_PREVIEW_MODE: '1', BOOT_ERP_PREVIEW_SCHEMA: config.schema,
    BOOT_ERP_PREVIEW_EXPIRES_AT: config.expiresAt, BOOT_ERP_PREVIEW_USERS: JSON.stringify(config.users),
    AUTH_ENCRYPTION_KEY: randomBytes(32).toString('hex') });
  assert.deepEqual(getPreviewConfig(env)?.users, config.users);
  return env;
}
export async function cleanupPreviewSchema(owner: Pick<Client, 'query'>, state: PreviewState, created: boolean): Promise<void> {
  validatePreviewState(state);
  if (!created) return;
  const row = (await owner.query(`SELECT n.nspname,pg_get_userbyid(n.nspowner) AS owner,obj_description(n.oid,'pg_namespace') AS marker,
    current_database() AS database,current_user AS actor,inet_server_port() AS port FROM pg_namespace n WHERE n.nspname=$1`, [state.schema])).rows[0];
  if (!row || row.database !== 'boot_erp_test' || row.actor !== 'boot_erp_test_owner' || row.port !== 55432 ||
      row.owner !== 'boot_erp_test_owner' || row.marker !== `boot-erp-local-preview:${state.instanceId}`) throw new Error('Preview cleanup guard failed; schema preserved');
  await owner.query(`DROP SCHEMA ${state.schema} CASCADE`);
}
export async function preparePreview(state = newPreviewState()) {
  await assertPreviewEnvFilesAbsent();
  validatePreviewState(state);
  if (state.pid !== process.pid || Date.parse(state.expiresAt) <= Date.now()) throw new Error('Invalid preview instance');
  const urls = await localConnections(), owner = new Client({ connectionString: urls.owner, connectionTimeoutMillis: 3000 });
  const app = new URL(urls.app); app.searchParams.set('options', `-c search_path=${state.schema}`);
  const users = Object.fromEntries(previewRoles.map(role => [role, randomUUID()]));
  const config = getPreviewConfig({ BOOT_ERP_PREVIEW_MODE: '1', APP_ORIGIN: 'http://localhost:3000', DATABASE_URL: app.toString(),
    BOOT_ERP_PREVIEW_SCHEMA: state.schema, BOOT_ERP_PREVIEW_EXPIRES_AT: state.expiresAt, BOOT_ERP_PREVIEW_USERS: JSON.stringify(users) })!;
  const pool = new Pool({ connectionString: app.toString(), max: 5, connectionTimeoutMillis: 3000 });
  pool.on('error', () => {});
  let created = false;
  try {
    await owner.connect();
    const target = (await owner.query('SELECT current_database() AS database,current_user AS actor,inet_server_port() AS port')).rows[0];
    assert.deepEqual(target, { database: 'boot_erp_test', actor: 'boot_erp_test_owner', port: 55432 });
    if ((await owner.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [state.schema])).rowCount) throw new Error('Preview schema already exists');
    await owner.query('BEGIN');
    try {
      await owner.query(`CREATE SCHEMA ${state.schema}`);
      await owner.query(`COMMENT ON SCHEMA ${state.schema} IS 'boot-erp-local-preview:${state.instanceId}'`);
      await owner.query('COMMIT'); created = true;
    } catch (error) { await owner.query('ROLLBACK'); throw error; }
    const count = await migrate(urls.owner, state.schema);
    const expected = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).map(name => name.slice(0, -4)).sort();
    const applied = (await owner.query(`SELECT name FROM ${state.schema}.migration_history ORDER BY name`)).rows.map(row => row.name);
    assert.equal(count, 7); assert.deepEqual(applied, expected);
    await owner.query(`REVOKE ALL ON SCHEMA ${state.schema} FROM PUBLIC`);
    await owner.query(`GRANT USAGE ON SCHEMA ${state.schema} TO boot_erp_test_app`);
    await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${state.schema} TO boot_erp_test_app`);
    await owner.query(`REVOKE ALL ON ${state.schema}.migration_history FROM boot_erp_test_app`);
    await owner.query(`SET search_path TO ${state.schema}`);
    const actual = (await pool.query("SELECT current_schema() AS schema,current_setting('search_path') AS path")).rows[0];
    assert.deepEqual(actual, { schema: state.schema, path: state.schema });
    const fixture = await populatePreview(owner, pool, config);
    let cleaned = false;
    return { state, config, pool, owner, fixture, databaseUrl: app.toString(),
      async cleanup() {
        if (cleaned) return;
        await pool.end();
        try { await cleanupPreviewSchema(owner, state, created); cleaned = true; }
        finally { await owner.end(); }
      } };
  } catch (error) {
    await pool.end().catch(() => {});
    try { await cleanupPreviewSchema(owner, state, created); }
    catch { throw new PreviewCleanupError('Preview cleanup failed; owned marker and schema preserved for inspection'); }
    finally { await owner.end(); }
    throw error;
  }
}
async function stopChild(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error('Preview child did not stop; schema preserved')), 15000);
    child.once('exit', () => { clearTimeout(timeout); done(); });
    // Only this actual spawned child handle is signalled; no PID lookup or port-owner kill.
    if (!child.kill('SIGTERM')) { clearTimeout(timeout); fail(new Error('Preview child stop failed; schema preserved')); }
  });
}
export async function runPreview(fixtureOnly = false) {
  await assertPreviewEnvFilesAbsent();
  if (!fixtureOnly) {
    await assertPreviewPortAvailable();
    const build = await lstat(join(repository, '.next', 'BUILD_ID'));
    if (!build.isFile() || build.isSymbolicLink()) throw new Error('Build the application before starting preview');
  }
  const state = newPreviewState(), directory = await previewDirectory(), marker = join(directory, 'local-preview.json');
  const stopFile = join(directory, `preview-stop-${state.instanceId}`);
  let markerCreated = false, handle: Awaited<ReturnType<typeof preparePreview>> | undefined, child: ChildProcess | undefined;
  let requested = false, preserveMarker = false;
  const onSignal = () => { requested = true; };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    if (!fixtureOnly) { await writePrivateMarker(marker, state); markerCreated = true; }
    handle = await preparePreview(state);
    if (fixtureOnly) return { status: 'fixture-verified', migrations: 7, tables: 40, ...handle.fixture.totals };
    if (requested) return { status: 'stopped-before-start' };
    await assertPreviewEnvFilesAbsent();
    await assertPreviewPortAvailable();
    child = spawn(process.execPath, [join(repository, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--hostname', '127.0.0.1', '--port', '3000'],
      { cwd: repository, windowsHide: true, shell: false, stdio: 'inherit', env: previewChildEnvironment(handle.databaseUrl, handle.config) });
    let failed = false;
    child.once('error', () => { failed = true; requested = true; });
    child.once('exit', code => { failed = code !== 0 && !requested; requested = true; });
    console.log(JSON.stringify({ status: 'preview-starting', origin: 'http://localhost:3000', expiresAt: state.expiresAt,
      notice: 'Temporary synthetic preview only; not a Google login or real business data.' }));
    while (!requested && Date.now() < Date.parse(state.expiresAt)) {
      await new Promise(done => setTimeout(done, 1000));
      try { if (samePreview(await readPreviewMarker(stopFile), state)) requested = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { /* Invalid markers cannot select an instance. */ } }
    }
    if (failed) throw new Error('Preview server exited unexpectedly');
    return { status: 'preview-stopped' };
  } catch (error) {
    preserveMarker = error instanceof PreviewCleanupError;
    throw error;
  } finally {
    try {
      if (child) await stopChild(child);
      await handle?.cleanup();
      for (const file of preserveMarker ? [] : [stopFile, ...(markerCreated ? [marker] : [])]) {
        try { if (samePreview(await readPreviewMarker(file), state)) await unlink(file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--fixture-check') || process.argv.length > 3) throw new Error('Invalid preview arguments');
    console.log(JSON.stringify(await runPreview(process.argv[2] === '--fixture-check')));
  } catch { console.error('Local preview unavailable or stopped with a cleanup issue. Check the private local test configuration, build, port and owned preview marker; secrets are not logged.'); process.exitCode = 1; }
}
