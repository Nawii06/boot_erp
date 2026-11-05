import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { archiveHash, clientFor, collectState, ownerConfig, postgresTools, privateDirectory, runTool, sourceKey, toolEnvironment } from './backup-config.mjs';

export async function backupLocal(source) {
  sourceKey(source);
  const config = await ownerConfig(source);
  const directory = await privateDirectory(true);
  const tools = await postgresTools();
  const id = 'backup-' + randomUUID().replaceAll('-', '');
  const archive = join(directory, `${id}.dump`);
  // Reserve a fresh file; existing artifacts are never overwritten.
  await writeFile(archive, '', { flag: 'wx', mode: 0o600 });
  const client = await clientFor(config);
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const state = await collectState(client);
    await runTool(tools.pg_dump, ['--format=custom', '--no-owner', '--no-acl', '--schema=public', '--snapshot=' + snapshot, '--file=' + archive], toolEnvironment(config));
    const manifest = { formatVersion: 1, id, source, createdAt: new Date().toISOString(), archive: `${id}.dump`, archiveSha256: await archiveHash(archive), state };
    await client.query('COMMIT');
    // A manifest is written only after the dump succeeds and has been hashed.
    await writeFile(join(directory, `${id}.json`), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { status: 'backup_ready', id, source, tables: Object.keys(state.counts).length };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 3) throw new Error();
    console.log(JSON.stringify(await backupLocal(process.argv[2])));
  } catch { console.error('Local backup unavailable or failed. No credential values or PostgreSQL output logged.'); process.exitCode = 1; }
}
