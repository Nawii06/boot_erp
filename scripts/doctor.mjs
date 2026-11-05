import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localRoot } from './local-paths.mjs';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
let ready = true;
function report(label, ok) {
  console.log(`${ok ? 'OK' : 'MISSING/MISMATCH'} ${label}`);
  if (!ok) ready = false;
}
async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
report(`Node ${pkg.engines.node} (current ${process.versions.node})`, process.versions.node === pkg.engines.node);
report('Installed dependencies', await exists(new URL('../node_modules/next/package.json', import.meta.url)));
try {
  const root = localRoot();
  report('Private DB connections file', await exists(join(root, 'postgres', 'connections.json')));
  report('Private authentication key', await exists(join(root, 'auth', 'encryption.key')));
} catch { report('Private configuration directory', false); }
report('Google OAuth file configured', Boolean(process.env.BOOT_ERP_GOOGLE_OAUTH_FILE) && await exists(process.env.BOOT_ERP_GOOGLE_OAUTH_FILE));
console.log('File presence only; DB connectivity and credentials are not validated. See docs/current-environment.md.');
process.exitCode = ready ? 0 : 1;
