import { access, chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { localRoot } from './local-paths.mjs';
import { assertLocalDatabase } from './db-config.mjs';

export const repository = fileURLToPath(new URL('../', import.meta.url));
export const backupIdPattern = /^backup-[0-9a-f]{32}$/;
export const restoreDatabasePattern = /^boot_erp_restore_[0-9a-f]{32}$/;
const markerName = '.boot-erp-local-backups-v1';
const marker = 'boot-erp-local-backups-v1\n';

export function ensureDevelopment() {
  if (process.env.NODE_ENV === 'production') throw new Error('Local development/test backup only');
}
export function sourceKey(value) {
  if (!['dev', 'test'].includes(value)) throw new Error('Choose dev or test');
  return value;
}
export function backupId(value) {
  if (!backupIdPattern.test(value ?? '')) throw new Error('Invalid backup ID');
  return value;
}
export function restoreName(value) {
  if (!restoreDatabasePattern.test(value ?? '')) throw new Error('Invalid disposable restore database');
  return value;
}
export function inside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../'));
}
export function assertBackupPath(path, root, dataDirectory) {
  if (!isAbsolute(path) || inside(repository, path) || inside(dataDirectory, path) ||
      resolve(path) === resolve(root) || resolve(path) === resolve(root, '..') || resolve(path) === resolve(path, '..')) {
    throw new Error('Use a dedicated private backup directory outside the repository and PGDATA');
  }
}
export async function runTool(binary, args, env = process.env, capture = false) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { env, windowsHide: true, shell: false, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
    let output = '', diagnostic = '';
    if (capture) child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { if (diagnostic.length < 65536) diagnostic += data; });
    child.on('error', () => reject(new Error('Local tool could not start; output suppressed')));
    child.on('exit', code => {
      const category = /permission denied/i.test(diagnostic) ? 'permission' : /snapshot/i.test(diagnostic) ? 'snapshot' :
        /already exists/i.test(diagnostic) ? 'existing-object' : /authentication|connection|could not connect/i.test(diagnostic) ? 'connection' : 'other';
      code === 0 ? resolveResult(output.trim()) : reject(new Error(`Local tool ${basename(binary)} failed (exit ${code}, category ${category}); raw output suppressed`));
    });
  });
}
export async function privateDirectory(create = false) {
  ensureDevelopment();
  const root = await realpath(localRoot());
  const data = await realpath(join(root, 'postgres', 'data'));
  const requested = process.env.BOOT_ERP_BACKUP_ROOT ?? join(root, 'backups');
  assertBackupPath(requested, root, data);
  const parent = await realpath(resolve(requested, '..'));
  const directory = join(parent, basename(resolve(requested)));
  assertBackupPath(directory, root, data);
  let created = false;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await readFile(join(directory, markerName), 'utf8') !== marker) throw new Error();
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw new Error('Private backup directory unavailable or unrecognized');
    // Existing folders without our marker are never adopted or have their ACL changed.
    try { await lstat(directory); throw new Error('Unrecognized existing backup directory'); }
    catch (existing) { if (existing.code !== 'ENOENT') throw existing; }
    await mkdir(directory, { mode: 0o700 });
    created = true;
  }
  if (process.platform === 'win32') {
    const script = created
      ? `$ErrorActionPreference='Stop';$s=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetOwner($s);$a.SetAccessRuleProtection($true,$false);$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));$y=New-Object Security.Principal.SecurityIdentifier('S-1-5-18');$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($y,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));Set-Acl -LiteralPath $env:BOOT_ERP_ACL_TARGET -AclObject $a`
      : `$ErrorActionPreference='Stop';$s=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$a=Get-Acl -LiteralPath $env:BOOT_ERP_ACL_TARGET;if(-not $a.AreAccessRulesProtected -or $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $s){throw 'Private ACL required'};$seen=@();foreach($r in $a.Access){$id=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($id -notin @($s,'S-1-5-18') -or $r.AccessControlType -ne 'Allow' -or (($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)){throw 'Private ACL required'};$seen+=$id};if($s -notin $seen -or 'S-1-5-18' -notin $seen){throw 'Private ACL required'}`;
    await runTool('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { ...process.env, BOOT_ERP_ACL_TARGET: directory });
  } else await chmod(directory, 0o700);
  if (created) await writeFile(join(directory, markerName), marker, { flag: 'wx', mode: 0o600 });
  return directory;
}
export async function ownerConfig(source) {
  ensureDevelopment();
  sourceKey(source);
  const root = await realpath(localRoot());
  const all = JSON.parse(await readFile(join(root, 'postgres', 'connections.json'), 'utf8'));
  const config = all[`${source}_migration`];
  if (!config || typeof config.password !== 'string' || !config.password) throw new Error('Local owner configuration unavailable');
  assertLocalDatabase(`postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${config.database}`, `boot_erp_${source}`, 'owner');
  return { host: config.host, port: config.port, database: config.database, user: config.user, password: config.password, connectionTimeoutMillis: 3000 };
}
export async function adminConfig() {
  ensureDevelopment();
  const root = await realpath(localRoot());
  const parts = (await readFile(join(root, 'postgres', 'admin.pgpass'), 'utf8')).trim().split(':');
  if (parts.length !== 5 || parts[0] !== '127.0.0.1' || parts[1] !== '55432' || parts[2] !== '*' ||
      parts[3] !== 'boot_erp_cluster_admin' || !/^[0-9a-f]{64}$/.test(parts[4])) throw new Error('Dedicated local maintenance configuration unavailable');
  return { host: parts[0], port: 55432, database: 'postgres', user: parts[3], password: parts[4], connectionTimeoutMillis: 3000 };
}
export function toolEnvironment(config) {
  const env = { ...process.env };
  // Drop all inherited libpq settings, including PGHOSTADDR, before pinning the local target.
  for (const key of Object.keys(env)) if (/DATABASE_URL|GOOGLE_|AUTH_ENCRYPTION_KEY|BOOT_ERP_ADMIN_FILE/.test(key) || key.startsWith('PG')) delete env[key];
  return { ...env, PGHOST: config.host, PGPORT: String(config.port), PGDATABASE: config.database, PGUSER: config.user, PGPASSWORD: config.password, PGSSLMODE: 'disable' };
}
export async function postgresTools() {
  const root = process.env.BOOT_ERP_PG_BIN ?? join(process.env.LOCALAPPDATA ?? '', 'boot_erp', 'tools', 'postgresql-18.6-5', 'pgsql', 'bin');
  if (!isAbsolute(root)) throw new Error('An absolute local PostgreSQL binary directory is required');
  const directory = await realpath(root);
  if (inside(repository, directory)) throw new Error('PostgreSQL binaries must be outside the repository');
  const paths = Object.fromEntries(['pg_dump', 'pg_restore'].map(name => [name, join(directory, name + (process.platform === 'win32' ? '.exe' : ''))]));
  for (const path of Object.values(paths)) {
    await access(path);
    if (!/\(PostgreSQL\) 18\.6(?:\s|$)/.test(await runTool(path, ['--version'], process.env, true))) throw new Error('PostgreSQL 18.6 tools are required');
  }
  return paths;
}
export async function archiveHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const quote = value => '"' + value.replaceAll('"', '""') + '"';
export async function collectState(client) {
  const version = (await client.query("SELECT current_setting('server_version') AS version,inet_server_port() AS port")).rows[0];
  if (version.version !== '18.6' || version.port !== 55432) throw new Error('Only the dedicated PostgreSQL 18.6 cluster is allowed');
  const columns = (await client.query(`SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`)).rows;
  const tables = (await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)).rows.map(row => row.table_name);
  const counts = {}, numericSums = {};
  for (const table of tables) {
    counts[table] = (await client.query(`SELECT count(*)::text AS count FROM public.${quote(table)}`)).rows[0].count;
    for (const column of columns.filter(c => c.table_name === table && ['bigint', 'integer', 'smallint', 'numeric'].includes(c.data_type))) {
      numericSums[`${table}.${column.column_name}`] = (await client.query(`SELECT COALESCE(sum(${quote(column.column_name)}::numeric),0)::text AS total FROM public.${quote(table)}`)).rows[0].total;
    }
  }
  const files = [];
  for (const table of ['budget_files', 'expense_files']) {
    if (!tables.includes(table)) throw new Error('Required private file tables are missing');
    const rows = (await client.query(`SELECT id::text,version::text,sha256,encode(sha256(content),'hex') AS actual_hash,octet_length(content)::text AS size FROM public.${quote(table)} ORDER BY id`)).rows;
    if (rows.some(row => row.sha256 !== row.actual_hash)) throw new Error('Stored evidence hash differs from content');
    files.push(...rows.map(row => ({ table, ...row })));
  }
  const migrations = (await client.query('SELECT name FROM public.migration_history ORDER BY name')).rows.map(row => row.name);
  const expected = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).map(name => name.slice(0, -4)).sort();
  if (!isDeepStrictEqual(migrations, expected)) throw new Error('Database migrations differ from the repository');
  return { serverVersion: version.version, columns, counts, numericSums, files, migrations };
}
export function compareState(expected, actual) {
  if (!isDeepStrictEqual(expected, actual)) throw new Error('Restored counts, numeric totals, evidence hashes or schema differ');
}
export async function clientFor(config) {
  const client = new pg.Client(config);
  try { await client.connect(); }
  catch { await client.end().catch(() => {}); throw new Error('Dedicated local database connection unavailable'); }
  return client;
}
export async function loadManifest(directory, id) {
  backupId(id);
  const path = join(directory, `${id}.json`), archive = join(directory, `${id}.dump`);
  for (const file of [path, archive]) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Backup files must be regular private files');
  }
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (manifest.formatVersion !== 1 || manifest.id !== id || manifest.archive !== `${id}.dump` ||
      !['dev', 'test'].includes(manifest.source) || !/^[0-9a-f]{64}$/.test(manifest.archiveSha256) || !manifest.state ||
      manifest.state.serverVersion !== '18.6' || await archiveHash(archive) !== manifest.archiveSha256) throw new Error('Backup manifest/archive verification failed');
  return { manifest, archive };
}
