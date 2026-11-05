import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client,Pool } from 'pg';
import { migrate } from '../scripts/migrate.mjs';
import { assertLocalDatabase,requiredUrl } from '../scripts/db-config.mjs';
import { issueSession } from '../src/server/google.ts';
import { paymentAmounts,paymentDate } from '../src/lib/payments.ts';
import { paymentList,paymentDetail,recordPayment,recordExternalClaim,settleCase } from '../src/server/payments.ts';

test('payment input requires exact gross=withholding+net and a real canonical date',()=>{
  assert.deepEqual(paymentAmounts({grossAmount:'9007199254740993',withheldAmount:'1',netAmount:'9007199254740992'}),{gross:'9007199254740993',withheld:'1',net:'9007199254740992'});
  for(const values of [{grossAmount:'10',withheldAmount:'2',netAmount:'9'},{grossAmount:'0',withheldAmount:'0',netAmount:'0'},{grossAmount:10,withheldAmount:'0',netAmount:'10'},{grossAmount:'10',withheldAmount:'-1',netAmount:'11'}])assert.throws(()=>paymentAmounts(values));
  for(const value of ['2026-02-30','2026-2-01','2026-11-06T00:00:00Z'])assert.throws(()=>paymentDate(value));
  assert.equal(paymentDate('2026-11-06'),'2026-11-06');
});

test('P5 manual external claims, partial payments, refunds, closure and role boundaries on isolated PostgreSQL',async t=>{
  const ownerUrl=assertLocalDatabase(requiredUrl('TEST_MIGRATION_DATABASE_URL'),'boot_erp_test','owner');
  const appUrl=assertLocalDatabase(requiredUrl('TEST_DATABASE_URL'),'boot_erp_test','app');
  const schema=`foundation_test_${randomUUID().replaceAll('-','')}`,owner=new Client({connectionString:ownerUrl});
  const app=new URL(appUrl);app.searchParams.set('options',`-c search_path=${schema},public`);
  const pool=new Pool({connectionString:app.toString()});
  let created=false;
  const input=(data:Record<string,unknown>)=>({requestId:randomUUID(),reason:'Synthetic payment verification',...data});
  await owner.connect();
  try {
    await owner.query(`CREATE SCHEMA ${schema}`);created=true;
    assert.ok(await migrate(ownerUrl,schema)>=6);
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO boot_erp_test_app`);
    await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO boot_erp_test_app`);
    await owner.query(`REVOKE ALL ON ${schema}.migration_history FROM boot_erp_test_app`);
    await owner.query(`SET search_path TO ${schema},public`);
    async function actor(role:string) {
      const id=randomUUID(),email=`${id}@example.invalid`;
      await owner.query('INSERT INTO users(id,role,active) VALUES($1,$2,true)',[id,role]);
      await owner.query('INSERT INTO login_accounts(user_id,email,binding_allowed) VALUES($1,$2,true)',[id,email]);
      await owner.query("INSERT INTO email_ownership_checks(id,user_id,email,outcome,method,checked_by,checked_at) VALUES($1,$2,$3,'verified','synthetic',$2,clock_timestamp())",[randomUUID(),id,email]);
      return {id,token:await issueSession(pool,{provider:'google',issuer:'https://accounts.google.com',subject:id,email})};
    }
    const staff=await actor('staff'),admin=await actor('admin'),ra=await actor('researcher'),rb=await actor('researcher'),pi=await actor('principal_investigator');
    const code=randomUUID(),codeVersion=randomUUID();
    await owner.query("INSERT INTO budget_codes(id,code,level) VALUES($1,'N99.99.999',3)",[code]);
    await owner.query("INSERT INTO budget_code_versions(id,code_id,version,name,active,effective_on,actor_id,reason) VALUES($1,$2,0,'Synthetic detail',true,'2026-03-01',$3,'synthetic')",[codeVersion,code,staff.id]);
    async function fixture(year=2026,state='approved') {
      const project=randomUUID(),work=randomUUID(),line=randomUUID(),id=randomUUID();
      await owner.query("INSERT INTO projects(id,code,name,kind,business_year) VALUES($1,$2,'Synthetic project','research',$3)",[project,project,year]);
      for(const a of [ra,rb,pi])await owner.query("INSERT INTO project_memberships(id,project_id,user_id,starts_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP-INTERVAL '1 day')",[randomUUID(),project,a.id]);
      await owner.query("INSERT INTO work_items(id,project_id,title,description,assigned_to,created_by) VALUES($1,$2,'Synthetic work','',$3,$4)",[work,project,ra.id,staff.id]);
      await owner.query("INSERT INTO budget_lines(id,project_id,internal_label,original_amount) VALUES($1,$2,'Synthetic budget',1000)",[line,project]);
      await owner.query(`INSERT INTO budget_accounts(line_id,code_version_id,classification_snapshot,business_name,business_year,academic_year,period_start,period_end,fund,current_amount,committed_amount)
        VALUES($1,$2,'[]','Synthetic business',1,$3,$4,$5,'Synthetic fund',1000,1000)`,[line,codeVersion,year,`${year}-03-01`,`${year}-12-31`]);
      await owner.query('INSERT INTO spend_cases(id,project_id,applicant_id,budget_line_id) VALUES($1,$2,$3,$4)',[id,project,ra.id,line]);
      await owner.query('INSERT INTO spend_states(case_id,project_id,work_id,amount,state) VALUES($1,$2,$3,1000,$4)',[id,project,work,state]);
      return {id,project,work,line,year};
    }
    type Fixture=Awaited<ReturnType<typeof fixture>>;
    async function cmd(f:Fixture,more:Record<string,unknown>) {
      const version=(await owner.query('SELECT version FROM spend_states WHERE case_id=$1',[f.id])).rows[0].version;
      return input({caseId:f.id,projectId:f.project,version,...more});
    }
    const balances=async(f:Fixture)=>(await owner.query('SELECT current_amount,committed_amount FROM budget_accounts WHERE line_id=$1',[f.line])).rows[0];
    async function external(f:Fixture,action='submitted',documentNumber=`SYNTHETIC-${f.id}`,token=staff.token) {
      return recordExternalClaim(pool,token,await cmd(f,{action,documentNumber,occurredOn:`${f.year}-10-01`,evidence:'Synthetic manual external evidence'}));
    }
    async function pay(f:Fixture,gross='1000',token=staff.token) {
      return recordPayment(pool,token,await cmd(f,{action:'pay',grossAmount:gross,withheldAmount:'0',netAmount:gross,paidOn:`${f.year}-10-02`,evidence:'Synthetic actual payment proof'}));
    }
    async function conflict(work:Promise<unknown>,code='CONFLICT'){await assert.rejects(work,(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code===code);}

    await t.test('E-01/E-02: internal approval and external registration never imply payment; only approved cases accept records',async()=>{
      const f=await fixture();await conflict(pay(f));
      await conflict(recordExternalClaim(pool,staff.token,await cmd(f,{action:'submitted',documentNumber:`SYNTHETIC-${f.id}`,occurredOn:'2026-02-28',evidence:'Synthetic invalid prior-period record'})),'INVALID_INPUT');
      await external(f);
      assert.equal((await paymentDetail(pool,staff.token,f.id)).payments.length,0);
      assert.equal((await balances(f)).committed_amount,'1000');
      const draft=await fixture(2026,'submitted');await conflict(external(draft));
      await conflict(pay(f,'1',ra.token),'FORBIDDEN');await conflict(external(f,'rejected',`SYNTHETIC-${f.id}`,pi.token),'FORBIDDEN');
    });
    await t.test('partial gross/withholding/net preserve the reservation, receipts replay once and old versions fail',async()=>{
      const f=await fixture();await external(f);
      const request=await cmd(f,{action:'pay',grossAmount:'400',withheldAmount:'40',netAmount:'360',paidOn:'2026-10-02',evidence:'Synthetic payment proof'});
      const result=await recordPayment(pool,staff.token,request);assert.deepEqual(await recordPayment(pool,staff.token,request),result);
      assert.equal((await paymentDetail(pool,staff.token,f.id)).item.paid_amount,'400');
      assert.equal((await paymentDetail(pool,staff.token,f.id)).payments.length,1);
      const dates=await paymentDetail(pool,staff.token,f.id);
      assert.equal(dates.payments[0].paid_on,'2026-10-02');assert.equal(dates.attempts[0].occurred_on,'2026-10-01');
      assert.equal(dates.item.period_start,'2026-03-01');assert.equal(dates.item.period_end,'2026-12-31');
      assert.equal((await balances(f)).committed_amount,'1000');
      await conflict(recordPayment(pool,staff.token,{...request,grossAmount:'401',netAmount:'361'}));
      await conflict(recordPayment(pool,staff.token,{...request,requestId:randomUUID()}));
      await conflict(pay(f,'601'));await pay(f,'600');
      assert.equal((await paymentDetail(pool,staff.token,f.id)).item.paid_amount,'1000');
    });
    await t.test('E-04: concurrent partial payments cannot overpay or record both at one version',async()=>{
      const f=await fixture();await external(f);
      const request=await cmd(f,{action:'pay',grossAmount:'700',withheldAmount:'0',netAmount:'700',paidOn:'2026-10-02',evidence:'Synthetic concurrent payment'});
      const results=await Promise.allSettled([recordPayment(pool,staff.token,request),recordPayment(pool,admin.token,{...request,requestId:randomUUID()})]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal((await paymentDetail(pool,staff.token,f.id)).item.paid_amount,'700');
      assert.equal((await balances(f)).committed_amount,'1000');
    });
    await t.test('read visibility follows work reassignment and PI scope; document numbers do not link multiple cases',async()=>{
      const f=await fixture();await external(f);await pay(f,'100');
      assert.ok((await paymentList(pool,ra.token,f.project)).some(row=>row.case_id===f.id));
      assert.equal((await paymentList(pool,rb.token,f.project)).length,0);
      await conflict(paymentDetail(pool,rb.token,f.id),'FORBIDDEN');assert.equal((await paymentDetail(pool,pi.token,f.id)).payments.length,1);
      await owner.query('UPDATE work_items SET assigned_to=$2 WHERE id=$1',[f.work,rb.id]);
      await conflict(paymentDetail(pool,ra.token,f.id),'FORBIDDEN');assert.equal((await paymentDetail(pool,rb.token,f.id)).payments.length,1);
      const other=await fixture();await conflict(external(other,'submitted',`SYNTHETIC-${f.id}`));
      await owner.query('UPDATE project_memberships SET active=false WHERE project_id=$1 AND user_id=$2',[f.project,pi.id]);
      await conflict(paymentDetail(pool,pi.token,f.id),'FORBIDDEN');
    });
    await t.test('external rejection/resubmission remains append-only and blocks payment until resubmitted',async()=>{
      const f=await fixture();await external(f);await external(f,'rejected');await conflict(pay(f));
      await external(f,'resubmitted');await pay(f,'1');
      assert.deepEqual((await paymentDetail(pool,staff.token,f.id)).attempts.map(a=>a.kind),['submitted','rejected','resubmitted']);
    });
    await t.test('E-05/E-06: refund is linked and capped per original payment; explicit restoration happens once only',async()=>{
      const f=await fixture();await external(f);const paid=await pay(f);
      const request=await cmd(f,{action:'refund',paymentId:paid.id,amount:'400',refundedOn:'2026-10-03',evidence:'Synthetic refund proof',restoreBudget:true,restoredOn:'2026-10-03'});
      const result=await recordPayment(pool,staff.token,request);assert.deepEqual(await recordPayment(pool,staff.token,request),result);
      assert.equal((await balances(f)).committed_amount,'600');
      assert.equal((await paymentDetail(pool,staff.token,f.id)).item.paid_amount,'1000');
      await conflict(recordPayment(pool,staff.token,await cmd(f,{action:'restore-refund',refundId:result.id,restoredOn:'2026-10-03'})));
      await conflict(recordPayment(pool,staff.token,await cmd(f,{action:'refund',paymentId:paid.id,amount:'601',refundedOn:'2026-10-03',evidence:'Synthetic over refund',restoreBudget:false})));
      const detail=await paymentDetail(pool,staff.token,f.id);assert.equal(detail.refunds.length,1);
      assert.equal(detail.refunds[0].refunded_on,'2026-10-03');assert.equal(detail.refunds[0].restored_on,'2026-10-03');
      await conflict(pay(f,'1'));
    });
    await t.test('cross-year refunds record facts without restoring budget and keep settlement pending',async()=>{
      const f=await fixture(2025);await external(f);const paid=await pay(f);
      const data={action:'refund',paymentId:paid.id,amount:'1000',refundedOn:'2026-10-03',evidence:'Synthetic cross-year refund',restoreBudget:true,restoredOn:'2026-10-03'};
      await conflict(recordPayment(pool,staff.token,await cmd(f,data)),'INVALID_INPUT');
      assert.equal((await paymentDetail(pool,staff.token,f.id)).refunds.length,0);
      await recordPayment(pool,staff.token,await cmd(f,{...data,restoreBudget:false}));
      assert.equal((await balances(f)).committed_amount,'1000');
      await conflict(settleCase(pool,staff.token,await cmd(f,{action:'close'})));
    });
    await t.test('E-07: complete cases close, mutations stop until reasoned reopen, immutable ledgers reject rewrites',async()=>{
      const f=await fixture();await external(f);await pay(f,'500');
      await conflict(settleCase(pool,staff.token,await cmd(f,{action:'close'})));await pay(f,'500');
      await settleCase(pool,staff.token,await cmd(f,{action:'close'}));assert.equal((await paymentDetail(pool,staff.token,f.id)).closed,true);
      await conflict(external(f,'rejected'));
      await settleCase(pool,admin.token,await cmd(f,{action:'reopen'}));assert.equal((await paymentDetail(pool,staff.token,f.id)).closed,false);
      for(const table of ['external_claim_links','external_claim_attempts','payment_records','payment_refunds','refund_restorations','settlement_events']) {
        await assert.rejects(pool.query(`DELETE FROM ${table} WHERE false`));
      }
    });
  } finally {
    await pool.end();if(created){assert.match(schema,/^foundation_test_[0-9a-f]{32}$/);await owner.query(`DROP SCHEMA ${schema} CASCADE`);}await owner.end();
  }
});
