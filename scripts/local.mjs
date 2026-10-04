import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { assertLocalDatabase } from './db-config.mjs';

// Optional helper for the phase 00 Windows setup. Secrets stay outside the repository.
const mode = process.argv[2];
const commands = {
  dev: ['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1'],
  start: ['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1'],
  migrate: ['scripts/migrate.mjs'],
  'migrate:test': ['scripts/migrate.mjs'],
  seed: ['--conditions=react-server','scripts/seed.ts'],
  'test:db': ['--conditions=react-server','--test','tests/database.test.ts'],
};
if (!commands[mode]) throw new Error('Choose dev, start, migrate, migrate:test, seed or test:db');
try {
  const configs = JSON.parse(await readFile(join(process.env.LOCALAPPDATA, 'boot_erp/postgres/connections.json'), 'utf8'));
  const url = (key, database, suffix) => {
    const c = configs[key];
    return assertLocalDatabase(`postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}`, database, suffix);
  };
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
  for (const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']) delete env[key];
  if (mode.startsWith('migrate')) env.MIGRATION_DATABASE_URL = url(mode === 'migrate' ? 'dev_migration' : 'test_migration', mode === 'migrate' ? 'boot_erp_dev' : 'boot_erp_test', 'owner');
  else if (mode === 'test:db') {
    env.TEST_DATABASE_URL = url('test','boot_erp_test','app');
    env.TEST_MIGRATION_DATABASE_URL = url('test_migration','boot_erp_test','owner');
  } else env.DATABASE_URL = url('dev','boot_erp_dev','app');
  const child = spawn(process.execPath, [...commands[mode], ...process.argv.slice(3)], { stdio: 'inherit', env, windowsHide: true });
  child.on('error', () => { console.error('Local command could not start'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch { console.error('Local configuration unavailable or invalid. See docs/foundation.md; credentials are not logged.'); process.exitCode = 1; }
