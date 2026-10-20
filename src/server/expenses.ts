import 'server-only';
import { randomUUID,createHash } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { AppError } from '../lib/errors.ts';
import { uuid,textInput } from '../lib/validation.ts';
import { jsonValue } from '../lib/money.ts';
import { expenseType,draftData,policyData,optionalText } from '../lib/expense.ts';
import { transaction } from './transaction.ts';
import { authenticate,manager,hash,type Actor } from './security.ts';

type Input=Record<string,unknown>;
function fail(code:AppError['code']='CONFLICT'):never {throw new AppError(code);}
const managed=(a:Actor)=>['staff','admin'].includes(a.role);
const member=`EXISTS(SELECT 1 FROM project_memberships m WHERE m.project_id=d.project_id AND m.user_id=$1
  AND m.active AND m.starts_at<=CURRENT_TIMESTAMP AND (m.ends_at IS NULL OR m.ends_at>CURRENT_TIMESTAMP))`;
const scope=`($2 IN ('staff','admin') OR (${member} AND ($2='principal_investigator' OR w.assigned_to=$1)))`;
const visible=`SELECT d.*,w.title AS work_title,v.data,v.budget_line_id,v.policy_version_id
 FROM expense_drafts d JOIN work_items w ON w.id=d.work_id
 JOIN expense_draft_versions v ON v.draft_id=d.id AND v.version=d.version`;
async function accessWork(c:PoolClient,a:Actor,project:string,work:string) {
  const w=(await c.query('SELECT * FROM work_items WHERE id=$1 AND project_id=$2 FOR SHARE',[uuid(work),uuid(project)])).rows[0];
  if(!w)fail('FORBIDDEN');
  if(!managed(a)) {
    if(a.role==='researcher'&&w.assigned_to!==a.id)fail('FORBIDDEN');
    if(!(await c.query(`SELECT 1 FROM project_memberships WHERE project_id=$1 AND user_id=$2 AND active
      AND starts_at<=CURRENT_TIMESTAMP AND (ends_at IS NULL OR ends_at>CURRENT_TIMESTAMP) FOR SHARE`,[project,a.id])).rowCount)fail('FORBIDDEN');
  }
}
async function accessDraft(c:PoolClient,a:Actor,id:string) {
  const d=(await c.query('SELECT * FROM expense_drafts WHERE id=$1',[uuid(id)])).rows[0];
  if(!d)fail('FORBIDDEN');
  await accessWork(c,a,d.project_id,d.work_id);return d;
}
async function receipt(c:PoolClient,a:Actor,input:Input,run:()=>Promise<unknown>) {
  const request=uuid(input.requestId),fingerprint=hash(jsonValue({namespace:'expense',input}));
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${a.id}:${request}`]);
  const prior=(await c.query('SELECT * FROM command_receipts WHERE actor_id=$1 AND request_id=$2',[a.id,request])).rows[0];
  if(prior){if(prior.fingerprint!==fingerprint)fail();return prior.result;}
  const result=await run();
  await c.query('INSERT INTO command_receipts(actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4)',[a.id,request,fingerprint,jsonValue(result)]);
  return result;
}
async function audit(c:PoolClient,a:Actor,input:Input,id:string,project:string|null,before:unknown,after:unknown) {
  await c.query(`INSERT INTO budget_events(id,project_id,entity_id,actor_id,request_id,action,reason,before_state,after_state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),project,id,a.id,uuid(input.requestId),`expense.${input.action}`,
    textInput(input.reason,1000),jsonValue(before),jsonValue(after)]);
}
export async function draftList(pool:Pool,token:string,search='') {
  if(search.length>200)fail('INVALID_INPUT');
  return transaction(pool,async c=>{const a=await authenticate(c,token);
    return (await c.query(`${visible} WHERE ${scope} AND ($3='' OR position(lower($3) in lower(v.data->>'title'))>0)
      ORDER BY d.created_at,d.id LIMIT 1000`,[a.id,a.role,search])).rows;});
}
export async function draftDetail(pool:Pool,token:string,id:string) {
  return transaction(pool,async c=>{const a=await authenticate(c,token);await accessDraft(c,a,id);
    const item=(await c.query(`${visible} WHERE d.id=$1`,[id])).rows[0];
    return {item,history:(await c.query('SELECT * FROM expense_draft_versions WHERE draft_id=$1 ORDER BY version',[id])).rows,
      files:(await c.query(`SELECT id,slot_id,version,filename,label,sha256,octet_length(content) AS size,actor_id,reason,created_at
        FROM expense_files WHERE draft_id=$1 ORDER BY created_at,id`,[id])).rows};
  });
}
export async function saveDraft(pool:Pool,token:string,input:Input) {
  return transaction(pool,async c=>{
    const a=await authenticate(c,token,true);if(a.role==='principal_investigator')fail('FORBIDDEN');
    if(!['create','edit'].includes(String(input.action)))fail('PHASE_NOT_ENABLED');
    const create=input.action==='create',id=create?randomUUID():uuid(input.id);
    const d=create?{project_id:uuid(input.projectId),work_id:uuid(input.workId)}:await accessDraft(c,a,id);
    await accessWork(c,a,d.project_id,d.work_id);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`expense:${id}`]);
    return receipt(c,a,input,async()=>{
      const before=create?null:(await c.query(`${visible} WHERE d.id=$1 FOR UPDATE OF d`,[id])).rows[0];
      if(before && input.version!==before.version)fail();
      const data=draftData(input),line=input.lineId?uuid(input.lineId):null,policy=input.policyVersionId?uuid(input.policyVersionId):null;
      if(line && !(await c.query(`SELECT 1 FROM budget_accounts b JOIN budget_lines l ON l.id=b.line_id WHERE l.id=$1 AND l.project_id=$2`,[line,d.project_id])).rowCount)fail('FORBIDDEN');
      if(policy) {
        const p=(await c.query('SELECT * FROM expense_policy_versions WHERE id=$1',[policy])).rows[0];
        if(!p||p.type_key!==data.type||p.data.status!=='verified')fail('INVALID_INPUT');
      }
      const version=create?'0':(BigInt(before.version)+1n).toString();
      if(create)await c.query('INSERT INTO expense_drafts(id,project_id,work_id,applicant_id) VALUES($1,$2,$3,$4)',[id,d.project_id,d.work_id,a.id]);
      else await c.query('UPDATE expense_drafts SET version=$2 WHERE id=$1',[id,version]);
      await c.query(`INSERT INTO expense_draft_versions(id,draft_id,version,budget_line_id,policy_version_id,data,actor_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),id,version,line,policy,jsonValue(data),a.id,textInput(input.reason,1000)]);
      await audit(c,a,input,id,d.project_id,before??{},{version,data,line,policy});
      return {id,version};
    });
  });
}
function fileData(input:unknown) {
  if(!input||typeof input!=='object'||Array.isArray(input))fail('INVALID_INPUT');
  const f=input as Input,name=textInput(f.name,200),content=f.content,label=textInput(f.label,200);
  if(/[\x00-\x1f\x7f/\\]/.test(name)||typeof content!=='string'||content.length>6990508)fail('INVALID_INPUT');
  const bytes=Buffer.from(content,'base64'),ext=name.split('.').pop()?.toLowerCase();
  const signatures:Record<string,string>={pdf:'255044462d',png:'89504e470d0a1a0a',jpg:'ffd8ff',jpeg:'ffd8ff',
    hwp:'d0cf11e0a1b11ae1',doc:'d0cf11e0a1b11ae1',xls:'d0cf11e0a1b11ae1',docx:'504b0304',xlsx:'504b0304',hwpx:'504b0304'};
  if(!bytes.length||bytes.length>5242880||bytes.toString('base64')!==content||!ext||!signatures[ext]||!bytes.toString('hex',0,8).startsWith(signatures[ext]))fail('INVALID_INPUT');
  // Check ZIP container directories without extracting or executing archive entries.
  const required:Record<string,string>={docx:'word/document.xml',xlsx:'xl/workbook.xml',hwpx:'Contents/content.hpf'};
  if(required[ext]) {
    let end=-1;
    for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
    if(end<0||bytes.readUInt16LE(end+4)!==0||bytes.readUInt16LE(end+6)!==0)fail('INVALID_INPUT');
    const count=bytes.readUInt16LE(end+10),length=bytes.readUInt32LE(end+12);
    let pos=bytes.readUInt32LE(end+16);const stop=pos+length;let found=false;
    if(stop!==end||!count||count>10000)fail('INVALID_INPUT');
    for(let n=0;n<count;n++){
      if(pos+46>stop||bytes.readUInt32LE(pos)!==0x02014b50)fail('INVALID_INPUT');
      const size=bytes.readUInt16LE(pos+28),extra=bytes.readUInt16LE(pos+30),comment=bytes.readUInt16LE(pos+32);
      if(pos+46+size+extra+comment>stop)fail('INVALID_INPUT');
      const entry=bytes.subarray(pos+46,pos+46+size).toString('utf8');
      if(entry===required[ext])found=true;
      if(entry.startsWith('/')||entry.includes('\\')||entry.split('/').includes('..')||/vbaProject\.bin$/i.test(entry))fail('INVALID_INPUT');
      pos+=46+size+extra+comment;
    }
    if(pos!==stop||!found)fail('INVALID_INPUT');
  }
  return {name,label,bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
}
export async function attachDraftFile(pool:Pool,token:string,input:Input) {
  return transaction(pool,async c=>{
    const a=await authenticate(c,token,true);if(a.role==='principal_investigator')fail('FORBIDDEN');
    if(input.action!=='attach')fail('UNAVAILABLE');
    const id=uuid(input.id),d=await accessDraft(c,a,id);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`expense:${id}`]);
    return receipt(c,a,input,async()=>{
      const before=(await c.query('SELECT * FROM expense_drafts WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(input.version!==before.version)fail();
      const f=fileData(input.file),slot=input.slotId?uuid(input.slotId):randomUUID();
      const files=(await c.query(`SELECT DISTINCT ON(slot_id) id,slot_id,version,octet_length(content) AS size
        FROM expense_files WHERE draft_id=$1 ORDER BY slot_id,version DESC`,[id])).rows;
      const old=files.find(v=>v.slot_id===slot);
      if(input.slotId&&!old)fail('FORBIDDEN');
      if(files.length+(old?0:1)>10||files.reduce((n,v)=>n+v.size,0)-(old?.size??0)+f.bytes.length>20971520)fail('INVALID_INPUT');
      const fileId=randomUUID(),version=(BigInt(before.version)+1n).toString(),fileVersion=old?(BigInt(old.version)+1n).toString():'0';
      await c.query(`INSERT INTO expense_files(id,draft_id,slot_id,version,filename,label,sha256,content,actor_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[fileId,id,slot,fileVersion,f.name,f.label,f.sha256,f.bytes,a.id,textInput(input.reason,1000)]);
      await c.query(`INSERT INTO expense_draft_versions(id,draft_id,version,budget_line_id,policy_version_id,data,actor_id,reason)
        SELECT $1,draft_id,$3,budget_line_id,policy_version_id,data,$4,$5 FROM expense_draft_versions WHERE draft_id=$2 AND version=$6`,
        [randomUUID(),id,version,a.id,textInput(input.reason,1000),before.version]);
      await c.query('UPDATE expense_drafts SET version=$2 WHERE id=$1',[id,version]);
      await audit(c,a,input,id,d.project_id,{version:before.version,file:old?.id??null},{version,fileId,slot,fileVersion,hash:f.sha256});
      return {id,version,fileId};
    });
  });
}
export async function downloadDraftFile(pool:Pool,token:string,id:string) {
  return transaction(pool,async c=>{
    const a=await authenticate(c,token),f=(await c.query('SELECT draft_id FROM expense_files WHERE id=$1',[uuid(id)])).rows[0];
    if(!f)fail('FORBIDDEN');await accessDraft(c,a,f.draft_id);
    return (await c.query('SELECT filename,content FROM expense_files WHERE id=$1',[id])).rows[0] as {filename:string;content:Buffer};
  });
}
const policyLatest=`SELECT DISTINCT ON(type_key,subtype) * FROM expense_policy_versions ORDER BY type_key,subtype,version DESC`;
export async function policyList(pool:Pool,token:string) {
  return transaction(pool,async c=>{const a=await authenticate(c,token);
    const rows=(await c.query(policyLatest)).rows;
    return a.role==='researcher'?rows.filter(r=>r.data.status==='verified').map(({id,type_key,subtype,version,data})=>({id,type_key,subtype,version,data})):rows;
  });
}
export async function policyHistory(pool:Pool,token:string,type:string,subtype:string) {
  expenseType(type);optionalText(subtype);
  return transaction(pool,async c=>{const a=await authenticate(c,token);
    if(a.role==='researcher')fail('FORBIDDEN');
    return (await c.query('SELECT * FROM expense_policy_versions WHERE type_key=$1 AND subtype=$2 ORDER BY version',[type,subtype])).rows;
  });
}
export async function savePolicy(pool:Pool,token:string,input:Input) {
  return transaction(pool,async c=>{
    const a=await authenticate(c,token,true);manager(a);
    if(input.action!=='policy')fail('UNAVAILABLE');
    const type=expenseType(input.type),subtype=optionalText(input.subtype);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`expense-policy:${type}:${subtype}`]);
    return receipt(c,a,input,async()=>{
      const before=(await c.query('SELECT * FROM expense_policy_versions WHERE type_key=$1 AND subtype=$2 ORDER BY version DESC LIMIT 1',[type,subtype])).rows[0];
      if(input.version!==(before?.version??''))fail();
      const id=randomUUID(),version=before?(BigInt(before.version)+1n).toString():'0',data=policyData(input);
      await c.query(`INSERT INTO expense_policy_versions(id,type_key,subtype,version,data,actor_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,type,subtype,version,jsonValue(data),a.id,textInput(input.reason,1000)]);
      await audit(c,a,input,id,null,before??{},{type,subtype,version,data});return {id,version};
    });
  });
}
