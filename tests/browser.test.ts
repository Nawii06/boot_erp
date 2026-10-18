import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium,expect,type Browser } from '@playwright/test';
import { Pool,Client } from 'pg';
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
  const pageErrors:string[]=[];page.on('pageerror',e=>pageErrors.push(e.message));
  await page.goto('http://localhost:3000');await expect(page.getByRole('button',{name:'Google 계정으로 로그인'})).toBeVisible();
  await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/phase-02-login.png',fullPage:true});
  const as=async(id:string)=>{await context.clearCookies();await context.addCookies([{name:'boot_session',value:tokens[id],url:'http://localhost:3000',httpOnly:true,sameSite:'Lax'}]);await page.goto('http://localhost:3000');};
  await as(admin);await expect(page.getByRole('button',{name:'계정 관리',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'동료 비공개 업무',exact:true})).toBeVisible();
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
  // Same browser account replacement must clear old user's data before the next screen.
  await context.clearCookies();await context.addCookies([{name:'boot_session',value:tokens[researcher],url:'http://localhost:3000',httpOnly:true,sameSite:'Lax'}]);
  await expect(page.getByRole('button',{name:'계정 관리',exact:true})).toHaveCount(0,{timeout:25000});
  await expect(page.getByRole('button',{name:'동료 비공개 업무',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'로그아웃',exact:true}).click();await expect(page.getByRole('button',{name:'Google 계정으로 로그인'})).toBeVisible();await page.goBack();await expect(page.getByRole('button',{name:'내 연구 업무',exact:true})).toHaveCount(0);
  assert.deepEqual(pageErrors,[]);
  console.log('Browser checks passed: four roles, real form save, same-browser account replacement, no persistent data cache, idle warning/extension, logout and mobile layout. Synthetic screenshots only.');
}catch(e){console.error(e instanceof Error?e.message:'Browser checks failed');process.exitCode=1;}
finally{
  await browser?.close();if(child&&child.exitCode===null){child.kill();await once(child,'exit');}await pool.end();
  if(created){for(const table of ['project_history','work_history','work_items','otp_credentials','oauth_flows','account_audit_events','auth_sessions','auth_identities','email_ownership_checks','login_accounts','audit_events','command_receipts','spend_cases','budget_lines','project_memberships','projects','users','people','migration_history'])await owner.query(`DROP TABLE IF EXISTS ${schema}.${table}`);await owner.query(`DROP FUNCTION IF EXISTS ${schema}.reject_foundation_rewrite()`);await owner.query(`DROP SCHEMA ${schema}`);}await owner.end();
}
