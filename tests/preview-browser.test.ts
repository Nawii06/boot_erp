import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { expect } from '@playwright/test';

const origin='http://localhost:3000';
const status=await fetch(origin+'/api/auth/preview');
assert.equal(status.status,200,'Start the isolated local preview server first');
const configuration=await status.json();
assert.equal(configuration.enabled,true);
assert.deepEqual(configuration.roles,['staff','researcher','principal_investigator','admin']);
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1600,height:1000}}),page=await context.newPage();
const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
try{
  await page.goto(origin);
  await expect(page.getByRole('button',{name:'임시 접속',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Google 계정으로 로그인',exact:true})).toHaveCount(0);
  await expect(page.getByLabel('임시 접속 역할')).toHaveValue('staff');
  for(const role of configuration.roles){
    await page.getByLabel('임시 접속 역할').selectOption(role);
    const login=page.waitForResponse(response=>response.url().endsWith('/api/auth/preview')&&response.request().method()==='POST');
    await page.getByRole('button',{name:'임시 접속',exact:true}).click();
    assert.equal((await login).status(),200);
    await expect(page.getByRole('heading',{name:'업무·예산 현황',exact:true})).toBeVisible();
    await expect(page.getByRole('complementary',{name:'임시 접속 안내'})).toContainText('가상자료');
    for(const amount of ['100,000,000','40,000,000','60,000,000','25,000,000'])await expect(page.locator('.summary-cards')).toContainText(amount);
    const session=await context.request.get(origin+'/api/session');assert.equal(session.status(),200);
    assert.equal((await session.json()).role,role);
    assert.equal(await page.evaluate(()=>localStorage.length),0);
    if(role==='principal_investigator')await expect(page.getByRole('button',{name:'＋ 지출 신청',exact:true})).toHaveCount(0);
    if(role==='researcher'||role==='principal_investigator')await expect(page.getByRole('button',{name:'계정 관리',exact:true})).toHaveCount(0);
    if(role==='staff'){
      await mkdir('test-results',{recursive:true});
      await page.screenshot({path:'test-results/local-preview-live.png',fullPage:true});
      await page.setViewportSize({width:375,height:812});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.setViewportSize({width:1600,height:1000});
    }
    await page.getByRole('button',{name:'로그아웃',exact:true}).click();
    await expect(page.getByRole('button',{name:'임시 접속',exact:true})).toBeVisible();
    assert.equal((await context.request.get(origin+'/api/session')).status(),401);
  }
  assert.deepEqual(errors,[]);
  console.log('Local preview UI passed: 4 role logins, real dashboard amounts, scoped menus, mobile width, logout and no localStorage credentials.');
}finally{await context.close();await browser.close();}
