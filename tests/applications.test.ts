import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client,Pool} from 'pg';
import {migrate} from '../scripts/migrate.mjs';
import {assertLocalDatabase,requiredUrl} from '../scripts/db-config.mjs';
import {issueSession} from '../src/server/google.ts';
import {applicationData,validateApplication,detailFields,requiredDocuments} from '../src/lib/application.ts';
import {applicationList,applicationDetail,manageApplication} from '../src/server/applications.ts';
import {attachDraftFile,saveDraft} from '../src/server/expenses.ts';

const policy={status:'verified',source:'Synthetic policy',sourceVersion:'1',clause:'synthetic',startsOn:'2026-03-01',endsOn:'2026-12-31',
  rateMode:'apply',rate:'100',calculationUnit:'per_item',caseLimitMode:'apply',caseLimit:'1000',periodLimitMode:'apply',periodLimit:'1000',periodBasis:'calendar_month',
  deadlineMode:'apply',deadlineDays:'0',deadlineEvent:'before_use',calendar:'calendar',personnelScope:'',holidayDates:[]};
const base={type:'office',title:'Synthetic application',purpose:'Synthetic purpose',calculation:'2 x 100',dateKind:'planned',useDate:'2026-11-20',amount:'200',
  details:{item:'Synthetic item',location:'Synthetic location',quantity:'2',days:'1',people:'1',hours:'1',unitPrice:'100'},documents:{}};

test('application rules: pending/missing/over-limit/personnel scope block; exact counts and business calendar',()=>{
  const data=applicationData(base);validateApplication(data,policy,'2026-11-06');
  for(const bad of [{...policy,rateMode:'pending'},{...policy,caseLimit:'199'},{...policy,rate:'99'},
    {...policy,deadlineDays:'15'},{...policy,startsOn:'2026-11-07'},{...policy,deadlineEvent:'unknown'},
    {...policy,personnelScope:'',status:'pending'}])assert.throws(()=>validateApplication(data,bad,'2026-11-06'));
  assert.throws(()=>validateApplication(applicationData({...base,amount:'201'}),policy,'2026-11-06'),{code:'INVALID_INPUT'});
  validateApplication(applicationData({...base,items:[{label:'Synthetic a',quantity:'1',unitPrice:'100'},{label:'Synthetic b',quantity:'2',unitPrice:'50'}]}),policy,'2026-11-06');
  assert.throws(()=>validateApplication(applicationData({...base,items:[{label:'Synthetic a',quantity:'3',unitPrice:'100'}]}),policy,'2026-11-06'),{code:'INVALID_INPUT'});
  assert.throws(()=>applicationData({...base,details:{...base.details,quantity:'9007199254740993.5'}}),{code:'INVALID_INPUT'});
  assert.throws(()=>validateApplication(data,policy,'2026-11-06',true),{code:'INVALID_INPUT'});
  const holidayData=applicationData({...base,useDate:'2026-11-09'});
  validateApplication(holidayData,{...policy,calendar:'business',deadlineDays:'1'},'2026-11-06');
  assert.throws(()=>validateApplication(holidayData,{...policy,calendar:'business',deadlineDays:'1',holidayDates:['2026-11-09']},'2026-11-06'),{code:'CONFLICT'});
  for(const type of Object.keys(detailFields) as (keyof typeof detailFields)[]){
    const details:Record<string,string>={quantity:'2',days:'1',people:'1',hours:'1',unitPrice:'100'};
    for(const [key] of detailFields[type])details[key]=['periodStart','periodEnd'].includes(key)?'2026-11-20':'Synthetic';
    const id=randomUUID(),documents={[id]:[...new Set([...requiredDocuments[type].submit,...requiredDocuments[type].approve])]};
    const d=applicationData({...base,type,details,documents});
    if(type==='personnel')assert.throws(()=>validateApplication(d,policy,'2026-11-06'),{code:'CONFLICT'});
    validateApplication(d,{...policy,personnelScope:'Synthetic confirmed scope'},'2026-11-06',true);
  }
});

test('applications DB: frozen submissions, evidence, money transitions, rights and concurrent limits',
 {skip:!process.env.TEST_DATABASE_URL||!process.env.TEST_MIGRATION_DATABASE_URL},async t=>{
  const ownerUrl=assertLocalDatabase(requiredUrl('TEST_MIGRATION_DATABASE_URL'),'boot_erp_test','owner');
  const appUrl=assertLocalDatabase(requiredUrl('TEST_DATABASE_URL'),'boot_erp_test','app');
  const schema=`foundation_test_${randomUUID().replaceAll('-','')}`,owner=new Client({connectionString:ownerUrl});
  const url=new URL(appUrl);url.searchParams.set('options',`-c search_path=${schema},public`);const pool=new Pool({connectionString:url.toString(),max:5});
  let created=false;await owner.connect();
  try{
    assert.ok((await owner.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date::text today")).rows[0].today<'2026-11-20','Synthetic date fixture must remain in its test window');
    await owner.query(`CREATE SCHEMA ${schema}`);created=true;assert.ok(await migrate(ownerUrl,schema)>=6);
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO boot_erp_test_app`);await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO boot_erp_test_app`);
    await owner.query(`REVOKE ALL ON ${schema}.migration_history FROM boot_erp_test_app`);await owner.query(`SET search_path TO ${schema},public`);
    async function user(role:string){const id=randomUUID(),email=`${id}@example.invalid`;
      await owner.query('INSERT INTO users(id,role,active) VALUES($1,$2,true)',[id,role]);await owner.query('INSERT INTO login_accounts(user_id,email,binding_allowed) VALUES($1,$2,true)',[id,email]);
      await owner.query("INSERT INTO email_ownership_checks(id,user_id,email,outcome,method,checked_by,checked_at) VALUES($1,$2,$3,'verified','synthetic',$2,clock_timestamp())",[randomUUID(),id,email]);
      return{id,token:await issueSession(pool,{provider:'google',issuer:'https://accounts.google.com',subject:id,email})};}
    const staff=await user('staff'),admin=await user('admin'),ra=await user('researcher'),rb=await user('researcher'),pi=await user('principal_investigator');
    const category=randomUUID(),code=randomUUID();await owner.query("INSERT INTO budget_codes(id,code,level) VALUES($1,'N92',1)",[category]);
    await owner.query("INSERT INTO budget_code_versions(id,code_id,version,name,active,effective_on,actor_id,reason) VALUES($1,$2,0,'Synthetic',true,'2026-03-01',$3,'synthetic')",[code,category,staff.id]);
    const policyId=randomUUID();await owner.query(`INSERT INTO expense_policy_versions(id,type_key,subtype,version,data,actor_id,reason)
      VALUES($1,'office','',0,$2,$3,'synthetic')`,[policyId,JSON.stringify(policy),staff.id]);
    async function fixture(){const projectId=randomUUID(),workA=randomUUID(),workB=randomUUID(),lineId=randomUUID();
      await owner.query("INSERT INTO projects(id,code,name,kind,business_year) VALUES($1,$2,'Synthetic','research',2026)",[projectId,projectId]);
      for(const u of [ra,rb,pi])await owner.query('INSERT INTO project_memberships(id,project_id,user_id,starts_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP)',[randomUUID(),projectId,u.id]);
      for(const [id,assigned]of [[workA,ra.id],[workB,rb.id]])await owner.query("INSERT INTO work_items(id,project_id,title,description,assigned_to,created_by) VALUES($1,$2,'Synthetic work','',$3,$4)",[id,projectId,assigned,staff.id]);
      await owner.query("INSERT INTO budget_lines(id,project_id,internal_label,original_amount) VALUES($1,$2,'Synthetic',1000)",[lineId,projectId]);
      await owner.query(`INSERT INTO budget_accounts(line_id,code_version_id,classification_snapshot,business_name,business_year,academic_year,period_start,period_end,fund,current_amount)
        VALUES($1,$2,'[]','Synthetic',1,2026,'2026-03-01','2026-12-31','Synthetic',1000)`,[lineId,code]);return{projectId,workA,workB,lineId};}
    const f=await fixture();
    const command=(input:Record<string,unknown>)=>({requestId:randomUUID(),reason:'Synthetic application verification',...input});
    async function create(extra:Record<string,unknown>={},token=ra.token,fixture=f){return await manageApplication(pool,token,command({...base,action:'save',projectId:fixture.projectId,workId:fixture.workA,lineId:fixture.lineId,policyVersionId:policyId,...extra})) as {draftId:string};}
    async function act(id:string,action:string,token=ra.token,extra:Record<string,unknown>={}){const d=await applicationDetail(pool,token,id);
      return await manageApplication(pool,token,command({draftId:id,action,version:d.item.version,draftVersion:d.item.draftVersion,...extra})) as Row;}
    type Row=Record<string,any>;
    const balance=async(fixture=f)=>(await owner.query('SELECT committed_amount FROM budget_accounts WHERE line_id=$1',[fixture.lineId])).rows[0].committed_amount;
    const draft=await create();
    await t.test('draft is uncommitted; unknown policy/personnel scope never enable submission',async()=>{
      assert.equal(await balance(),'0');
      const noPolicy=await create({policyVersionId:null});await assert.rejects(act(noPolicy.draftId,'submit'),{code:'INVALID_INPUT'});
      const pendingId=randomUUID();await owner.query(`INSERT INTO expense_policy_versions(id,type_key,subtype,version,data,actor_id,reason)
        VALUES($1,'office','pending',0,$2,$3,'synthetic')`,[pendingId,JSON.stringify({...policy,status:'pending'}),staff.id]);
      const pending=await create({policyVersionId:pendingId});await assert.rejects(act(pending.draftId,'submit'),{code:'CONFLICT'});
      assert.equal(await balance(),'0');
    });
    await t.test('a valid primary use date cannot hide detail periods outside the budget period',async()=>{
      const periodFixture=await fixture(),softwarePolicyId=randomUUID();
      await owner.query(`INSERT INTO expense_policy_versions(id,type_key,subtype,version,data,actor_id,reason)
        VALUES($1,'software','',0,$2,$3,'synthetic')`,[softwarePolicyId,JSON.stringify(policy),staff.id]);
      for(const [periodStart,periodEnd]of [['2026-02-28','2026-11-20'],['2026-11-20','2027-01-01']]){
        const details={...base.details,product:'Synthetic software',purchaseKind:'subscription',periodStart,periodEnd};
        const input={...base,type:'software',details,policyVersionId:softwarePolicyId};
        const created=await create(input,ra.token,periodFixture),d=await applicationDetail(pool,ra.token,created.draftId);
        const file=await attachDraftFile(pool,ra.token,command({action:'attach',id:created.draftId,version:d.item.draftVersion,
          file:{name:'synthetic.pdf',label:'Synthetic quote',content:Buffer.from('%PDF-1.7\nsynthetic\n%%EOF').toString('base64')}})) as Row;
        await act(created.draftId,'save',ra.token,{...input,lineId:periodFixture.lineId,documents:{[file.fileId]:['quotation']}});
        const saved=await applicationDetail(pool,ra.token,created.draftId);
        assert.equal((saved.data as Row).details.periodStart,periodStart);
        assert.equal((saved.data as Row).details.periodEnd,periodEnd);
        await assert.rejects(act(created.draftId,'submit'),{code:'CONFLICT'});
        assert.equal(await balance(periodFixture),'0');
        assert.equal((await owner.query('SELECT count(*)::int n FROM spend_cases WHERE project_id=$1',[periodFixture.projectId])).rows[0].n,0);
      }
    });
    await t.test('calendar dates keep the final allowed day and the submission-day policy at approval',async()=>{
      const boundary=await fixture(),boundaryPolicyId=randomUUID(),today=(await owner.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date::text today")).rows[0].today;
      await owner.query(`INSERT INTO expense_policy_versions(id,type_key,subtype,version,data,actor_id,reason)
        VALUES($1,'software','date-boundary',0,$2,$3,'synthetic')`,[boundaryPolicyId,JSON.stringify({...policy,startsOn:today}),staff.id]);
      const details={...base.details,product:'Synthetic boundary software',purchaseKind:'subscription',periodStart:'2026-03-01',periodEnd:'2026-12-31'};
      const input={...base,type:'software',useDate:'2026-12-31',details,policyVersionId:boundaryPolicyId};
      const created=await create(input,ra.token,boundary),d=await applicationDetail(pool,ra.token,created.draftId);
      const file=await attachDraftFile(pool,ra.token,command({action:'attach',id:created.draftId,version:d.item.draftVersion,
        file:{name:'synthetic.pdf',label:'Synthetic boundary proof',content:Buffer.from('%PDF-1.7\nsynthetic\n%%EOF').toString('base64')}})) as Row;
      await act(created.draftId,'save',ra.token,{...input,lineId:boundary.lineId,documents:{[file.fileId]:['quotation','transaction','licence']}});
      await act(created.draftId,'submit');assert.equal(await balance(boundary),'200');
      const submitted=await applicationDetail(pool,ra.token,created.draftId);assert.equal(submitted.submissions[0].applicable_on,today);
      await act(created.draftId,'start',staff.token);await act(created.draftId,'approve',staff.token);
      assert.equal((await applicationDetail(pool,ra.token,created.draftId)).item.state,'approved');
      assert.equal(await balance(boundary),'200');
    });
    await t.test('submit atomically commits once and preserves policy/data snapshot; peers/PI cannot change',async()=>{
      const d=await applicationDetail(pool,ra.token,draft.draftId),cmd=command({draftId:draft.draftId,action:'submit',draftVersion:d.item.draftVersion,version:d.item.version});
      const results=await Promise.all([manageApplication(pool,ra.token,cmd),manageApplication(pool,ra.token,cmd)]);assert.deepEqual(results[0],results[1]);assert.equal(await balance(),'200');
      const frozen=await applicationDetail(pool,ra.token,draft.draftId);assert.equal(frozen.submissions.length,1);assert.equal(frozen.submissions[0].policy_snapshot.rate,'100');
      await assert.rejects(applicationDetail(pool,rb.token,draft.draftId),{code:'FORBIDDEN'});
      assert.ok((await applicationList(pool,pi.token)).some(v=>v.draftId===draft.draftId));
      await assert.rejects(act(draft.draftId,'start',pi.token),{code:'FORBIDDEN'});
      await assert.rejects(saveDraft(pool,ra.token,command({action:'edit',id:draft.draftId,version:frozen.item.draftVersion,...base})),{code:'CONFLICT'});
      await assert.rejects(owner.query('UPDATE expense_submission_versions SET version=99 WHERE application_id=$1',[frozen.item.id]),{code:'55000'});
    });
    await t.test('approval requires documents; same-amount supplement retains commit and resolves per-document note',async()=>{
      await act(draft.draftId,'start',staff.token);await assert.rejects(act(draft.draftId,'approve',staff.token),{code:'INVALID_INPUT'});
      await act(draft.draftId,'review-note',staff.token,{documentKind:'transaction',outcome:'missing',note:'Synthetic missing proof'});
      await act(draft.draftId,'supplement',staff.token);assert.equal(await balance(),'200');
      await assert.rejects(act(draft.draftId,'withdraw'),{code:'FORBIDDEN'});
      await assert.rejects(act(draft.draftId,'save',ra.token,{...base,amount:'300',lineId:f.lineId,policyVersionId:policyId}),{code:'CONFLICT'});
      const d=await applicationDetail(pool,ra.token,draft.draftId);
      const file=await attachDraftFile(pool,ra.token,command({action:'attach',id:draft.draftId,version:d.item.draftVersion,file:{name:'synthetic.pdf',label:'Synthetic proof',content:Buffer.from('%PDF-1.7\nsynthetic\n%%EOF').toString('base64')}})) as Row;
      await act(draft.draftId,'save',ra.token,{...base,lineId:f.lineId,policyVersionId:policyId,documents:{[file.fileId]:['transaction','completion']}});
      await act(draft.draftId,'resubmit');assert.equal(await balance(),'200');
      await assert.rejects(act(draft.draftId,'approve',staff.token),{code:'CONFLICT'});
      await act(draft.draftId,'review-note',staff.token,{documentKind:'transaction',outcome:'accepted',note:'Synthetic proof checked'});
      await act(draft.draftId,'approve',staff.token);assert.equal(await balance(),'200');
      const frozen=await applicationDetail(pool,pi.token,draft.draftId);assert.equal(frozen.submissions.length,2);assert.equal(frozen.submissions[1].files_snapshot.length,1);
      assert.equal(frozen.submissions[0].policy_version_id,frozen.submissions[1].policy_version_id);
    });
    await t.test('cancel restores once; amount change requires draft and resubmission validates current capacity',async()=>{
      await act(draft.draftId,'cancel',admin.token);assert.equal(await balance(),'0');await assert.rejects(act(draft.draftId,'cancel',admin.token),{code:'CONFLICT'});
      await act(draft.draftId,'save',ra.token,{...base,amount:'300',details:{...base.details,quantity:'3'},lineId:f.lineId,policyVersionId:policyId});
      await act(draft.draftId,'submit');assert.equal(await balance(),'300');
      await act(draft.draftId,'withdraw');assert.equal(await balance(),'0');
    });
    await t.test('parallel submissions obey budget and per-period cap; rollback leaves no partial case/snapshot',async()=>{
      const race=await fixture(),a=await create({amount:'800',details:{...base.details,quantity:'8'}},ra.token,race),
        b=await create({amount:'800',details:{...base.details,quantity:'8'},workId:race.workB},rb.token,race);
      const r=await Promise.allSettled([act(a.draftId,'submit'),act(b.draftId,'submit',rb.token)]);
      assert.equal(r.filter(v=>v.status==='fulfilled').length,1);assert.equal(r.filter(v=>v.status==='rejected').length,1);assert.equal(await balance(race),'800');
      assert.equal((await owner.query('SELECT count(*)::int n FROM spend_cases WHERE project_id=$1',[race.projectId])).rows[0].n,1);
    });
    await t.test('reassignment inherits full frozen versions and revoked membership removes access',async()=>{
      await owner.query('UPDATE work_items SET assigned_to=$2,version=version+1 WHERE id=$1',[f.workA,rb.id]);
      await assert.rejects(applicationDetail(pool,ra.token,draft.draftId),{code:'FORBIDDEN'});
      const inherited=await applicationDetail(pool,rb.token,draft.draftId);assert.ok(inherited.submissions.length>=3);assert.ok(inherited.notes.length>=2);
      await owner.query('UPDATE project_memberships SET active=false WHERE project_id=$1 AND user_id=$2',[f.projectId,rb.id]);
      await assert.rejects(applicationDetail(pool,rb.token,draft.draftId),{code:'FORBIDDEN'});
    });
  }finally{await pool.end();if(created&&/^foundation_test_[0-9a-f]{32}$/.test(schema))await owner.query(`DROP SCHEMA ${schema} CASCADE`);await owner.end();}
});
