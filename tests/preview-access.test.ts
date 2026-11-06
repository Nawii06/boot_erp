import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { migrate } from '../scripts/migrate.mjs';
import { assertLocalDatabase, requiredUrl } from '../scripts/db-config.mjs';
import { getPreviewConfig, previewRoles, type PreviewRole } from '../src/lib/preview-config.ts';
import { GET, POST } from '../src/app/api/auth/preview/route.ts';
import { GET as sessionGet } from '../src/app/api/session/route.ts';
import { runtimePool } from '../src/server/db.ts';
import { issuePreviewSession } from '../src/server/preview.ts';
import { hash } from '../src/server/security.ts';

test('local preview uses real scoped sessions only in its disposable schema',async t => {
  const ownerUrl=assertLocalDatabase(requiredUrl('TEST_MIGRATION_DATABASE_URL'),'boot_erp_test','owner');
  const appUrl=assertLocalDatabase(requiredUrl('TEST_DATABASE_URL'),'boot_erp_test','app');
  const schema=`boot_preview_${randomUUID().replaceAll('-','')}`;
  const owner=new Client({connectionString:ownerUrl});let created='',pool:Pool|undefined;
  const envKeys=['DATABASE_URL','MIGRATION_DATABASE_URL','APP_ORIGIN','BOOT_ERP_PREVIEW_MODE','BOOT_ERP_PREVIEW_SCHEMA','BOOT_ERP_PREVIEW_EXPIRES_AT','BOOT_ERP_PREVIEW_USERS'];
  const old=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
  const users=Object.fromEntries(previewRoles.map(role=>[role,randomUUID()])) as Record<PreviewRole,string>;
  const url=new URL(appUrl);url.searchParams.set('options',`-c search_path=${schema}`);
  await owner.connect();
  const request=(method='GET',data:unknown={role:'staff'},extra:Record<string,string>={},address='http://localhost:3000/api/auth/preview') =>
    new Request(address,{method,headers:{host:'localhost:3000',origin:'http://localhost:3000','Content-Type':'application/json',...extra},
      ...(method==='POST'?{body:JSON.stringify(data)}:{})});
  try {
    await owner.query(`CREATE SCHEMA ${schema}`);created=schema;await migrate(ownerUrl,schema);
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO boot_erp_test_app`);
    await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO boot_erp_test_app`);
    await owner.query(`REVOKE ALL ON ${schema}.migration_history FROM boot_erp_test_app`);
    await owner.query(`SET search_path TO ${schema}`);
    for(const role of previewRoles) {
      const id=users[role],person=randomUUID(),email=`preview-${role}@erp.example.invalid`;
      await owner.query('INSERT INTO people(id,display_name) VALUES($1,$2)',[person,`가상 ${role}`]);
      await owner.query('INSERT INTO users(id,person_id,role,active) VALUES($1,$2,$3,true)',[id,person,role]);
      await owner.query('INSERT INTO login_accounts(user_id,email,binding_allowed) VALUES($1,$2,true)',[id,email]);
      await owner.query("INSERT INTO email_ownership_checks(id,user_id,email,outcome,method,checked_by,checked_at) VALUES($1,$2,$3,'verified','local-preview',$2,clock_timestamp())",[randomUUID(),id,email]);
    }
    process.env.DATABASE_URL=url.toString();delete process.env.MIGRATION_DATABASE_URL;
    process.env.APP_ORIGIN='http://localhost:3000';process.env.BOOT_ERP_PREVIEW_SCHEMA=schema;
    process.env.BOOT_ERP_PREVIEW_EXPIRES_AT=new Date(Date.now()+3600000).toISOString();
    process.env.BOOT_ERP_PREVIEW_USERS=JSON.stringify(users);
    await t.test('default off hides both handlers without a session',async()=>{
      delete process.env.BOOT_ERP_PREVIEW_MODE;
      assert.equal((await GET(request())).status,404);assert.equal((await POST(request('POST'))).status,404);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM auth_sessions')).rows[0].n,0);
    });
    process.env.BOOT_ERP_PREVIEW_MODE='1';pool=runtimePool();
    const config=getPreviewConfig()!;
    await t.test('metadata is limited and local; cross-origin and identity injection fail',async()=>{
      const options=await GET(request());assert.equal(options.status,200);
      assert.deepEqual(await options.json(),{enabled:true,expiresAt:config.expiresAt,roles:previewRoles});
      assert.equal((await GET(request('GET',{}, {host:'evil.example.invalid'}))).status,403);
      assert.equal((await POST(request('POST',{role:'staff'},{origin:'http://evil.example.invalid'}))).status,403);
      assert.equal((await POST(request('POST',{role:'staff'},{'sec-fetch-site':'cross-site'}))).status,403);
      assert.equal((await POST(request('POST',{role:'staff'},{host:'evil.example.invalid'}))).status,403);
      assert.equal((await POST(request('POST',{role:'staff'},{},'http://evil.example.invalid/api/auth/preview'))).status,403);
      for(const data of [{role:'owner'},{role:'staff',id:users.admin},{role:'staff',email:'someone@example.invalid'},{role:users.admin}]) {
        assert.equal((await POST(request('POST',data))).status,400);
      }
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM auth_sessions')).rows[0].n,0);
    });
    const tokens={} as Record<PreviewRole,string>;
    await t.test('all four roles receive HttpOnly scoped sessions, bounded by preview expiry',async()=>{
      for(const role of previewRoles){
        const response=await POST(request('POST',{role}));
        if(response.status!==200)await issuePreviewSession(pool!,config,role); // Preserve the internal failure in this synthetic-only test.
        assert.equal(response.status,200);
        assert.deepEqual(await response.json(),{ok:true,role,expiresAt:config.expiresAt,authentication:'local-preview'});
        const cookie=response.headers.get('set-cookie')??'';assert.match(cookie,/^boot_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax$/);
        tokens[role]=cookie.match(/^boot_session=([^;]+)/)![1];
        const session=await sessionGet(new Request('http://localhost:3000/api/session',{headers:{cookie:`boot_session=${tokens[role]}`}}));
        assert.equal(session.status,200);const actual=await session.json();assert.equal(actual.id,users[role]);assert.equal(actual.role,role);
        const identity=(await owner.query(`SELECT i.provider_key,i.issuer,i.subject,s.expires_at FROM auth_sessions s JOIN auth_identities i ON i.id=s.identity_id WHERE s.token_hash=$1`,[hash(tokens[role])])).rows[0];
        assert.equal(identity.provider_key,'local-preview');assert.equal(identity.issuer,'urn:boot-erp:preview');assert.equal(identity.subject,users[role]);
        assert.ok(identity.expires_at.getTime()<=config.expiresAtMs);
      }
    });
    await t.test('repeated same-browser access replaces its old session without bypassing slot policy',async()=>{
      let previous=tokens.staff;
      for(let i=0;i<3;i++){
        const response=await POST(request('POST',{role:'staff'},{cookie:`boot_session=${previous}`}));assert.equal(response.status,200);
        assert.ok((await owner.query('SELECT revoked_at FROM auth_sessions WHERE token_hash=$1',[hash(previous)])).rows[0].revoked_at);
        previous=(response.headers.get('set-cookie')??'').match(/^boot_session=([^;]+)/)![1];
      }
      tokens.staff=previous;
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL',[users.staff])).rows[0].n,1);
    });
    await t.test('configured role cannot impersonate a changed account or unverified proof',async()=>{
      await owner.query('UPDATE users SET role=\'admin\' WHERE id=$1',[users.researcher]);
      assert.equal((await POST(request('POST',{role:'researcher'}))).status,403);
      await owner.query('UPDATE users SET role=\'researcher\',active=false WHERE id=$1',[users.researcher]);
      assert.equal((await POST(request('POST',{role:'researcher'}))).status,403);
      await owner.query('UPDATE users SET active=true WHERE id=$1',[users.researcher]);
      await owner.query("INSERT INTO email_ownership_checks(id,user_id,email,outcome,method,checked_by,checked_at) VALUES($1,$2,$3,'rejected','local-preview',$4,clock_timestamp())",[randomUUID(),users.researcher,'preview-researcher@erp.example.invalid',users.admin]);
      assert.equal((await POST(request('POST',{role:'researcher'}))).status,403);
      await owner.query('UPDATE login_accounts SET email=\'real@example.invalid\' WHERE user_id=$1',[users.principal_investigator]);
      assert.equal((await POST(request('POST',{role:'principal_investigator'}))).status,403);
    });
    await t.test('actual public search path and expired configuration cannot issue sessions',async()=>{
      const publicUrl=new URL(appUrl);publicUrl.searchParams.set('options','-c search_path=public');
      const wrong=new Pool({connectionString:publicUrl.toString()});
      try{await assert.rejects(issuePreviewSession(wrong,config,'admin'),{message:'UNAVAILABLE'});}finally{await wrong.end();}
      process.env.BOOT_ERP_PREVIEW_EXPIRES_AT=new Date(Date.now()-1).toISOString();
      assert.equal((await GET(request())).status,503);assert.equal((await POST(request('POST',{role:'admin'}))).status,503);
      process.env.BOOT_ERP_PREVIEW_MODE='0';assert.equal((await POST(request('POST',{role:'admin'}))).status,404);
      const closedSession=await sessionGet(new Request('http://localhost:3000/api/session',{
        headers:{cookie:`boot_session=${tokens.admin}`},
      }));
      assert.equal(closedSession.status,503);
      assert.deepEqual(await closedSession.json(),{error:{code:'UNAVAILABLE'}});
    });
  } finally {
    await pool?.end();
    if(created && /^boot_preview_[0-9a-f]{32}$/.test(created))await owner.query(`DROP SCHEMA ${created} CASCADE`);
    await owner.end();for(const key of envKeys){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}
  }
});
