import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseGoogleCredentials, loadGoogleCredentials, googleRedirectUri } from '../scripts/google-config.mjs';

const fake = { web: { client_id: 'fake.apps.googleusercontent.com', client_secret: 'SYNTHETIC_NOT_A_REAL_SECRET', redirect_uris: [] } };
test('Google config fixes origin/redirect and ignores untrusted endpoint URLs', () => {
  const value = parseGoogleCredentials('\uFEFF' + JSON.stringify({ web: { ...fake.web, token_uri: 'https://attacker.invalid' } }));
  assert.equal(value.redirectUri, googleRedirectUri);
  assert.equal(value.redirectListedInDownload, false); // Old downloads may omit a later console registration.
  assert.equal('token_uri' in value, false);
  assert.equal(parseGoogleCredentials(JSON.stringify({ web: { ...fake.web, redirect_uris: [googleRedirectUri] } })).redirectListedInDownload, true);
});
test('invalid Google input never includes credentials or parser input in errors', () => {
  for (const raw of ['SYNTHETIC_NOT_A_REAL_SECRET', JSON.stringify({ installed: fake.web }), JSON.stringify({ web: { ...fake.web, client_secret: 'invalid\nsecret' } }), '{}']) {
    assert.throws(() => parseGoogleCredentials(raw), e => e.message === 'Google OAuth configuration unavailable or invalid; credential values are not logged.');
  }
});
test('private file loading and CLI keep secret values out of output; repository files rejected', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'boot-erp-google-test-'));
  const file = join(folder, 'synthetic.json');
  try {
    await writeFile(file, JSON.stringify(fake));
    assert.equal((await loadGoogleCredentials(file)).clientId, fake.web.client_id);
    const cli = fileURLToPath(new URL('../scripts/google-config.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli], { env: { ...process.env, BOOT_ERP_GOOGLE_OAUTH_FILE: file }, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).liveLoginVerified, false);
    for (const value of [fake.web.client_secret, fake.web.client_id, file]) assert.equal((result.stdout + result.stderr).includes(value), false);
    await assert.rejects(loadGoogleCredentials(fileURLToPath(new URL('../package.json', import.meta.url))), /configuration unavailable/);
    await assert.rejects(loadGoogleCredentials('relative.json'), /configuration unavailable/);
    await writeFile(file, 'SYNTHETIC_NOT_A_REAL_SECRET');
    const failure = spawnSync(process.execPath, [cli], { env: { ...process.env, BOOT_ERP_GOOGLE_OAUTH_FILE: file }, encoding: 'utf8', windowsHide: true });
    assert.equal(failure.status, 1);
    assert.equal((failure.stdout + failure.stderr).includes(fake.web.client_secret), false);
  } finally { await unlink(file); await rmdir(folder); }
});
