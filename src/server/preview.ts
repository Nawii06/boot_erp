import 'server-only';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../lib/errors.ts';
import { previewRoles, type PreviewConfig, type PreviewRole } from '../lib/preview-config.ts';
import { issueSession } from './google.ts';
import { hash } from './security.ts';
import { transaction } from './transaction.ts';

function assertLive(config: PreviewConfig): void {
  if (!/^boot_preview_[0-9a-f]{32}$/.test(config.schema) || config.expiresAtMs <= Date.now() ||
      config.expiresAtMs - Date.now() > 8 * 60 * 60 * 1000) throw new AppError('UNAVAILABLE');
}

async function verifyDatabase(client: PoolClient, config: PreviewConfig): Promise<void> {
  assertLive(config);
  const {rows} = await client.query(`SELECT current_database() AS database, current_user AS username,
    current_schema() AS schema, current_setting('search_path') AS path,
    host(inet_server_addr()) AS address, inet_server_port() AS port`);
  const actual = rows[0];
  if (!actual || actual.database !== 'boot_erp_test' || actual.username !== 'boot_erp_test_app' ||
      actual.schema !== config.schema || actual.path !== config.schema ||
      !['127.0.0.1', '::1'].includes(actual.address) || actual.port !== 55432) throw new AppError('UNAVAILABLE');
}

async function verifyAccount(client: PoolClient, config: PreviewConfig, role: PreviewRole): Promise<string> {
  await verifyDatabase(client, config);
  const email = `preview-${role}@erp.example.invalid`;
  const {rows} = await client.query(`SELECT u.id, u.role, u.active, a.email,
    proof.outcome, proof.method FROM users u JOIN login_accounts a ON a.user_id=u.id
    LEFT JOIN LATERAL (SELECT outcome, method FROM email_ownership_checks
      WHERE user_id=u.id AND email=a.email AND checked_at>=a.ownership_after
      ORDER BY checked_at DESC,id DESC LIMIT 1) proof ON true
    WHERE u.id=$1 FOR SHARE OF u,a`, [config.users[role]]);
  const user = rows[0];
  if (!user || user.role !== role || !user.active || user.email !== email ||
      user.outcome !== 'verified' || user.method !== 'local-preview') throw new AppError('FORBIDDEN');
  return email;
}

// This provider exists only behind the explicit local, expiring test-schema guard.
// It is not evidence of a Google login and accepts no client-supplied identity.
export async function issuePreviewSession(pool: Pool, config: PreviewConfig, selectedRole: unknown, previousToken = ''): Promise<{token: string; role: PreviewRole}> {
  if (typeof selectedRole !== 'string' || !previewRoles.includes(selectedRole as PreviewRole)) throw new AppError('INVALID_INPUT');
  const role = selectedRole as PreviewRole;
  const email = await transaction(pool, async client => {
    const verifiedEmail = await verifyAccount(client, config, role);
    if (/^[A-Za-z0-9_-]{43}$/.test(previousToken)) {
      await client.query(`UPDATE auth_sessions s SET revoked_at=CURRENT_TIMESTAMP FROM auth_identities i
        WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.identity_id=i.id AND i.user_id=s.user_id
          AND i.provider_key='local-preview' AND i.issuer='urn:boot-erp:preview'
          AND i.subject=s.user_id::text AND s.user_id=ANY($2::uuid[])`,
        [hash(previousToken),previewRoles.map(key => config.users[key])]);
    }
    return verifiedEmail;
  });
  const token = await issueSession(pool, {provider:'local-preview',issuer:'urn:boot-erp:preview',subject:config.users[role],email});
  try {
    await transaction(pool, async client => {
      await verifyAccount(client, config, role);
      const bounded = await client.query(`UPDATE auth_sessions SET expires_at=LEAST(expires_at,$2::timestamptz)
        WHERE token_hash=$1 AND revoked_at IS NULL AND issued_at<$2::timestamptz RETURNING token_hash`,
        [hash(token),config.expiresAt]);
      if (bounded.rowCount !== 1) throw new AppError('UNAVAILABLE');
    });
  } catch (error) {
    await pool.query('UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE token_hash=$1 AND revoked_at IS NULL',[hash(token)]).catch(() => {});
    throw error;
  }
  return {token,role};
}
