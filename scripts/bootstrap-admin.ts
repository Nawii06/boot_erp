import { readFile,realpath,stat } from 'node:fs/promises';
import { isAbsolute,relative,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { transaction } from '../src/server/transaction.ts';
import { emailInput,accountAudit } from '../src/server/accounts.ts';
import { textInput } from '../src/lib/validation.ts';
import { revoke } from '../src/server/security.ts';
import { assertLocalDatabase,requiredUrl } from './db-config.mjs';

// Local operator-only bootstrap. No HTTP endpoint and no account values in command output.
const pool=new Pool({connectionString:assertLocalDatabase(requiredUrl('DATABASE_URL'),'boot_erp_dev','app')});
try {
  const requested=process.env.BOOT_ERP_ADMIN_FILE;
  if(!requested||!isAbsolute(requested))throw new Error();
  const file=await realpath(requested),root=await realpath(fileURLToPath(new URL('..',import.meta.url))),inside=relative(root,file);
  if(!inside||(!inside.startsWith(`..${sep}`)&&!isAbsolute(inside)))throw new Error();
  if((await stat(file)).size>16384)throw new Error();
  const input=JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
  const email=emailInput(input.email),name=textInput(input.name),method=textInput(input.ownershipMethod,500);
  if(input.ownershipConfirmed!==true)throw new Error();
  const result=await transaction(pool,async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('account-management',0))");
    if(process.argv[2]==='recover'){
      const existingEmail=emailInput(input.existingEmail),reason=textInput(input.reason,1000),operatorName=textInput(input.operatorName);
      const target=(await c.query("SELECT u.id,a.email,u.active FROM users u JOIN login_accounts a ON a.user_id=u.id WHERE u.role='admin' AND a.email=$1 FOR UPDATE OF u,a",[existingEmail])).rows[0];
      if(!target)throw new Error();
      await revoke(c,target.id);
      await c.query('UPDATE auth_identities SET enabled=false WHERE user_id=$1',[target.id]);
      await c.query('DELETE FROM otp_credentials WHERE user_id=$1',[target.id]);
      await c.query('UPDATE login_accounts SET email=$2,binding_allowed=true,ownership_after=clock_timestamp() WHERE user_id=$1',[target.id,email]);
      await c.query('UPDATE users SET active=true WHERE id=$1',[target.id]);
      await c.query("INSERT INTO email_ownership_checks(id,user_id,email,outcome,method,checked_by,checked_at) VALUES($1,$2,$3,'verified',$4,$2,clock_timestamp())",[randomUUID(),target.id,email,method]);
      await accountAudit(c,target.id,target.id,'admin.offline-recovery',reason,target,{email,active:true,operatorName,operatorMethod:'server-local manual identity recovery'});
      return 'recovered';
    }
    const admins=(await c.query("SELECT u.id,a.email FROM users u LEFT JOIN login_accounts a ON a.user_id=u.id WHERE role='admin'")).rows;
    if(admins.length){
      if(admins.length===1&&admins[0].email===email)return 'already_registered';
      throw new Error();
    }
    const id=randomUUID(),person=randomUUID();
    await c.query('INSERT INTO people(id,display_name) VALUES($1,$2)',[person,name]);
    await c.query("INSERT INTO users(id,person_id,role,active) VALUES($1,$2,'admin',true)",[id,person]);
    await c.query('INSERT INTO login_accounts(user_id,email,binding_allowed) VALUES($1,$2,true)',[id,email]);
    await c.query("INSERT INTO email_ownership_checks(id,user_id,email,outcome,method,checked_by,checked_at) VALUES($1,$2,$3,'verified',$4,$2,clock_timestamp())",[randomUUID(),id,email,method]);
    await accountAudit(c,id,id,'admin.bootstrap','서버 운영자의 최초 관리자 등록 및 소유 확인',{}, {role:'admin',active:true,ownershipConfirmed:true});
    return 'registered';
  });
  console.log(JSON.stringify({bootstrap:result,googleLoginVerified:false}));
}catch{console.error('Administrator bootstrap refused. Check the private file, ownership confirmation, and existing administrator state. No private values logged.');process.exitCode=1;}
finally{await pool.end();}
