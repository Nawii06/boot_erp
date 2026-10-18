import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Pool } from 'pg';
import { AppError } from '../lib/errors.ts';
import { transaction } from './transaction.ts';
import { appOrigin, hash, randomToken, seal, unseal } from './security.ts';

const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { timeoutDuration: 5000 });
export interface VerifiedIdentity { provider: string; issuer: string; subject: string; email: string }
function config() {
  const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
  const redirect = `${appOrigin()}/api/auth/google/callback`;
  if (!id || !secret || process.env.GOOGLE_REDIRECT_URI !== redirect) throw new AppError('UNAVAILABLE');
  return { id, secret, redirect };
}
export async function verifyGoogleToken(token: string, nonce: string, audience: string, key: JWTVerifyGetKey = jwks): Promise<VerifiedIdentity> {
  try {
    const { payload: p } = await jwtVerify(token, key, { algorithms: ['RS256'], audience,
      issuer: ['https://accounts.google.com', 'accounts.google.com'], requiredClaims: ['sub','exp','iat','nonce','email','email_verified'], maxTokenAge: '10 minutes', clockTolerance: 5 });
    if (p.nonce !== nonce || p.email_verified !== true || (p.azp !== undefined && p.azp !== audience) ||
        (Array.isArray(p.aud) && p.aud.length > 1 && p.azp !== audience) ||
        typeof p.sub !== 'string' || !p.sub || p.sub.length > 255 || typeof p.email !== 'string' ||
        !/^[^\s@]+@[^\s@]+$/.test(p.email) || p.email.length > 254) throw new Error();
    return { provider: 'google', issuer: 'https://accounts.google.com', subject: p.sub, email: p.email.toLowerCase() };
  } catch { throw new AppError('UNAUTHENTICATED'); }
}
export async function beginGoogle(pool: Pool): Promise<{ url: string; browser: string }> {
  const cfg = config(), state = randomToken(), browser = randomToken(), verifier = randomToken(), nonce = randomToken();
  await transaction(pool, async c => {
    await c.query('DELETE FROM oauth_flows WHERE expires_at<CURRENT_TIMESTAMP');
    await c.query("INSERT INTO oauth_flows(state_hash,browser_hash,verifier,nonce,expires_at) VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+INTERVAL '5 minutes')",
      [hash(state), hash(browser), seal(verifier, hash(state)), nonce]);
  });
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: cfg.id, redirect_uri: cfg.redirect, response_type: 'code', scope: 'openid email',
    state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
  return { url: url.href, browser };
}
export async function consumeFlow(pool: Pool, state: string, browser: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(browser)) throw new AppError('UNAUTHENTICATED');
  return transaction(pool, async c => {
    const result = await c.query('DELETE FROM oauth_flows WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>CURRENT_TIMESTAMP RETURNING verifier,nonce', [hash(state), hash(browser)]);
    if (!result.rows[0]) throw new AppError('UNAUTHENTICATED');
    return { verifier: unseal(result.rows[0].verifier, hash(state)), nonce: result.rows[0].nonce as string };
  });
}
export async function finishGoogle(pool: Pool, state: string, browser: string, code: string): Promise<string> {
  const cfg = config(), flow = await consumeFlow(pool, state, browser);
  if (!code || code.length > 4096) throw new AppError('UNAUTHENTICATED');
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cfg.id, client_secret: cfg.secret,
      redirect_uri: cfg.redirect, grant_type: 'authorization_code', code, code_verifier: flow.verifier }) });
  if (!response.ok) throw new AppError('UNAUTHENTICATED');
  const result = await response.json();
  if (typeof result.id_token !== 'string') throw new AppError('UNAUTHENTICATED');
  return issueSession(pool, await verifyGoogleToken(result.id_token, flow.nonce, cfg.id));
}
// Trusted server boundary: only a provider adapter may supply a VERIFIED identity. Never accepts HTTP JSON.
export async function issueSession(pool: Pool, identity: VerifiedIdentity): Promise<string> {
  return transaction(pool, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('account-management',0))");
    const accounts = await c.query(`SELECT a.*,u.active FROM login_accounts a JOIN users u ON u.id=a.user_id WHERE a.email=$1 FOR UPDATE OF a,u`, [identity.email]);
    const a = accounts.rows[0]; if (!a?.active) throw new AppError('UNAUTHENTICATED');
    const proof = (await c.query(`SELECT outcome,checked_by FROM email_ownership_checks WHERE user_id=$1 AND email=$2 AND checked_at>=$3 ORDER BY checked_at DESC,id DESC LIMIT 1`, [a.user_id, a.email, a.ownership_after])).rows[0];
    if (proof?.outcome !== 'verified') throw new AppError('UNAUTHENTICATED');
    let link = (await c.query('SELECT * FROM auth_identities WHERE provider_key=$1 AND issuer=$2 AND subject=$3 FOR UPDATE', [identity.provider, identity.issuer, identity.subject])).rows[0];
    if (link && link.user_id !== a.user_id) throw new AppError('UNAUTHENTICATED');
    if (!link?.enabled) {
      if (!a.binding_allowed) throw new AppError('UNAUTHENTICATED');
      // A deliberate registration/recovery authorizes ONE new provider connection; email alone never merges accounts.
      if ((await c.query('SELECT 1 FROM auth_identities WHERE user_id=$1 AND enabled', [a.user_id])).rowCount) throw new AppError('UNAUTHENTICATED');
      if (link) await c.query('UPDATE auth_identities SET enabled=true WHERE id=$1', [link.id]);
      else { link = { id: randomUUID() }; await c.query('INSERT INTO auth_identities(id,user_id,provider_key,issuer,subject,enabled,linked_by) VALUES($1,$2,$3,$4,$5,true,$6)', [link.id, a.user_id, identity.provider, identity.issuer, identity.subject, proof.checked_by]); }
      await c.query('UPDATE login_accounts SET binding_allowed=false WHERE user_id=$1', [a.user_id]);
      await c.query("INSERT INTO account_audit_events(id,actor_id,target_user_id,request_id,action,reason,before_state,after_state) VALUES($1,$2,$2,$3,'identity.link','사전 등록 및 수기 확인에 따른 최초/복구 연결','{}',$4)", [randomUUID(),a.user_id,randomUUID(),JSON.stringify({ provider: identity.provider, identityId: link.id, authorizedBy: proof.checked_by })]);
    }
    await c.query("UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND revoked_at IS NULL AND (expires_at<=CURRENT_TIMESTAMP OR last_seen_at<=CURRENT_TIMESTAMP-INTERVAL '15 minutes')", [a.user_id]);
    const used = (await c.query('SELECT slot FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL', [a.user_id])).rows.map(r => r.slot);
    const slot = [1,2].find(s => !used.includes(s)); if (!slot) throw new AppError('CONFLICT');
    const token = randomToken();
    await c.query("INSERT INTO auth_sessions(token_hash,user_id,identity_id,slot,auth_version,expires_at) VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP+INTERVAL '8 hours')", [hash(token),a.user_id,link.id,slot,a.auth_version]);
    return token;
  });
}
