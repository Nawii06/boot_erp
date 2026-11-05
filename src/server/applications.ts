import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { AppError } from '../lib/errors.ts';
import { uuid,textInput } from '../lib/validation.ts';
import { jsonValue,won } from '../lib/money.ts';
import { applicationData,validateApplication,type ApplicationData,documentLabels } from '../lib/application.ts';
import { transaction } from './transaction.ts';
import { authenticate,manager,hash,type Actor } from './security.ts';

type Input=Record<string,unknown>;
type Row=Record<string,any>;
const managed=(a:Actor)=>a.role==='staff'||a.role==='admin';
function fail(code:AppError['code']='CONFLICT'):never{throw new AppError(code);}
const membership=`EXISTS(SELECT 1 FROM project_memberships m WHERE m.project_id=d.project_id AND m.user_id=$1
 AND m.active AND m.starts_at<=CURRENT_TIMESTAMP AND (m.ends_at IS NULL OR m.ends_at>CURRENT_TIMESTAMP))`;
const scope=`($2 IN ('staff','admin') OR (${membership} AND ($2='principal_investigator' OR w.assigned_to=$1)))`;
const visible=`SELECT d.*,w.assigned_to,w.title AS work_title,p.name AS project_name,v.data,v.budget_line_id,v.policy_version_id,
 a.id AS application_id,s.state,s.version AS state_version,s.amount AS submitted_amount,s.paid_amount,s.processing_by
 FROM expense_drafts d JOIN work_items w ON w.id=d.work_id AND w.project_id=d.project_id
 JOIN projects p ON p.id=d.project_id JOIN expense_draft_versions v ON v.draft_id=d.id AND v.version=d.version
 LEFT JOIN expense_applications a ON a.draft_id=d.id LEFT JOIN spend_states s ON s.case_id=a.id`;
async function access(c:PoolClient,a:Actor,id:string):Promise<Row>{
  const row=(await c.query(`${visible} WHERE d.id=$3 AND ${scope} FOR SHARE OF w`,[a.id,a.role,uuid(id)])).rows[0];
  if(!row)fail('FORBIDDEN');
  if(!managed(a)&&!(await c.query(`SELECT 1 FROM project_memberships WHERE project_id=$1 AND user_id=$2 AND active
    AND starts_at<=CURRENT_TIMESTAMP AND (ends_at IS NULL OR ends_at>CURRENT_TIMESTAMP) FOR SHARE`,[row.project_id,a.id])).rowCount)fail('FORBIDDEN');
  return row;
}
const summary=(r:Row)=>({id:r.application_id??null,draftId:r.id,projectId:r.project_id,projectName:r.project_name,
  workId:r.work_id,title:r.data.title??'',type:r.data.type,amount:r.data.amount??null,
  state:r.state??'draft',version:r.state_version??'0',draftVersion:r.version,createdAt:r.created_at});
async function latest(c:PoolClient,id:string):Promise<Row|undefined>{return (await c.query(
  'SELECT *,applicable_on::text AS applicable_on FROM expense_submission_versions WHERE application_id=$1 ORDER BY version DESC LIMIT 1',[id])).rows[0];}
async function files(c:PoolClient,id:string){return (await c.query(`SELECT DISTINCT ON(slot_id)
 id,slot_id,version,filename,label,sha256,octet_length(content) AS size FROM expense_files WHERE draft_id=$1 ORDER BY slot_id,version DESC`,[id])).rows;}
async function validDocuments(c:PoolClient,d:Row,data:ApplicationData){
  const current=await files(c,d.id),ids=new Set(current.map(f=>f.id));
  for(const id of Object.keys(data.documents))if(!ids.has(id))fail('INVALID_INPUT');
  return current.map(f=>({...f,documentKinds:data.documents[f.id]??[]}));
}

/** Call under the project budget advisory lock, before changing a draft/version or attachment. */
export async function guardApplicationDraftWrite(c:PoolClient,draftId:string,inputData?:unknown,line?:unknown,policy?:unknown):Promise<void>{
  const found=(await c.query(`SELECT a.id,s.state FROM expense_applications a JOIN spend_states s ON s.case_id=a.id WHERE a.draft_id=$1`,[draftId])).rows[0];
  if(!found)return;
  if(!['draft','supplement'].includes(found.state))fail();
  if(found.state==='supplement'&&inputData){
    const frozen=await latest(c,found.id);if(!frozen)fail();
    const next=inputData as Row,old=frozen.data as Row;
    if(next.amount!==old.amount||next.type!==old.type||line!==old.lineId||policy!==(old.referencePolicyVersionId??frozen.policy_version_id))fail();
    for(const key of ['quantity','days','people','hours','unitPrice'])if((next.details?.[key]??'')!==(old.details?.[key]??''))fail();
    if(JSON.stringify(next.items??[])!==JSON.stringify(old.items??[]))fail();
  }
}

export async function applicationList(pool:Pool,token:string,search=''){
  if(typeof search!=='string'||search.length>200)fail('INVALID_INPUT');
  return transaction(pool,async c=>{const a=await authenticate(c,token);
    return (await c.query(`${visible} WHERE ${scope} AND ($3='' OR position(lower($3) in lower(v.data->>'title'))>0)
      ORDER BY d.created_at DESC,d.id DESC LIMIT 1000`,[a.id,a.role,search])).rows.map(summary);});
}
export async function applicationDetail(pool:Pool,token:string,id:string){
  return transaction(pool,async c=>{const a=await authenticate(c,token),d=await access(c,a,id);
    const submissions=d.application_id?(await c.query('SELECT *,applicable_on::text AS applicable_on FROM expense_submission_versions WHERE application_id=$1 ORDER BY version',[d.application_id])).rows:[];
    const notes=d.application_id?(await c.query('SELECT * FROM expense_review_notes WHERE application_id=$1 ORDER BY created_at,id',[d.application_id])).rows:[];
    const history=d.application_id?(await c.query('SELECT action,reason,before_state,after_state,actor_id,created_at FROM budget_events WHERE entity_id=$1 ORDER BY created_at,id',[d.application_id])).rows:[];
    return {item:summary(d),data:d.data,lineId:d.budget_line_id,policyVersionId:d.policy_version_id,submissions,notes,history,
      files:await files(c,d.id),draftHistory:(await c.query('SELECT id,version,data,actor_id,reason,created_at FROM expense_draft_versions WHERE draft_id=$1 ORDER BY version',[d.id])).rows};});
}
async function audit(c:PoolClient,a:Actor,input:Input,d:Row,id:string,before:unknown,after:unknown){
  // Record after lock acquisition; transaction-start timestamps can reverse queued commands.
  await c.query(`INSERT INTO budget_events(id,project_id,entity_id,actor_id,request_id,action,reason,before_state,after_state,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())`,[randomUUID(),d.project_id,id,a.id,input.requestId,`application.${input.action}`,
    textInput(input.reason,1000),jsonValue(before),jsonValue(after)]);
}
async function checkPeriod(c:PoolClient,d:Row,data:ApplicationData,policy:Row,applicableOn:string){
  if(policy.periodLimitMode!=='apply')return;
  const total=(await c.query(`SELECT COALESCE(sum(s.amount),0)::text total FROM spend_states s JOIN spend_cases x ON x.id=s.case_id
    JOIN LATERAL(SELECT data,applicable_on FROM expense_submission_versions v WHERE v.application_id=s.case_id ORDER BY version DESC LIMIT 1) v ON true
    WHERE s.project_id=$1 AND s.state<>'draft' AND ($2::uuid IS NULL OR s.case_id<>$2)
      AND v.data->>'type'=$3 AND ($4='business_period' OR date_trunc('month',v.applicable_on)=date_trunc('month',$5::date))`,
    [d.project_id,d.application_id??null,data.type,policy.periodBasis,applicableOn])).rows[0].total;
  if(BigInt(total)+won(data.amount)>won(policy.periodLimit))fail();
}
async function snapshot(c:PoolClient,a:Actor,input:Input,d:Row,id:string,data:ApplicationData,policy:Row,applicableOn:string){
  const prior=await latest(c,id),fileRows=await validDocuments(c,d,data);
  const submissionId=randomUUID(),version=prior?(BigInt(prior.version)+1n).toString():'0';
  await c.query(`INSERT INTO expense_submission_versions(id,application_id,version,draft_version,policy_version_id,applicable_on,data,policy_snapshot,files_snapshot,actor_id,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[submissionId,id,version,d.version,policy.id,applicableOn,
    jsonValue({...data,lineId:d.budget_line_id,workId:d.work_id,referencePolicyVersionId:d.policy_version_id}),jsonValue(policy.data),jsonValue(fileRows),a.id,textInput(input.reason,1000)]);
  return submissionId;
}

export async function manageApplication(pool:Pool,token:string,input:Input){
  const action=textInput(input.action),requestId=uuid(input.requestId);textInput(input.reason,1000);
  const fingerprint=hash(jsonValue({namespace:'application',input}));
  return transaction(pool,async c=>{
    const a=await authenticate(c,token,true);if(a.role==='principal_investigator')fail('FORBIDDEN');
    let d:Row;
    if(action==='save'&&!input.draftId){
      const project=uuid(input.projectId),work=uuid(input.workId),w=(await c.query('SELECT * FROM work_items WHERE id=$1 AND project_id=$2 FOR SHARE',[work,project])).rows[0];
      if(!w)fail('FORBIDDEN');
      if(!managed(a)&&(w.assigned_to!==a.id||!(await c.query(`SELECT 1 FROM project_memberships WHERE project_id=$1 AND user_id=$2
        AND active AND starts_at<=CURRENT_TIMESTAMP AND (ends_at IS NULL OR ends_at>CURRENT_TIMESTAMP) FOR SHARE`,[project,a.id])).rowCount))fail('FORBIDDEN');
      d={id:randomUUID(),project_id:project,work_id:work,assigned_to:w.assigned_to,version:'0',application_id:null,state:null};
    } else d=await access(c,a,uuid(input.draftId));
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`budget:${d.project_id}`]);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${a.id}:${requestId}`]);
    const receipt=(await c.query('SELECT * FROM command_receipts WHERE actor_id=$1 AND request_id=$2',[a.id,requestId])).rows[0];
    if(receipt){if(receipt.fingerprint!==fingerprint)fail();return receipt.result;}
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`expense:${d.id}`]);
    if(input.draftId)d=await access(c,a,d.id);
    const finish=async(result:unknown)=>{await c.query('INSERT INTO command_receipts(actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4)',[a.id,requestId,fingerprint,jsonValue(result)]);return result;};
    if(action==='save'){
      const data=applicationData(input),line=input.lineId?uuid(input.lineId):null,policy=input.policyVersionId?uuid(input.policyVersionId):null;
      if(input.draftId&&input.draftVersion!==d.version)fail();
      await guardApplicationDraftWrite(c,d.id,data,line,policy);
      if(line&&!(await c.query('SELECT 1 FROM budget_lines l JOIN budget_accounts b ON b.line_id=l.id WHERE l.id=$1 AND l.project_id=$2',[line,d.project_id])).rowCount)fail('FORBIDDEN');
      if(policy&&!(await c.query('SELECT 1 FROM expense_policy_versions WHERE id=$1 AND type_key=$2',[policy,data.type])).rowCount)fail('INVALID_INPUT');
      const next=input.draftId?(BigInt(d.version)+1n).toString():'0';
      if(!input.draftId)await c.query('INSERT INTO expense_drafts(id,project_id,work_id,applicant_id) VALUES($1,$2,$3,$4)',[d.id,d.project_id,d.work_id,d.assigned_to??a.id]);
      await c.query(`INSERT INTO expense_draft_versions(id,draft_id,version,budget_line_id,policy_version_id,data,actor_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),d.id,next,line,policy,jsonValue(data),a.id,input.reason]);
      if(input.draftId)await c.query('UPDATE expense_drafts SET version=$2 WHERE id=$1',[d.id,next]);
      await audit(c,a,input,d,d.application_id??d.id,{draftVersion:d.version},{draftVersion:next});
      return finish({draftId:d.id,id:d.application_id??null,draftVersion:next});
    }
    let state:Row|undefined;
    if(d.application_id)state=(await c.query('SELECT * FROM spend_states WHERE case_id=$1 FOR UPDATE',[d.application_id])).rows[0];
    if(state&&input.version!==state.version)fail();
    if(input.draftVersion!==undefined&&input.draftVersion!==d.version)fail();
    const before=state?{...state}:{};
    const currentDate=(await c.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date::text today")).rows[0].today;
    if(action==='submit'||action==='resubmit'){
      if(action==='submit'&&state&&state.state!=='draft')fail();
      if(action==='resubmit'&&state?.state!=='supplement')fail();
      if(!d.budget_line_id||!d.policy_version_id||input.draftVersion!==d.version)fail('INVALID_INPUT');
      const data=applicationData(d.data);
      let selected:Row,applicableOn=currentDate;
      if(action==='resubmit'){
        const frozen=await latest(c,d.application_id);if(!frozen)fail();
        selected={id:frozen.policy_version_id,data:frozen.policy_snapshot};applicableOn=String(frozen.applicable_on);
      } else {
        const ref=(await c.query('SELECT * FROM expense_policy_versions WHERE id=$1 AND type_key=$2',[d.policy_version_id,data.type])).rows[0];if(!ref)fail();
        selected=(await c.query(`SELECT * FROM expense_policy_versions WHERE type_key=$1 AND subtype=$2
          AND data->>'startsOn'<=$3 AND (data->>'endsOn' IS NULL OR data->>'endsOn'>=$3) ORDER BY version DESC LIMIT 1`,[data.type,ref.subtype,currentDate])).rows[0];if(!selected)fail();
      }
      validateApplication(data,selected.data,applicableOn);
      await validDocuments(c,d,data);
      // PostgreSQL DATE is a calendar date, not a local-midnight instant to convert through UTC.
      const account=(await c.query('SELECT *,period_start::text AS period_start,period_end::text AS period_end FROM budget_accounts WHERE line_id=$1 FOR UPDATE',[d.budget_line_id])).rows[0];
      if(!account)fail();
      const periodStart=String(account.period_start),periodEnd=String(account.period_end);
      if([currentDate,data.useDate!,data.details.periodStart,data.details.periodEnd]
        .some(date=>date&&(date<periodStart||date>periodEnd)))fail();
      if(!d.application_id){
        d.application_id=randomUUID();
        await c.query('INSERT INTO spend_cases(id,project_id,applicant_id,budget_line_id) VALUES($1,$2,$3,$4)',[d.application_id,d.project_id,d.applicant_id,d.budget_line_id]);
        await c.query('INSERT INTO spend_states(case_id,project_id,work_id,amount) VALUES($1,$2,$3,$4)',[d.application_id,d.project_id,d.work_id,data.amount]);
        await c.query('INSERT INTO expense_applications(id,draft_id,created_by) VALUES($1,$2,$3)',[d.application_id,d.id,a.id]);
        state=(await c.query('SELECT * FROM spend_states WHERE case_id=$1 FOR UPDATE',[d.application_id])).rows[0];
      } else {
        const base=(await c.query('SELECT budget_line_id FROM spend_cases WHERE id=$1',[d.application_id])).rows[0];
        if(base.budget_line_id!==d.budget_line_id)fail();
      }
      await checkPeriod(c,d,data,selected.data,applicableOn);
      const delta=action==='submit'?won(data.amount):0n,newCommitted=BigInt(account.committed_amount)+delta;
      if(newCommitted>BigInt(account.current_amount))fail();
      if(delta)await c.query('UPDATE budget_accounts SET committed_amount=$2,version=version+1 WHERE line_id=$1',[d.budget_line_id,newCommitted.toString()]);
      const submissionId=await snapshot(c,a,input,d,d.application_id,data,selected,applicableOn);
      const next=action==='resubmit'?'reviewing':'submitted';
      const after=(await c.query('UPDATE spend_states SET state=$2,amount=$3,version=version+1 WHERE case_id=$1 RETURNING *',[d.application_id,next,data.amount])).rows[0];
      await audit(c,a,input,d,d.application_id,before,{...after,submissionId,delta:delta.toString()});
      return finish({id:d.application_id,draftId:d.id,version:after.version,submissionId});
    }
    if(!state||!d.application_id)fail();
    if(action==='review-note'){
      manager(a);if(!['reviewing','supplement'].includes(state.state))fail();
      const kind=textInput(input.documentKind,100);if(!Object.hasOwn(documentLabels,kind))fail('INVALID_INPUT');
      if(!['note','missing','accepted'].includes(String(input.outcome)))fail('INVALID_INPUT');
      const frozen=await latest(c,d.application_id);if(!frozen)fail();
      await c.query(`INSERT INTO expense_review_notes(id,application_id,submission_id,document_kind,outcome,note,actor_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp())`,[randomUUID(),d.application_id,frozen.id,kind,input.outcome,textInput(input.note,2000),a.id]);
      const after=(await c.query('UPDATE spend_states SET version=version+1 WHERE case_id=$1 RETURNING *',[d.application_id])).rows[0];
      await audit(c,a,input,d,d.application_id,before,{...after,documentKind:kind,outcome:input.outcome});
      return finish({id:d.application_id,draftId:d.id,version:after.version});
    }
    let next=state.state,delta=0n,processingBy=state.processing_by,processingAt=state.processing_at;
    if(action==='start'){manager(a);if(state.state!=='submitted'||processingBy)fail();next='reviewing';processingBy=a.id;processingAt=new Date();}
    else if(action==='supplement'){manager(a);if(state.state!=='reviewing')fail();next='supplement';}
    else if(action==='approve'){
      manager(a);if(state.state!=='reviewing')fail();
      const frozen=await latest(c,d.application_id);if(!frozen||String(frozen.draft_version)!==String(d.version))fail();
      const applicableOn=String(frozen.applicable_on);
      const frozenData=applicationData(frozen.data);validateApplication(frozenData,frozen.policy_snapshot,applicableOn,true);
      await checkPeriod(c,d,frozenData,frozen.policy_snapshot,applicableOn);
      const missing=(await c.query(`SELECT 1 FROM (SELECT DISTINCT ON(document_kind) outcome FROM expense_review_notes
        WHERE application_id=$1 ORDER BY document_kind,created_at DESC,id DESC) n WHERE outcome='missing'`,[d.application_id])).rowCount;
      if(missing)fail();next='approved';
    } else if(['withdraw','reject','cancel','revise'].includes(action)){
      if(state.state==='draft'||BigInt(state.paid_amount)>0n)fail();
      // Optional P5 table may not yet exist during the P3-only migration/test sequence.
      const paymentTable=(await c.query("SELECT to_regclass('payment_records') AS table_id")).rows[0].table_id;
      if(paymentTable&&(await c.query('SELECT 1 FROM payment_records WHERE case_id=$1 LIMIT 1',[d.application_id])).rowCount)fail();
      if(action==='withdraw'){if(state.state!=='submitted'||processingBy||(!managed(a)&&d.applicant_id!==a.id))fail('FORBIDDEN');}
      else{manager(a);if(action==='reject'&&state.state==='approved')fail();}
      next='draft';delta=-BigInt(state.amount);processingBy=null;processingAt=null;
    } else fail('INVALID_INPUT');
    if(delta){const account=(await c.query('SELECT * FROM budget_accounts WHERE line_id=$1 FOR UPDATE',[d.budget_line_id])).rows[0];
      const committed=BigInt(account.committed_amount)+delta;if(committed<0n)fail();
      await c.query('UPDATE budget_accounts SET committed_amount=$2,version=version+1 WHERE line_id=$1',[d.budget_line_id,committed.toString()]);}
    const after=(await c.query(`UPDATE spend_states SET state=$2,processing_by=$3,processing_at=$4,version=version+1 WHERE case_id=$1 RETURNING *`,
      [d.application_id,next,processingBy,processingAt])).rows[0];
    await audit(c,a,input,d,d.application_id,before,{...after,delta:delta.toString()});
    return finish({id:d.application_id,draftId:d.id,version:after.version});
  });
}
