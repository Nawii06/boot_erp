import assert from 'node:assert/strict';
const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Local HTTP test only');
const home = await fetch(base);
assert.equal(home.status, 200);
const html = await home.text();
assert.match(html, /로그인 준비 중/);
assert.match(html, /lang="ko"/);
assert.doesNotMatch(html, /postgresql:\/\/|DATABASE_URL|boot_erp_dev_app|FAKE_PASSWORD/);
assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
assert.equal(home.headers.get('x-frame-options'), 'DENY');
const health = await fetch(`${base}/api/health`);
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { status: 'ok' });
for (const headers of [{}, { 'x-user-id': '30000000-0000-4000-8000-000000000001', 'x-role': 'admin', cookie: 'role=admin; session=synthetic' }]) {
  const session = await fetch(`${base}/api/session`, { headers });
  assert.equal(session.status, 401);
  assert.equal(session.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await session.json(), { error: { code: 'UNAUTHENTICATED' } });
}
assert.equal((await fetch(`${base}/api/session`, { method: 'POST' })).status, 405);
assert.equal((await fetch(`${base}/api/files/synthetic`)).status, 404);
assert.equal((await fetch(`${base}/uploads/synthetic`)).status, 404);
console.log('HTTP checks passed: home, DB health, closed session (including spoofed headers), no upload/download routes.');
