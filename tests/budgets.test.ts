import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { migrate } from '../scripts/migrate.mjs';
import { assertLocalDatabase,requiredUrl } from '../scripts/db-config.mjs';
import { runtimePool } from '../src/server/db.ts';
import { issueSession } from '../src/server/google.ts';
import { GET,POST } from '../src/app/api/erp/[...path]/route.ts';

test('phase 03: budget integrity and private files on real PostgreSQL and HTTP handlers',async t=>{
  const ownerUrl=assertLocalDatabase(requiredUrl('TEST_MIGRATION_DATABASE_URL'),'boot_erp_test','owner');
  const appUrl=assertLocalDatabase(requiredUrl('TEST_DATABASE_URL'),'boot_erp_test','app');
  const schema=`foundation_test_${randomUUID().replaceAll('-','')}`,owner=new Client({connectionString:ownerUrl});
  const url=new URL(appUrl);url.searchParams.set('options',`-c search_path=${schema},public`);process.env.DATABASE_URL=url.toString();
  delete process.env.MIGRATION_DATABASE_URL;process.env.APP_ORIGIN='http://localhost:3000';
  const pool=runtimePool();let created=false;
  async function call(path:string,token:string,data?:Record<string,unknown>,origin='http://localhost:3000'){
    const request=new Request('http://localhost:3000/api/erp/'+path,{method:data?'POST':'GET',headers:{cookie:`boot_session=${token}`,origin,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
    const ctx={params:Promise.resolve({path:path.split('?')[0].split('/')})};
    const r=await(data?POST:GET)(request,ctx);return {status:r.status,data:r.headers.get('content-type')?.includes('json')?await r.json():Buffer.from(await r.arrayBuffer()),headers:r.headers};
  }
  const input=(data:Record<string,unknown>)=>({requestId:randomUUID(),reason:'synthetic budget verification',...data});
  async function ok(path:string,token:string,data?:Record<string,unknown>){const r=await call(path,token,data);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
  const file={name:'synthetic.pdf',content:Buffer.from('%PDF-1.7\nsynthetic attachment only\n%%EOF').toString('base64')};
  await owner.connect();
  try{
    await owner.query(`CREATE SCHEMA ${schema}`);created=true;assert.equal(await migrate(ownerUrl,schema),4);
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO boot_erp_test_app`);
    await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO boot_erp_test_app`);
    await owner.query(`REVOKE ALL ON ${schema}.migration_history FROM boot_erp_test_app`);await owner.query(`SET search_path TO ${schema},public`);
    async function seed(role:string){const id=randomUUID(),email=`${id}@example.invalid`;
      await owner.query('INSERT INTO users(id,role,active) VALUES($1,$2,true)',[id,role]);
      await owner.query('INSERT INTO login_accounts(user_id,email,binding_allowed) VALUES($1,$2,true)',[id,email]);
      await owner.query("INSERT INTO email_ownership_checks(id,user_id,email,outcome,method,checked_by,checked_at) VALUES($1,$2,$3,'verified','synthetic',$2,clock_timestamp())",[randomUUID(),id,email]);
      return {id,token:await issueSession(pool,{provider:'google',issuer:'https://accounts.google.com',subject:id,email})};
    }
    const staff=await seed('staff'),admin=await seed('admin'),ra=await seed('researcher'),rb=await seed('researcher'),pi=await seed('principal_investigator');
    const cat=await ok('budget-codes',staff.token,input({action:'create',level:1,code:'N90',name:'Synthetic category',active:true,effectiveOn:'2026-03-01'}));
    const sub=await ok('budget-codes',staff.token,input({action:'create',level:2,code:'N90.01',name:'Synthetic subcategory',parentId:cat.id,active:true,effectiveOn:'2026-03-01'}));
    const detail=await ok('budget-codes',staff.token,input({action:'create',level:3,code:'N90.01.001',name:'Synthetic detail',parentId:sub.id,active:true,effectiveOn:'2026-03-01'}));
    const codes=await ok('budget-codes',ra.token),codeVersionId=codes.find((c:{id:string})=>c.id===detail.id).version_id;
    async function fixture(values=['1000000','1000000']){
      const project=randomUUID(),workA=randomUUID(),workB=randomUUID();
      await owner.query("INSERT INTO projects(id,code,name,kind,business_year) VALUES($1,$2,'Synthetic project','research',2026)",[project,project]);
      for(const u of [ra,rb,pi])await owner.query('INSERT INTO project_memberships(id,project_id,user_id,starts_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP)',[randomUUID(),project,u.id]);
      for(const [work,user] of [[workA,ra.id],[workB,rb.id]])await owner.query("INSERT INTO work_items(id,project_id,title,description,assigned_to,created_by) VALUES($1,$2,'Synthetic work','',$3,$4)",[work,project,user,staff.id]);
      const lines=[];for(const value of values)lines.push((await ok('budgets',staff.token,input({projectId:project,codeVersionId,label:'Synthetic line',fund:'Synthetic fund',amount:value}))).id);
      return {project,workA,workB,lines};
    }
    type F=Awaited<ReturnType<typeof fixture>>;
    const balances=(f:F)=>ok('budgets?project='+f.project,staff.token);
    async function spend(f:F,token=ra.token,value='800000',workId=f.workA,lineId=f.lines[0]){return ok('budget-spend',token,input({projectId:f.project,action:'create',workId,lineId,amount:value}));}
    async function transition(f:F,id:string,action:string,token=ra.token,extra:Record<string,unknown>={}){
      const v=(await owner.query('SELECT version FROM spend_states WHERE case_id=$1',[id])).rows[0].version;
      return ok('budget-spend',token,input({projectId:f.project,id,action,version:v,...extra}));
    }
    async function change(f:F,token=ra.token,afters=['700000','1300000']){
      const b=await balances(f);return ok('budget-changes',token,input({projectId:f.project,action:'submit',file,lines:f.lines.map((id,i)=>({id,version:b.find((r:{id:string})=>r.id===id).version,after:afters[i]}))}));
    }
    async function changeAction(f:F,id:string,action:string,token=staff.token){const v=(await owner.query('SELECT version FROM budget_changes WHERE id=$1',[id])).rows[0].version;return ok('budget-changes',token,input({projectId:f.project,id,action,version:v}));}
    await t.test('B-01: parallel 800k submissions against 1m accept exactly one, with atomic receipt and balance',async()=>{
      const f=await fixture(),a=await spend(f),b=await spend(f,rb.token,'800000',f.workB);
      const results=await Promise.all([call('budget-spend',ra.token,input({projectId:f.project,id:a.id,action:'submit',version:'0'})),call('budget-spend',rb.token,input({projectId:f.project,id:b.id,action:'submit',version:'0'}))]);
      assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
      assert.equal((await balances(f)).find((x:{id:string})=>x.id===f.lines[0]).available_amount,'200000');
      assert.equal((await owner.query("SELECT count(*)::int n FROM budget_events WHERE project_id=$1 AND action='spend.submit'",[f.project])).rows[0].n,1);
    });
    await t.test('B-02/B-03: multi-line confirmation, concurrent retry once, audit immutable',async()=>{
      const f=await fixture(),ch=await change(f);await changeAction(f,ch.id,'review');
      const cmd=input({projectId:f.project,id:ch.id,action:'confirm',version:'1'});
      const r=await Promise.all([call('budget-changes',staff.token,cmd),call('budget-changes',staff.token,cmd)]);assert.deepEqual(r.map(v=>v.status),[200,200]);assert.deepEqual(r[0].data,r[1].data);
      const rows=await balances(f);assert.equal(rows.find((x:{id:string})=>x.id===f.lines[0]).current_amount,'700000');assert.equal(rows.find((x:{id:string})=>x.id===f.lines[1]).current_amount,'1300000');
      assert.equal((await call('budget-changes',staff.token,{...cmd,reason:'different payload'})).status,409);
      await assert.rejects(pool.query('DELETE FROM budget_events WHERE entity_id=$1',[ch.id]),{code:'55000'});
      await assert.rejects(pool.query('UPDATE budget_change_lines SET after_amount=0 WHERE change_id=$1',[ch.id]),{code:'55000'});
      assert.equal((await call('budget-changes',staff.token,input({projectId:f.project,id:ch.id,action:'cancel',version:'2'}))).status,409);
    });
    await t.test('B-02/B-04: second-row version failure rolls back the first update, audit and receipt',async()=>{
      const f=await fixture(),ch=await change(f);await changeAction(f,ch.id,'review');
      const second=[...f.lines].sort()[1];await owner.query('UPDATE budget_accounts SET version=version+1 WHERE line_id=$1',[second]);
      const cmd=input({projectId:f.project,id:ch.id,action:'confirm',version:'1'});assert.equal((await call('budget-changes',staff.token,cmd)).status,409);
      assert.deepEqual((await balances(f)).map((r:{current_amount:string})=>r.current_amount),['1000000','1000000']);
      assert.equal((await owner.query('SELECT 1 FROM command_receipts WHERE request_id=$1',[cmd.requestId])).rowCount,0);
      assert.equal((await owner.query("SELECT 1 FROM budget_events WHERE entity_id=$1 AND action='budget.change.confirm'",[ch.id])).rowCount,0);
    });
    await t.test('B-04: reduction below active commitment blocked; intervening submission invalidates change',async()=>{
      const f=await fixture(),ch=await change(f),a=await spend(f);await transition(f,a.id,'submit');await changeAction(f,ch.id,'review');
      assert.equal((await call('budget-changes',staff.token,input({projectId:f.project,id:ch.id,action:'confirm',version:'1'}))).status,409);
      const rows=await balances(f);assert.equal((await call('budget-changes',ra.token,input({projectId:f.project,action:'submit',file,lines:rows.map((l:{id:string;version:string})=>({id:l.id,version:l.version,after:l.id===f.lines[0]?'700000':'1300000'}))}))).status,409);
    });
    await t.test('B-05/B-07: project, role and total-change boundaries; admin may confirm staff total change',async()=>{
      const f=await fixture(),other=await fixture();
      assert.equal((await call('budget-spend',ra.token,input({projectId:f.project,action:'create',workId:f.workA,lineId:other.lines[0],amount:'1'}))).status,403);
      assert.equal((await call('budgets',admin.token,input({projectId:f.project,codeVersionId,label:'Forbidden',fund:'Synthetic',amount:'1'}))).status,403);
      const data=input({projectId:f.project,action:'submit',file,lines:[{id:f.lines[0],version:'0',after:'1100000'}]});
      for(const u of [ra,admin,pi])assert.equal((await call('budget-changes',u.token,data)).status,403);
      assert.equal((await call('budget-changes',ra.token,input({projectId:f.project,action:'submit',file,lines:[{id:f.lines[0],version:'0',after:'700000'},{id:other.lines[0],version:'0',after:'1300000'}]}))).status,403);
      const ch=await ok('budget-changes',staff.token,data);await changeAction(f,ch.id,'review');await changeAction(f,ch.id,'confirm',admin.token);
      assert.equal((await balances(f)).find((r:{id:string})=>r.id===f.lines[0]).current_amount,'1100000');
      await owner.query('UPDATE project_memberships SET active=false WHERE project_id=$1 AND user_id=$2',[other.project,ra.id]);
      assert.equal((await call('budgets?project='+other.project,ra.token)).status,403);
    });
    await t.test('B-08: missing reason, amount, file, disguised extension and oversized file are rejected',async()=>{
      const f=await fixture(),base=input({projectId:f.project,action:'submit',file,lines:[{id:f.lines[0],version:'0',after:'700000'},{id:f.lines[1],version:'0',after:'1300000'}]});
      for(const bad of [{...base,reason:''},{...base,file:null},{...base,lines:[{id:f.lines[0],version:'0'}]},{...base,file:{...file,name:'attack.html'}},{...base,file:{name:'fake.pdf',content:Buffer.from('fake').toString('base64')}},{...base,file:{name:'too-large.pdf',content:Buffer.alloc(5242881).toString('base64')}}])assert.equal((await call('budget-changes',ra.token,bad)).status,400);
      assert.equal((await call('budget-changes',ra.token,base,'https://foreign.invalid')).status,403);
      assert.equal((await owner.query('SELECT 1 FROM budget_changes WHERE project_id=$1',[f.project])).rowCount,0);
    });
    await t.test('B-07/B-08: other researcher cannot list, detail or download; PI reads, revoked membership denied',async()=>{
      const f=await fixture(),ch=await change(f),d=await ok('budget-changes/'+ch.id+'?project='+f.project,ra.token);
      assert.equal((await ok('budget-changes?project='+f.project,rb.token)).length,0);
      assert.equal((await call('budget-changes/'+ch.id+'?project='+f.project,rb.token)).status,403);
      const fileId=d.files[0].id;assert.equal((await call('budget-files/'+fileId,rb.token)).status,403);
      const downloaded=await call('budget-files/'+fileId,pi.token);assert.equal(downloaded.status,200);assert.equal(downloaded.data.toString(),Buffer.from(file.content,'base64').toString());
      assert.equal(downloaded.headers.get('cache-control'),'no-store');assert.equal(downloaded.headers.get('x-content-type-options'),'nosniff');
      await owner.query('UPDATE project_memberships SET active=false WHERE project_id=$1 AND user_id=$2',[f.project,pi.id]);
      assert.equal((await call('budget-files/'+fileId,pi.token)).status,403);assert.equal((await call('budget-files/'+fileId,'')).status,401);
      assert.equal((await call('budget-spend',rb.token,input({projectId:f.project,action:'create',workId:f.workA,lineId:f.lines[0],amount:'1'}))).status,403);
    });
    await t.test('B-09: restore once, edit and resubmit uses current balance; original author and history survive',async()=>{
      const f=await fixture(),a=await spend(f);await transition(f,a.id,'submit');
      const cmd=input({projectId:f.project,id:a.id,action:'withdraw',version:'1'});await ok('budget-spend',ra.token,cmd);await ok('budget-spend',ra.token,cmd);
      await transition(f,a.id,'edit',ra.token,{amount:'900000'});
      const b=await spend(f,rb.token,'200000',f.workB);await transition(f,b.id,'submit',rb.token);
      assert.equal((await call('budget-spend',ra.token,input({projectId:f.project,id:a.id,action:'submit',version:'3'}))).status,409);
      assert.equal((await owner.query('SELECT state FROM spend_states WHERE case_id=$1',[a.id])).rows[0].state,'draft');
      await transition(f,b.id,'withdraw',rb.token);await transition(f,a.id,'submit');
      assert.equal((await balances(f)).find((r:{id:string})=>r.id===f.lines[0]).available_amount,'100000');
      assert.equal((await owner.query("SELECT count(*)::int n FROM budget_events WHERE entity_id=$1 AND action='spend.withdraw'",[a.id])).rows[0].n,1);
    });
    await t.test('B-10: processing start vs researcher withdrawal accepts one; explicit start blocks withdrawal',async()=>{
      const f=await fixture(),a=await spend(f);await transition(f,a.id,'submit');
      const result=await Promise.all([call('budget-spend',ra.token,input({projectId:f.project,id:a.id,action:'withdraw',version:'1'})),call('budget-spend',staff.token,input({projectId:f.project,id:a.id,action:'start',version:'1'}))]);
      assert.deepEqual(result.map(r=>r.status).sort(),[200,409]);
      const b=await spend(f,ra.token,'1');await transition(f,b.id,'submit');await transition(f,b.id,'start',staff.token);
      assert.equal((await call('budget-spend',ra.token,input({projectId:f.project,id:b.id,action:'withdraw',version:'2'}))).status,403);
      assert.ok((await owner.query('SELECT processing_by,processing_at FROM spend_states WHERE case_id=$1',[b.id])).rows[0].processing_at);
    });
    await t.test('W-05/B-11: supplement keeps deduction, edits blocked, approved cancel managers only, paid guard',async()=>{
      const f=await fixture(),a=await spend(f);await transition(f,a.id,'submit');await transition(f,a.id,'start',staff.token);await transition(f,a.id,'supplement',staff.token);
      assert.equal((await call('budget-spend',ra.token,input({projectId:f.project,id:a.id,action:'edit',version:'3',amount:'1'}))).status,409);
      await transition(f,a.id,'resubmit');await transition(f,a.id,'approve',staff.token);
      assert.equal((await balances(f)).find((r:{id:string})=>r.id===f.lines[0]).available_amount,'200000');
      assert.equal((await call('budget-spend',ra.token,input({projectId:f.project,id:a.id,action:'cancel',version:'5'}))).status,403);
      // Simulated future payment fixture: verifies guard only, not a payment-entry implementation.
      await owner.query('UPDATE spend_states SET paid_amount=1 WHERE case_id=$1',[a.id]);
      for(const u of [staff,admin])assert.equal((await call('budget-spend',u.token,input({projectId:f.project,id:a.id,action:'cancel',version:'5'}))).status,409);
      await owner.query('UPDATE spend_states SET paid_amount=0 WHERE case_id=$1',[a.id]);await transition(f,a.id,'cancel',admin.token);
      assert.equal((await balances(f)).find((r:{id:string})=>r.id===f.lines[0]).available_amount,'1000000');
    });
    await t.test('B-08: rejected resubmission keeps old attachment and links the new immutable submission',async()=>{
      const f=await fixture(),ch=await change(f);await changeAction(f,ch.id,'reject');
      const newer=await ok('budget-changes',ra.token,input({projectId:f.project,action:'submit',supersedes:ch.id,file:{...file,name:'revised.pdf'},lines:[{id:f.lines[0],version:'0',after:'800000'},{id:f.lines[1],version:'0',after:'1200000'}]}));
      assert.equal((await ok('budget-changes/'+newer.id+'?project='+f.project,ra.token)).item.supersedes,ch.id);
      assert.equal((await ok('budget-changes/'+ch.id+'?project='+f.project,ra.token)).files[0].filename,'synthetic.pdf');
      await assert.rejects(pool.query('DELETE FROM budget_files WHERE change_id=$1',[ch.id]),{code:'55000'});
    });
    await t.test('classification versions preserve codes, hierarchy and allocation snapshots; integer precision',async()=>{
      const f=await fixture(['9007199254740993']);assert.equal((await balances(f))[0].original_amount,'9007199254740993');
      await ok('budget-codes',admin.token,input({action:'update',id:detail.id,version:'0',parentId:sub.id,name:'Revised synthetic name',active:false,effectiveOn:'2026-03-01'}));
      assert.equal((await balances(f))[0].classification_snapshot[2].name,'Synthetic detail');
      assert.equal((await call('budgets',staff.token,input({projectId:f.project,codeVersionId,label:'inactive',fund:'Synthetic',amount:'1'}))).status,400);
      assert.equal((await call('budget-codes',staff.token,input({action:'create',level:3,code:'N90.01.002',name:'Bad parent',parentId:cat.id,active:true,effectiveOn:'2026-03-01'}))).status,400);
      assert.equal((await call('budget-codes',pi.token,input({action:'update',id:detail.id}))).status,403);
      assert.equal(await migrate(ownerUrl,schema),0);
    });
  }finally{
    await pool.end();if(created){
      for(const table of ['budget_events','spend_states','budget_files','budget_change_lines','budget_changes','budget_accounts','budget_code_versions','budget_codes','project_history','work_history','work_items','otp_credentials','oauth_flows','account_audit_events','auth_sessions','auth_identities','email_ownership_checks','login_accounts','audit_events','command_receipts','spend_cases','budget_lines','project_memberships','projects','users','people','migration_history'])await owner.query(`DROP TABLE IF EXISTS ${schema}.${table}`);
      await owner.query(`DROP FUNCTION ${schema}.protect_budget_snapshot()`);await owner.query(`DROP FUNCTION ${schema}.reject_foundation_rewrite()`);await owner.query(`DROP SCHEMA ${schema}`);
    }await owner.end();
  }
});
