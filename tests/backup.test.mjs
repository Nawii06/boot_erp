import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { adminConfig, archiveHash, assertBackupPath, backupId, clientFor, collectState, compareState, ensureDevelopment, inside, loadManifest, postgresTools, privateDirectory, repository, restoreName, runTool, sourceKey, toolEnvironment } from '../scripts/backup-config.mjs';
import { backupLocal } from '../scripts/backup-local.mjs';
import { cleanupDisposable, restoreCheck } from '../scripts/restore-check.mjs';

test('backup source and production guards reject broader databases', () => {
  assert.equal(sourceKey('dev'), 'dev');
  assert.equal(sourceKey('test'), 'test');
  for (const value of ['postgres', 'boot_erp_dev', '../dev', '', null]) assert.throws(() => sourceKey(value));
  const previous = process.env.NODE_ENV;
  try { process.env.NODE_ENV = 'production'; assert.throws(ensureDevelopment); }
  finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test('backup output rejects repository, PGDATA and broad directory roots', () => {
  const root = join(tmpdir(), 'boot-erp-synthetic-private');
  const data = join(root, 'postgres', 'data');
  for (const path of [repository, join(repository, 'private'), data, join(data, 'nested'), root, join(root, '..'), 'relative']) {
    assert.throws(() => assertBackupPath(path, root, data));
  }
  assert.doesNotThrow(() => assertBackupPath(join(root, 'backups'), root, data));
  assert.equal(inside(root, root + '-other'), false);
});

test('restore names cannot select existing dev/test or arbitrary artifacts', () => {
  assert.equal(backupId('backup-' + 'a'.repeat(32)), 'backup-' + 'a'.repeat(32));
  assert.equal(restoreName('boot_erp_restore_' + 'b'.repeat(32)), 'boot_erp_restore_' + 'b'.repeat(32));
  for (const value of ['boot_erp_dev', 'boot_erp_test', 'postgres', 'boot_erp_restore_foo', '../backup-' + 'a'.repeat(32), '']) {
    assert.throws(() => backupId(value));
    assert.throws(() => restoreName(value));
  }
});

test('restore comparison catches exact totals, evidence and schema mismatches', () => {
  const state = { counts: { rows: '2' }, numericSums: { amount: '9007199254740993' }, files: [{ actual_hash: 'a'.repeat(64) }], columns: [{ column_name: 'amount', data_type: 'bigint' }] };
  assert.doesNotThrow(() => compareState(state, structuredClone(state)));
  for (const mutate of [s => s.counts.rows = '3', s => s.numericSums.amount = '9007199254740992', s => s.files[0].actual_hash = 'b'.repeat(64), s => s.columns[0].data_type = 'integer']) {
    const changed = structuredClone(state); mutate(changed); assert.throws(() => compareState(state, changed));
  }
});

test('failed disposable cleanup preserves the role and never targets existing databases', async () => {
  const database = 'boot_erp_restore_' + 'd'.repeat(32), role = 'boot_erp_restore_role_' + 'd'.repeat(32);
  const calls = [];
  const blocked = { query: async sql => { calls.push(sql); throw new Error('synthetic busy DB'); } };
  await assert.rejects(cleanupDisposable(blocked, { database, role, createdDatabase: true, createdRole: true }));
  assert.deepEqual(calls, ['DROP DATABASE ' + database]);
  calls.length = 0;
  for (const invalid of ['boot_erp_dev', 'boot_erp_test', 'postgres']) {
    await assert.rejects(cleanupDisposable(blocked, { database: invalid, role, createdDatabase: true, createdRole: true }));
  }
  await assert.rejects(cleanupDisposable(blocked, { database, role: 'boot_erp_dev_owner', createdDatabase: true, createdRole: true }));
  await cleanupDisposable(blocked, { database, role, createdDatabase: false, createdRole: false });
  assert.deepEqual(calls, []);
  const successful = { query: async sql => { calls.push(sql); } };
  await cleanupDisposable(successful, { database, role, createdDatabase: true, createdRole: true });
  assert.deepEqual(calls, ['DROP DATABASE ' + database, 'DROP ROLE ' + role]);
});

test('existing unmarked private directories are not adopted or modified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boot-erp-backup-root-test-'));
  const dataRoot = join(root, 'postgres'), data = join(dataRoot, 'data'), existing = join(root, 'existing'), retained = join(existing, 'retained.txt');
  const beforeRoot = process.env.BOOT_ERP_LOCAL_ROOT, beforeBackup = process.env.BOOT_ERP_BACKUP_ROOT;
  try {
    await mkdir(dataRoot); await mkdir(data); await mkdir(existing); await writeFile(retained, 'SYNTHETIC_RETAINED');
    process.env.BOOT_ERP_LOCAL_ROOT = root; process.env.BOOT_ERP_BACKUP_ROOT = existing;
    await assert.rejects(privateDirectory(true), /Unrecognized existing/);
    assert.equal(await readFile(retained, 'utf8'), 'SYNTHETIC_RETAINED');
  } finally {
    if (beforeRoot === undefined) delete process.env.BOOT_ERP_LOCAL_ROOT; else process.env.BOOT_ERP_LOCAL_ROOT = beforeRoot;
    if (beforeBackup === undefined) delete process.env.BOOT_ERP_BACKUP_ROOT; else process.env.BOOT_ERP_BACKUP_ROOT = beforeBackup;
    await unlink(retained); await rmdir(existing); await rmdir(data); await rmdir(dataRoot); await rmdir(root);
  }
});

test('tool environment uses selected local role and excludes unrelated credentials', () => {
  const previous = process.env.AUTH_ENCRYPTION_KEY;
  const previousHostAddr = process.env.PGHOSTADDR;
  process.env.AUTH_ENCRYPTION_KEY = 'SYNTHETIC_AUTH_SECRET';
  process.env.PGHOSTADDR = '203.0.113.1';
  try {
    const env = toolEnvironment({ host: '127.0.0.1', port: 55432, database: 'boot_erp_test', user: 'boot_erp_test_owner', password: 'SYNTHETIC_DB_SECRET' });
    assert.equal(env.AUTH_ENCRYPTION_KEY, undefined);
    assert.equal(env.PGHOSTADDR, undefined);
    assert.equal(env.PGUSER, 'boot_erp_test_owner');
    assert.equal(env.PGDATABASE, 'boot_erp_test');
    assert.equal(env.PGPASSWORD, 'SYNTHETIC_DB_SECRET');
  } finally {
    if (previous === undefined) delete process.env.AUTH_ENCRYPTION_KEY; else process.env.AUTH_ENCRYPTION_KEY = previous;
    if (previousHostAddr === undefined) delete process.env.PGHOSTADDR; else process.env.PGHOSTADDR = previousHostAddr;
  }
});

test('archive digest, manifest and artifact IDs are verified before restoration', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'boot-erp-backup-test-'));
  const id = 'backup-' + 'c'.repeat(32), archive = join(folder, id + '.dump'), manifestPath = join(folder, id + '.json');
  try {
    await writeFile(archive, 'SYNTHETIC_ARCHIVE');
    const manifest = { formatVersion: 1, id, source: 'test', archive: id + '.dump', archiveSha256: await archiveHash(archive), state: { serverVersion: '18.6' } };
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.equal((await loadManifest(folder, id)).manifest.id, id);
    await writeFile(archive, 'ALTERED_SYNTHETIC_ARCHIVE');
    await assert.rejects(loadManifest(folder, id), /verification failed/);
    await assert.rejects(loadManifest(folder, '../' + id), /Invalid backup ID/);
    assert.equal((await readFile(manifestPath, 'utf8')).includes('SYNTHETIC_ARCHIVE'), false);
  } finally { await unlink(archive); await unlink(manifestPath); await rmdir(folder); }
});

test('invalid CLI input is rejected without echoing input or contacting a database', () => {
  const fake = 'SYNTHETIC_SECRET_do_not_echo';
  for (const name of ['backup-local.mjs', 'restore-check.mjs']) {
    const script = fileURLToPath(new URL('../scripts/' + name, import.meta.url));
    const result = spawnSync(process.execPath, [script, fake], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1);
    assert.equal((result.stdout + result.stderr).includes(fake), false);
    assert.equal((result.stdout + result.stderr).includes('postgresql://'), false);
  }
});

// Explicit local-only integration mode. Existing dev/test tables are read, never seeded or cleared.
if (process.env.BOOT_ERP_RUN_BACKUP_DB_TEST === '1') test('isolated full-ledger clone roundtrip preserves money, relations, evidence and audit', async () => {
  const directory = await privateDirectory(true), tools = await postgresTools();
  const artifacts = [];
  const base = await backupLocal('test'); artifacts.push(base.id);
  const { archive: baseArchive } = await loadManifest(directory, base.id);
  const admin = await clientFor(await adminConfig());
  const suffix = randomUUID().replaceAll('-', ''), database = restoreName('boot_erp_restore_' + suffix), role = 'boot_erp_restore_role_' + suffix;
  const password = randomBytes(32).toString('hex');
  const config = { host: '127.0.0.1', port: 55432, database, user: role, password, connectionTimeoutMillis: 3000 };
  let createdRole = false, createdDatabase = false;
  try {
    const existing = (await admin.query('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS db,EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$2) AS role', [database, role])).rows[0];
    assert.equal(existing.db, false); assert.equal(existing.role, false);
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`); createdRole = true;
    await admin.query(`CREATE DATABASE ${database} OWNER ${role} TEMPLATE template0`); createdDatabase = true;
    await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await admin.query(`ALTER DATABASE ${database} SET timezone TO 'UTC'`);
    await runTool(tools.pg_restore, ['--single-transaction', '--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', '--dbname=' + database, baseArchive], toolEnvironment(config));
    const client = await clientFor(config);
    try {
      const person = randomUUID(), user = randomUUID(), staff = randomUUID(), project = randomUUID(), line = randomUUID(), work = randomUUID(), draft = randomUUID(), slot = randomUUID();
      const policyId=randomUUID(),application=randomUUID(),submission=randomUUID(),codeIds=[randomUUID(),randomUUID(),randomUUID()],codeVersions=[randomUUID(),randomUUID(),randomUUID()];
      const evidence=[],requestIds=[];
      const policy={status:'verified',source:'Synthetic restore policy',sourceVersion:'1',clause:'synthetic only',startsOn:'2026-03-01',endsOn:'2026-12-31',
        rateMode:'not_applicable',caseLimitMode:'not_applicable',periodLimitMode:'not_applicable',deadlineMode:'not_applicable'};
      const data={type:'office',title:'Synthetic restore application',purpose:'Synthetic',calculation:'8 x 100',dateKind:'actual',useDate:'2026-11-06',amount:'800',
        details:{item:'Synthetic item',location:'Synthetic location',quantity:'8',unitPrice:'100',days:'1',people:'1'},items:[]};
      async function receipt(action,entity){const request=randomUUID();requestIds.push(request);
        await client.query('INSERT INTO command_receipts(actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4)',[staff,request,createHash('sha256').update(action+entity).digest('hex'),{id:entity,action}]);
        await client.query('INSERT INTO budget_events(id,project_id,entity_id,actor_id,request_id,action,reason,before_state,after_state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())',
          [randomUUID(),project,application,staff,request,action,'synthetic restore audit',{}, {id:entity,action}]);
        return request;
      }
      await client.query('BEGIN');
      await client.query('INSERT INTO people(id,display_name) VALUES($1,$2)', [person, 'Synthetic restore fixture']);
      await client.query("INSERT INTO users(id,person_id,role) VALUES($1,$2,'researcher')", [user, person]);
      await client.query("INSERT INTO users(id,role) VALUES($1,'staff')",[staff]);
      await client.query("INSERT INTO projects(id,code,name,kind,business_year) VALUES($1,$2,'Synthetic restore project','research',2026)", [project, 'RESTORE-' + suffix]);
      await client.query("INSERT INTO project_memberships(id,project_id,user_id,starts_at) VALUES($1,$2,$3,'2026-03-01')",[randomUUID(),project,user]);
      await client.query('INSERT INTO budget_lines(id,project_id,internal_label,original_amount) VALUES($1,$2,$3,$4)', [line, project, 'Synthetic large exact amount', '9007199254740993']);
      for(let level=1;level<=3;level++){
        const code=['N97','N97.01','N97.01.001'][level-1];
        await client.query('INSERT INTO budget_codes(id,code,level) VALUES($1,$2,$3)',[codeIds[level-1],code,level]);
        await client.query("INSERT INTO budget_code_versions(id,code_id,version,parent_id,name,active,effective_on,actor_id,reason) VALUES($1,$2,0,$3,'Synthetic restore code',true,'2026-03-01',$4,'synthetic')",[codeVersions[level-1],codeIds[level-1],level===1?null:codeIds[level-2],staff]);
      }
      await client.query(`INSERT INTO budget_accounts(line_id,code_version_id,classification_snapshot,business_name,business_year,academic_year,period_start,period_end,fund,current_amount,committed_amount,version)
        VALUES($1,$2,$3,'Synthetic',1,2026,'2026-03-01','2026-12-31','Synthetic',9007199254740993,600,2)`,[line,codeVersions[2],JSON.stringify(codeIds.map((id,index)=>({id,version_id:codeVersions[index],name:'Synthetic restore code'})))]);
      await client.query('INSERT INTO work_items(id,project_id,title,description,assigned_to,created_by) VALUES($1,$2,$3,$4,$5,$6)', [work, project, 'Synthetic restore work', '', user,staff]);
      await client.query("INSERT INTO expense_policy_versions(id,type_key,subtype,version,data,actor_id,reason) VALUES($1,'office','',0,$2,$3,'synthetic restore policy')",[policyId,policy,staff]);
      await client.query('INSERT INTO expense_drafts(id,project_id,work_id,applicant_id,version) VALUES($1,$2,$3,$4,1)', [draft, project, work, user]);
      for (let version = 0; version < 2; version++) {
        const content = Buffer.from('SYNTHETIC_EVIDENCE_VERSION_' + version);
        const file={id:randomUUID(),slot_id:slot,version:String(version),sha256:createHash('sha256').update(content).digest('hex'),size:String(content.length),documentKinds:['transaction','completion']};evidence.push(file);
        await client.query('INSERT INTO expense_draft_versions(id,draft_id,version,budget_line_id,policy_version_id,data,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), draft, version,line,policyId,{...data,documents:{[file.id]:['transaction','completion']}}, user, 'synthetic restore check']);
        await client.query('INSERT INTO expense_files(id,draft_id,slot_id,version,filename,label,sha256,content,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [file.id, draft, slot, version, 'synthetic.txt', 'synthetic', file.sha256, content, user, 'synthetic restore check']);
      }
      await client.query('INSERT INTO spend_cases(id,project_id,applicant_id,budget_line_id) VALUES($1,$2,$3,$4)',[application,project,user,line]);
      await client.query("INSERT INTO spend_states(case_id,project_id,work_id,amount,paid_amount,state,version,processing_by,processing_at) VALUES($1,$2,$3,800,800,'approved',8,$4,CURRENT_TIMESTAMP)",[application,project,work,staff]);
      await client.query('INSERT INTO expense_applications(id,draft_id,created_by) VALUES($1,$2,$3)',[application,draft,user]);
      await client.query(`INSERT INTO expense_submission_versions(id,application_id,version,draft_version,policy_version_id,applicable_on,data,policy_snapshot,files_snapshot,actor_id,reason)
        VALUES($1,$2,0,1,$3,'2026-11-06',$4,$5,$6,$7,'synthetic restore submission')`,[submission,application,policyId,{...data,lineId:line,workId:work,documents:{[evidence[1].id]:['transaction','completion']}},policy,JSON.stringify([evidence[1]]),user]);
      await client.query("INSERT INTO expense_review_notes(id,application_id,submission_id,document_kind,outcome,note,actor_id,created_at) VALUES($1,$2,$3,'transaction','accepted','Synthetic proof reviewed',$4,clock_timestamp())",[randomUUID(),application,submission,staff]);
      const submitRequest=await receipt('application.submit',application);
      await client.query("INSERT INTO audit_events(id,actor_id,project_id,request_id,action,reason,before_state,after_state) VALUES($1,$2,$3,$4,'synthetic.restore','synthetic restore integrity',$5,$6)",[randomUUID(),staff,project,submitRequest,{}, {application}]);
      await receipt('application.approve',application);
      await client.query('INSERT INTO external_claim_links(case_id,document_number,actor_id) VALUES($1,$2,$3)',[application,'SYNTHETIC-RESTORE-'+suffix,staff]);
      const claimId=randomUUID(),claimRequest=await receipt('external-claim.submitted',claimId);
      await client.query("INSERT INTO external_claim_attempts(id,case_id,project_id,kind,occurred_on,evidence,actor_id,request_id,reason) VALUES($1,$2,$3,'submitted','2026-11-06','Synthetic claim proof',$4,$5,'synthetic restore claim')",[claimId,application,project,staff,claimRequest]);
      const paymentIds=[randomUUID(),randomUUID()];
      for(const [index,gross,withheld,net] of [[0,'300','30','270'],[1,'500','50','450']]){
        const request=await receipt('payment.pay',paymentIds[index]);
        await client.query("INSERT INTO payment_records(id,case_id,project_id,gross_amount,withheld_amount,net_amount,paid_on,evidence,actor_id,request_id,reason) VALUES($1,$2,$3,$4,$5,$6,'2026-11-06','Synthetic payment proof',$7,$8,'synthetic restore payment')",[paymentIds[index],application,project,gross,withheld,net,staff,request]);
      }
      const refundId=randomUUID(),refundRequest=await receipt('payment.refund',refundId);
      await client.query("INSERT INTO payment_refunds(id,payment_id,case_id,project_id,amount,refunded_on,evidence,actor_id,request_id,reason) VALUES($1,$2,$3,$4,200,'2026-11-06','Synthetic refund proof',$5,$6,'synthetic restore refund')",[refundId,paymentIds[1],application,project,staff,refundRequest]);
      const restoreRequest=await receipt('payment.restore-refund',refundId);
      await client.query("INSERT INTO refund_restorations(refund_id,case_id,restored_on,actor_id,request_id,reason) VALUES($1,$2,'2026-11-06',$3,$4,'synthetic restore budget')",[refundId,application,staff,restoreRequest]);
      const settlement=randomUUID(),closeRequest=await receipt('settlement.close',settlement);
      await client.query("INSERT INTO settlement_events(id,case_id,project_id,action,actor_id,request_id,reason) VALUES($1,$2,$3,'close',$4,$5,'synthetic restore closure')",[settlement,application,project,staff,closeRequest]);
      await client.query('COMMIT');
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshot = (await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
      const state = await collectState(client);
      assert.ok(BigInt(state.numericSums['budget_lines.original_amount']) >= 9007199254740993n);
      assert.ok(state.files.filter(file => file.table === 'expense_files').length >= 2);
      assert.equal(state.numericSums['spend_states.paid_amount'],'800');
      assert.equal(state.numericSums['payment_records.gross_amount'],'800');
      assert.equal(state.numericSums['payment_records.withheld_amount'],'80');
      assert.equal(state.numericSums['payment_records.net_amount'],'720');
      assert.equal(state.numericSums['payment_refunds.amount'],'200');
      assert.equal(state.numericSums['budget_accounts.committed_amount'],'600');
      assert.equal(state.counts.expense_submission_versions,'1');assert.equal(state.counts.refund_restorations,'1');assert.equal(state.counts.settlement_events,'1');
      assert.equal(state.counts.budget_events,String(requestIds.length));assert.equal(state.counts.command_receipts,String(requestIds.length));
      const id = 'backup-' + randomUUID().replaceAll('-', ''), archive = join(directory, id + '.dump'); artifacts.push(id);
      await writeFile(archive, '', { flag: 'wx', mode: 0o600 });
      await runTool(tools.pg_dump, ['--format=custom', '--no-owner', '--no-acl', '--schema=public', '--snapshot=' + snapshot, '--file=' + archive], toolEnvironment(config));
      await writeFile(join(directory, id + '.json'), JSON.stringify({ formatVersion: 1, id, source: 'test', createdAt: new Date().toISOString(), archive: id + '.dump', archiveSha256: await archiveHash(archive), state }), { flag: 'wx', mode: 0o600 });
      await client.query('COMMIT');
      const result = await restoreCheck(id);
      assert.equal(result.status, 'restore_verified'); assert.equal(result.cleanup, 'complete');
      // Independently query restored foreign-key chains and business facts before disposal.
      const targetSuffix=randomUUID().replaceAll('-',''),targetDatabase=restoreName('boot_erp_restore_'+targetSuffix),targetRole='boot_erp_restore_role_'+targetSuffix,targetPassword=randomBytes(32).toString('hex');
      let targetRoleCreated=false,targetDatabaseCreated=false;
      try{
        const exists=(await admin.query('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS db,EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$2) AS role',[targetDatabase,targetRole])).rows[0];assert.equal(exists.db,false);assert.equal(exists.role,false);
        await admin.query(`CREATE ROLE ${targetRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${targetPassword}'`);targetRoleCreated=true;
        await admin.query(`CREATE DATABASE ${targetDatabase} OWNER ${targetRole} TEMPLATE template0`);targetDatabaseCreated=true;
        await admin.query(`REVOKE ALL ON DATABASE ${targetDatabase} FROM PUBLIC`);await admin.query(`ALTER DATABASE ${targetDatabase} SET timezone TO 'UTC'`);
        const targetConfig={host:'127.0.0.1',port:55432,database:targetDatabase,user:targetRole,password:targetPassword,connectionTimeoutMillis:3000};
        await runTool(tools.pg_restore,['--single-transaction','--clean','--if-exists','--no-owner','--no-acl','--exit-on-error','--dbname='+targetDatabase,archive],toolEnvironment(targetConfig));
        const restored=await clientFor(targetConfig);
        try{
          compareState(state,await collectState(restored));
          const chain=(await restored.query(`SELECT a.draft_id,d.project_id,d.work_id,x.budget_line_id,v.policy_version_id,
            v.files_snapshot->0->>'id' AS file_id,s.amount::text,s.paid_amount::text,b.committed_amount::text,
            (b.current_amount-b.committed_amount)::text AS available
            FROM expense_applications a JOIN expense_drafts d ON d.id=a.draft_id JOIN spend_cases x ON x.id=a.id
            JOIN spend_states s ON s.case_id=a.id JOIN budget_accounts b ON b.line_id=x.budget_line_id
            JOIN expense_submission_versions v ON v.application_id=a.id WHERE a.id=$1`,[application])).rows[0];
          assert.deepEqual(chain,{draft_id:draft,project_id:project,work_id:work,budget_line_id:line,policy_version_id:policyId,file_id:evidence[1].id,amount:'800',paid_amount:'800',committed_amount:'600',available:(9007199254740993n-600n).toString()});
          const relations=(await restored.query(`SELECT
            (SELECT count(*)::int FROM payment_records p JOIN external_claim_links l ON l.case_id=p.case_id WHERE p.case_id=$1) AS payments,
            (SELECT count(*)::int FROM payment_refunds r JOIN payment_records p ON p.id=r.payment_id AND p.case_id=r.case_id JOIN refund_restorations f ON f.refund_id=r.id AND f.case_id=r.case_id WHERE r.case_id=$1) AS restored_refunds,
            (SELECT count(*)::int FROM settlement_events e WHERE e.case_id=$1 AND e.action='close') AS closures,
            (SELECT count(*)::int FROM budget_events e JOIN command_receipts r ON r.actor_id=e.actor_id AND r.request_id=e.request_id WHERE e.entity_id=$1) AS audit_receipts`,[application])).rows[0];
          assert.deepEqual(relations,{payments:2,restored_refunds:1,closures:1,audit_receipts:requestIds.length});
        }finally{await restored.end();}
      }finally{await cleanupDisposable(admin,{database:targetDatabase,role:targetRole,createdDatabase:targetDatabaseCreated,createdRole:targetRoleCreated});}
    } finally { await client.end(); }
  } finally {
    try { await cleanupDisposable(admin, { database, role, createdDatabase, createdRole }); }
    finally {
      await admin.end();
      for (const id of artifacts) for (const extension of ['.json', '.dump']) await unlink(join(directory, backupId(id) + extension)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
});
