import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { assertLocalDatabase } from './db-config.mjs';
import { loadGoogleCredentials } from './google-config.mjs';

// Optional helper for the phase 00 Windows setup. Secrets stay outside the repository.
const mode = process.argv[2];
const commands = {
  dev: ['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1'],
  start: ['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1'],
  migrate: ['scripts/migrate.mjs'],
  'migrate:test': ['scripts/migrate.mjs'],
  seed: ['--conditions=react-server','scripts/seed.ts'],
  'test:db': ['--conditions=react-server','--test','--test-concurrency=1','tests/database.test.ts','tests/access.test.ts','tests/budgets.test.ts','tests/expenses.test.ts'],
  'bootstrap-admin': ['--conditions=react-server','scripts/bootstrap-admin.ts'],
  'recover-admin': ['--conditions=react-server','scripts/bootstrap-admin.ts','recover'],
  'test:ui': ['--conditions=react-server','tests/browser.test.ts'],
};
if (!commands[mode]) throw new Error(`Choose ${Object.keys(commands).join(', ')}`);
try {
  const configs = JSON.parse(await readFile(join(process.env.LOCALAPPDATA, 'boot_erp/postgres/connections.json'), 'utf8'));
  const url = (key, database, suffix) => {
    const c = configs[key];
    return assertLocalDatabase(`postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}`, database, suffix);
  };
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
  for (const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']) delete env[key];
  for (const key of ['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REDIRECT_URI','APP_ORIGIN','BOOT_ERP_GOOGLE_OAUTH_FILE','AUTH_ENCRYPTION_KEY']) delete env[key];
  if(!['bootstrap-admin','recover-admin'].includes(mode))delete env.BOOT_ERP_ADMIN_FILE;
  if (['dev','start'].includes(mode) && process.env.BOOT_ERP_GOOGLE_OAUTH_FILE) {
    const google = await loadGoogleCredentials(process.env.BOOT_ERP_GOOGLE_OAUTH_FILE);
    Object.assign(env, { GOOGLE_CLIENT_ID: google.clientId, GOOGLE_CLIENT_SECRET: google.clientSecret,
      GOOGLE_REDIRECT_URI: google.redirectUri, APP_ORIGIN: google.origin });
    const key=await readFile(join(process.env.LOCALAPPDATA,'boot_erp','auth','encryption.key'),'utf8');
    if(!/^[0-9a-f]{64}$/.test(key))throw new Error();
    env.AUTH_ENCRYPTION_KEY=key;
  }
  if (mode.startsWith('migrate')) env.MIGRATION_DATABASE_URL = url(mode === 'migrate' ? 'dev_migration' : 'test_migration', mode === 'migrate' ? 'boot_erp_dev' : 'boot_erp_test', 'owner');
  else if (['test:db','test:ui'].includes(mode)) {
    env.TEST_DATABASE_URL = url('test','boot_erp_test','app');
    env.TEST_MIGRATION_DATABASE_URL = url('test_migration','boot_erp_test','owner');
  } else env.DATABASE_URL = url('dev','boot_erp_dev','app');
  const child = spawn(process.execPath, [...commands[mode], ...process.argv.slice(3)], { stdio: 'inherit', env, windowsHide: true });
  child.on('error', () => { console.error('Local command could not start'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch { console.error('Local configuration unavailable or invalid. See docs/foundation.md; credentials are not logged.'); process.exitCode = 1; }
