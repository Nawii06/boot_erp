import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateImport, validateImportFile } from '../scripts/validate-import.mjs';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  return {
    schemaVersion: 1, synthetic: true, batchId: 'SYNTHETIC-BATCH-01', sourceSystem: 'synthetic-fixture',
    scope: { businessName: '1차년도 부트캠프 사업', businessYear: 1, academicYear: 2026, periodStart: '2026-03-01', periodEnd: '2026-12-31', cutoffDate: '2026-11-06', projectIds: [id(1)] },
    budgetBasis: 'current_snapshot', previousImports: { batchIds: [], sourceIds: [] },
    projects: [{ id: id(1), sourceId: 'PROJECT-01', code: 'SYNTHETIC-01', name: '가상 검수 과제', kind: 'research', businessYear: 2026 }],
    classifications: [
      { id: id(2), sourceId: 'CODE-01', versionId: id(12), code: 'N01', level: 1, parentId: null, name: '가상 비목', effectiveOn: '2026-03-01', active: true },
      { id: id(3), sourceId: 'CODE-02', versionId: id(13), code: 'N01.01', level: 2, parentId: id(2), name: '가상 세목', effectiveOn: '2026-03-01', active: true },
      { id: id(4), sourceId: 'CODE-03', versionId: id(14), code: 'N01.01.001', level: 3, parentId: id(3), name: '가상 세세목', effectiveOn: '2026-03-01', active: true },
    ],
    budgetLines: [{ id: id(5), sourceId: 'LINE-01', projectId: id(1), codeVersionId: id(14), label: '가상 배정 항목', fund: '가상 재원', originalAmount: '1000', currentAmount: '1200', committedAmount: '200', availableAmount: '1000' }],
    budgetHistory: [{ id: id(6), sourceId: 'HISTORY-01', lineId: id(5), occurredOn: '2026-04-01', beforeAmount: '1000', afterAmount: '1200', effect: 'reference' }],
  };
}
function rejects(change, code) {
  const batch = fixture(); change(batch);
  const result = validateImport(batch);
  assert.equal(result.valid, false);
  assert.ok(result.errorCodes.includes(code), JSON.stringify(result));
}

test('snapshot validates complete in-memory relationships without mutating or returning source data', () => {
  const batch = fixture(), before = JSON.stringify(batch);
  assert.deepEqual(validateImport(batch), { valid: true, counts: { projects: 1, classifications: 3, budgetLines: 1, budgetHistory: 1 }, errorCodes: [] });
  assert.equal(JSON.stringify(batch), before);
  assert.equal(JSON.stringify(validateImport(batch)).includes(batch.projects[0].name), false);
});

test('rejects non-synthetic data and unsupported entities rather than silently ignoring them', () => {
  rejects(b => { b.synthetic = false; }, 'SYNTHETIC_ONLY');
  rejects(b => { b.payments = [{ amount: '1' }]; }, 'UNSUPPORTED_FIELD');
  rejects(b => { delete b.previousImports; }, 'MISSING_FIELD');
});

test('prevents duplicate batches, original source IDs and target UUIDs including case differences', () => {
  rejects(b => { b.previousImports.batchIds = [b.batchId]; }, 'BATCH_ALREADY_IMPORTED');
  rejects(b => { b.previousImports.sourceIds = ['LINE-01']; }, 'SOURCE_ALREADY_IMPORTED');
  rejects(b => { b.budgetLines[0].sourceId = 'PROJECT-01'; }, 'DUPLICATE_SOURCE_ID');
  rejects(b => { b.classifications[0].versionId = id(1); }, 'DUPLICATE_TARGET_ID');
  rejects(b => { b.projects[0].id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; b.classifications[0].versionId = b.projects[0].id.toUpperCase(); }, 'DUPLICATE_TARGET_ID');
  rejects(b => { b.previousImports.batchIds = ['OLD', 'OLD']; }, 'INVALID_IMPORT_LEDGER');
  rejects(b => { b.projects[0].code = ' '; }, 'INVALID_PROJECT');
});

test('won values require canonical nonnegative integer strings inside PostgreSQL bigint bounds', () => {
  for (const amount of [1000, 9007199254740992, '1.5', '1e3', '-1', '01', '9223372036854775808', null]) {
    rejects(b => { b.budgetLines[0].currentAmount = amount; }, 'INVALID_WON');
  }
  const batch = fixture();
  Object.assign(batch.budgetLines[0], { originalAmount: '9223372036854775807', currentAmount: '9223372036854775807', committedAmount: '1', availableAmount: '9223372036854775806' });
  assert.equal(validateImport(batch).valid, true);
});

test('available balance is exact and a reservation cannot exceed current budget', () => {
  rejects(b => { b.budgetLines[0].availableAmount = '999'; }, 'BALANCE_MISMATCH');
  rejects(b => { b.budgetLines[0].committedAmount = '1201'; }, 'BALANCE_MISMATCH');
});

test('aggregate won totals cannot overflow the existing signed bigint money contract', () => {
  rejects(b => {
    Object.assign(b.budgetLines[0], { originalAmount: '9223372036854775807', currentAmount: '9223372036854775807', committedAmount: '0', availableAmount: '9223372036854775807' });
    b.budgetLines.push({ ...b.budgetLines[0], id: id(7), sourceId: 'LINE-02' });
  }, 'TOTAL_WON_OVERFLOW');
});

test('snapshot history is reference-only to prevent double applying changes already in current amounts', () => {
  rejects(b => { b.budgetHistory[0].effect = 'apply'; }, 'SNAPSHOT_HISTORY_REAPPLY');
  rejects(b => { b.budgetBasis = 'unknown'; }, 'INVALID_BUDGET_BASIS');
});

test('reconstruction validates every before/after link and final amount without adding totals twice', () => {
  const batch = fixture(); batch.budgetBasis = 'original_with_history'; batch.budgetHistory[0].effect = 'apply';
  assert.equal(validateImport(batch).valid, true);
  batch.budgetHistory[0].beforeAmount = '999';
  assert.ok(validateImport(batch).errorCodes.includes('HISTORY_CHAIN_MISMATCH'));
  batch.budgetHistory[0].beforeAmount = '1000'; batch.budgetLines[0].currentAmount = '1400'; batch.budgetLines[0].availableAmount = '1200';
  assert.ok(validateImport(batch).errorCodes.includes('HISTORY_TOTAL_MISMATCH'));
  batch.budgetHistory[0].effect = 'reference';
  assert.ok(validateImport(batch).errorCodes.includes('MIXED_BUDGET_BASIS'));
});

test('history order and dates must be valid and within the confirmed period and cutoff', () => {
  rejects(b => { b.budgetHistory[0].occurredOn = '2026-02-30'; }, 'HISTORY_DATE_OUTSIDE_SCOPE');
  rejects(b => { b.budgetHistory[0].occurredOn = '2026-11-07'; }, 'HISTORY_DATE_OUTSIDE_SCOPE');
  const batch = fixture(); batch.budgetBasis = 'original_with_history'; batch.budgetHistory[0].effect = 'apply';
  batch.budgetHistory.push({ ...batch.budgetHistory[0], id: id(8), sourceId: 'HISTORY-02', occurredOn: '2026-03-15', beforeAmount: '1200', afterAmount: '1200' });
  assert.ok(validateImport(batch).errorCodes.includes('HISTORY_ORDER_INVALID'));
});

test('scope cannot add unknown projects, years or business periods', () => {
  rejects(b => { b.scope.projectIds = [id(99)]; }, 'PROJECT_OUTSIDE_SCOPE');
  rejects(b => { b.scope.projectIds.push(id(99)); }, 'SCOPE_PROJECT_MISSING');
  rejects(b => { b.scope.periodEnd = '2027-12-31'; }, 'OUTSIDE_CONFIRMED_BUSINESS');
  rejects(b => { b.scope.cutoffDate = '2026-02-28'; }, 'INVALID_DATE_RANGE');
});

test('line and history references cannot escape the declared project and classification chain', () => {
  rejects(b => { b.budgetLines[0].projectId = id(99); }, 'PROJECT_REFERENCE_MISSING');
  rejects(b => { b.budgetLines[0].codeVersionId = id(13); }, 'CLASSIFICATION_REFERENCE_MISSING');
  rejects(b => { b.classifications[2].parentId = id(2); }, 'INVALID_CLASSIFICATION_PARENT');
  rejects(b => { b.classifications[2].effectiveOn = '2026-11-07'; }, 'INVALID_EFFECTIVE_DATE');
  rejects(b => { b.budgetHistory[0].lineId = id(99); }, 'LINE_REFERENCE_MISSING');
});

test('malformed structures and hostile values fail with codes, never source exception details', () => {
  for (const batch of [null, [], { scope: null }, { ...fixture(), projects: [null] }, { ...fixture(), scope: { toString: 'SYNTHETIC_SECRET' } }]) {
    const result = validateImport(batch);
    assert.equal(result.valid, false);
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_SECRET'), false);
  }
  rejects(b => { b.budgetLines = new Array(10001).fill({}); }, 'INVALID_COLLECTION');
});

test('file and CLI output expose only counts and error codes; parsing failures do not echo path or contents', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'boot-erp-import-test-')), file = join(folder, 'synthetic.json');
  const script = fileURLToPath(new URL('../scripts/validate-import.mjs', import.meta.url));
  try {
    await writeFile(file, '\uFEFF' + JSON.stringify(fixture()));
    assert.equal((await validateImportFile(file)).valid, true);
    const run = spawnSync(process.execPath, [script, file], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(Object.keys(JSON.parse(run.stdout)).sort(), ['counts', 'errorCodes', 'valid']);
    for (const secret of [file, 'SYNTHETIC-BATCH-01', '가상 검수 과제', 'PROJECT-01', '1200']) assert.equal((run.stdout + run.stderr).includes(secret), false);
    await writeFile(file, 'SYNTHETIC_SECRET_INVALID_JSON');
    const fail = spawnSync(process.execPath, [script, file], { encoding: 'utf8', windowsHide: true });
    assert.equal(fail.status, 1);
    assert.deepEqual(JSON.parse(fail.stdout).errorCodes, ['INPUT_UNAVAILABLE_OR_INVALID']);
    assert.equal((fail.stdout + fail.stderr).includes('SYNTHETIC_SECRET'), false);
    const missing = await validateImportFile(join(folder, 'absent.json'));
    assert.deepEqual(missing.errorCodes, ['INPUT_UNAVAILABLE_OR_INVALID']);
  } finally { await unlink(file); await rmdir(folder); }
});
