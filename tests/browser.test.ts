import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium,expect,type Browser } from '@playwright/test';
import { Pool,Client } from 'pg';
import { TOTP,Secret } from 'otpauth';
import { migrate } from '../scripts/migrate.mjs';
import { assertLocalDatabase,requiredUrl } from '../scripts/db-config.mjs';
import { issueSession } from '../src/server/google.ts';
import { hash } from '../src/server/security.ts';

const ownerUrl=assertLocalDatabase(requiredUrl('TEST_MIGRATION_DATABASE_URL'),'boot_erp_test','owner');
const appUrl=assertLocalDatabase(requiredUrl('TEST_DATABASE_URL'),'boot_erp_test','app');
const schema=`foundation_test_${randomUUID().replaceAll('-','')}`,owner=new Client({connectionString:ownerUrl});
const url=new URL(appUrl);url.searchParams.set('options',`-c search_path=${schema},public`);
const pool=new Pool({connectionString:url.toString()});let created=false,child:ReturnType<typeof spawn>|undefined,browser:Browser|undefined;
try{
  // Never attach tests to another app already occupying the OAuth origin.
  try{await fetch('http://localhost:3000',{signal:AbortSignal.timeout(500)});throw new Error('UI test port occupied');}catch(e){if(e instanceof Error&&e.message==='UI test port occupied')throw e;}
  await owner.connect();await owner.query(`CREATE SCHEMA ${schema}`);created=true;await migrate(ownerUrl,schema);
  await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO boot_erp_test_app`);await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO boot_erp_test_app`);
  await owner.query(`REVOKE ALL ON ${schema}.migration_history FROM boot_erp_test_app`);await owner.query(`SET search_path TO ${schema},public`);
  const project=randomUUID(),admin=randomUUID(),researcher=randomUUID(),pi=randomUUID(),staff=randomUUID(),peer=randomUUID();
  const tokens:Record<string,string>={};
  for(const [id,role,label] of [[admin,'admin','가상 관리자'],[researcher,'researcher','가상 연구원'],[pi,'principal_investigator','가상 책임자'],[staff,'staff','가상 담당자'],[peer,'researcher','가상 동료 연구원']]){
    const person=randomUUID(),email=`${role}-${id}@example.invalid`;
    await owner.query('INSERT INTO people(id,display_name) VALUES($1,$2)',[person,label]);await owner.query('INSERT INTO users(id,person_id,role,active) VALUES($1,$2,$3,true)',[id,person,role]);
    await owner.query('INSERT INTO login_accounts(user_id,email,binding_allowed) VALUES($1,$2,true)',[id,email]);
    await owner.query("INSERT INTO email_ownership_checks(id,user_id,email,outcome,method,checked_by,checked_at) VALUES($1,$2,$3,'verified','synthetic ownership',$2,clock_timestamp())",[randomUUID(),id,email]);
    tokens[id]=await issueSession(pool,{provider:'google',issuer:'https://accounts.google.com',subject:id,email});
  }
  await owner.query("INSERT INTO projects(id,code,name,kind,business_year) VALUES($1,'UI-TEST','가상 연구 과제','research',2026)",[project]);
  for(const id of [researcher,pi,peer])await owner.query('INSERT INTO project_memberships(id,project_id,user_id,starts_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP)',[randomUUID(),project,id]);
  for(const [id,title] of [[researcher,'내 연구 업무'],[peer,'동료 비공개 업무']])await owner.query('INSERT INTO work_items(id,project_id,title,description,assigned_to,created_by) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),project,title,'가상 업무 설명',id,staff]);
  child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3000'],{windowsHide:true,stdio:'ignore',env:{...process.env,DATABASE_URL:url.toString(),MIGRATION_DATABASE_URL:'',APP_ORIGIN:'http://localhost:3000',AUTH_ENCRYPTION_KEY:'cd'.repeat(32),NEXT_TELEMETRY_DISABLED:'1'}});
  let ready=false;for(let n=0;n<60;n++){if(child.exitCode!==null)throw new Error('UI test server stopped');try{if((await fetch('http://localhost:3000/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(ready);
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();
  page.setDefaultTimeout(15000);
  const pageErrors:string[]=[];page.on('pageerror',e=>pageErrors.push(e.message));
  await page.goto('http://localhost:3000');await expect(page.getByRole('button',{name:'Google 계정으로 로그인'})).toBeVisible();
  await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/phase-02-login.png',fullPage:true});
  // Stop the old page's session polling before selecting a different fixture user.
  // The separate live account-replacement check below still exercises that polling.
  const as=async(id:string)=>{await page.goto('about:blank');await context.clearCookies();await context.addCookies([{name:'boot_session',value:tokens[id],url:'http://localhost:3000',httpOnly:true,sameSite:'Lax'}]);await page.goto('http://localhost:3000');};
  await as(admin);await expect(page.getByRole('button',{name:'계정 관리',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'동료 비공개 업무',exact:true})).toBeVisible();
  await owner.query("UPDATE auth_sessions SET issued_at=issued_at-INTERVAL '6 minutes',expires_at=expires_at-INTERVAL '6 minutes' WHERE token_hash=$1",[hash(tokens[admin])]);
  await page.getByRole('button',{name:'추가 본인 확인',exact:true}).click();
  await page.getByRole('button',{name:'인증 앱 등록 키 보기',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('인증 앱 등록 시간이 만료되었습니다');
  await expect(page.getByRole('button',{name:'Google로 다시 로그인',exact:true})).toBeVisible();
  await owner.query("UPDATE auth_sessions SET issued_at=issued_at+INTERVAL '6 minutes',expires_at=expires_at+INTERVAL '6 minutes' WHERE token_hash=$1",[hash(tokens[admin])]);
  await page.getByRole('button',{name:'인증 앱 등록 키 보기',exact:true}).click();
  await expect(page.locator('.secret code')).toBeVisible();
  const secret=await page.locator('.secret code').textContent();assert.ok(secret);
  await page.getByLabel('인증 앱 코드',{exact:true}).fill(new TOTP({secret:Secret.fromBase32(secret)}).generate());
  await page.getByRole('button',{name:'코드 확인',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('추가 본인 확인을 완료했습니다');
  assert.equal((await owner.query('SELECT confirmed FROM otp_credentials WHERE user_id=$1',[admin])).rows[0].confirmed,true);
  await page.getByRole('button',{name:'과제·비교과',exact:true}).click();await page.getByText('과제·비교과 등록',{exact:true}).click();
  await page.getByLabel('관리 코드',{exact:true}).fill('UI-CREATED');await page.getByLabel('과제·비교과 이름',{exact:true}).fill('화면 등록 시험');await page.getByLabel('등록·변경 사유',{exact:true}).fill('가상 UI 검수');await page.getByRole('button',{name:'저장',exact:true}).click();
  await expect(page.getByRole('button',{name:'화면 등록 시험',exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/phase-02-admin.png',fullPage:true});
  await as(researcher);await expect(page.getByRole('button',{name:'내 연구 업무',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'동료 비공개 업무',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'계정 관리',exact:true})).toHaveCount(0);
  assert.equal(await page.evaluate(()=>localStorage.length),0);
  // Idle warning is tested without sending an activity event after moving the DB clock.
  await owner.query("UPDATE auth_sessions SET issued_at=issued_at-INTERVAL '14 minutes',last_seen_at=last_seen_at-INTERVAL '14 minutes',expires_at=expires_at-INTERVAL '14 minutes' WHERE token_hash=$1",[hash(tokens[researcher])]);
  await expect(page.locator('.warning')).toBeVisible({timeout:25000});await page.getByRole('button',{name:'계속 사용',exact:true}).click();await expect(page.locator('.warning')).toHaveCount(0,{timeout:25000});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/phase-02-researcher-mobile.png',fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await as(pi);await expect(page.getByRole('button',{name:'동료 비공개 업무',exact:true})).toBeVisible();await expect(page.getByText('업무 등록',{exact:true})).toHaveCount(0);
  await as(staff);await expect(page.getByRole('button',{name:'계정 관리',exact:true})).toBeVisible();
  console.log('Browser: start budget workflow');await page.getByRole('button',{name:'예산배정·변경',exact:true}).click();
  await expect(page.getByRole('heading',{name:'예산배정·변경',exact:true})).toBeVisible();
  await page.getByLabel('예산 과제·비교과',{exact:true}).selectOption(project);
  await page.getByText('분류코드 관리',{exact:true}).click();
  const codeForm=page.locator('form').filter({has:page.getByRole('button',{name:'분류 등록 승인',exact:true})});
  for(const [level,code,name,parent] of [['1','N91','가상 비목',''],['2','N91.01','가상 세목','N91'],['3','N91.01.001','가상 세세목','N91.01']]){
    await codeForm.getByLabel('분류 단계',{exact:true}).selectOption(level);await codeForm.getByLabel('관리코드',{exact:true}).fill(code);await codeForm.getByLabel('분류명',{exact:true}).fill(name);
    if(parent){const parentId=(await owner.query('SELECT id FROM budget_codes WHERE code=$1',[parent])).rows[0].id;await codeForm.getByLabel('부모 분류',{exact:true}).selectOption(parentId);}
    await codeForm.getByLabel('처리 사유',{exact:true}).fill('가상 분류 검수');await codeForm.getByRole('button',{name:'분류 등록 승인',exact:true}).click();
    await expect(page.getByRole('button',{name:code+' · '+name,exact:true})).toBeVisible();
  }
  await page.getByText('예산 최초 배정',{exact:true}).click();
  const allocationForm=page.locator('form').filter({has:page.getByRole('button',{name:'예산 배정',exact:true})});
  for(const label of ['가상 예산 A','가상 예산 B']){
    await allocationForm.getByLabel('예산항목 이름',{exact:true}).fill(label);await allocationForm.getByLabel('재원',{exact:true}).fill('가상 재원');
    await allocationForm.getByLabel('최초 배정액 (원)',{exact:true}).fill('1000000');await allocationForm.getByLabel('처리 사유',{exact:true}).fill('가상 최초 배정');await allocationForm.getByRole('button',{name:'예산 배정',exact:true}).click();
    await expect(page.getByRole('button',{name:label,exact:true})).toBeVisible();
  }
  console.log('Browser: researcher budget change');await as(researcher);await page.getByRole('button',{name:'예산배정·변경',exact:true}).click();await page.getByLabel('예산 과제·비교과',{exact:true}).selectOption(project);
  await page.getByText('예산변경 신청',{exact:true}).click();
  const changeForm=page.locator('form').filter({has:page.getByRole('button',{name:'변경 신청 제출',exact:true})});
  await changeForm.getByLabel('가상 예산 A 변경 후 금액',{exact:true}).fill('700000');await changeForm.getByLabel('가상 예산 B 변경 후 금액',{exact:true}).fill('1300000');
  await changeForm.getByLabel('처리 사유',{exact:true}).fill('가상 UI 항목 간 이동');
  await changeForm.locator('input[type=file]').setInputFiles({name:'synthetic-budget.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\nsynthetic UI fixture\n%%EOF')});
  await changeForm.getByRole('button',{name:'변경 신청 제출',exact:true}).click();await expect(page.getByRole('button',{name:'가상 UI 항목 간 이동',exact:true})).toBeVisible();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  console.log('Browser: staff confirmation');await as(staff);await page.getByRole('button',{name:'예산배정·변경',exact:true}).click();await page.getByLabel('예산 과제·비교과',{exact:true}).selectOption(project);
  for(const action of ['review','confirm']){
    await page.getByRole('button',{name:'가상 UI 항목 간 이동',exact:true}).click();
    const review=page.locator('form').filter({has:page.getByRole('button',{name:'변경 처리',exact:true})});
    await review.getByLabel('처리 선택',{exact:true}).selectOption(action);await review.getByLabel('처리 사유',{exact:true}).fill('가상 검토 '+action);await review.getByRole('button',{name:'변경 처리',exact:true}).click();
    await expect(page.getByRole('heading',{name:'변경신청 상세',exact:true})).toHaveCount(0);
  }
  await expect(page.locator('tbody tr').filter({has:page.getByRole('button',{name:'가상 예산 A',exact:true})})).toContainText('700,000원');
  await page.getByRole('button',{name:'가상 UI 항목 간 이동',exact:true}).click();
  const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'synthetic-budget.pdf 내려받기',exact:true}).click();const download=await downloadPromise;
  assert.equal(download.suggestedFilename(),'synthetic-budget.pdf');assert.equal(await download.failure(),null);
  await page.screenshot({path:'test-results/phase-03-budget-mobile.png',fullPage:true});
  await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'test-results/phase-03-budget.png',fullPage:true});
  console.log('Browser: start phase 04 limited workflow');
  await page.getByRole('button',{name:'지출 초안·증빙',exact:true}).click();
  await page.getByRole('button',{name:'단가·한도 설정',exact:true}).click();
  await page.getByLabel('세부 구분 (예: 국내, 업체)',{exact:true}).fill('가상 UI 기준');
  await page.getByLabel('기준 등록·변경 사유',{exact:true}).fill('가상 기준 검수');
  await page.getByRole('button',{name:'기준 버전 저장',exact:true}).click();
  await expect(page.getByRole('button',{name:'사무용품 · 가상 UI 기준 · 버전 0 · 확인 필요',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'사무용품 · 가상 UI 기준 · 버전 0 · 확인 필요',exact:true}).click();
  await page.getByLabel('확인 상태',{exact:true}).selectOption('verified');
  await page.getByLabel('계산 단위',{exact:true}).fill('개');
  await page.getByLabel('단가 (원) (정수)',{exact:true}).fill('1000');
  await page.getByLabel('근거 자료명',{exact:true}).fill('가상 기준');
  await page.getByLabel('자료 버전',{exact:true}).fill('가상 v1');
  await page.getByLabel('근거 항목',{exact:true}).fill('시험용 항목');
  await page.getByLabel('적용 시작일',{exact:true}).fill('2026-03-01');
  await page.getByLabel('기준 등록·변경 사유',{exact:true}).fill('가상 확인 기록');
  await page.getByRole('button',{name:'기준 버전 저장',exact:true}).click();
  await expect(page.getByRole('button',{name:'사무용품 · 가상 UI 기준 · 버전 1 · 확인 완료',exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/phase-04-settings.png',fullPage:true});
  await as(researcher);await page.getByRole('button',{name:'지출 초안·증빙',exact:true}).click();
  const workId=(await owner.query('SELECT id FROM work_items WHERE assigned_to=$1',[researcher])).rows[0].id;
  await page.getByLabel('배정 업무',{exact:true}).selectOption(workId);
  await page.getByLabel('제목',{exact:true}).fill('가상 지출 초안');
  await page.getByLabel('저장·수정 사유',{exact:true}).fill('가상 초안 생성');
  await page.getByRole('button',{name:'초안 저장',exact:true}).click();
  await expect(page.getByRole('heading',{name:'가상 지출 초안',exact:true})).toBeVisible();
  const draftId=(await owner.query('SELECT id FROM expense_drafts WHERE work_id=$1',[workId])).rows[0].id;
  const lineId=(await owner.query("SELECT id FROM budget_lines WHERE internal_label='가상 예산 A'")).rows[0].id;
  await page.getByLabel('예산항목 (초안에서는 미선택 가능)',{exact:true}).selectOption(lineId);
  await page.getByLabel('금액 (원 단위 정수, 초안에서는 미입력 가능)',{exact:true}).fill('12345');
  await page.getByLabel('사용일 (초안 기록용)',{exact:true}).fill('2026-10-20');
  await page.getByLabel('목적·내용',{exact:true}).fill('가상 자료로만 시험');
  await page.getByLabel('저장·수정 사유',{exact:true}).fill('가상 초안 수정');
  await page.getByRole('button',{name:'초안 저장',exact:true}).click();
  await expect(page.getByText('저장했습니다. 신청 제출·승인은 아직 제공하지 않습니다.',{exact:true})).toBeVisible();
  await expect(page.getByLabel('예산항목 (초안에서는 미선택 가능)',{exact:true})).toHaveValue(lineId);
  await page.getByLabel('자료 설명 (필수서류 자동 판정 없음)',{exact:true}).fill('가상 근거');
  await page.getByLabel('파일',{exact:true}).setInputFiles({name:'synthetic-expense.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\nsynthetic draft evidence\n%%EOF')});
  await page.getByLabel('첨부·교체 사유',{exact:true}).fill('가상 첨부 저장');
  await page.getByRole('button',{name:'첨부 저장',exact:true}).click();
  await expect(page.getByRole('link',{name:'synthetic-expense.pdf',exact:true}).first()).toBeVisible();
  const expenseDownloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'synthetic-expense.pdf',exact:true}).first().click();
  const expenseDownload=await expenseDownloadPromise;assert.equal(expenseDownload.suggestedFilename(),'synthetic-expense.pdf');assert.equal(await expenseDownload.failure(),null);
  const fileSlot=(await owner.query('SELECT slot_id FROM expense_files WHERE draft_id=$1',[draftId])).rows[0].slot_id;
  await page.getByLabel('추가·교체 대상',{exact:true}).selectOption(fileSlot);
  await page.getByLabel('자료 설명 (필수서류 자동 판정 없음)',{exact:true}).fill('가상 근거 교체');
  await page.getByLabel('파일',{exact:true}).setInputFiles({name:'synthetic-revised.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\nsynthetic revised\n%%EOF')});
  await page.getByLabel('첨부·교체 사유',{exact:true}).fill('이전 파일 보존 시험');
  await page.getByRole('button',{name:'첨부 저장',exact:true}).click();
  await expect(page.getByRole('link',{name:'synthetic-revised.pdf',exact:true}).first()).toBeVisible();
  assert.equal((await owner.query('SELECT count(*)::int n FROM expense_files WHERE draft_id=$1',[draftId])).rows[0].n,2);
  assert.equal((await owner.query('SELECT 1 FROM budget_accounts WHERE committed_amount<>0')).rowCount,0);
  await expect(page.getByRole('button',{name:/^(신청 제출|승인)$/})).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/phase-04-draft-mobile.png',fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'test-results/phase-04-draft.png',fullPage:true});
  await as(peer);await page.getByRole('button',{name:'지출 초안·증빙',exact:true}).click();
  await expect(page.getByRole('button',{name:'가상 지출 초안',exact:true})).toHaveCount(0);
  await as(pi);await page.getByRole('button',{name:'지출 초안·증빙',exact:true}).click();
  await page.getByRole('button',{name:'가상 지출 초안',exact:true}).click();
  await expect(page.getByRole('link',{name:'synthetic-revised.pdf',exact:true}).first()).toBeVisible();
  await expect(page.getByRole('button',{name:'초안 저장',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'첨부 저장',exact:true})).toHaveCount(0);
  await as(admin);
  // Same browser account replacement must clear old user's data before the next screen.
  await context.clearCookies();await context.addCookies([{name:'boot_session',value:tokens[researcher],url:'http://localhost:3000',httpOnly:true,sameSite:'Lax'}]);
  await expect(page.getByRole('button',{name:'계정 관리',exact:true})).toHaveCount(0,{timeout:25000});
  await expect(page.getByRole('button',{name:'동료 비공개 업무',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'로그아웃',exact:true}).click();await expect(page.getByRole('button',{name:'Google 계정으로 로그인'})).toBeVisible();await page.goBack();await expect(page.getByRole('button',{name:'내 연구 업무',exact:true})).toHaveCount(0);
  assert.deepEqual(pageErrors,[]);
  console.log('Browser checks passed: phases 02/03 regression plus phase 04 draft create/edit, settings pending/verified, private upload/replacement/download, peer isolation, PI read-only and mobile layout. Synthetic screenshots only.');
}catch(e){console.error(e instanceof Error?e.stack:'Browser checks failed');process.exitCode=1;}
finally{
  await browser?.close();if(child&&child.exitCode===null){child.kill();await once(child,'exit');}await pool.end();
  if(created){for(const table of ['expense_files','expense_draft_versions','expense_policy_versions','expense_drafts','budget_events','spend_states','budget_files','budget_change_lines','budget_changes','budget_accounts','budget_code_versions','budget_codes','project_history','work_history','work_items','otp_credentials','oauth_flows','account_audit_events','auth_sessions','auth_identities','email_ownership_checks','login_accounts','audit_events','command_receipts','spend_cases','budget_lines','project_memberships','projects','users','people','migration_history'])await owner.query(`DROP TABLE IF EXISTS ${schema}.${table}`);await owner.query(`DROP FUNCTION IF EXISTS ${schema}.reject_foundation_rewrite()`);await owner.query(`DROP FUNCTION IF EXISTS ${schema}.protect_budget_snapshot()`);await owner.query(`DROP FUNCTION IF EXISTS ${schema}.protect_expense_draft()`);await owner.query(`DROP SCHEMA ${schema}`);}await owner.end();
}
