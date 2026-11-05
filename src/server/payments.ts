import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { AppError } from '../lib/errors.ts';
import { jsonValue } from '../lib/money.ts';
import { uuid,textInput } from '../lib/validation.ts';
import { paymentDate,paymentAmounts,refundAmount,externalAttemptKinds } from '../lib/payments.ts';
import { transaction } from './transaction.ts';
import { authenticate,manager,hash,type Actor } from './security.ts';

type Input=Record<string,unknown>;
type CaseRow={case_id:string;project_id:string;work_id:string;amount:string;paid_amount:string;state:string;version:string;budget_line_id:string;applicant_id:string;assigned_to:string|null;title:string;project_name:string;period_start:string;period_end:string;academic_year:number};
const fail=(code:AppError['code']='CONFLICT'):never=>{throw new AppError(code);};
const member=`EXISTS(SELECT 1 FROM project_memberships m WHERE m.project_id=s.project_id AND m.user_id=$1
  AND m.active AND m.starts_at<=CURRENT_TIMESTAMP AND (m.ends_at IS NULL OR m.ends_at>CURRENT_TIMESTAMP))`;
const scope=`($2 IN ('staff','admin') OR (${member} AND ($2='principal_investigator' OR w.assigned_to=$1)))`;
const cases=`SELECT s.*,x.budget_line_id,x.applicant_id,w.assigned_to,w.title,p.name AS project_name,
  b.period_start::text,b.period_end::text,b.academic_year
  FROM spend_states s JOIN spend_cases x ON x.id=s.case_id JOIN work_items w ON w.id=s.work_id AND w.project_id=s.project_id
  JOIN projects p ON p.id=s.project_id JOIN budget_accounts b ON b.line_id=x.budget_line_id`;
async function accessCase(c:PoolClient,a:Actor,id:string,lock=false):Promise<CaseRow> {
  const row=(await c.query(`${cases} WHERE s.case_id=$1 ${lock?'FOR UPDATE OF s':''}`,[uuid(id)])).rows[0];
  if(!row)fail('FORBIDDEN');
  if(!['staff','admin'].includes(a.role)) {
    if(a.role==='researcher'&&row.assigned_to!==a.id)fail('FORBIDDEN');
    if(!(await c.query(`SELECT 1 FROM project_memberships WHERE project_id=$1 AND user_id=$2 AND active
      AND starts_at<=CURRENT_TIMESTAMP AND (ends_at IS NULL OR ends_at>CURRENT_TIMESTAMP) FOR SHARE`,[row.project_id,a.id])).rowCount)fail('FORBIDDEN');
  }
  return row;
}
async function closed(c:PoolClient,id:string) {
  return (await c.query('SELECT action FROM settlement_events WHERE case_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[id])).rows[0]?.action==='close';
}
async function latestClaim(c:PoolClient,id:string) {
  return (await c.query('SELECT *,occurred_on::text AS occurred_date FROM external_claim_attempts WHERE case_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[id])).rows[0];
}
async function historicalDate(c:PoolClient,value:unknown):Promise<string> {
  const date=paymentDate(value);
  if(!(await c.query("SELECT $1::date<=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date AS valid",[date])).rows[0].valid)fail('INVALID_INPUT');
  return date;
}
async function command(pool:Pool,token:string,input:Input,namespace:string,run:(c:PoolClient,a:Actor,row:CaseRow)=>Promise<Record<string,unknown>>) {
  const project=uuid(input.projectId),id=uuid(input.caseId),request=uuid(input.requestId),reason=textInput(input.reason,1000);
  return transaction(pool,async c=>{
    const a=await authenticate(c,token,true);manager(a);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`budget:${project}`]);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${a.id}:${request}`]);
    const fingerprint=hash(jsonValue({namespace,input}));
    const prior=(await c.query('SELECT fingerprint,result FROM command_receipts WHERE actor_id=$1 AND request_id=$2',[a.id,request])).rows[0];
    if(prior){if(prior.fingerprint!==fingerprint)fail();return prior.result;}
    const before=await accessCase(c,a,id,true);
    if(before.project_id!==project)fail('FORBIDDEN');
    if(input.version!==before.version)fail();
    const output=await run(c,a,before);
    const version=(await c.query('UPDATE spend_states SET version=version+1 WHERE case_id=$1 RETURNING version',[id])).rows[0].version;
    const result={...output,caseId:id,version};
    await c.query('INSERT INTO command_receipts(actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4)',[a.id,request,fingerprint,jsonValue(result)]);
    await c.query(`INSERT INTO budget_events(id,project_id,entity_id,actor_id,request_id,action,reason,before_state,after_state,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())`,[randomUUID(),project,id,a.id,request,`${namespace}.${input.action}`,reason,jsonValue(before),jsonValue(result)]);
    return result;
  });
}
export async function paymentList(pool:Pool,token:string,project?:string) {
  if(project)uuid(project);
  return transaction(pool,async c=>{
    const a=await authenticate(c,token);
    return (await c.query(`${cases}
      WHERE ${scope} AND ($3::uuid IS NULL OR s.project_id=$3)
      AND (s.state='approved' OR EXISTS(SELECT 1 FROM payment_records x WHERE x.case_id=s.case_id))
      ORDER BY s.case_id LIMIT 1000`,[a.id,a.role,project??null])).rows;
  });
}
export async function paymentDetail(pool:Pool,token:string,id:string) {
  return transaction(pool,async c=>{
    const a=await authenticate(c,token),item=await accessCase(c,a,id);
    return {item,closed:await closed(c,id),document:(await c.query('SELECT * FROM external_claim_links WHERE case_id=$1',[id])).rows[0]??null,
      attempts:(await c.query('SELECT *,occurred_on::text AS occurred_on FROM external_claim_attempts WHERE case_id=$1 ORDER BY created_at,id',[id])).rows,
      payments:(await c.query('SELECT *,paid_on::text AS paid_on FROM payment_records WHERE case_id=$1 ORDER BY payment_records.paid_on,created_at,id',[id])).rows,
      refunds:(await c.query(`SELECT r.*,r.refunded_on::text AS refunded_on,x.restored_on::text AS restored_on,x.actor_id AS restored_by FROM payment_refunds r
        LEFT JOIN refund_restorations x ON x.refund_id=r.id WHERE r.case_id=$1 ORDER BY r.refunded_on,r.created_at,r.id`,[id])).rows,
      settlements:(await c.query('SELECT * FROM settlement_events WHERE case_id=$1 ORDER BY created_at,id',[id])).rows};
  });
}
export async function recordExternalClaim(pool:Pool,token:string,input:Input) {
  return command(pool,token,input,'external-claim',async(c,a,row)=>{
    if(row.state!=='approved'||await closed(c,row.case_id))fail();
    const kind=textInput(input.action) as keyof typeof externalAttemptKinds;
    if(!Object.hasOwn(externalAttemptKinds,kind))fail('INVALID_INPUT');
    const date=await historicalDate(c,input.occurredOn),evidence=textInput(input.evidence,1000),document=textInput(input.documentNumber);
    if(date<row.period_start)fail('INVALID_INPUT');
    const prior=await latestClaim(c,row.case_id);
    if((!prior&&kind!=='submitted')||(prior&&kind==='submitted')||(kind==='rejected'&&prior?.kind==='rejected')||(kind==='resubmitted'&&prior?.kind!=='rejected'))fail();
    if(prior&&date<prior.occurred_date)fail('INVALID_INPUT');
    const link=(await c.query('SELECT * FROM external_claim_links WHERE case_id=$1',[row.case_id])).rows[0];
    if(link&&link.document_number!==document)fail();
    if(!link) {
      if((await c.query('SELECT 1 FROM external_claim_links WHERE document_number=$1',[document])).rowCount)fail();
      const created=await c.query('INSERT INTO external_claim_links(case_id,document_number,actor_id) VALUES($1,$2,$3) ON CONFLICT(document_number) DO NOTHING RETURNING case_id',[row.case_id,document,a.id]);
      if(!created.rowCount)fail();
    }
    const id=randomUUID();
    await c.query(`INSERT INTO external_claim_attempts(id,case_id,project_id,kind,occurred_on,evidence,actor_id,request_id,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,row.case_id,row.project_id,kind,date,evidence,a.id,uuid(input.requestId),textInput(input.reason,1000)]);
    return {id,kind};
  });
}
async function restoreRefund(c:PoolClient,a:Actor,input:Input,row:CaseRow,refundId:string) {
  const refund=(await c.query('SELECT *,refunded_on::text AS refunded_date FROM payment_refunds WHERE id=$1 AND case_id=$2',[uuid(refundId),row.case_id])).rows[0];
  if(!refund||await closed(c,row.case_id))fail();
  const date=await historicalDate(c,input.restoredOn);
  if(date<refund.refunded_date||date<row.period_start||date>row.period_end||refund.refunded_date<row.period_start||refund.refunded_date>row.period_end||Number(date.slice(0,4))!==row.academic_year)fail('INVALID_INPUT');
  if((await c.query('SELECT 1 FROM refund_restorations WHERE refund_id=$1',[refundId])).rowCount)fail();
  const budget=(await c.query('SELECT * FROM budget_accounts WHERE line_id=$1 FOR UPDATE',[row.budget_line_id])).rows[0];
  const next=BigInt(budget.committed_amount)-BigInt(refund.amount);if(next<0n)fail();
  await c.query('INSERT INTO refund_restorations(refund_id,case_id,restored_on,actor_id,request_id,reason) VALUES($1,$2,$3,$4,$5,$6)',[refundId,row.case_id,date,a.id,uuid(input.requestId),textInput(input.reason,1000)]);
  await c.query('UPDATE budget_accounts SET committed_amount=$2,version=version+1 WHERE line_id=$1',[row.budget_line_id,next.toString()]);
}
export async function recordPayment(pool:Pool,token:string,input:Input) {
  return command(pool,token,input,'payment',async(c,a,row)=>{
    if(row.state!=='approved'||await closed(c,row.case_id))fail();
    if(input.action==='pay') {
      const claim=await latestClaim(c,row.case_id);if(!claim||claim.kind==='rejected')fail();
      const values=paymentAmounts(input),date=await historicalDate(c,input.paidOn);
      if(date<claim.occurred_date)fail('INVALID_INPUT');
      const recorded=(await c.query('SELECT coalesce(sum(gross_amount),0)::text AS total FROM payment_records WHERE case_id=$1',[row.case_id])).rows[0].total;
      if(BigInt(recorded)!==BigInt(row.paid_amount))fail();
      const next=BigInt(row.paid_amount)+BigInt(values.gross);if(next>BigInt(row.amount))fail();
      const id=randomUUID();
      await c.query(`INSERT INTO payment_records(id,case_id,project_id,gross_amount,withheld_amount,net_amount,paid_on,evidence,actor_id,request_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,row.case_id,row.project_id,values.gross,values.withheld,values.net,date,textInput(input.evidence,1000),a.id,uuid(input.requestId),textInput(input.reason,1000)]);
      await c.query('UPDATE spend_states SET paid_amount=$2 WHERE case_id=$1',[row.case_id,next.toString()]);
      return {id,paidAmount:next.toString()};
    }
    if(input.action==='refund') {
      const payment=(await c.query('SELECT *,paid_on::text AS paid_date FROM payment_records WHERE id=$1 AND case_id=$2',[uuid(input.paymentId),row.case_id])).rows[0];
      if(!payment)fail('FORBIDDEN');
      const amount=refundAmount(input.amount),date=await historicalDate(c,input.refundedOn);
      if(date<payment.paid_date||typeof input.restoreBudget!=='boolean')fail('INVALID_INPUT');
      const refunded=(await c.query('SELECT coalesce(sum(amount),0)::text AS total FROM payment_refunds WHERE payment_id=$1',[input.paymentId])).rows[0].total;
      if(BigInt(refunded)+BigInt(amount)>BigInt(payment.gross_amount))fail();
      const id=randomUUID();
      await c.query(`INSERT INTO payment_refunds(id,payment_id,case_id,project_id,amount,refunded_on,evidence,actor_id,request_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,input.paymentId,row.case_id,row.project_id,amount,date,textInput(input.evidence,1000),a.id,uuid(input.requestId),textInput(input.reason,1000)]);
      if(input.restoreBudget)await restoreRefund(c,a,input,row,id);
      return {id,restoration:input.restoreBudget?'restored':'deferred'};
    }
    if(input.action==='restore-refund') {
      const id=uuid(input.refundId);await restoreRefund(c,a,input,row,id);return {id,restoration:'restored'};
    }
    return fail('INVALID_INPUT');
  });
}
export async function settleCase(pool:Pool,token:string,input:Input) {
  return command(pool,token,input,'settlement',async(c,a,row)=>{
    const isClosed=await closed(c,row.case_id);
    if(input.action==='close') {
      const claim=await latestClaim(c,row.case_id);
      if(isClosed||row.state!=='approved'||BigInt(row.paid_amount)!==BigInt(row.amount)||!claim||claim.kind==='rejected')fail();
      if((await c.query('SELECT 1 FROM payment_refunds r LEFT JOIN refund_restorations x ON x.refund_id=r.id WHERE r.case_id=$1 AND x.refund_id IS NULL',[row.case_id])).rowCount)fail();
      const total=(await c.query('SELECT coalesce(sum(gross_amount),0)::text AS total FROM payment_records WHERE case_id=$1',[row.case_id])).rows[0].total;
      if(total!==row.paid_amount)fail();
    } else if(input.action==='reopen') {if(!isClosed)fail();}
    else fail('INVALID_INPUT');
    const id=randomUUID();
    await c.query('INSERT INTO settlement_events(id,case_id,project_id,action,actor_id,request_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,row.case_id,row.project_id,input.action,a.id,uuid(input.requestId),textInput(input.reason,1000)]);
    return {id,closed:input.action==='close'};
  });
}
