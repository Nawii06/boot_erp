import 'server-only';
import { randomUUID, createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../lib/errors.ts';
import { uuid, textInput } from '../lib/validation.ts';
import { won, jsonValue, sumWon } from '../lib/money.ts';
import { transaction } from './transaction.ts';
import { authenticate, manager, hash, type Actor } from './security.ts';

type Input = Record<string, unknown>;
function fail(code: 'INVALID_INPUT' | 'FORBIDDEN' | 'CONFLICT' = 'CONFLICT'): never { throw new AppError(code); }
const managed = (a: Actor) => a.role === 'staff' || a.role === 'admin';
const version = (input: unknown, actual: string) => { if (typeof input !== 'string' || input !== actual) fail(); };
function amount(input: unknown, positive = false) { const v = won(input); if (v < (positive ? 1n : 0n)) fail('INVALID_INPUT'); return v.toString(); }
async function projectAccess(c: PoolClient, a: Actor, id: string) {
  const p = (await c.query('SELECT * FROM projects WHERE id=$1 FOR SHARE', [uuid(id)])).rows[0];
  if (!p) fail('FORBIDDEN');
  if (!managed(a) && !(await c.query(`SELECT 1 FROM project_memberships WHERE project_id=$1 AND user_id=$2
    AND active AND starts_at<=CURRENT_TIMESTAMP AND (ends_at IS NULL OR ends_at>CURRENT_TIMESTAMP) FOR SHARE`, [id,a.id])).rowCount) fail('FORBIDDEN');
  return p;
}
async function event(c: PoolClient, a: Actor, input: Input, action: string, entity: string, project: string | null, before: unknown, after: unknown) {
  await c.query(`INSERT INTO budget_events(id,project_id,entity_id,actor_id,request_id,action,reason,before_state,after_state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(),project,entity,a.id,uuid(input.requestId),action,textInput(input.reason,1000),jsonValue(before),jsonValue(after)]);
}
// Per-project serialisation coordinates every allocation/change/deduction. Separate projects remain concurrent.
async function budgetCommand(pool: Pool, token: string, input: Input, action: string,
  run: (c: PoolClient, a: Actor, project: string) => Promise<unknown>, global = false) {
  const request = uuid(input.requestId), project = global ? '' : uuid(input.projectId);
  textInput(input.reason,1000);
  const fingerprint = hash(jsonValue({action,input}));
  return transaction(pool, async c => {
    const a = await authenticate(c,token,true);
    if (a.role === 'principal_investigator') fail('FORBIDDEN');
    if (global) manager(a); else await projectAccess(c,a,project);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`budget:${project || 'classification'}`]);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${a.id}:${request}`]);
    const receipt = (await c.query('SELECT fingerprint,result FROM command_receipts WHERE actor_id=$1 AND request_id=$2',[a.id,request])).rows[0];
    if (receipt) { if (receipt.fingerprint !== fingerprint) fail(); return receipt.result; }
    const result = await run(c,a,project);
    await c.query('INSERT INTO command_receipts(actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4)',[a.id,request,fingerprint,jsonValue(result)]);
    return result;
  });
}
const latestCodes = `SELECT b.id,b.code,b.level,v.id AS version_id,v.version,v.parent_id,v.name,v.active,v.effective_on
  FROM budget_codes b JOIN LATERAL (SELECT * FROM budget_code_versions WHERE code_id=b.id ORDER BY version DESC LIMIT 1) v ON true`;
export async function classificationList(pool: Pool, token: string) {
  return transaction(pool,async c => { await authenticate(c,token); return (await c.query(latestCodes+' ORDER BY b.code')).rows; });
}
export async function manageClassification(pool: Pool, token: string, input: Input) {
  return budgetCommand(pool,token,input,'classification',async(c,a)=>{
    const create = input.action === 'create'; if (!create && input.action !== 'update') fail('INVALID_INPUT');
    const id = create ? randomUUID() : uuid(input.id);
    const before = create ? null : (await c.query(`SELECT * FROM (${latestCodes}) x WHERE id=$1`,[id])).rows[0];
    if (!create && !before) fail('INVALID_INPUT');
    if (before) version(input.version,before.version);
    const level = before?.level ?? Number(input.level), code = before?.code ?? textInput(input.code,20);
    const expressions = [/^N\d{2}$/, /^N\d{2}\.\d{2}$/, /^N\d{2}\.\d{2}\.\d{3}$/];
    if (![1,2,3].includes(level) || !expressions[level-1].test(code) || typeof input.active !== 'boolean') fail('INVALID_INPUT');
    const parent = level === 1 ? null : uuid(input.parentId);
    if (parent) {
      const p = (await c.query(`SELECT * FROM (${latestCodes}) x WHERE id=$1`,[parent])).rows[0];
      if (!p || p.level !== level-1 || !p.active) fail('INVALID_INPUT');
    }
    const date = textInput(input.effectiveOn,10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date) fail('INVALID_INPUT');
    if (create) await c.query('INSERT INTO budget_codes(id,code,level) VALUES($1,$2,$3)',[id,code,level]);
    const after = (await c.query(`INSERT INTO budget_code_versions(id,code_id,version,parent_id,name,active,effective_on,actor_id,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,version`,[randomUUID(),id,before?BigInt(before.version)+1n:0n,parent,textInput(input.name),input.active,date,a.id,textInput(input.reason,1000)])).rows[0];
    await event(c,a,input,'classification.version',id,null,before??{}, {...after,code,parent,name:input.name,active:input.active,effectiveOn:date});
    return {id,version:after.version};
  },true);
}
async function classificationSnapshot(c: PoolClient, id: string) {
  const rows = (await c.query(latestCodes)).rows;
  const chain = []; let current = rows.find(r=>r.version_id===id);
  if (!current || current.level!==3) fail('INVALID_INPUT');
  for (let level=3;level>=1;level--) {
    if (!current || current.level!==level || !current.active || new Date(current.effective_on)>new Date()) fail('INVALID_INPUT');
    chain.unshift(current); current = rows.find(r=>r.id===current.parent_id);
  }
  return chain;
}
export async function allocateBudget(pool: Pool, token: string, input: Input) {
  return budgetCommand(pool,token,input,'budget.allocate',async(c,a,project)=>{
    if (a.role !== 'staff') fail('FORBIDDEN');
    const p = await projectAccess(c,a,project); if (p.business_year!==2026) fail('INVALID_INPUT');
    // Serialise with classification edits so a snapshot cannot mix revisions.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('budget:classification',0))");
    const classification = uuid(input.codeVersionId), snapshot = await classificationSnapshot(c,classification);
    const id = randomUUID(), value = amount(input.amount);
    await c.query('INSERT INTO budget_lines(id,project_id,internal_label,original_amount) VALUES($1,$2,$3,$4)',[id,project,textInput(input.label),value]);
    await c.query(`INSERT INTO budget_accounts(line_id,code_version_id,classification_snapshot,business_name,business_year,academic_year,period_start,period_end,fund,current_amount)
      VALUES($1,$2,$3,'1차년도 부트캠프 사업',1,2026,'2026-03-01','2026-12-31',$4,$5)`,[id,classification,jsonValue(snapshot),textInput(input.fund),value]);
    await event(c,a,input,'budget.allocate',id,project,{}, {amount:value,classification:snapshot,label:input.label,fund:input.fund}); return {id};
  });
}
export async function budgetList(pool: Pool, token: string, project: string) {
  return transaction(pool,async c=>{
    const a=await authenticate(c,token);await projectAccess(c,a,project);
    // Only shared master balances; no applicant names, spend counts or other researchers' records.
    return (await c.query(`SELECT l.id,l.internal_label,l.original_amount,b.*, (b.current_amount-b.committed_amount)::text AS available_amount
      FROM budget_lines l JOIN budget_accounts b ON b.line_id=l.id WHERE l.project_id=$1 ORDER BY l.created_at,l.id`,[project])).rows;
  });
}
function attachment(input: unknown) {
  if (!input || typeof input!=='object' || Array.isArray(input)) fail('INVALID_INPUT');
  const f=input as Input, name=textInput(f.name,200), content=f.content;
  if (/[\x00-\x1f\x7f/\\]/.test(name) || typeof content!=='string' || content.length>6990508 || content.length%4!==0 || /[^A-Za-z0-9+/=]/.test(content)) fail('INVALID_INPUT');
  const bytes=Buffer.from(content,'base64'), ext=name.split('.').pop()?.toLowerCase();
  if (!bytes.length || bytes.length>5242880 || bytes.toString('base64')!==content) fail('INVALID_INPUT');
  const signatures:Record<string,string>={pdf:'255044462d',png:'89504e470d0a1a0a',jpg:'ffd8ff',jpeg:'ffd8ff',docx:'504b0304',xlsx:'504b0304',hwpx:'504b0304',hwp:'d0cf11e0a1b11ae1',doc:'d0cf11e0a1b11ae1',xls:'d0cf11e0a1b11ae1'};
  if (!ext || !signatures[ext] || !bytes.toString('hex',0,8).startsWith(signatures[ext])) fail('INVALID_INPUT');
  return {name,bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
}
async function visibleChange(c: PoolClient,a: Actor,id: string,project: string) {
  const r=(await c.query('SELECT * FROM budget_changes WHERE id=$1 AND project_id=$2 FOR UPDATE',[uuid(id),project])).rows[0];
  if (!r || (a.role==='researcher' && r.applicant_id!==a.id)) fail('FORBIDDEN');return r;
}
export async function changeList(pool: Pool, token: string, project: string) {
  return transaction(pool,async c=>{const a=await authenticate(c,token);await projectAccess(c,a,project);
    return (await c.query(`SELECT * FROM budget_changes WHERE project_id=$1 AND ($2<>'researcher' OR applicant_id=$3) ORDER BY created_at DESC,id`,[project,a.role,a.id])).rows;
  });
}
export async function changeDetail(pool: Pool, token: string, project: string,id: string) {
  return transaction(pool,async c=>{const a=await authenticate(c,token);await projectAccess(c,a,project);const item=await visibleChange(c,a,id,project);
    return {item,lines:(await c.query('SELECT * FROM budget_change_lines WHERE change_id=$1 ORDER BY line_id',[id])).rows,
      files:(await c.query('SELECT id,filename,sha256,version FROM budget_files WHERE change_id=$1',[id])).rows,
      history:(await c.query('SELECT action,reason,before_state,after_state,created_at FROM budget_events WHERE entity_id=$1 ORDER BY created_at,id',[id])).rows};
  });
}
export async function downloadBudgetFile(pool: Pool, token: string, id: string) {
  return transaction(pool,async c=>{const a=await authenticate(c,token);
    const file=(await c.query('SELECT f.id,f.change_id,b.project_id FROM budget_files f JOIN budget_changes b ON b.id=f.change_id WHERE f.id=$1',[uuid(id)])).rows[0];
    if (!file) fail('FORBIDDEN');await projectAccess(c,a,file.project_id);await visibleChange(c,a,file.change_id,file.project_id);
    return (await c.query('SELECT filename,content FROM budget_files WHERE id=$1',[id])).rows[0] as {filename:string;content:Buffer};
  });
}
export async function manageBudgetChange(pool: Pool, token: string, input: Input) {
  return budgetCommand(pool,token,input,'budget.change',async(c,a,project)=>{
    if (input.action==='submit') {
      if (!Array.isArray(input.lines) || input.lines.length<1 || input.lines.length>100) fail('INVALID_INPUT');
      const lines=input.lines as Input[], ids=lines.map(l=>uuid(l.id));if(new Set(ids).size!==ids.length)fail('INVALID_INPUT');
      const file=attachment(input.file),id=randomUUID();
      let prior=null;
      if(input.supersedes){prior=await visibleChange(c,a,uuid(input.supersedes),project);if(!['rejected','cancelled'].includes(prior.state))fail();}
      const checked=[];
      for(const line of lines) {
        const b=(await c.query(`SELECT b.* FROM budget_accounts b JOIN budget_lines l ON l.id=b.line_id WHERE b.line_id=$1 AND l.project_id=$2 FOR UPDATE OF b`,[line.id,project])).rows[0];
        if(!b)fail('FORBIDDEN');version(line.version,b.version);
        const after=amount(line.after);if(after===b.current_amount)fail('INVALID_INPUT');
        if(BigInt(after)<BigInt(b.committed_amount))fail();
        checked.push({id:line.id,before:b.current_amount,after,version:b.version});
      }
      const total=sumWon(checked.map(l=>BigInt(l.after)-BigInt(l.before)));
      if(total!==0n && a.role!=='staff')fail('FORBIDDEN');
      await c.query('INSERT INTO budget_changes(id,project_id,applicant_id,reason,kind,supersedes) VALUES($1,$2,$3,$4,$5,$6)',[id,project,a.id,input.reason,total===0n?'transfer':'total',prior?.id??null]);
      for(const l of checked)await c.query('INSERT INTO budget_change_lines(change_id,line_id,before_amount,after_amount,expected_version) VALUES($1,$2,$3,$4,$5)',[id,l.id,l.before,l.after,l.version]);
      await c.query('INSERT INTO budget_files(id,change_id,filename,sha256,content) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,file.name,file.sha256,file.bytes]);
      await event(c,a,input,'budget.change.submit',id,project,{}, {lines:checked,supersedes:prior?.id??null,fileHash:file.sha256});return {id};
    }
    const id=uuid(input.id),before=await visibleChange(c,a,id,project);version(input.version,before.version);
    const action=textInput(input.action);let state='';
    if(action==='review'){manager(a);if(before.state!=='submitted')fail();state='reviewing';}
    else if(action==='confirm') {
      manager(a);if(before.state!=='reviewing')fail();
      const lines=(await c.query('SELECT * FROM budget_change_lines WHERE change_id=$1 ORDER BY line_id',[id])).rows;
      for(const l of lines) {
        const b=(await c.query('SELECT * FROM budget_accounts WHERE line_id=$1 FOR UPDATE',[l.line_id])).rows[0];
        version(l.expected_version,b.version);
        if(b.current_amount!==l.before_amount || BigInt(l.after_amount)<BigInt(b.committed_amount))fail();
        await c.query('UPDATE budget_accounts SET current_amount=$2,version=version+1 WHERE line_id=$1',[l.line_id,l.after_amount]);
      }
      state='confirmed';
    } else if(action==='reject'){manager(a);if(!['submitted','reviewing'].includes(before.state))fail();state='rejected';}
    else if(action==='cancel') {if(!['submitted','reviewing'].includes(before.state)||(!managed(a)&&(before.applicant_id!==a.id||before.state!=='submitted')))fail();state='cancelled';}
    else fail('INVALID_INPUT');
    const after=(await c.query('UPDATE budget_changes SET state=$2,version=version+1 WHERE id=$1 RETURNING *',[id,state])).rows[0];
    await event(c,a,input,`budget.change.${action}`,id,project,before,after);return {id,version:after.version};
  });
}

async function workAccess(c: PoolClient,a: Actor,project: string,id: string) {
  const w=(await c.query('SELECT * FROM work_items WHERE id=$1 AND project_id=$2 FOR SHARE',[uuid(id),project])).rows[0];
  if(!w || (a.role==='researcher'&&w.assigned_to!==a.id))fail('FORBIDDEN');return w;
}
// Stage 03 shared service only. Full expenditure/evidence UI and actual payment entry belong to later stages.
export async function manageSpend(pool: Pool,token: string,input: Input) {
  return budgetCommand(pool,token,input,'spend.transition',async(c,a,project)=>{
    const action=textInput(input.action),id=action==='create'?randomUUID():uuid(input.id);
    if(action==='create') {
      await workAccess(c,a,project,uuid(input.workId));
      if(!(await c.query('SELECT 1 FROM budget_accounts b JOIN budget_lines l ON l.id=b.line_id WHERE l.id=$1 AND l.project_id=$2',[uuid(input.lineId),project])).rowCount)fail('FORBIDDEN');
      await c.query('INSERT INTO spend_cases(id,project_id,applicant_id,budget_line_id) VALUES($1,$2,$3,$4)',[id,project,a.id,input.lineId]);
      await c.query('INSERT INTO spend_states(case_id,project_id,work_id,amount) VALUES($1,$2,$3,$4)',[id,project,input.workId,amount(input.amount,true)]);
      await event(c,a,input,'spend.create',id,project,{}, {amount:input.amount,workId:input.workId,lineId:input.lineId});return {id,version:'0'};
    }
    const before=(await c.query(`SELECT s.*,x.budget_line_id,x.applicant_id FROM spend_states s JOIN spend_cases x ON x.id=s.case_id
      WHERE s.case_id=$1 AND s.project_id=$2 FOR UPDATE OF s`,[id,project])).rows[0];
    if(!before)fail('FORBIDDEN');await workAccess(c,a,project,before.work_id);version(input.version,before.version);
    const b=(await c.query('SELECT * FROM budget_accounts WHERE line_id=$1 FOR UPDATE',[before.budget_line_id])).rows[0];
    let state=before.state, value=before.amount, delta=0n, processingBy=before.processing_by, processingAt=before.processing_at;
    if(action==='edit'){if(state!=='draft')fail();value=amount(input.amount,true);}
    else if(action==='submit') {
      if(state!=='draft')fail();
      const today=(await c.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date BETWEEN $1::date AND $2::date AS valid",[b.period_start,b.period_end])).rows[0].valid;
      if(!today)fail();delta=BigInt(value);state='submitted';
    } else if(action==='start') {manager(a);if(state!=='submitted'||processingBy)fail();state='reviewing';processingBy=a.id;processingAt=new Date();}
    else if(action==='supplement'){manager(a);if(state!=='reviewing')fail();state='supplement';}
    else if(action==='resubmit'){if(state!=='supplement')fail();state='reviewing';}
    else if(action==='approve'){manager(a);if(state!=='reviewing')fail();state='approved';}
    else if(['withdraw','reject','cancel'].includes(action)) {
      if(state==='draft'||BigInt(before.paid_amount)>0n)fail();
      if(action==='withdraw'){if(state!=='submitted'||processingBy||(!managed(a)&&before.applicant_id!==a.id))fail('FORBIDDEN');}
      else {manager(a);if(action==='reject'&&state==='approved')fail();}
      delta=-BigInt(value);state='draft';processingBy=null;processingAt=null;
    } else fail('INVALID_INPUT');
    const committed=BigInt(b.committed_amount)+delta;
    if(committed<0n||committed>BigInt(b.current_amount))fail();
    if(delta!==0n)await c.query('UPDATE budget_accounts SET committed_amount=$2,version=version+1 WHERE line_id=$1',[before.budget_line_id,committed.toString()]);
    const after=(await c.query(`UPDATE spend_states SET state=$2,amount=$3,processing_by=$4,processing_at=$5,version=version+1 WHERE case_id=$1 RETURNING *`,[id,state,value,processingBy,processingAt])).rows[0];
    await event(c,a,input,`spend.${action}`,id,project,before,{...after,delta:delta.toString()});return {id,version:after.version};
  });
}
