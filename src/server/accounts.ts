import 'server-only';
import { randomUUID } from 'node:crypto';
import { TOTP, Secret } from 'otpauth';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../lib/errors.ts';
import { textInput, uuid } from '../lib/validation.ts';
import { roles } from './access.ts';
import { transaction } from './transaction.ts';
import { authenticate, manager, steppedUp, revoke, seal, unseal, hash, type Actor } from './security.ts';

export function emailInput(value: unknown): string {
  const email = textInput(value,254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new AppError('INVALID_INPUT');
  return email;
}
export async function accountAudit(c: PoolClient, actor: string, target: string, action: string, reason: string, before: unknown, after: unknown) {
  await c.query('INSERT INTO account_audit_events(id,actor_id,target_user_id,request_id,action,reason,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [randomUUID(),actor,target,randomUUID(),action,reason,JSON.stringify(before),JSON.stringify(after)]);
}
export async function command<T>(pool: Pool, token: string, input: Record<string, unknown>, action: string,
  work: (c: PoolClient,a: Actor) => Promise<T>, sensitive = false): Promise<T> {
  const requestId = uuid(input.requestId), fingerprint = hash(JSON.stringify({ action,input }));
  return transaction(pool, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('account-management',0))");
    const a = await authenticate(c, token, true); manager(a); if (sensitive) steppedUp(a);
    const existing = (await c.query('SELECT fingerprint,result FROM command_receipts WHERE actor_id=$1 AND request_id=$2', [a.id,requestId])).rows[0];
    if (existing) { if (existing.fingerprint !== fingerprint) throw new AppError('CONFLICT'); return existing.result as T; }
    const result = await work(c,a);
    await c.query('INSERT INTO command_receipts(actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4)', [a.id,requestId,fingerprint,JSON.stringify(result)]);
    return result;
  });
}
export async function accountList(pool: Pool, token: string) {
  return transaction(pool, async c => {
    const a = await authenticate(c,token); manager(a);
    return (await c.query(`SELECT u.id,u.role,u.active,p.display_name,a.email,a.auth_version,
      EXISTS(SELECT 1 FROM otp_credentials o WHERE o.user_id=u.id AND o.confirmed) AS otp_ready,
      (SELECT outcome FROM email_ownership_checks x WHERE x.user_id=u.id AND x.email=a.email AND x.checked_at>=a.ownership_after ORDER BY x.checked_at DESC,x.id DESC LIMIT 1) AS ownership
      FROM users u JOIN login_accounts a ON a.user_id=u.id LEFT JOIN people p ON p.id=u.person_id ORDER BY a.email LIMIT 1000`)).rows;
  });
}
export async function accountDetail(pool:Pool,token:string,id:string){
  uuid(id);return transaction(pool,async c=>{
    const a=await authenticate(c,token);manager(a);
    const target=(await c.query('SELECT role FROM users WHERE id=$1',[id])).rows[0];
    if(!target||(target.role==='admin'&&a.role!=='admin'))throw new AppError('FORBIDDEN');
    return {history:(await c.query('SELECT id,action,reason,actor_id,before_state,after_state,created_at FROM account_audit_events WHERE target_user_id=$1 ORDER BY created_at,id',[id])).rows,
      ownership:(await c.query('SELECT email,outcome,method,checked_by,checked_at FROM email_ownership_checks WHERE user_id=$1 ORDER BY checked_at,id',[id])).rows};
  });
}
export async function manageAccount(pool: Pool, token: string, input: Record<string,unknown>) {
  return command(pool,token,input,'account.change',async (c,a) => {
    const action = textInput(input.action), reason = textInput(input.reason,1000);
    if (action === 'create') {
      const role = textInput(input.role); if (!roles.includes(role as typeof roles[number]) || (role==='admin' && a.role!=='admin')) throw new AppError('FORBIDDEN');
      const email = emailInput(input.email), name = textInput(input.name), id = randomUUID(), person = randomUUID();
      await c.query('INSERT INTO people(id,display_name) VALUES($1,$2)', [person,name]);
      await c.query('INSERT INTO users(id,person_id,role,active) VALUES($1,$2,$3,false)', [id,person,role]);
      await c.query('INSERT INTO login_accounts(user_id,email,binding_allowed) VALUES($1,$2,true)', [id,email]);
      await accountAudit(c,a.id,id,'account.register',reason,{}, { email,role,active:false }); return { id };
    }
    const id = uuid(input.id);
    const before = (await c.query(`SELECT u.id,u.role,u.active,a.email,a.auth_version FROM users u JOIN login_accounts a ON a.user_id=u.id WHERE u.id=$1 FOR UPDATE OF u,a`,[id])).rows[0];
    if (!before) throw new AppError('INVALID_INPUT');
    if (before.role==='admin' && a.role!=='admin') throw new AppError('FORBIDDEN');
    if (String(input.version)!==before.auth_version) throw new AppError('CONFLICT');
    if (action==='verify') {
      const outcome = textInput(input.outcome); if (!['verified','rejected'].includes(outcome)) throw new AppError('INVALID_INPUT');
      await c.query('INSERT INTO email_ownership_checks(id,user_id,email,outcome,method,checked_by,checked_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())', [randomUUID(),id,before.email,outcome,textInput(input.method,500),a.id]);
    } else if (action==='status') {
      if (typeof input.active!=='boolean') throw new AppError('INVALID_INPUT');
      await c.query('UPDATE users SET active=$2 WHERE id=$1',[id,input.active]);
    } else if (action==='role') {
      const role = textInput(input.role); if (!roles.includes(role as typeof roles[number]) || (role==='admin' && a.role!=='admin')) throw new AppError('FORBIDDEN');
      await c.query('UPDATE users SET role=$2 WHERE id=$1',[id,role]);
    } else if (action==='recover' || action==='email') {
      const email = action==='email' ? emailInput(input.email) : before.email;
      await c.query('UPDATE login_accounts SET email=$2,binding_allowed=true,ownership_after=clock_timestamp() WHERE user_id=$1',[id,email]);
      await c.query('UPDATE auth_identities SET enabled=false WHERE user_id=$1',[id]);
      await c.query('DELETE FROM otp_credentials WHERE user_id=$1',[id]);
      await c.query('UPDATE users SET active=false WHERE id=$1',[id]);
    } else throw new AppError('INVALID_INPUT');
    // Keep at least one functioning administrator. Offline recovery is separately documented.
    if (before.role==='admin' && before.active) {
      const other = await c.query(`SELECT 1 FROM users u JOIN login_accounts l ON l.user_id=u.id WHERE u.role='admin' AND u.active AND
        (SELECT outcome='verified' FROM email_ownership_checks e WHERE e.user_id=u.id AND e.email=l.email AND e.checked_at>=l.ownership_after ORDER BY e.checked_at DESC,e.id DESC LIMIT 1)`);
      if (!other.rowCount) throw new AppError('CONFLICT');
    }
    await revoke(c,id);
    const after = (await c.query('SELECT u.id,u.role,u.active,a.email,a.auth_version FROM users u JOIN login_accounts a ON a.user_id=u.id WHERE u.id=$1',[id])).rows[0];
    await accountAudit(c,a.id,id,`account.${action}`,reason,before,{ ...after, ...(action==='verify' ? { outcome:input.outcome,method:input.method } : {}) });
    return { id };
  },true);
}
export async function beginOtp(pool: Pool,token: string) {
  return transaction(pool, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('account-management',0))");
    const a = await authenticate(c,token,true); manager(a);
    if (a.issuedAt.getTime()<Date.now()-300000) throw new AppError('FORBIDDEN');
    const existing = (await c.query('SELECT * FROM otp_credentials WHERE user_id=$1 FOR UPDATE',[a.id])).rows[0];
    if (existing?.confirmed) throw new AppError('CONFLICT');
    const secret = existing ? unseal(existing.encrypted_secret,a.id) : new Secret({size:20}).base32;
    if (!existing) { await c.query('INSERT INTO otp_credentials(user_id,encrypted_secret) VALUES($1,$2)',[a.id,seal(secret,a.id)]);
      await accountAudit(c,a.id,a.id,'otp.enroll.begin','Google 로그인 직후 인증 앱 등록 시작',{},{}); }
    return { secret, uri:new TOTP({ issuer:'BOOT ERP',label:a.email,secret:Secret.fromBase32(secret),algorithm:'SHA1',digits:6,period:30 }).toString() };
  });
}
export async function verifyOtp(pool: Pool,token: string,code: unknown) {
  if (typeof code!=='string' || !/^\d{6}$/.test(code)) throw new AppError('INVALID_INPUT');
  const ok = await transaction(pool,async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('account-management',0))");
    const a=await authenticate(c,token,true); manager(a);
    const o=(await c.query('SELECT * FROM otp_credentials WHERE user_id=$1 FOR UPDATE',[a.id])).rows[0];
    if (!o || (o.locked_until && o.locked_until.getTime()>Date.now())) return false;
    if (!o.confirmed && a.issuedAt.getTime()<Date.now()-300000) return false;
    const now=Date.now(), totp=new TOTP({secret:Secret.fromBase32(unseal(o.encrypted_secret,a.id)),algorithm:'SHA1',digits:6,period:30});
    const delta=totp.validate({token:code,timestamp:now,window:1}), counter=Math.floor(now/30000)+(delta ?? 0);
    if (delta===null || BigInt(counter)<=BigInt(o.last_counter)) {
      await c.query("UPDATE otp_credentials SET failures=failures+1,locked_until=CASE WHEN failures+1>=5 THEN CURRENT_TIMESTAMP+INTERVAL '15 minutes' ELSE NULL END WHERE user_id=$1",[a.id]);
      return false; // Commit failure counters; do not roll back rate limiting.
    }
    await c.query('UPDATE otp_credentials SET confirmed=true,last_counter=$2,failures=0,locked_until=NULL WHERE user_id=$1',[a.id,counter]);
    await c.query('UPDATE auth_sessions SET step_up_at=CURRENT_TIMESTAMP WHERE token_hash=$1',[a.tokenHash]);
    await accountAudit(c,a.id,a.id,o.confirmed?'otp.stepup':'otp.enroll.confirm','인증 앱 일회용 코드 확인',{},{}); return true;
  });
  if (!ok) throw new AppError('FORBIDDEN');
  return { verified:true };
}
