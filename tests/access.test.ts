import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Pool,Client } from 'pg';
import { TOTP,Secret } from 'otpauth';
import { migrate } from '../scripts/migrate.mjs';
import { assertLocalDatabase,requiredUrl } from '../scripts/db-config.mjs';
import { runtimePool } from '../src/server/db.ts';
import { issueSession,beginGoogle,consumeFlow,type VerifiedIdentity } from '../src/server/google.ts';
import { hash } from '../src/server/security.ts';
import { GET as erpGet,POST as erpPost } from '../src/app/api/erp/[...path]/route.ts';
import { GET as sessionGet } from '../src/app/api/session/route.ts';
import { POST as startGoogle } from '../src/app/api/auth/google/start/route.ts';
import { GET as callbackGoogle } from '../src/app/api/auth/google/callback/route.ts';

test('phase 02: real PostgreSQL and HTTP handlers with synthetic accounts',async t=>{
  const ownerUrl=assertLocalDatabase(requiredUrl('TEST_MIGRATION_DATABASE_URL'),'boot_erp_test','owner');
  const appUrl=assertLocalDatabase(requiredUrl('TEST_DATABASE_URL'),'boot_erp_test','app');
  const schema=`foundation_test_${randomUUID().replaceAll('-','')}`,owner=new Client({connectionString:ownerUrl});
  const url=new URL(appUrl);url.searchParams.set('options',`-c search_path=${schema},public`);process.env.DATABASE_URL=url.toString();
  delete process.env.MIGRATION_DATABASE_URL;
  process.env.APP_ORIGIN='http://localhost:3000';process.env.AUTH_ENCRYPTION_KEY='cd'.repeat(32);
  process.env.GOOGLE_CLIENT_ID='synthetic.apps.googleusercontent.com';process.env.GOOGLE_CLIENT_SECRET='synthetic-only';
  process.env.GOOGLE_REDIRECT_URI='http://localhost:3000/api/auth/google/callback';
  const pool=runtimePool();let created=false;
  const server=createServer(async(req,res)=>{
    try{
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const method=req.method??'GET',headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
      const request=new Request(`http://localhost:3000${req.url}`,{method,headers,...(method==='POST'?{body:Buffer.concat(chunks)}:{})});
      const path=new URL(request.url).pathname;
      const response=path==='/api/session'?await sessionGet(request):path==='/api/auth/google/start'?await startGoogle(request):path==='/api/auth/google/callback'?await callbackGoogle(request):
        await (method==='POST'?erpPost:erpGet)(request,{params:Promise.resolve({path:path.replace('/api/erp/','').split('/')})});
      res.statusCode=response.status;response.headers.forEach((v,k)=>{if(k!=='set-cookie')res.setHeader(k,v);});
      const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);
      res.end(Buffer.from(await response.arrayBuffer()));
    }catch{res.statusCode=500;res.end('Test harness failed');}
  });
  await owner.connect();
  try{
    await owner.query(`CREATE SCHEMA ${schema}`);created=true;assert.equal(await migrate(ownerUrl,schema),4);
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO boot_erp_test_app`);
    await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO boot_erp_test_app`);
    await owner.query(`REVOKE ALL ON ${schema}.migration_history FROM boot_erp_test_app`);await owner.query(`SET search_path TO ${schema},public`);
    server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
    async function call(path:string,token='',data?:Record<string,unknown>,origin='http://localhost:3000'){
      const r=await fetch(base+path,{method:data?'POST':'GET',headers:{cookie:`boot_session=${token}`,origin,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
      return {status:r.status,data:await r.json(),headers:r.headers};
    }
    const identities=new Map<string,VerifiedIdentity>();
    async function seed(role:string,label:string){
      const id=randomUUID(),person=randomUUID(),email=`${label}@example.invalid`;
      await owner.query('INSERT INTO people(id,display_name) VALUES($1,$2)',[person,label]);
      await owner.query('INSERT INTO users(id,person_id,role,active) VALUES($1,$2,$3,true)',[id,person,role]);
      await owner.query('INSERT INTO login_accounts(user_id,email,binding_allowed) VALUES($1,$2,true)',[id,email]);
      await owner.query("INSERT INTO email_ownership_checks(id,user_id,email,outcome,method,checked_by,checked_at) VALUES($1,$2,$3,'verified','synthetic ownership',$2,clock_timestamp())",[randomUUID(),id,email]);
      const identity={provider:'google',issuer:'https://accounts.google.com',subject:label,email};identities.set(id,identity);return {id,token:await issueSession(pool,identity)};
    }
    const admin=await seed('admin','admin'),staff=await seed('staff','staff'),ra=await seed('researcher','researcher-a'),rb=await seed('researcher','researcher-b'),pi=await seed('principal_investigator','pi');
    async function stepup(token:string){const enrol=await call('/api/erp/otp-enroll',token,{});assert.equal(enrol.status,200);
      const code=new TOTP({secret:Secret.fromBase32(enrol.data.secret)}).generate();assert.equal((await call('/api/erp/otp-verify',token,{code})).status,200);return {code,secret:enrol.data.secret};}
    let adminOtp:{code:string;secret:string};
    await t.test('OTP registration expiry tells a valid manager to reauthenticate; fresh login permits registration',async()=>{
      const account=await seed('staff','enrollment-expiry');
      const age=()=>owner.query("UPDATE auth_sessions SET issued_at=issued_at-INTERVAL '6 minutes',expires_at=expires_at-INTERVAL '6 minutes' WHERE token_hash=$1",[hash(account.token)]);
      await age();
      assert.equal((await call('/api/session',account.token)).status,200);
      const refused=await call('/api/erp/otp-enroll',account.token,{});
      assert.equal(refused.status,403);assert.equal(refused.data.error.code,'REAUTH_REQUIRED');
      assert.equal((await owner.query('SELECT 1 FROM otp_credentials WHERE user_id=$1',[account.id])).rowCount,0);
      account.token=await issueSession(pool,identities.get(account.id)!);
      const enrolled=await call('/api/erp/otp-enroll',account.token,{});assert.equal(enrolled.status,200);
      const code=new TOTP({secret:Secret.fromBase32(enrolled.data.secret)}).generate();
      await age();
      const confirmation=await call('/api/erp/otp-verify',account.token,{code});
      assert.equal(confirmation.data.error.code,'REAUTH_REQUIRED');
      assert.equal((await owner.query('SELECT confirmed FROM otp_credentials WHERE user_id=$1',[account.id])).rows[0].confirmed,false);
    });
    await t.test('A-11: OTP enrollment, replay protection, and per-account throttling',async()=>{
      adminOtp=await stepup(admin.token);await stepup(staff.token);
      assert.equal((await call('/api/erp/otp-verify',admin.token,{code:adminOtp.code})).status,403);
      for(let n=0;n<4;n++)assert.equal((await call('/api/erp/otp-verify',admin.token,{code:adminOtp.code})).status,403);
      const lock=(await owner.query('SELECT failures,locked_until FROM otp_credentials WHERE user_id=$1',[admin.id])).rows[0];assert.equal(lock.failures,5);assert.ok(lock.locked_until>Date.now());
      assert.equal((await call('/api/erp/otp-enroll',admin.token,{})).status,409);
      assert.equal((await call('/api/erp/otp-enroll',ra.token,{})).status,403);
    });
    async function mutate(path:string,token:string,data:Record<string,unknown>){return call('/api/erp/'+path,token,{requestId:randomUUID(),reason:'synthetic verification',...data});}
    async function version(id:string){return (await owner.query('SELECT auth_version FROM login_accounts WHERE user_id=$1',[id])).rows[0].auth_version;}
    let project='',other='',workA='',workB='';
    await t.test('A-03/A-05: management, project creation and idempotent audit',async()=>{
      const data={action:'create',name:'Synthetic research',code:'TEST-02',kind:'research',year:2026,reason:'synthetic project',requestId:randomUUID()};
      const first=await call('/api/erp/projects',staff.token,data);assert.equal(first.status,200);project=first.data.id;
      assert.deepEqual((await call('/api/erp/projects',staff.token,data)).data,first.data);
      assert.equal((await call('/api/erp/projects',staff.token,{...data,name:'conflicting retry'})).status,409);
      const p2=await mutate('projects',admin.token,{action:'create',name:'Unassigned program',code:'TEST-OTHER',kind:'program',year:2026});assert.equal(p2.status,200);other=p2.data.id;
      for(const user of [ra,rb,pi]){
        const v=(await owner.query('SELECT version FROM projects WHERE id=$1',[project])).rows[0].version;
        assert.equal((await mutate('projects',staff.token,{action:'member',id:project,version:v,userId:user.id,active:true})).status,200);
      }
      const create=async(title:string,userId:string)=>mutate('work',staff.token,{action:'create',projectId:project,title,description:'synthetic history',assignedTo:userId});
      const wa=await create('Private A',ra.id),wb=await create('Private B',rb.id);assert.equal(wa.status,200);assert.equal(wb.status,200);workA=wa.data.id;workB=wb.data.id;
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM project_history WHERE project_id=$1',[project])).rows[0].n,4);
      assert.equal((await call('/api/erp/system',staff.token)).status,403);
      assert.equal((await call('/api/erp/work',admin.token)).data.length,2);
    });
    await t.test('A-01/A-06: same-project researcher isolation on list, detail, search, count and export',async()=>{
      assert.deepEqual((await call('/api/erp/work',ra.token)).data.map((w:{id:string})=>w.id),[workA]);
      assert.equal((await call('/api/erp/work/'+workB,ra.token)).status,403);
      assert.deepEqual((await call('/api/erp/work?q=Private%20B',ra.token)).data,[]);
      assert.equal((await call('/api/erp/stats',ra.token)).data.visibleWorkCount,1);
      const exported=await call('/api/erp/export',ra.token);assert.equal(exported.data.length,1);assert.equal(exported.data[0].id,workA);assert.equal(exported.headers.get('cache-control'),'no-store');
      assert.equal((await call('/api/erp/projects/'+project,ra.token)).data.participants.length,1);
      assert.equal((await call('/api/erp/projects/'+other,ra.token)).status,403);
      assert.equal((await call('/api/erp/files/'+workB,ra.token)).status,403);
    });
    await t.test('A-02/A-07: PI can read assigned project but cannot perform business mutations',async()=>{
      assert.equal((await call('/api/erp/work',pi.token)).data.length,2);
      assert.equal((await call('/api/erp/work/'+workB,pi.token)).status,200);
      assert.equal((await call('/api/erp/projects/'+other,pi.token)).status,403);
      for(const kind of ['projects','work','accounts'])assert.equal((await mutate(kind,pi.token,{action:'create'})).status,403);
    });
    await t.test('A-08: handover preserves old content/actor and immediately removes predecessor access',async()=>{
      const before=(await call('/api/erp/work/'+workA,staff.token)).data.item;
      const change={action:'update',id:workA,version:before.version,title:'Private A continued',description:before.description,assignedTo:rb.id};
      const result=await mutate('work',staff.token,change);assert.equal(result.status,200);
      assert.equal((await mutate('work',staff.token,change)).status,409);
      assert.equal((await call('/api/erp/work/'+workA,ra.token)).status,403);
      assert.equal((await call('/api/erp/work',ra.token)).data.length,0);
      const successor=await call('/api/erp/work/'+workA,rb.token);assert.equal(successor.status,200);assert.equal(successor.data.history.length,2);
      assert.equal(successor.data.history[0].after_state.title,'Private A');assert.equal(successor.data.history[0].actor_id,staff.id);
      await assert.rejects(pool.query('UPDATE work_history SET reason=$1',['overwrite']),{code:'55000'});
      await assert.rejects(pool.query('DELETE FROM project_history'),{code:'55000'});
    });
    await t.test('A-10: staff cannot manage admin or elevate itself; stale/missing step-up rejected',async()=>{
      assert.equal((await mutate('accounts',staff.token,{action:'create',name:'bad',email:'bad@example.invalid',role:'admin'})).status,403);
      assert.equal((await mutate('accounts',staff.token,{action:'status',id:admin.id,version:await version(admin.id),active:false})).status,403);
      assert.equal((await mutate('accounts',staff.token,{action:'role',id:staff.id,version:await version(staff.id),role:'admin'})).status,403);
      assert.equal((await mutate('accounts',staff.token,{action:'verify',id:admin.id,version:await version(admin.id),outcome:'verified',method:'forged'})).status,403);
      assert.equal((await call('/api/erp/accounts/'+admin.id,staff.token)).status,403);
      assert.equal((await call('/api/erp/accounts/'+ra.id,staff.token)).status,200);
      await owner.query("UPDATE auth_sessions SET step_up_at=issued_at WHERE token_hash=$1",[hash(staff.token)]);
      await owner.query("UPDATE auth_sessions SET issued_at=issued_at-INTERVAL '10 minutes',step_up_at=issued_at-INTERVAL '9 minutes',expires_at=expires_at-INTERVAL '10 minutes' WHERE token_hash=$1",[hash(staff.token)]);
      assert.equal((await mutate('accounts',staff.token,{action:'create',name:'later',email:'later@example.invalid',role:'researcher'})).status,403);
      assert.equal((await mutate('accounts',admin.token,{action:'status',id:admin.id,version:await version(admin.id),active:false})).status,409);
    });
    await t.test('A-12: preregistration, manual verification and activation required separately',async()=>{
      const identity={provider:'google',issuer:'https://accounts.google.com',subject:'new-external',email:'external@example.invalid'};
      await assert.rejects(issueSession(pool,identity),{code:'UNAUTHENTICATED'});
      const reg=await mutate('accounts',admin.token,{action:'create',name:'Synthetic external',email:identity.email,role:'researcher'});assert.equal(reg.status,200);const id=reg.data.id;
      await assert.rejects(issueSession(pool,identity),{code:'UNAUTHENTICATED'});
      assert.equal((await mutate('accounts',admin.token,{action:'status',id,version:await version(id),active:true})).status,200);
      await assert.rejects(issueSession(pool,identity),{code:'UNAUTHENTICATED'});
      assert.equal((await mutate('accounts',admin.token,{action:'verify',id,version:await version(id),outcome:'rejected',method:'synthetic rejection'})).status,200);
      await assert.rejects(issueSession(pool,identity),{code:'UNAUTHENTICATED'});
      assert.equal((await mutate('accounts',admin.token,{action:'verify',id,version:await version(id),outcome:'verified',method:'synthetic ownership checked'})).status,200);
      const token=await issueSession(pool,identity);assert.equal((await call('/api/session',token)).status,200);
      assert.equal((await call('/api/erp/projects',token)).data.length,0);
    });
    await t.test('A-04: assignment removal and suspension affect existing sessions immediately',async()=>{
      const pv=(await owner.query('SELECT version FROM projects WHERE id=$1',[project])).rows[0].version;
      assert.equal((await mutate('projects',admin.token,{action:'member',id:project,version:pv,userId:rb.id,active:false})).status,200);
      assert.equal((await call('/api/erp/work/'+workA,rb.token)).status,403);
      assert.equal((await call('/api/erp/export',rb.token)).data.length,0);
      assert.equal((await mutate('accounts',admin.token,{action:'status',id:ra.id,version:await version(ra.id),active:false})).status,200);
      assert.equal((await call('/api/session',ra.token)).status,401);
    });
    await t.test('A-09: email change/recovery and simulated SSO keep internal history, never auto-merge',async()=>{
      const original=identities.get(rb.id)!;
      await assert.rejects(issueSession(pool,{...original,provider:'university-sso',issuer:'https://sso.example.invalid'}),{code:'UNAUTHENTICATED'});
      assert.equal((await mutate('accounts',admin.token,{action:'email',id:rb.id,version:await version(rb.id),email:'changed@example.invalid'})).status,200);
      assert.equal((await call('/api/session',rb.token)).status,401);
      await assert.rejects(issueSession(pool,{...original,email:'changed@example.invalid'}),{code:'UNAUTHENTICATED'});
      assert.equal((await mutate('accounts',admin.token,{action:'verify',id:rb.id,version:await version(rb.id),outcome:'verified',method:'synthetic reverification'})).status,200);
      assert.equal((await mutate('accounts',admin.token,{action:'status',id:rb.id,version:await version(rb.id),active:true})).status,200);
      const sso={provider:'university-sso',issuer:'https://sso.example.invalid',subject:'synthetic-new-subject',email:'changed@example.invalid'};
      const token=await issueSession(pool,sso);assert.equal((await call('/api/session',token)).data.id,rb.id);
      assert.equal((await owner.query('SELECT assigned_to FROM work_items WHERE id=$1',[workA])).rows[0].assigned_to,rb.id);
      await assert.rejects(issueSession(pool,{...original,email:sso.email}),{code:'UNAUTHENTICATED'});
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM auth_identities WHERE user_id=$1',[rb.id])).rows[0].n,2);
    });
    await t.test('A-11: recovery revokes sessions and OTP, requires fresh manual proof, and retains user ID',async()=>{
      assert.equal((await mutate('accounts',admin.token,{action:'recover',id:staff.id,version:await version(staff.id)})).status,200);
      assert.equal((await call('/api/session',staff.token)).status,401);
      assert.equal((await owner.query('SELECT 1 FROM otp_credentials WHERE user_id=$1',[staff.id])).rowCount,0);
      await assert.rejects(issueSession(pool,identities.get(staff.id)!),{code:'UNAUTHENTICATED'});
      assert.equal((await mutate('accounts',admin.token,{action:'verify',id:staff.id,version:await version(staff.id),outcome:'verified',method:'synthetic recovery identity check'})).status,200);
      assert.equal((await mutate('accounts',admin.token,{action:'status',id:staff.id,version:await version(staff.id),active:true})).status,200);
      const restored=await issueSession(pool,identities.get(staff.id)!);assert.equal((await call('/api/session',restored)).data.id,staff.id);
      assert.equal((await call('/api/erp/accounts/'+staff.id,admin.token)).data.history.some((e:{action:string})=>e.action==='account.recover'),true);
    });
    await t.test('A-11: concurrent login cap, idle/absolute expiry, polling, activity and global logout',async()=>{
      const fresh=await seed('researcher','sessions'),identity=identities.get(fresh.id)!;
      const parallel=await Promise.allSettled([issueSession(pool,identity),issueSession(pool,identity)]);assert.equal(parallel.filter(r=>r.status==='fulfilled').length,1);
      const second=(parallel.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<string>).value;
      const firstSeen=(await owner.query('SELECT last_seen_at FROM auth_sessions WHERE token_hash=$1',[hash(fresh.token)])).rows[0].last_seen_at;
      await call('/api/session',fresh.token);assert.equal((await owner.query('SELECT last_seen_at FROM auth_sessions WHERE token_hash=$1',[hash(fresh.token)])).rows[0].last_seen_at.getTime(),firstSeen.getTime());
      assert.equal((await call('/api/erp/activity',fresh.token,{})).status,200);
      await owner.query("UPDATE auth_sessions SET issued_at=issued_at-INTERVAL '16 minutes',last_seen_at=last_seen_at-INTERVAL '16 minutes',expires_at=expires_at-INTERVAL '16 minutes' WHERE token_hash=$1",[hash(fresh.token)]);
      assert.equal((await call('/api/session',fresh.token)).status,401);
      const replacement=await issueSession(pool,identity);assert.equal((await call('/api/session',replacement)).status,200);
      assert.equal((await call('/api/erp/logout',second,{all:true})).status,200);
      assert.equal((await call('/api/session',replacement)).status,401);
      const absolute=await issueSession(pool,identity);
      await owner.query("UPDATE auth_sessions SET issued_at=issued_at-INTERVAL '9 hours',last_seen_at=issued_at-INTERVAL '2 hours',expires_at=expires_at-INTERVAL '9 hours' WHERE token_hash=$1",[hash(absolute)]);
      assert.equal((await call('/api/session',absolute)).status,401);
    });
    await t.test('HTTP CSRF, spoofed identity, one-use browser-bound OAuth state and safe callback failure',async()=>{
      assert.equal((await mutate('projects','synthetic',{action:'create'})).status,401);
      assert.equal((await call('/api/erp/projects',admin.token,{action:'create'},'https://attacker.invalid')).status,403);
      const flow=await beginGoogle(pool),q=new URL(flow.url).searchParams;assert.equal(q.get('code_challenge_method'),'S256');assert.equal(q.get('scope'),'openid email');
      await assert.rejects(consumeFlow(pool,q.get('state')!,'x'.repeat(43)),{code:'UNAUTHENTICATED'});
      assert.ok((await consumeFlow(pool,q.get('state')!,flow.browser)).nonce);
      await assert.rejects(consumeFlow(pool,q.get('state')!,flow.browser),{code:'UNAUTHENTICATED'});
      const response=await fetch(base+'/api/auth/google/callback?code=synthetic&state=invalid',{redirect:'manual'});assert.equal(response.status,303);assert.equal(response.headers.get('location'),'http://localhost:3000/?login=failed');
      const spoof=await fetch(base+'/api/session',{headers:{'x-user-id':admin.id,'x-role':'admin',cookie:'role=admin'}});assert.equal(spoof.status,401);
    });
  }finally{
    if(server.listening)await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await pool.end();
    if(created){for(const table of ['budget_events','spend_states','budget_files','budget_change_lines','budget_changes','budget_accounts','budget_code_versions','budget_codes','project_history','work_history','work_items','otp_credentials','oauth_flows','account_audit_events','auth_sessions','auth_identities','email_ownership_checks','login_accounts','audit_events','command_receipts','spend_cases','budget_lines','project_memberships','projects','users','people','migration_history'])await owner.query(`DROP TABLE IF EXISTS ${schema}.${table}`);
      await owner.query(`DROP FUNCTION IF EXISTS ${schema}.reject_foundation_rewrite()`);await owner.query(`DROP FUNCTION IF EXISTS ${schema}.protect_budget_snapshot()`);await owner.query(`DROP SCHEMA ${schema}`);}
    await owner.end();
  }
});
