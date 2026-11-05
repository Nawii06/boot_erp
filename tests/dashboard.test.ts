import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { dashboardFilters, dashboardTotals, dashboardCsv, type DashboardResult, type DashboardLine } from '../src/lib/dashboard.ts';
import { dashboardOverview } from '../src/server/dashboard.ts';
import { issueSession } from '../src/server/google.ts';
import { migrate } from '../scripts/migrate.mjs';
import { assertLocalDatabase, requiredUrl } from '../scripts/db-config.mjs';

test('dashboard filters reject ambiguous/invalid input and validate KST calendar dates', () => {
  assert.deepEqual(dashboardFilters(), { projectId: null, year: null, from: null, to: null });
  const id = randomUUID();
  assert.deepEqual(dashboardFilters(new URLSearchParams({ projectId: id, year: '2026', from: '2026-02-28', to: '2026-03-01' })),
    { projectId: id, year: 2026, from: '2026-02-28', to: '2026-03-01' });
  for (const input of [{ projectId: 'not-a-uuid' }, { year: '1' }, { year: 2026.5 }, { year: 2201 },
    { year: ['2026'] }, { from: '2026-02-29' }, { to: '2026-03-01T00:00:00Z' },
    { from: '2026-11-02', to: '2026-11-01' }]) {
    assert.throws(() => dashboardFilters(input), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => dashboardFilters(new URLSearchParams('year=2026&year=2025')), { code: 'INVALID_INPUT' });
});

test('dashboard totals retain exact money above JS safe integers; CSV neutralises formulas', () => {
  const lines: DashboardLine[] = [{ id: randomUUID(), projectId: randomUUID(), projectName: '=synthetic',
    label: '\t+synthetic', current: '9223372036854775807', committed: '7', available: '9223372036854775800', paid:'10',withheld:'1',received:'9',refunded:'3',netExecution:'7' }];
  const totals = dashboardTotals([...lines, ...lines]);
  assert.deepEqual(totals, { current: '18446744073709551614', committed: '14', available: '18446744073709551600',paid:'20',withheld:'2',received:'18',refunded:'6',netExecution:'14' });
  assert.throws(() => dashboardTotals([{ ...lines[0], available: '1' }]), { code: 'UNAVAILABLE' });
  assert.throws(() => dashboardTotals([{ ...lines[0],received:'10' }]), { code: 'UNAVAILABLE' });
  assert.equal(dashboardTotals([{...lines[0],paid:'0',withheld:'0',received:'0',refunded:'3',netExecution:'-3'}]).netExecution,'-3');
  assert.deepEqual(dashboardTotals([]),{current:'0',committed:'0',available:'0',paid:'0',withheld:'0',received:'0',refunded:'0',netExecution:'0'});
  const result: DashboardResult = { asOf: '2026-11-06T00:00:00.000Z',
    scope: { ...dashboardFilters(), role: 'staff', dateBasis: 'draft_created_at_kst', budgetBasis: 'current_snapshot',paymentBasis:'paid_on_kst',refundBasis:'refunded_on_kst',processingBasis:'current_state_no_period_filter',paymentScope:'project_all' },
    totals: dashboardTotals(lines), lines,
    recent: [{ id: randomUUID(), projectId: lines[0].projectId, projectName: '@synthetic', title: '  -synthetic,"title"',
      applicationId:null,number:'SYNTHETIC-DRAFT',amount: null, createdAt: '2026-11-06T00:00:00.000Z', state: 'draft' }], projects: [],processing:{review:0,supplement:0,payment:0},
    capabilities: { submission: true, payments: true }, unavailable: { paid: false, review: false } };
  const csv = dashboardCsv(result);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=synthetic"'));
  assert.ok(csv.includes('"\'\t+synthetic"'));
  assert.ok(csv.includes('"\'@synthetic"'));
  assert.ok(csv.includes('"\'  -synthetic,""title"""'));
  assert.ok(csv.includes('9223372036854775807'));
  assert.doesNotMatch(csv, /applicant|token|postgresql:\/\//);
});

test('dashboard DB: scoped budgets/drafts, exact shared snapshot, filters and reassignment',
  { skip: !process.env.TEST_MIGRATION_DATABASE_URL || !process.env.TEST_DATABASE_URL }, async t => {
  const ownerUrl = assertLocalDatabase(requiredUrl('TEST_MIGRATION_DATABASE_URL'), 'boot_erp_test', 'owner');
  const appUrl = assertLocalDatabase(requiredUrl('TEST_DATABASE_URL'), 'boot_erp_test', 'app');
  const schema = `foundation_test_${randomUUID().replaceAll('-', '')}`;
  const owner = new Client({ connectionString: ownerUrl });
  const url = new URL(appUrl); url.searchParams.set('options', `-c search_path=${schema},public`);
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  let created = false;
  await owner.connect();
  try {
    await owner.query(`CREATE SCHEMA ${schema}`); created = true;
    assert.equal(await migrate(ownerUrl, schema),7);
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO boot_erp_test_app`);
    await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO boot_erp_test_app`);
    await owner.query(`REVOKE ALL ON ${schema}.migration_history FROM boot_erp_test_app`);
    await owner.query(`SET search_path TO ${schema},public`);
    async function actor(role: string) {
      const id = randomUUID(), email = `${id}@example.invalid`;
      await owner.query('INSERT INTO users(id,role,active) VALUES($1,$2,true)', [id, role]);
      await owner.query('INSERT INTO login_accounts(user_id,email,binding_allowed) VALUES($1,$2,true)', [id, email]);
      await owner.query(`INSERT INTO email_ownership_checks(id,user_id,email,outcome,method,checked_by,checked_at)
        VALUES($1,$2,$3,'verified','synthetic',$2,clock_timestamp())`, [randomUUID(), id, email]);
      return { id, token: await issueSession(pool, { provider: 'google', issuer: 'https://accounts.google.com', subject: id, email }) };
    }
    const staff = await actor('staff'), admin = await actor('admin'), ra = await actor('researcher'),
      rb = await actor('researcher'), pi = await actor('principal_investigator'), outsider = await actor('researcher');
    async function project(year: number, name: string) {
      const id = randomUUID();
      await owner.query("INSERT INTO projects(id,code,name,kind,business_year) VALUES($1,$2,$3,'research',$4)", [id, id, name, year]);
      return id;
    }
    const p = await project(2026, 'Synthetic shared'), other = await project(2025, 'Synthetic other');
    for (const u of [ra, rb, pi]) await owner.query(`INSERT INTO project_memberships(id,project_id,user_id,starts_at)
      VALUES($1,$2,$3,CURRENT_TIMESTAMP)`, [randomUUID(), p, u.id]);
    const workA = randomUUID(), workB = randomUUID(), workOther = randomUUID();
    for (const [id, projectId, assignee] of [[workA, p, ra.id], [workB, p, rb.id], [workOther, other, outsider.id]]) {
      await owner.query(`INSERT INTO work_items(id,project_id,title,description,assigned_to,created_by)
        VALUES($1,$2,'Synthetic work','',$3,$4)`, [id, projectId, assignee, staff.id]);
    }
    const category = randomUUID(), codeVersion = randomUUID();
    await owner.query("INSERT INTO budget_codes(id,code,level) VALUES($1,'N91',1)", [category]);
    await owner.query(`INSERT INTO budget_code_versions(id,code_id,version,name,active,effective_on,actor_id,reason)
      VALUES($1,$2,0,'Synthetic',true,'2026-03-01',$3,'synthetic')`, [codeVersion, category, staff.id]);
    async function line(projectId: string, current: string, committed: string) {
      const id = randomUUID();
      await owner.query(`INSERT INTO budget_lines(id,project_id,internal_label,original_amount)
        VALUES($1,$2,'Synthetic line',$3)`, [id, projectId, current]);
      await owner.query(`INSERT INTO budget_accounts(line_id,code_version_id,classification_snapshot,business_name,business_year,
        academic_year,period_start,period_end,fund,current_amount,committed_amount)
        VALUES($1,$2,'[]','Synthetic',1,2026,'2026-03-01','2026-12-31','Synthetic',$3,$4)`, [id, codeVersion, current, committed]);
      return id;
    }
    const lineA = await line(p, '9007199254740993', '123'), lineB = await line(p, '1000', '200');
    const lineOther=await line(other, '700', '100');
    async function draft(projectId: string, work: string, applicant: string, title: string, at: string) {
      const id = randomUUID();
      await owner.query(`INSERT INTO expense_drafts(id,project_id,work_id,applicant_id,created_at) VALUES($1,$2,$3,$4,$5)`,
        [id, projectId, work, applicant, at]);
      await owner.query(`INSERT INTO expense_draft_versions(id,draft_id,version,data,actor_id,reason)
        VALUES($1,$2,0,$3,$4,'synthetic')`, [randomUUID(), id, JSON.stringify({ title, amount: null }), applicant]);
      return id;
    }
    const draftA = await draft(p, workA, ra.id, 'Synthetic own', '2026-11-05T15:00:00Z');
    const draftB = await draft(p, workB, rb.id, 'Synthetic peer', '2026-11-05T14:59:59Z');
    await draft(other, workOther, outsider.id, 'Synthetic outside', '2026-11-06T00:00:00Z');
    const policy=randomUUID();
    await owner.query("INSERT INTO expense_policy_versions(id,type_key,subtype,version,data,actor_id,reason) VALUES($1,'office','synthetic',0,'{}',$2,'synthetic')",[policy,staff.id]);
    async function spend(projectId:string,workId:string,lineId:string,applicant:string,amount:string,paid:string,state='approved') {
      const id=randomUUID();await owner.query('INSERT INTO spend_cases(id,project_id,applicant_id,budget_line_id) VALUES($1,$2,$3,$4)',[id,projectId,applicant,lineId]);
      await owner.query('INSERT INTO spend_states(case_id,project_id,work_id,amount,paid_amount,state) VALUES($1,$2,$3,$4,$5,$6)',[id,projectId,workId,amount,paid,state]);return id;
    }
    async function submitted(draftId:string,caseId:string,title:string) {
      await owner.query('INSERT INTO expense_applications(id,draft_id,created_by) VALUES($1,$2,$3)',[caseId,draftId,staff.id]);
      await owner.query(`INSERT INTO expense_submission_versions(id,application_id,version,draft_version,policy_version_id,applicable_on,data,policy_snapshot,files_snapshot,actor_id,reason)
        VALUES($1,$2,0,0,$3,'2026-11-01',$4,'{}','[]',$5,'synthetic')`,[randomUUID(),caseId,policy,JSON.stringify({title}),staff.id]);
    }
    async function receipt() {const id=randomUUID();await owner.query("INSERT INTO command_receipts(actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,'{}')",[staff.id,id,'a'.repeat(64)]);return id;}
    async function payment(caseId:string,projectId:string,gross:string,withheld:string,received:string,paidOn:string) {
      const id=randomUUID();await owner.query(`INSERT INTO payment_records(id,case_id,project_id,gross_amount,withheld_amount,net_amount,paid_on,evidence,actor_id,request_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic',$8,$9,'synthetic')`,[id,caseId,projectId,gross,withheld,received,paidOn,staff.id,await receipt()]);return id;
    }
    async function refund(caseId:string,projectId:string,paymentId:string,amount:string,date:string) {
      await owner.query(`INSERT INTO payment_refunds(id,payment_id,case_id,project_id,amount,refunded_on,evidence,actor_id,request_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,'synthetic',$7,$8,'synthetic')`,[randomUUID(),paymentId,caseId,projectId,amount,date,staff.id,await receipt()]);
    }
    const caseA=await spend(p,workA,lineA,ra.id,'100','70'),caseB=await spend(p,workB,lineB,rb.id,'200','40'),caseOther=await spend(other,workOther,lineOther,outsider.id,'100','30');
    await submitted(draftA,caseA,'Synthetic frozen own');await submitted(draftB,caseB,'Synthetic frozen peer');
    for(const caseId of [caseA,caseB,caseOther])await owner.query('INSERT INTO external_claim_links(case_id,document_number,actor_id) VALUES($1,$2,$3)',[caseId,'SYNTHETIC-'+caseId,staff.id]);
    const paymentA=await payment(caseA,p,'50','5','45','2026-11-05');await payment(caseA,p,'20','2','18','2026-11-06');
    const paymentB=await payment(caseB,p,'40','4','36','2026-11-06');await payment(caseOther,other,'30','3','27','2026-11-06');
    await refund(caseA,p,paymentA,'10','2026-11-06');await refund(caseB,p,paymentB,'5','2026-11-06');
    await spend(p,workA,lineA,ra.id,'10','0','submitted');await spend(p,workB,lineB,rb.id,'10','0','supplement');
    for(const kind of ['submitted','rejected','resubmitted'])await owner.query(`INSERT INTO external_claim_attempts(id,case_id,project_id,kind,occurred_on,evidence,actor_id,request_id,reason)
      VALUES($1,$2,$3,$4,'2026-11-01','synthetic',$5,$6,'synthetic')`,[randomUUID(),caseA,p,kind,staff.id,await receipt()]);
    for(let n=0;n<3;n++)await owner.query(`INSERT INTO expense_files(id,draft_id,slot_id,version,filename,label,sha256,content,actor_id,reason)
      VALUES($1,$2,$3,0,'synthetic.pdf','synthetic',$4,$5,$6,'synthetic')`,[randomUUID(),draftA,randomUUID(),'b'.repeat(64),Buffer.from('%PDF-synthetic'),staff.id]);
    await t.test('researcher sees shared balances and only assigned draft; no applicant/peer metadata', async () => {
      const result = await dashboardOverview(pool, ra.token);
      assert.equal(result.projects.length, 1);
      assert.equal(result.lines.length, 2);
      assert.deepEqual(result.recent.map(d => d.id), [draftA]);
      assert.deepEqual(result.totals, { current: '9007199254741993', committed: '323', available: '9007199254741670',paid:'70',withheld:'7',received:'63',refunded:'10',netExecution:'60' });
      assert.equal(result.lines.find(l=>l.id===lineB)?.paid,'0');
      assert.deepEqual(result.unavailable, { paid: false, review: false });
      assert.deepEqual(result.processing,{review:null,supplement:null,payment:null});
      assert.equal(result.recent[0].state,'approved');assert.equal(result.recent[0].title,'Synthetic frozen own');assert.equal(result.recent[0].amount,'100');assert.equal(result.recent[0].applicationId,caseA);
      const json = JSON.stringify(result);
      assert.doesNotMatch(json, /Synthetic peer|Synthetic outside|applicant|email|tokenHash|work_title/);
      assert.ok(!json.includes(rb.id));
    });
    await t.test('PI sees assigned project drafts; managers see all projects; foreign project fails', async () => {
      assert.equal((await dashboardOverview(pool, pi.token)).recent.length, 2);
      assert.equal((await dashboardOverview(pool,pi.token)).totals.paid,'110');
      assert.deepEqual((await dashboardOverview(pool,pi.token)).processing,{review:null,supplement:null,payment:null});
      assert.equal((await dashboardOverview(pool, staff.token)).projects.length, 2);
      assert.equal((await dashboardOverview(pool, admin.token)).recent.length, 3);
      assert.equal((await dashboardOverview(pool, outsider.token)).lines.length, 0);
      await assert.rejects(dashboardOverview(pool, ra.token, { projectId: other }), { code: 'FORBIDDEN' });
      await assert.rejects(dashboardOverview(pool, ra.token, { projectId: randomUUID() }), { code: 'FORBIDDEN' });
      await assert.rejects(dashboardOverview(pool, ''), { code: 'UNAUTHENTICATED' });
    });
    await t.test('year and KST date filter recent drafts; dates never change current balance', async () => {
      const day = await dashboardOverview(pool, pi.token, { projectId: p, year: '2026', from: '2026-11-06', to: '2026-11-06' });
      assert.deepEqual(day.recent.map(d => d.id), [draftA]);
      assert.equal(day.lines.length, 2);
      assert.equal(day.totals.current, '9007199254741993');
      assert.equal(day.totals.paid,'60');assert.equal(day.totals.refunded,'15');assert.equal(day.totals.netExecution,'45');
      const ownDay=await dashboardOverview(pool,ra.token,{projectId:p,from:'2026-11-06',to:'2026-11-06'});
      assert.equal(ownDay.totals.paid,'20');assert.equal(ownDay.totals.refunded,'10');
      const empty = await dashboardOverview(pool, staff.token, { year: '2024' });
      assert.deepEqual(empty.totals, { current: '0', committed: '0', available: '0',paid:'0',withheld:'0',received:'0',refunded:'0',netExecution:'0' });
      assert.equal(empty.recent.length, 0);
    });
    await t.test('R-01/R-02: attachments and claim attempts never multiply financial facts; CSV and period bases agree',async()=>{
      const result=await dashboardOverview(pool,staff.token,{projectId:p});
      assert.equal(result.totals.paid,'110');assert.equal(result.totals.withheld,'11');assert.equal(result.totals.received,'99');assert.equal(result.totals.refunded,'15');assert.equal(result.totals.netExecution,'95');
      assert.deepEqual(result.processing,{review:1,supplement:1,payment:2});
      const noPeriod=await dashboardOverview(pool,staff.token,{projectId:p,from:'2026-01-01',to:'2026-01-02'});
      assert.deepEqual(noPeriod.processing,result.processing);assert.equal(noPeriod.totals.paid,'0');assert.equal(noPeriod.totals.current,result.totals.current);
      const own=await dashboardOverview(pool,ra.token,{projectId:p,from:'2026-11-06',to:'2026-11-06'});
      assert.equal(own.scope.paymentScope,'assigned_work');assert.equal(own.scope.processingBasis,'current_state_no_period_filter');
      const csv=dashboardCsv(result);assert.ok(csv.includes('기간 실제 지급총액'));assert.ok(csv.includes('"합계","","","","9007199254741993","323","9007199254741670","110","11","99","15","95"'));
    });
    await t.test('budgets and recent drafts stay in one repeatable snapshot across a concurrent commit', async () => {
      let triggered = false;
      const wrappedPool = { connect: async () => {
        const c = await pool.connect();
        return { query: async (sql: string, values?: unknown[]) => {
          const result = await c.query(sql, values);
          if (!triggered && sql.includes('FROM projects p JOIN budget_lines')) {
            triggered = true;
            await owner.query('UPDATE budget_accounts SET current_amount=current_amount+100,version=version+1 WHERE line_id=$1', [lineB]);
            await draft(p, workA, ra.id, 'Synthetic concurrent', '2026-11-06T03:00:00Z');
            await payment(caseA,p,'10','1','9','2026-11-06');await owner.query('UPDATE spend_states SET paid_amount=80 WHERE case_id=$1',[caseA]);
          }
          return result;
        }, release: (broken?: boolean) => c.release(broken) };
      } } as unknown as Pool;
      const snapshot = await dashboardOverview(wrappedPool, ra.token);
      assert.equal(triggered, true);
      assert.equal(snapshot.totals.current, '9007199254741993');
      assert.equal(snapshot.recent.length, 1);
      assert.equal(snapshot.totals.paid,'70');
      const after = await dashboardOverview(pool, ra.token);
      assert.equal(after.totals.current, '9007199254742093');
      assert.equal(after.recent.length, 2);
      assert.equal(after.totals.paid,'80');
      assert.equal(snapshot.lines.find(l => l.id === lineA)?.committed, '123');
    });
    await t.test('returned application displays its latest logical state without marking internal approval as paid',async()=>{
      const d=await draft(p,workA,ra.id,'Synthetic returned','2026-11-06T04:00:00Z'),id=await spend(p,workA,lineA,ra.id,'1','0','draft');await submitted(d,id,'Synthetic old snapshot');
      await owner.query(`INSERT INTO budget_events(id,project_id,entity_id,actor_id,request_id,action,reason,before_state,after_state)
        VALUES($1,$2,$3,$4,$5,'application.reject','synthetic','{}','{}')`,[randomUUID(),p,id,staff.id,await receipt()]);
      const row=(await dashboardOverview(pool,ra.token)).recent.find(r=>r.id===d);assert.equal(row?.state,'rejected');assert.equal(row?.title,'Synthetic returned');
    });
    await t.test('reassignment transfers prior drafts; membership removal and account suspension deny access', async () => {
      await owner.query('UPDATE work_items SET assigned_to=$2,version=version+1 WHERE id=$1', [workA, rb.id]);
      assert.equal((await dashboardOverview(pool, ra.token)).recent.length, 0);
      const inherited = await dashboardOverview(pool, rb.token);
      assert.ok(inherited.recent.some(d => d.id === draftA));
      assert.ok(inherited.recent.some(d => d.id === draftB));
      assert.equal(inherited.totals.paid,'120');
      await owner.query('UPDATE project_memberships SET active=false WHERE project_id=$1 AND user_id=$2', [p, rb.id]);
      assert.equal((await dashboardOverview(pool, rb.token)).projects.length, 0);
      await assert.rejects(dashboardOverview(pool, rb.token, { projectId: p }), { code: 'FORBIDDEN' });
      await owner.query('UPDATE users SET active=false WHERE id=$1', [ra.id]);
      await assert.rejects(dashboardOverview(pool, ra.token), { code: 'UNAUTHENTICATED' });
    });
  } finally {
    await pool.end();
    if (created && /^foundation_test_[0-9a-f]{32}$/.test(schema)) {
      // Only this freshly generated schema is removed; public and existing schemas are untouched.
      await owner.query(`DROP SCHEMA ${schema} CASCADE`);
    }
    await owner.end();
  }
});
