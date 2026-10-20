import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { migrate } from '../scripts/migrate.mjs';
import { assertLocalDatabase,requiredUrl } from '../scripts/db-config.mjs';
import { runtimePool } from '../src/server/db.ts';
import { issueSession } from '../src/server/google.ts';
import { GET,POST } from '../src/app/api/erp/[...path]/route.ts';

test('phase 04 limited: drafts, private evidence and policy versions',async t=>{
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
    await owner.query(`CREATE SCHEMA ${schema}`);created=true;assert.equal(await migrate(ownerUrl,schema),5);
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
    const f=await fixture(),other=await fixture();
    const create=(extra:Record<string,unknown>={})=>input({action:'create',projectId:f.project,workId:f.workA,type:'office',dateKind:'planned',title:'Synthetic draft',...extra});
    const read=(id:string,token=ra.token)=>ok('expense-drafts/'+id,token);
    async function attach(id:string,extra:Record<string,unknown>={},token=ra.token){const d=await read(id,token);return ok('expense-files',token,input({action:'attach',id,version:d.item.version,file:{...file,label:'Synthetic proof'},...extra}));}
    let draft:any,firstFile:string,firstPolicy:any;
    await t.test('draft accepts incomplete data; duplicate create once and no budget deduction',async()=>{
      const cmd=create(),results=await Promise.all([call('expense-drafts',ra.token,cmd),call('expense-drafts',ra.token,cmd)]);
      assert.deepEqual(results.map(r=>r.status),[200,200]);assert.deepEqual(results[0].data,results[1].data);draft=results[0].data;
      const d=await read(draft.id);assert.equal(d.item.data.amount,null);assert.equal(d.item.budget_line_id,null);assert.equal(d.history.length,1);
      assert.equal((await owner.query('SELECT 1 FROM spend_cases')).rowCount,0);
      assert.equal((await owner.query('SELECT 1 FROM budget_accounts WHERE committed_amount<>0')).rowCount,0);
      assert.equal((await call('expense-drafts',ra.token,{...cmd,title:'changed retry'})).status,409);
    });
    await t.test('role, project and peer boundaries including CSRF and unknown actions',async()=>{
      assert.equal((await call('expense-drafts',pi.token,create())).status,403);
      assert.equal((await call('expense-drafts',rb.token,create())).status,403);
      assert.equal((await call('expense-drafts',ra.token,create({workId:other.workA}))).status,403);
      assert.equal((await call('expense-drafts',ra.token,create({lineId:other.lines[0]}))).status,403);
      assert.equal((await call('expense-drafts',ra.token,create(),'https://foreign.invalid')).status,403);
      assert.equal((await call('expense-drafts/'+draft.id,rb.token)).status,403);
      assert.equal((await ok('expense-drafts?q=Synthetic',rb.token)).length,0);
      assert.equal((await read(draft.id,pi.token)).item.id,draft.id);
      assert.equal((await call('expense-drafts','',create())).status,401);
      for(const action of ['submit','approve','start','resubmit','cancel']) {
        assert.equal((await call('expense-drafts',staff.token,input({action,id:draft.id}))).status,409);
        assert.equal((await call('budget-spend',admin.token,input({action,id:draft.id,projectId:f.project,version:'0'}))).data.error.code,'PHASE_NOT_ENABLED');
      }
      assert.equal((await call('budget-spend','',create())).status,401);
    });
    await t.test('optimistic concurrency, exact won, invalid values and immutable audit',async()=>{
      const base=create({action:'edit',id:draft.id,version:'0',amount:'9007199254740993',lineId:f.lines[0]});
      const r=await Promise.all([call('expense-drafts',ra.token,base),call('expense-drafts',staff.token,{...base,requestId:randomUUID()})]);
      assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);
      assert.equal((await read(draft.id)).item.data.amount,'9007199254740993');
      for(const extra of [{amount:'1.1'},{amount:'-1'},{amount:1},{useDate:'2026-02-30'},{type:'unapproved-type'}])assert.equal((await call('expense-drafts',ra.token,create(extra))).status,400);
      const bad=create({action:'edit',id:draft.id,version:'0'});assert.equal((await call('expense-drafts',ra.token,bad)).status,409);
      assert.equal((await owner.query('SELECT 1 FROM command_receipts WHERE request_id=$1',[bad.requestId])).rowCount,0);
      await assert.rejects(pool.query('DELETE FROM expense_draft_versions WHERE draft_id=$1',[draft.id]),{code:'55000'});
    });
    await t.test('private upload/download; rejected types; server check; append-only replacement',async()=>{
      const d=await read(draft.id),cmd=input({action:'attach',id:draft.id,version:d.item.version,file:{...file,label:'Evidence'}});
      const both=await Promise.all([call('expense-files',ra.token,cmd),call('expense-files',ra.token,cmd)]);assert.deepEqual(both.map(r=>r.status),[200,200]);assert.deepEqual(both[0].data,both[1].data);firstFile=both[0].data.fileId;
      const d2=await read(draft.id),old=d2.files[0];
      await attach(draft.id,{slotId:old.slot_id,file:{name:'replacement.pdf',label:'Evidence',content:Buffer.from('%PDF-1.7\nnew version').toString('base64')}});
      assert.equal((await read(draft.id)).files.length,2);
      const download=await call('expense-files/'+firstFile,pi.token);assert.equal(download.status,200);assert.equal(download.data.toString(),Buffer.from(file.content,'base64').toString());
      assert.equal(download.headers.get('cache-control'),'no-store');assert.equal(download.headers.get('x-content-type-options'),'nosniff');assert.match(download.headers.get('content-disposition')??'',/^attachment/);
      assert.equal((await call('expense-files/'+firstFile,rb.token)).status,403);assert.equal((await call('expense-files/'+firstFile,'')).status,401);
      assert.equal((await call('expense-files',pi.token,{...cmd,requestId:randomUUID()})).status,403);
      for(const fileBad of [{...file,name:'archive.zip'},{...file,name:'../bad.pdf'},{name:'fake.pdf',content:Buffer.from('text').toString('base64')},{name:'fake.docx',content:Buffer.from('PK\x03\x04bad zip').toString('base64')},{name:'large.pdf',content:Buffer.alloc(5242881).toString('base64')}]) {
        const current=await read(draft.id);assert.equal((await call('expense-files',ra.token,input({action:'attach',id:draft.id,version:current.item.version,file:{...fileBad,label:'bad'}}))).status,400);
      }
      await assert.rejects(pool.query('DELETE FROM expense_files WHERE id=$1',[firstFile]),{code:'55000'});
    });
    await t.test('10 files, total 20MiB, boundary size and replacement enforce atomic limits',async()=>{
      const d=await ok('expense-drafts',ra.token,create());
      for(let n=0;n<10;n++)await attach(d.id);
      const current=await read(d.id),cmd=input({action:'attach',id:d.id,version:current.item.version,file:{...file,label:'eleventh'}});
      assert.equal((await call('expense-files',ra.token,cmd)).status,400);
      assert.equal((await read(d.id)).files.length,10);assert.equal((await owner.query('SELECT 1 FROM command_receipts WHERE request_id=$1',[cmd.requestId])).rowCount,0);
      await attach(d.id,{slotId:current.files[0].slot_id});assert.equal((await read(d.id)).files.length,11);
      const large=Buffer.alloc(5242880,32);large.write('%PDF-1.7');const full={name:'boundary.pdf',label:'boundary',content:large.toString('base64')};
      const d2=await ok('expense-drafts',ra.token,create());for(let n=0;n<4;n++)await attach(d2.id,{file:full});
      const v=await read(d2.id);assert.equal((await call('expense-files',ra.token,input({action:'attach',id:d2.id,version:v.item.version,file:{...file,label:'overflow'}}))).status,400);
      assert.equal((await read(d2.id)).files.length,4);
    });
    await t.test('concurrent attachments conflict rather than exceeding limits',async()=>{
      const d=await ok('expense-drafts',ra.token,create());for(let n=0;n<9;n++)await attach(d.id);
      const v=await read(d.id),base={action:'attach',id:d.id,version:v.item.version,file:{...file,label:'last'}};
      const results=await Promise.all([call('expense-files',ra.token,input(base)),call('expense-files',staff.token,input(base))]);
      assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await read(d.id)).files.length,10);
    });
    await t.test('policy pending vs verified; manager roles; version conflict and source requirements',async()=>{
      const base=input({action:'policy',type:'office',subtype:'synthetic',version:'',status:'pending'});
      assert.equal((await call('expense-policies',ra.token,base)).status,403);assert.equal((await call('expense-policies',pi.token,base)).status,403);
      const pending=await ok('expense-policies',staff.token,base);assert.equal((await ok('expense-policies',ra.token)).length,0);
      assert.equal((await ok('expense-policies',pi.token)).length,1);
      assert.equal((await call('expense-policies',staff.token,input({...base,requestId:randomUUID(),version:'0',status:'verified'}))).status,400);
      const verified=input({action:'policy',type:'office',subtype:'synthetic',version:'0',status:'verified',unit:'item',rate:'9007199254740993',caseLimit:'9007199254740994',source:'Synthetic rules',sourceVersion:'v1',clause:'synthetic section',startsOn:'2026-03-01'});
      const results=await Promise.all([call('expense-policies',staff.token,verified),call('expense-policies',admin.token,{...verified,requestId:randomUUID()})]);
      assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);firstPolicy=results.find(r=>r.status===200)!.data;
      const list=await ok('expense-policies',ra.token);assert.equal(list[0].data.rate,'9007199254740993');assert.equal(list[0].actor_id,undefined);
      assert.equal((await call('expense-policy-history?type=office&subtype=synthetic',ra.token)).status,403);
      assert.equal((await ok('expense-policy-history?type=office&subtype=synthetic',pi.token)).length,2);
      await assert.rejects(pool.query('UPDATE expense_policy_versions SET data=\'{}\' WHERE id=$1',[pending.id]),{code:'55000'});
    });
    await t.test('draft references immutable policy version; new settings never activate submission',async()=>{
      const d=await ok('expense-drafts',ra.token,create({policyVersionId:firstPolicy.id}));
      await ok('expense-policies',admin.token,input({action:'policy',type:'office',subtype:'synthetic',version:'1',status:'pending'}));
      assert.equal((await read(d.id)).item.policy_version_id,firstPolicy.id);
      assert.equal((await ok('expense-policies',ra.token)).length,0);
      assert.equal((await call('expense-drafts',ra.token,create({type:'meeting',policyVersionId:firstPolicy.id}))).status,400);
      for(const action of ['create','edit','submit','approve','resubmit','start','supplement','withdraw','reject','cancel'])assert.equal((await call('budget-spend',staff.token,input({action,projectId:f.project,id:d.id}))).data.error.code,'PHASE_NOT_ENABLED');
      assert.equal((await owner.query('SELECT 1 FROM budget_accounts WHERE committed_amount<>0')).rowCount,0);
    });
    await t.test('reassignment gives successor old revisions/files; previous assignee and revoked member denied',async()=>{
      await ok('work',staff.token,input({action:'update',id:f.workA,version:'0',title:'Synthetic reassigned work',description:'',assignedTo:rb.id}));
      assert.equal((await call('expense-drafts/'+draft.id,ra.token)).status,403);assert.equal((await call('expense-files/'+firstFile,ra.token)).status,403);
      const successor=await read(draft.id,rb.token);assert.equal(successor.item.applicant_id,ra.id);assert.ok(successor.history.some((v:any)=>v.actor_id===ra.id));
      assert.equal((await call('expense-files/'+firstFile,rb.token)).status,200);
      await ok('expense-drafts',rb.token,input({action:'edit',id:draft.id,version:successor.item.version,...successor.item.data,title:'Successor draft'}));
      assert.equal((await read(draft.id,rb.token)).item.applicant_id,ra.id);
      await owner.query('UPDATE project_memberships SET active=false WHERE project_id=$1 AND user_id=$2',[f.project,rb.id]);
      assert.equal((await call('expense-drafts/'+draft.id,rb.token)).status,403);assert.equal((await call('expense-files/'+firstFile,rb.token)).status,403);
      assert.equal((await ok('expense-drafts',rb.token)).length,0);
    });
    assert.equal(await migrate(ownerUrl,schema),0);
  } finally {
    await pool.end();
    if(created) {
      for(const table of ['expense_files','expense_draft_versions','expense_policy_versions','expense_drafts','budget_events','spend_states','budget_files','budget_change_lines','budget_changes','budget_accounts','budget_code_versions','budget_codes','project_history','work_history','work_items','otp_credentials','oauth_flows','account_audit_events','auth_sessions','auth_identities','email_ownership_checks','login_accounts','audit_events','command_receipts','spend_cases','budget_lines','project_memberships','projects','users','people','migration_history'])await owner.query(`DROP TABLE IF EXISTS ${schema}.${table}`);
      await owner.query(`DROP FUNCTION ${schema}.protect_expense_draft()`);await owner.query(`DROP FUNCTION ${schema}.protect_budget_snapshot()`);await owner.query(`DROP FUNCTION ${schema}.reject_foundation_rewrite()`);await owner.query(`DROP SCHEMA ${schema}`);
    }
    await owner.end();
  }
});
