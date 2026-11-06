import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Client, Pool } from 'pg';
import { previewRoles, type PreviewConfig } from '../src/lib/preview-config.ts';
import { issuePreviewSession } from '../src/server/preview.ts';
import { applicationDetail, manageApplication } from '../src/server/applications.ts';
import { attachDraftFile, savePolicy } from '../src/server/expenses.ts';
import { recordExternalClaim, recordPayment } from '../src/server/payments.ts';

const reason = '격리된 로컬 임시 미리보기용 가상 자료';
const command = (input: Record<string, unknown>) => ({ requestId: randomUUID(), reason, ...input });

// Accounts/master data are synthetic SQL fixtures; application/payment facts use the real services.
export async function populatePreview(owner: Client, pool: Pool, config: PreviewConfig) {
  const names = { staff: '가상 담당자', researcher: '가상 연구원', principal_investigator: '가상 과제책임자', admin: '가상 관리자' };
  for (const role of previewRoles) {
    const person = randomUUID();
    await owner.query('INSERT INTO people(id,display_name) VALUES($1,$2)', [person, names[role]]);
    await owner.query('INSERT INTO users(id,person_id,role,active) VALUES($1,$2,$3,true)', [config.users[role], person, role]);
    await owner.query('INSERT INTO login_accounts(user_id,email,binding_allowed) VALUES($1,$2,true)',
      [config.users[role], `preview-${role}@erp.example.invalid`]);
  }
  for (const role of previewRoles) await owner.query(`INSERT INTO email_ownership_checks
    (id,user_id,email,outcome,method,checked_by,checked_at) VALUES($1,$2,$3,'verified','local-preview',$4,clock_timestamp())`,
    [randomUUID(), config.users[role], `preview-${role}@erp.example.invalid`, config.users.staff]);

  const today = (await owner.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date::text AS today")).rows[0].today as string;
  if (today < '2026-03-01' || today > '2026-12-31') throw new Error('The synthetic preview fixture is limited to its 2026 test period');
  const project = randomUUID(), work = randomUUID();
  await owner.query(`INSERT INTO projects(id,code,name,kind,business_year) VALUES($1,'PREVIEW-2026','가상 부트캠프 산학공동과제','research',2026)`, [project]);
  for (const role of ['researcher', 'principal_investigator'] as const) await owner.query(`INSERT INTO project_memberships
    (id,project_id,user_id,starts_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP-INTERVAL '1 day')`, [randomUUID(), project, config.users[role]]);
  await owner.query(`INSERT INTO work_items(id,project_id,title,description,assigned_to,created_by)
    VALUES($1,$2,'가상 연구재료·사무용품 구매','실제 신청이나 지급이 아닌 임시 미리보기 자료입니다.',$3,$4)`,
    [work, project, config.users.researcher, config.users.staff]);
  const category = randomUUID();
  await owner.query("INSERT INTO budget_codes(id,code,level) VALUES($1,'N98',1)", [category]);
  await owner.query(`INSERT INTO budget_code_versions(id,code_id,version,name,active,effective_on,actor_id,reason)
    VALUES($1,$2,0,'가상 미리보기 분류',true,'2026-03-01',$3,$4)`, [randomUUID(), category, config.users.staff, reason]);
  const lines: string[] = [];
  const labels = ['가상 연구재료·사무용품비', '가상 소프트웨어 활용비', '가상 전문가 활용비', '가상 회의·활동비'];
  const amounts = ['50000000', '20000000', '20000000', '10000000'];
  for (let index = 0; index < labels.length; index++) {
    const code = randomUUID(), leaf = randomUUID(), version = randomUUID(), line = randomUUID(); lines.push(line);
    await owner.query('INSERT INTO budget_codes(id,code,level) VALUES($1,$2,2)', [code, `N98.0${index + 1}`]);
    await owner.query(`INSERT INTO budget_code_versions(id,code_id,version,parent_id,name,active,effective_on,actor_id,reason)
      VALUES($1,$2,0,$3,$4,true,'2026-03-01',$5,$6)`, [randomUUID(), code, category, labels[index], config.users.staff, reason]);
    await owner.query('INSERT INTO budget_codes(id,code,level) VALUES($1,$2,3)', [leaf, `N98.0${index + 1}.001`]);
    await owner.query(`INSERT INTO budget_code_versions(id,code_id,version,parent_id,name,active,effective_on,actor_id,reason)
      VALUES($1,$2,0,$3,$4,true,'2026-03-01',$5,$6)`, [version, leaf, code, `${labels[index]} 세세목`, config.users.staff, reason]);
    await owner.query('INSERT INTO budget_lines(id,project_id,internal_label,original_amount) VALUES($1,$2,$3,$4)',
      [line, project, labels[index], amounts[index]]);
    await owner.query(`INSERT INTO budget_accounts(line_id,code_version_id,classification_snapshot,business_name,business_year,
      academic_year,period_start,period_end,fund,current_amount) VALUES($1,$2,$3,'가상 부트캠프 사업',1,2026,'2026-03-01','2026-12-31','가상 사업비',$4)`,
      [line, version, JSON.stringify([{ code: 'N98', name: '가상 미리보기 분류' }, { code: `N98.0${index + 1}`, name: labels[index] },
        { code: `N98.0${index + 1}.001`, name: `${labels[index]} 세세목` }]), amounts[index]]);
  }
  const staff = (await issuePreviewSession(pool, config, 'staff')).token;
  const researcher = (await issuePreviewSession(pool, config, 'researcher')).token;
  try {
    const policy = await savePolicy(pool, staff, command({ action: 'policy', type: 'office', subtype: '', version: '',
      status: 'verified', source: '임시 미리보기용 가상 정책 (운영 규정 아님)', sourceVersion: 'preview-1', clause: reason,
      startsOn: '2026-03-01', endsOn: '2026-12-31', unit: '가상 건', rateMode: 'apply', rate: '100000000', calculationUnit: 'per_item',
      caseLimitMode: 'apply', caseLimit: '100000000', periodLimitMode: 'apply', periodLimit: '100000000',
      periodBasis: 'business_period', limitPeriod: '가상 사업기간', deadlineMode: 'apply', deadlineDays: '0', deadlineEvent: 'before_use', calendar: 'calendar' })) as { id: string };
    const data = { type: 'office', title: '가상 사무·연구물품 구매 신청', purpose: '임시 접속 화면과 예산·지급 현황 확인',
      calculation: '가상 물품 1건 × 40,000,000원', dateKind: 'actual', useDate: today, amount: '40000000',
      details: { item: '가상 연구용 물품', location: '가상 연구실', quantity: '1', days: '1', people: '1', unitPrice: '40000000' } };
    const saved = await manageApplication(pool, researcher, command({ ...data, action: 'save', projectId: project, workId: work,
      lineId: lines[0], policyVersionId: policy.id })) as { draftId: string };
    const draft = saved.draftId;
    const detail = await applicationDetail(pool, researcher, draft);
    const file = await attachDraftFile(pool, researcher, command({ action: 'attach', id: draft, version: detail.item.draftVersion,
      file: { name: 'preview-synthetic.pdf', label: '가상 증빙 (실제 거래 자료 아님)', content: Buffer.from('%PDF-1.7\nSynthetic preview evidence only\n%%EOF').toString('base64') } })) as { fileId: string };
    async function action(name: string, token: string, extra: Record<string, unknown> = {}) {
      const item = (await applicationDetail(pool, token, draft)).item;
      return manageApplication(pool, token, command({ ...extra, draftId: draft, action: name, version: item.version, draftVersion: item.draftVersion }));
    }
    await action('save', researcher, { ...data, lineId: lines[0], policyVersionId: policy.id, documents: { [file.fileId]: ['transaction', 'completion'] } });
    await action('submit', researcher);
    await action('start', staff);
    await action('approve', staff);
    const application = (await applicationDetail(pool, staff, draft)).item.id as string;
    const version = async () => (await owner.query('SELECT version FROM spend_states WHERE case_id=$1', [application])).rows[0].version;
    await recordExternalClaim(pool, staff, command({ action: 'submitted', projectId: project, caseId: application, version: await version(),
      documentNumber: 'PREVIEW-SYNTHETIC-001', occurredOn: today, evidence: '가상 대학 ERP 수기 청구 기록 (외부 전송 없음)' }));
    await recordPayment(pool, staff, command({ action: 'pay', projectId: project, caseId: application, version: await version(),
      grossAmount: '25000000', withheldAmount: '0', netAmount: '25000000', paidOn: today, evidence: '가상 부분 지급 사실 (실제 송금 없음)' }));
    const totals = (await owner.query(`SELECT sum(current_amount)::text AS budget,sum(committed_amount)::text AS committed,
      (SELECT sum(gross_amount)::text FROM payment_records) AS paid FROM budget_accounts`)).rows[0];
    assert.deepEqual(totals, { budget: '100000000', committed: '40000000', paid: '25000000' });
    return { project, work, lines, draft, application, totals };
  } finally {
    // Seed sessions are disposable; leave both normal session slots available to the browser.
    await pool.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL');
  }
}
