import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'node:net';
import {chromium,expect,type Browser,type Page} from '@playwright/test';
import {Client,Pool} from 'pg';
import {migrate} from '../scripts/migrate.mjs';
import {assertLocalDatabase,requiredUrl} from '../scripts/db-config.mjs';
import {issueSession} from '../src/server/google.ts';
import {manageApplication,applicationDetail} from '../src/server/applications.ts';
import {attachDraftFile} from '../src/server/expenses.ts';
import {recordPayment,recordExternalClaim} from '../src/server/payments.ts';

const ownerUrl=assertLocalDatabase(requiredUrl('TEST_MIGRATION_DATABASE_URL'),'boot_erp_test','owner');
const appUrl=assertLocalDatabase(requiredUrl('TEST_DATABASE_URL'),'boot_erp_test','app');
const schema=`foundation_test_${randomUUID().replaceAll('-','')}`,owner=new Client({connectionString:ownerUrl});
const url=new URL(appUrl);url.searchParams.set('options',`-c search_path=${schema},public`);
const pool=new Pool({connectionString:url.toString(),max:5});let created=false,child:ReturnType<typeof spawn>|undefined,browser:Browser|undefined,activePage:Page|undefined;
const input=(data:Record<string,unknown>)=>({requestId:randomUUID(),reason:'가상 통합 화면 검수',...data});
const pdf=Buffer.from('%PDF-1.7\nsynthetic completion evidence only\n%%EOF');
try{
  // A bind check also detects occupied ports which do not answer HTTP.
  for(const host of ['127.0.0.1','::1']){const guard=createServer();try{await new Promise<void>((resolve,reject)=>{guard.once('error',reject);guard.listen(3000,host,resolve);});await new Promise<void>((resolve,reject)=>guard.close(error=>error?reject(error):resolve()));}
    catch(error){if(host!=='::1'||!['EAFNOSUPPORT','EADDRNOTAVAIL'].includes((error as NodeJS.ErrnoException).code??''))throw new Error('Completion UI test port occupied or unavailable');}}
  await owner.connect();await owner.query(`CREATE SCHEMA ${schema}`);created=true;await migrate(ownerUrl,schema);
  await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO boot_erp_test_app`);await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO boot_erp_test_app`);
  await owner.query(`REVOKE ALL ON ${schema}.migration_history FROM boot_erp_test_app`);await owner.query(`SET search_path TO ${schema},public`);
  const tokens:Record<string,string>={},ids:Record<string,string>={};
  for(const [key,role,label]of [['admin','admin','가상 관리자'],['staff','staff','가상 담당자'],['researcher','researcher','가상 연구원'],['peer','researcher','가상 동료'],['pi','principal_investigator','가상 책임자']]){
    const id=randomUUID(),person=randomUUID(),email=`${key}-${id}@example.invalid`;ids[key]=id;
    await owner.query('INSERT INTO people(id,display_name) VALUES($1,$2)',[person,label]);await owner.query('INSERT INTO users(id,person_id,role,active) VALUES($1,$2,$3,true)',[id,person,role]);
    await owner.query('INSERT INTO login_accounts(user_id,email,binding_allowed) VALUES($1,$2,true)',[id,email]);
    await owner.query("INSERT INTO email_ownership_checks(id,user_id,email,outcome,method,checked_by,checked_at) VALUES($1,$2,$3,'verified','synthetic',$2,clock_timestamp())",[randomUUID(),id,email]);
    tokens[key]=await issueSession(pool,{provider:'google',issuer:'https://accounts.google.com',subject:id,email});
  }
  const project=randomUUID(),work=randomUUID(),peerWork=randomUUID(),line=randomUUID(),category=randomUUID(),codeVersion=randomUUID(),policyId=randomUUID();
  await owner.query("INSERT INTO projects(id,code,name,kind,business_year) VALUES($1,'COMPLETION-UI','가상 부트캠프 과제','research',2026)",[project]);
  for(const key of ['researcher','peer','pi'])await owner.query('INSERT INTO project_memberships(id,project_id,user_id,starts_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP)',[randomUUID(),project,ids[key]]);
  for(const [id,assigned,title]of [[work,ids.researcher,'가상 연구 업무'],[peerWork,ids.peer,'동료 비공개 업무']])await owner.query('INSERT INTO work_items(id,project_id,title,description,assigned_to,created_by) VALUES($1,$2,$3,\'\',$4,$5)',[id,project,title,assigned,ids.staff]);
  await owner.query("INSERT INTO budget_codes(id,code,level) VALUES($1,'N93',1)",[category]);await owner.query("INSERT INTO budget_code_versions(id,code_id,version,name,active,effective_on,actor_id,reason) VALUES($1,$2,0,'가상 비목',true,'2026-03-01',$3,'synthetic')",[codeVersion,category,ids.staff]);
  await owner.query("INSERT INTO budget_lines(id,project_id,internal_label,original_amount) VALUES($1,$2,'가상 연구활동비',100000000)",[line,project]);
  await owner.query(`INSERT INTO budget_accounts(line_id,code_version_id,classification_snapshot,business_name,business_year,academic_year,period_start,period_end,fund,current_amount)
    VALUES($1,$2,'[]','가상 사업',1,2026,'2026-03-01','2026-12-31','가상 재원',100000000)`,[line,codeVersion]);
  const policy={status:'verified',source:'가상 시험 기준',sourceVersion:'synthetic-1',clause:'시험 전용',startsOn:'2026-03-01',endsOn:'2026-12-31',rateMode:'apply',rate:'100000000',calculationUnit:'per_item',
    caseLimitMode:'apply',caseLimit:'100000000',periodLimitMode:'apply',periodLimit:'100000000',periodBasis:'business_period',deadlineMode:'not_applicable',calendar:'calendar',holidayDates:[]};
  await owner.query("INSERT INTO expense_policy_versions(id,type_key,subtype,version,data,actor_id,reason) VALUES($1,'office','가상 기준',0,$2,$3,'synthetic')",[policyId,JSON.stringify(policy),ids.staff]);
  const base={type:'office',title:'가상 지급 검수',purpose:'가상 지급 검수용',calculation:'가상 단가 × 수량',dateKind:'planned',useDate:'2026-11-20',amount:'40000000',
    details:{item:'가상 품목',location:'가상 장소',quantity:'1',days:'1',people:'1',hours:'1',unitPrice:'40000000'},items:[],documents:{},lineId:line,policyVersionId:policyId};
  const fixture=await manageApplication(pool,tokens.researcher,input({action:'save',projectId:project,workId:work,...base})) as {draftId:string};
  async function act(draftId:string,action:string,who='researcher',extra:Record<string,unknown>={}){const d=await applicationDetail(pool,tokens[who],draftId);return await manageApplication(pool,tokens[who],input({action,draftId,version:d.item.version,draftVersion:d.item.draftVersion,...extra})) as Record<string,any>;}
  let fd=await applicationDetail(pool,tokens.researcher,fixture.draftId);
  const evidence=await attachDraftFile(pool,tokens.researcher,input({action:'attach',id:fixture.draftId,version:fd.item.draftVersion,file:{name:'synthetic-fixture.pdf',label:'가상 증빙',content:pdf.toString('base64')}})) as {fileId:string};
  await act(fixture.draftId,'save','researcher',{...base,documents:{[evidence.fileId]:['transaction','completion']}});await act(fixture.draftId,'submit');await act(fixture.draftId,'start','staff');await act(fixture.draftId,'approve','staff');
  fd=await applicationDetail(pool,tokens.staff,fixture.draftId);
  await recordExternalClaim(pool,tokens.staff,input({action:'submitted',caseId:fd.item.id,projectId:project,version:fd.item.version,documentNumber:'SYNTHETIC-FIXTURE-1',occurredOn:'2026-11-06',evidence:'가상 실청구 확인'}));
  fd=await applicationDetail(pool,tokens.staff,fixture.draftId);
  await recordPayment(pool,tokens.staff,input({action:'pay',caseId:fd.item.id,projectId:project,version:fd.item.version,grossAmount:'25000000',withheldAmount:'0',netAmount:'25000000',paidOn:'2026-11-06',evidence:'가상 실제 지급 확인'}));
  await manageApplication(pool,tokens.peer,input({action:'save',projectId:project,workId:peerWork,type:'office',dateKind:'planned',title:'동료 전용 초안',details:{}}));
  child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3000'],{windowsHide:true,stdio:'ignore',env:{...process.env,DATABASE_URL:url.toString(),MIGRATION_DATABASE_URL:'',APP_ORIGIN:'http://localhost:3000',AUTH_ENCRYPTION_KEY:'ef'.repeat(32),NEXT_TELEMETRY_DISABLED:'1'}});
  let ready=false;for(let i=0;i<80;i++){if(child.exitCode!==null)throw new Error('Completion UI server stopped');try{if((await fetch('http://localhost:3000/api/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,250));}assert.ok(ready);
  const http=spawn(process.execPath,['scripts/check-http.mjs'],{windowsHide:true,stdio:'inherit',env:{...process.env,TEST_BASE_URL:'http://127.0.0.1:3000'}});
  await new Promise<void>((resolve,reject)=>{http.once('error',reject);http.once('exit',code=>code===0?resolve():reject(new Error('Completion isolated HTTP checks failed')));});
  browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1600,height:1000}}),page=await context.newPage();activePage=page;page.setDefaultTimeout(15000);
  const pageErrors:string[]=[];page.on('pageerror',error=>pageErrors.push(error.message));await mkdir('test-results',{recursive:true});
  async function as(who:string){await page.goto('about:blank');await context.clearCookies();await context.addCookies([{name:'boot_session',value:tokens[who],url:'http://localhost:3000',httpOnly:true,sameSite:'Lax'}]);await page.goto('http://localhost:3000');await expect(page.getByRole('heading',{name:'업무·예산 현황',exact:true})).toBeVisible();await expect(page.locator('.summary-cards').getByText('100,000,000',{exact:false}).first()).toBeVisible();}
  async function menu(name:string){const side=page.getByRole('complementary',{name:'업무 메뉴'});if(!await side.isVisible())await page.getByRole('button',{name:'☰ 메뉴',exact:true}).click();await side.getByRole('button',{name,exact:true}).click();}
  async function openApplication(who:string,title:string){await as(who);await menu(who==='staff'||who==='admin'?'지출 신청·검토':'지출 신청');await page.locator('.applications-panel table tbody tr').filter({hasText:title}).getByRole('button',{name:'상세 보기',exact:true}).click();await expect(page.locator('.applications-panel article.detail')).toBeVisible();}
  const panel=()=>page.locator('.applications-panel');
  async function clickAction(name:string){const response=page.waitForResponse(r=>r.url().endsWith('/api/erp/applications')&&r.request().method()==='POST');await panel().getByRole('button',{name,exact:true}).click();const r=await response;assert.equal(r.status(),200);await expect(panel().getByRole('status')).toContainText('처리했습니다');}
  await as('staff');
  await expect(page.locator('.summary-cards')).toContainText('40,000,000');await expect(page.locator('.summary-cards')).toContainText('60,000,000');await expect(page.locator('.summary-cards')).toContainText('25,000,000');
  await page.screenshot({path:'test-results/completion-dashboard-1600.png',fullPage:true});
  for(const [width,height]of [[1280,800],[375,812]]){await page.setViewportSize({width,height});await expect(page.getByRole('heading',{name:'업무·예산 현황'})).toBeVisible();await page.getByRole('heading',{name:'업무·예산 현황'}).click();await page.screenshot({path:`test-results/completion-dashboard-${width}.png`,fullPage:true});const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth,overflow:[...document.querySelectorAll('body *')].map(e=>({tag:e.tagName,cls:e.className,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width})).filter(e=>e.right>innerWidth+1).slice(0,15)}));assert.ok(dimensions.scroll<=dimensions.viewport,JSON.stringify({width,...dimensions}));await page.getByRole('link',{name:'본문 바로가기'}).focus();await page.keyboard.press('Enter');await expect(page.getByRole('main')).toBeFocused();}
  await page.setViewportSize({width:1600,height:1000});
  for(const who of ['researcher','peer','pi','admin']){await as(who);if(who==='researcher')await expect(page.getByText('동료 전용 초안',{exact:true})).toHaveCount(0);if(who==='pi')await expect(page.getByText('동료 전용 초안',{exact:true})).toBeVisible();if(who==='researcher'||who==='pi')await expect(page.getByRole('button',{name:'계정 관리',exact:true})).toHaveCount(0);}
  await as('researcher');await menu('지출 신청');
  const form=panel().locator('form.editor').filter({has:page.getByRole('button',{name:'초안·보완 저장',exact:true})});
  await form.getByLabel('배정 업무',{exact:true}).selectOption(work);await form.getByLabel('제목',{exact:true}).fill('가상 UI 신청');await form.getByLabel('예산항목',{exact:true}).selectOption(line);
  await form.getByLabel('사용일',{exact:true}).fill('2026-11-20');await form.getByLabel('금액 (원)',{exact:true}).fill('200');await form.getByLabel('목적·내용',{exact:true}).fill('가상 UI 목적');await form.getByLabel('금액 산출근거',{exact:true}).fill('2 × 100');
  await form.getByLabel('품명·규격',{exact:true}).fill('가상 사무용품');await form.getByLabel('사용·수령 장소',{exact:true}).fill('가상 연구실');await form.getByLabel('수량',{exact:true}).fill('2');await form.getByLabel('단가 (원)',{exact:true}).fill('100');await form.getByLabel('적용 기준',{exact:true}).selectOption(policyId);await form.getByLabel('저장 사유',{exact:true}).fill('가상 UI 생성');
  await clickAction('초안·보완 저장');
  await form.getByLabel('제목',{exact:true}).fill('저장 전 입력 유지');page.once('dialog',dialog=>void dialog.dismiss());await panel().getByRole('button',{name:'제출본·이력',exact:true}).click();await expect(form.getByLabel('제목',{exact:true})).toHaveValue('저장 전 입력 유지');
  await form.getByLabel('수량',{exact:true}).fill('not-a-number');await form.getByLabel('저장 사유',{exact:true}).fill('가상 실패 검수');
  const failedResponse=page.waitForResponse(r=>r.url().endsWith('/api/erp/applications')&&r.request().method()==='POST');await form.getByRole('button',{name:'초안·보완 저장'}).click();assert.equal((await failedResponse).status(),400);await expect(form.getByLabel('수량',{exact:true})).toHaveValue('not-a-number');
  page.once('dialog',dialog=>void dialog.dismiss());await menu('과제·비교과');await expect(form.getByLabel('제목',{exact:true})).toHaveValue('저장 전 입력 유지');
  await form.getByLabel('제목',{exact:true}).fill('가상 UI 신청');await form.getByLabel('수량',{exact:true}).fill('2');await clickAction('초안·보완 저장');
  await panel().getByRole('button',{name:'첨부·검토',exact:true}).click();const upload=panel().locator('form.editor').filter({has:page.getByRole('button',{name:'비공개 첨부 저장',exact:true})});
  await upload.getByLabel('자료 설명',{exact:true}).fill('가상 UI 증빙');await upload.getByLabel('파일',{exact:true}).setInputFiles({name:'synthetic-ui.pdf',mimeType:'application/pdf',buffer:pdf});await upload.getByLabel('첨부 사유',{exact:true}).fill('가상 UI 첨부');await upload.getByRole('button',{name:'비공개 첨부 저장'}).click();await expect(panel().getByRole('status')).toContainText('첨부했습니다');
  await panel().getByLabel('거래·청구 근거',{exact:true}).check();await panel().getByLabel('납품·수령·수행 확인',{exact:true}).check();await panel().getByLabel('분류 저장 사유',{exact:true}).fill('가상 서류 역할');await clickAction('서류 역할 저장');
  await panel().getByLabel('처리 사유',{exact:true}).fill('가상 제출');await clickAction('신청 제출');
  const draftId=(await owner.query("SELECT d.id FROM expense_drafts d JOIN expense_draft_versions v ON v.draft_id=d.id AND v.version=d.version WHERE v.data->>'title'='가상 UI 신청'")).rows[0].id;
  await openApplication('staff','가상 UI 신청');await panel().getByLabel('처리 사유',{exact:true}).fill('가상 처리 시작');await clickAction('처리 시작');await panel().getByLabel('처리 사유',{exact:true}).fill('가상 보완 요청');await clickAction('보완 요청');
  await openApplication('researcher','가상 UI 신청');await panel().getByLabel('처리 사유',{exact:true}).fill('가상 동일금액 보완 제출');await clickAction('보완 제출');
  await openApplication('staff','가상 UI 신청');await panel().getByLabel('처리 사유',{exact:true}).fill('가상 내부 승인');await clickAction('내부 승인');
  const completed=await applicationDetail(pool,tokens.staff,draftId);assert.equal(completed.item.state,'approved');assert.equal(completed.submissions.length,2);
  await menu('실청구·지급');await page.locator('.budget-table tbody tr').filter({hasText:'200원'}).getByRole('button',{name:'상세 보기',exact:true}).click();
  await page.getByText('실청구·반려·재상신 사실 기록',{exact:true}).click();const claimForm=page.locator('form.editor').filter({has:page.getByRole('button',{name:'실청구 사실 기록',exact:true})});
  await claimForm.getByLabel('대학 ERP 문서번호',{exact:true}).fill('SYNTHETIC-UI-2');await claimForm.getByLabel('처리일',{exact:true}).fill('2026-11-06');await claimForm.getByLabel('실제 사실 확인 근거',{exact:true}).fill('가상 UI 실청구');await claimForm.getByLabel('처리 사유',{exact:true}).fill('가상 실청구 기록');const claimResponse=page.waitForResponse(r=>r.url().endsWith('/api/erp/external-claims')&&r.request().method()==='POST');await claimForm.getByRole('button',{name:'실청구 사실 기록'}).click();assert.equal((await claimResponse).status(),200);await expect(page.getByRole('status').filter({hasText:'기록했습니다'})).toBeVisible();
  await page.getByText('부분·실제 지급 기록',{exact:true}).click();
  const payForm=page.locator('form.editor').filter({has:page.getByRole('button',{name:'실제 지급 기록',exact:true})});await payForm.getByLabel('실제 지급일',{exact:true}).fill('2026-11-06');await payForm.getByLabel('지급 총액(원)',{exact:true}).fill('200');await payForm.getByLabel('공제 금액(원)',{exact:true}).fill('0');await payForm.getByLabel('실수령액(원)',{exact:true}).fill('200');await payForm.getByLabel('실제 사실 확인 근거',{exact:true}).fill('가상 지급 확인');await payForm.getByLabel('처리 사유',{exact:true}).fill('가상 UI 지급');const payResponse=page.waitForResponse(r=>r.url().endsWith('/api/erp/payments')&&r.request().method()==='POST');await payForm.getByRole('button',{name:'실제 지급 기록'}).click();assert.equal((await payResponse).status(),200);await expect(page.getByRole('status').filter({hasText:'기록했습니다'})).toBeVisible();
  assert.equal((await owner.query('SELECT paid_amount FROM spend_states WHERE case_id=$1',[completed.item.id])).rows[0].paid_amount,'200');assert.equal((await owner.query('SELECT committed_amount FROM budget_accounts WHERE line_id=$1',[line])).rows[0].committed_amount,'40000200');
  await page.screenshot({path:'test-results/completion-payment-ui.png',fullPage:true});
  await page.getByText('실제 환입 기록',{exact:true}).click();const refundForm=page.locator('form.editor').filter({has:page.getByRole('button',{name:'환입 사실 기록',exact:true})});
  await refundForm.getByLabel('환입 금액(원)',{exact:true}).fill('50');await refundForm.getByLabel('실제 환입일',{exact:true}).fill('2026-11-06');await refundForm.getByLabel('실제 사실 확인 근거',{exact:true}).fill('가상 실제 환입 확인');await refundForm.getByLabel('같은 사용연차·기간의 예산복원을 명시적으로 확인합니다.',{exact:true}).check();await refundForm.getByLabel('예산복원 확인일',{exact:true}).fill('2026-11-06');await refundForm.getByLabel('처리 사유',{exact:true}).fill('가상 환입·복원');
  const refundResponse=page.waitForResponse(r=>r.url().endsWith('/api/erp/payments')&&r.request().method()==='POST');await refundForm.getByRole('button',{name:'환입 사실 기록'}).click();assert.equal((await refundResponse).status(),200);await expect(page.locator('article.detail')).toContainText('예산복원 확인');
  assert.equal((await owner.query('SELECT committed_amount FROM budget_accounts WHERE line_id=$1',[line])).rows[0].committed_amount,'40000150');
  assert.equal((await owner.query('SELECT sum(amount)::text total FROM payment_refunds WHERE case_id=$1',[completed.item.id])).rows[0].total,'50');
  const closeForm=page.locator('form.editor').filter({has:page.getByRole('button',{name:'정합성 확인 후 마감',exact:true})});await closeForm.getByLabel('처리 사유',{exact:true}).fill('가상 대조 후 마감');const closeResponse=page.waitForResponse(r=>r.url().endsWith('/api/erp/settlements')&&r.request().method()==='POST');await closeForm.getByRole('button',{name:'정합성 확인 후 마감'}).click();assert.equal((await closeResponse).status(),200);await expect(page.locator('article.detail')).toContainText('· 마감');
  const reopenForm=page.locator('form.editor').filter({has:page.getByRole('button',{name:'사유를 남기고 재개방',exact:true})});await reopenForm.getByLabel('처리 사유',{exact:true}).fill('가상 정정 검토 재개방');const reopenResponse=page.waitForResponse(r=>r.url().endsWith('/api/erp/settlements')&&r.request().method()==='POST');await reopenForm.getByRole('button',{name:'사유를 남기고 재개방'}).click();assert.equal((await reopenResponse).status(),200);await expect(page.locator('article.detail')).toContainText('진행 중');
  assert.deepEqual((await owner.query('SELECT action FROM settlement_events WHERE case_id=$1 ORDER BY created_at,id',[completed.item.id])).rows.map(r=>r.action),['close','reopen']);
  await menu('대시보드');await expect(page.locator('.summary-cards')).toContainText('40,000,150');await expect(page.locator('.summary-cards')).toContainText('59,999,850');await expect(page.locator('.summary-cards')).toContainText('25,000,200');await expect(page.locator('.dashboard')).toContainText('25,000,150');await page.screenshot({path:'test-results/completion-refund-dashboard.png',fullPage:true});
  let matrixChecks=0;
  async function widthCheck(label:string){const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(dimensions.scroll<=dimensions.viewport,JSON.stringify({label,...dimensions}));}
  for(const who of ['staff','researcher','pi','admin']){
    await as(who);const manager=who==='staff'||who==='admin';
    for(const [width,height]of [[1600,1000],[1280,800],[375,812]]){
      await page.setViewportSize({width,height});
      const pages:[string,string][]=[['대시보드','업무·예산 현황'],[manager?'전체 업무':'내 업무',manager?'전체 업무':'배정 업무'],['과제·비교과','과제·비교과'],['예산배정·변경','예산배정·변경'],[manager?'지출 신청·검토':'지출 신청','지출 신청·증빙'],['지출 초안·증빙','지출 초안·증빙'],['단가·한도 기준','지출 초안·증빙'],['실청구·지급','실청구·지급']];
      for(const [nav,heading]of pages){
        await menu(nav);await expect(page.getByRole('heading',{name:heading,exact:true}).first()).toBeVisible();
        if(nav==='예산배정·변경'){await page.getByLabel('예산 과제·비교과',{exact:true}).selectOption(project);await expect(page.getByRole('heading',{name:'항목별 예산',exact:true})).toBeVisible();}
        if(nav==='지출 신청'||nav==='지출 신청·검토'){
          if(who==='pi')await expect(panel().getByRole('button',{name:'초안·보완 저장',exact:true})).toHaveCount(0);
          if(width===375){await widthCheck(`${who}/375/application-draft-form`);await panel().locator('table tbody tr').filter({hasText:'가상 UI 신청'}).getByRole('button',{name:'상세 보기',exact:true}).click();await panel().getByRole('button',{name:'첨부·검토',exact:true}).click();await expect(panel().getByRole('link',{name:'synthetic-ui.pdf',exact:true})).toBeVisible();await widthCheck(`${who}/375/application-files`);await panel().getByRole('button',{name:'제출본·이력',exact:true}).click();await expect(panel().getByRole('heading',{name:'제출본·기준·첨부 보존',exact:true})).toBeVisible();await widthCheck(`${who}/375/application-history`);}
        }
        if(nav==='실청구·지급'&&width===375){await page.locator('.budget-table tbody tr').filter({hasText:'200원'}).getByRole('button',{name:'상세 보기',exact:true}).click();await expect(page.getByRole('heading',{name:'실제 지급 이력',exact:true})).toBeVisible();await widthCheck(`${who}/375/payment-detail`);if(!manager)await expect(page.getByRole('button',{name:'실제 지급 기록',exact:true})).toHaveCount(0);else{for(const summary of ['실청구·반려·재상신 사실 기록','부분·실제 지급 기록','실제 환입 기록'])await page.getByText(summary,{exact:true}).click();await widthCheck(`${who}/375/payment-forms`);}}
        await widthCheck(`${who}/${width}/${nav}`);matrixChecks++;
      }
      assert.equal(await page.locator('#erp-sidebar button[aria-label="계정 관리"]').count(),manager?1:0);
      if(manager){await menu('계정 관리');await expect(page.getByRole('heading',{name:'계정 관리',exact:true})).toBeVisible();await widthCheck(`${who}/${width}/accounts`);matrixChecks++;
        await page.locator('header .user-menu summary').click();const popup=await page.locator('header .user-menu>div').boundingBox();if(width===375)await page.screenshot({path:`test-results/completion-user-menu-${who}-375.png`,fullPage:true});await page.locator('header .user-menu').getByRole('button',{name:'추가 본인 확인',exact:true}).click();await expect(page.getByRole('heading',{name:'추가 본인 확인',exact:true})).toBeVisible();await page.locator('header .user-menu summary').click();assert.ok(popup&&popup.x>=0&&popup.x+popup.width<=width,JSON.stringify({label:`${who}/${width}/user-menu`,popup}));await widthCheck(`${who}/${width}/security`);matrixChecks++;}
    }
  }
  assert.equal(matrixChecks,108);
  await as('staff');await page.setViewportSize({width:375,height:812});await menu('예산배정·변경');await page.getByLabel('예산 과제·비교과',{exact:true}).selectOption(project);await page.getByText('예산변경 신청',{exact:true}).click();const budgetForm=page.locator('form.editor').filter({has:page.getByRole('button',{name:'변경 신청 제출',exact:true})});await budgetForm.getByLabel('가상 연구활동비 변경 후 금액',{exact:true}).fill('99999999');page.once('dialog',dialog=>void dialog.dismiss());await page.getByLabel('예산 과제·비교과',{exact:true}).selectOption('');await expect(page.getByLabel('예산 과제·비교과',{exact:true})).toHaveValue(project);await expect(budgetForm.getByLabel('가상 연구활동비 변경 후 금액',{exact:true})).toHaveValue('99999999');await widthCheck('staff/375/budget-unsaved');page.once('dialog',dialog=>void dialog.accept());await menu('대시보드');
  assert.deepEqual(pageErrors,[]);
  console.log('Completion UI passed: 108 role/page/viewport checks plus narrow application evidence/history/payment detail; dashboard 100m/40m/60m/25m; unsaved and failed input retention; request→supplement→approval→claim→payment→refund/restore→close/reopen→dashboard.');
}catch(error){if(activePage)await activePage.screenshot({path:'test-results/completion-ui-failure.png',fullPage:true}).catch(()=>{});console.error(error instanceof Error?error.stack:'Completion UI checks failed');process.exitCode=1;}
finally{await browser?.close();if(child&&child.exitCode===null){child.kill();await once(child,'exit');}await pool.end();if(created&&/^foundation_test_[0-9a-f]{32}$/.test(schema))await owner.query(`DROP SCHEMA ${schema} CASCADE`);await owner.end();}
