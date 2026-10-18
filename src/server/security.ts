import 'server-only';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../lib/errors.ts';
import { transaction } from './transaction.ts';
import type { Role } from './access.ts';

export const sessionCookie = 'boot_session';
export const flowCookie = 'boot_oauth';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export function appOrigin(): string {
  const value = process.env.APP_ORIGIN ?? 'http://localhost:3000';
  const url = new URL(value);
  if (url.origin !== value || (url.protocol !== 'https:' && value !== 'http://localhost:3000')) throw new AppError('UNAVAILABLE');
  return value;
}
export function cookie(name: string, value: string, clear = false): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${appOrigin().startsWith('https:') ? '; Secure' : ''}${clear ? '; Max-Age=0' : ''}`;
}
export function readCookie(request: Request, name = sessionCookie): string {
  const values = (request.headers.get('cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${name}=`));
  const value = values.length === 1 ? values[0].slice(name.length + 1) : '';
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}
export function sameOrigin(request: Request): void {
  if (request.headers.get('origin') !== appOrigin() || request.headers.get('sec-fetch-site') === 'cross-site') throw new AppError('FORBIDDEN');
}
export async function body(request: Request, maxBytes = 16384): Promise<Record<string, unknown>> {
  sameOrigin(request);
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AppError('INVALID_INPUT');
  // Bound reads before JSON parsing, including chunked requests.
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('INVALID_INPUT');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const item = await reader.read(); if (item.done) break; length += item.value.length;
      if (length > maxBytes) { await reader.cancel(); throw new AppError('INVALID_INPUT'); } chunks.push(item.value); }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new AppError('INVALID_INPUT'); }
}
function encryptionKey(): Buffer {
  const value = process.env.AUTH_ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-f]{64}$/.test(value)) throw new AppError('UNAVAILABLE');
  return Buffer.from(value, 'hex');
}
export function seal(value: string, context: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}
export function unseal(value: string, context: string): string {
  try { const raw = Buffer.from(value, 'base64url'), cipher = createDecipheriv('aes-256-gcm', encryptionKey(), raw.subarray(0, 12));
    cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString('utf8');
  } catch { throw new AppError('UNAVAILABLE'); }
}
export interface Actor { id: string; role: Role; email: string; tokenHash: string; issuedAt: Date; expiresAt: Date; lastSeenAt: Date; stepUpAt: Date | null }
export async function authenticate(client: PoolClient, token: string, touch = false): Promise<Actor> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError('UNAUTHENTICATED');
  const { rows } = await client.query(`SELECT u.id,u.role,a.email,s.issued_at,s.expires_at,s.last_seen_at,s.step_up_at
    FROM auth_sessions s JOIN users u ON u.id=s.user_id JOIN login_accounts a ON a.user_id=u.id
    JOIN auth_identities i ON i.id=s.identity_id AND i.user_id=u.id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND u.active AND i.enabled AND s.auth_version=a.auth_version
      AND s.expires_at>CURRENT_TIMESTAMP AND s.last_seen_at>CURRENT_TIMESTAMP-INTERVAL '15 minutes'
      AND (SELECT c.outcome='verified' FROM email_ownership_checks c WHERE c.user_id=u.id AND c.email=a.email
        AND c.checked_at>=a.ownership_after ORDER BY c.checked_at DESC,c.id DESC LIMIT 1)
    FOR SHARE OF u,a,i FOR UPDATE OF s`, [hash(token)]);
  const r = rows[0]; if (!r) throw new AppError('UNAUTHENTICATED');
  if (touch) { const result = await client.query('UPDATE auth_sessions SET last_seen_at=CURRENT_TIMESTAMP WHERE token_hash=$1 RETURNING last_seen_at', [hash(token)]); r.last_seen_at = result.rows[0].last_seen_at; }
  return { id: r.id, role: r.role, email: r.email, tokenHash: hash(token), issuedAt: r.issued_at, expiresAt: r.expires_at, lastSeenAt: r.last_seen_at, stepUpAt: r.step_up_at };
}
export function manager(actor: Actor): void { if (!['staff','admin'].includes(actor.role)) throw new AppError('FORBIDDEN'); }
export function steppedUp(actor: Actor): void {
  if (!actor.stepUpAt || actor.stepUpAt.getTime() < Date.now() - 300000) throw new AppError('FORBIDDEN');
}
export async function revoke(client: PoolClient, userId: string): Promise<void> {
  await client.query('UPDATE login_accounts SET auth_version=auth_version+1 WHERE user_id=$1', [userId]);
  await client.query('UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
}
export async function logout(pool: Pool, token: string, all: boolean): Promise<void> {
  await transaction(pool, async c => {
    const a = await authenticate(c, token);
    if (all) await revoke(c, a.id);
    else await c.query('UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE token_hash=$1', [a.tokenHash]);
  });
}
