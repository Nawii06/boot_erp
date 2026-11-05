import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_WON = 9223372036854775807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = value => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const amount = value => typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= MAX_WON;
const emptyCounts = () => ({ projects: 0, classifications: 0, budgetLines: 0, budgetHistory: 0 });

/** Synthetic-only, offline validation. No normalized source rows, amounts or identifiers leave this function. */
function validateBatch(batch) {
  const errors = new Set();
  const add = code => errors.add(code);
  const counts = emptyCounts();
  const result = () => ({ valid: errors.size === 0, counts, errorCodes: [...errors].sort() });
  const shape = (row, allowed, required = allowed) => {
    if (!object(row)) { add('INVALID_SHAPE'); return false; }
    if (Object.keys(row).some(key => !allowed.includes(key))) add('UNSUPPORTED_FIELD');
    if (required.some(key => !Object.hasOwn(row, key))) add('MISSING_FIELD');
    return true;
  };
  if (!shape(batch, ['schemaVersion', 'synthetic', 'batchId', 'sourceSystem', 'scope', 'budgetBasis', 'previousImports', 'projects', 'classifications', 'budgetLines', 'budgetHistory'])) return result();
  if (batch.schemaVersion !== 1) add('UNSUPPORTED_VERSION');
  if (batch.synthetic !== true) add('SYNTHETIC_ONLY');
  if (!label(batch.batchId) || !label(batch.sourceSystem)) add('INVALID_SOURCE_ID');
  if (!['current_snapshot', 'original_with_history'].includes(batch.budgetBasis)) add('INVALID_BUDGET_BASIS');

  const scope = object(batch.scope) ? batch.scope : {};
  shape(scope, ['businessName', 'businessYear', 'academicYear', 'periodStart', 'periodEnd', 'cutoffDate', 'projectIds']);
  if (scope.businessName !== '1차년도 부트캠프 사업' || scope.businessYear !== 1 || scope.academicYear !== 2026 || scope.periodStart !== '2026-03-01' || scope.periodEnd !== '2026-12-31') add('OUTSIDE_CONFIRMED_BUSINESS');
  if (![scope.periodStart, scope.periodEnd, scope.cutoffDate].every(date) || scope.periodStart > scope.periodEnd || scope.cutoffDate < scope.periodStart) add('INVALID_DATE_RANGE');
  const scopeProjects = new Set();
  if (!Array.isArray(scope.projectIds) || !scope.projectIds.length || scope.projectIds.length > 10000) add('INVALID_SCOPE');
  else for (const id of scope.projectIds) {
    if (typeof id !== 'string' || !UUID.test(id)) add('INVALID_UUID');
    else if (scopeProjects.has(id.toLowerCase())) add('DUPLICATE_TARGET_ID');
    else scopeProjects.add(id.toLowerCase());
  }

  const ledger = object(batch.previousImports) ? batch.previousImports : {};
  shape(ledger, ['batchIds', 'sourceIds']);
  for (const key of ['batchIds', 'sourceIds']) if (!Array.isArray(ledger[key]) || ledger[key].length > 100000 || ledger[key].some(id => !label(id)) || new Set(ledger[key]).size !== ledger[key].length) add('INVALID_IMPORT_LEDGER');
  const priorBatches = new Set(Array.isArray(ledger.batchIds) ? ledger.batchIds : []);
  const priorSources = new Set(Array.isArray(ledger.sourceIds) ? ledger.sourceIds : []);
  if (priorBatches.has(batch.batchId)) add('BATCH_ALREADY_IMPORTED');
  const seenSources = new Set(), seenIds = new Set();
  const identify = row => {
    if (!label(row.sourceId)) add('INVALID_SOURCE_ID');
    else {
      if (seenSources.has(row.sourceId)) add('DUPLICATE_SOURCE_ID');
      if (priorSources.has(row.sourceId)) add('SOURCE_ALREADY_IMPORTED');
      seenSources.add(row.sourceId);
    }
    if (typeof row.id !== 'string' || !UUID.test(row.id)) add('INVALID_UUID');
    else {
      const id = row.id.toLowerCase();
      if (seenIds.has(id)) add('DUPLICATE_TARGET_ID');
      seenIds.add(id);
    }
  };
  const rows = key => {
    if (!Array.isArray(batch[key]) || batch[key].length > 10000) { add('INVALID_COLLECTION'); return []; }
    counts[key] = batch[key].length;
    return batch[key].filter(row => { if (!object(row)) { add('INVALID_SHAPE'); return false; } return true; });
  };
  const projects = rows('projects'), classifications = rows('classifications'), lines = rows('budgetLines'), history = rows('budgetHistory');
  if (!projects.length || !classifications.length || !lines.length) add('EMPTY_BATCH');
  const projectMap = new Map(), codes = new Set(), versions = new Map(), classificationMap = new Map();
  for (const p of projects) {
    shape(p, ['id', 'sourceId', 'code', 'name', 'kind', 'businessYear']); identify(p);
    if (!label(p.code) || !label(p.name) || !['research', 'program'].includes(p.kind) || p.businessYear !== scope.academicYear) add('INVALID_PROJECT');
    if (codes.has(p.code)) add('DUPLICATE_PROJECT_CODE');
    codes.add(p.code);
    if (!scopeProjects.has(String(p.id).toLowerCase())) add('PROJECT_OUTSIDE_SCOPE');
    projectMap.set(String(p.id).toLowerCase(), p);
  }
  if (projectMap.size !== scopeProjects.size) add('SCOPE_PROJECT_MISSING');
  const classificationCodes = new Set();
  for (const c of classifications) {
    shape(c, ['id', 'sourceId', 'versionId', 'code', 'level', 'parentId', 'name', 'effectiveOn', 'active']); identify(c);
    if (typeof c.versionId !== 'string' || !UUID.test(c.versionId)) add('INVALID_UUID');
    else {
      const id = c.versionId.toLowerCase();
      if (seenIds.has(id)) add('DUPLICATE_TARGET_ID');
      seenIds.add(id); versions.set(id, c);
    }
    const expressions = [/^N\d{2}$/, /^N\d{2}\.\d{2}$/, /^N\d{2}\.\d{2}\.\d{3}$/];
    if (![1, 2, 3].includes(c.level) || typeof c.code !== 'string' || !expressions[c.level - 1]?.test(c.code) || !label(c.name) || c.active !== true) add('INVALID_CLASSIFICATION');
    if (classificationCodes.has(c.code)) add('DUPLICATE_CLASSIFICATION_CODE');
    classificationCodes.add(c.code);
    if (!date(c.effectiveOn) || c.effectiveOn > scope.cutoffDate || c.effectiveOn > scope.periodEnd) add('INVALID_EFFECTIVE_DATE');
    classificationMap.set(String(c.id).toLowerCase(), c);
  }
  for (const c of classifications) {
    if (c.level === 1) { if (c.parentId !== null) add('INVALID_CLASSIFICATION_PARENT'); }
    else {
      const parent = classificationMap.get(String(c.parentId).toLowerCase());
      if (!parent || parent.level !== c.level - 1 || typeof c.code !== 'string' || !c.code.startsWith(`${parent.code}.`)) add('INVALID_CLASSIFICATION_PARENT');
    }
  }

  const lineMap = new Map(), lineAmounts = new Map();
  const totals = { originalAmount: 0n, currentAmount: 0n, committedAmount: 0n, availableAmount: 0n };
  for (const line of lines) {
    shape(line, ['id', 'sourceId', 'projectId', 'codeVersionId', 'label', 'fund', 'originalAmount', 'currentAmount', 'committedAmount', 'availableAmount']); identify(line);
    if (!projectMap.has(String(line.projectId).toLowerCase())) add('PROJECT_REFERENCE_MISSING');
    if (!label(line.label) || !label(line.fund)) add('INVALID_BUDGET_LINE');
    const classification = versions.get(String(line.codeVersionId).toLowerCase());
    if (!classification || classification.level !== 3) add('CLASSIFICATION_REFERENCE_MISSING');
    const fields = ['originalAmount', 'currentAmount', 'committedAmount', 'availableAmount'];
    if (!fields.every(key => amount(line[key]))) add('INVALID_WON');
    else {
      for (const key of fields) { totals[key] += BigInt(line[key]); if (totals[key] > MAX_WON) add('TOTAL_WON_OVERFLOW'); }
      const original = BigInt(line.originalAmount), current = BigInt(line.currentAmount), committed = BigInt(line.committedAmount), available = BigInt(line.availableAmount);
      if (committed > current || available !== current - committed) add('BALANCE_MISMATCH');
      lineAmounts.set(String(line.id).toLowerCase(), { original, current });
    }
    lineMap.set(String(line.id).toLowerCase(), line);
  }

  const historyByLine = new Map();
  for (const h of history) {
    shape(h, ['id', 'sourceId', 'lineId', 'occurredOn', 'beforeAmount', 'afterAmount', 'effect']); identify(h);
    const lineId = String(h.lineId).toLowerCase();
    if (!lineMap.has(lineId)) add('LINE_REFERENCE_MISSING');
    if (!date(h.occurredOn) || h.occurredOn < scope.periodStart || h.occurredOn > scope.periodEnd || h.occurredOn > scope.cutoffDate) add('HISTORY_DATE_OUTSIDE_SCOPE');
    if (!amount(h.beforeAmount) || !amount(h.afterAmount)) add('INVALID_WON');
    if (batch.budgetBasis === 'current_snapshot' && h.effect !== 'reference') add('SNAPSHOT_HISTORY_REAPPLY');
    if (batch.budgetBasis === 'original_with_history' && h.effect !== 'apply') add('MIXED_BUDGET_BASIS');
    if (!historyByLine.has(lineId)) historyByLine.set(lineId, []);
    historyByLine.get(lineId).push(h);
  }
  if (batch.budgetBasis === 'original_with_history') for (const [id, values] of lineAmounts) {
    let running = values.original, previousDate = scope.periodStart;
    for (const h of historyByLine.get(id) ?? []) {
      // Keep the supplied sequence: silently sorting would hide a wrong original mapping.
      if (h.occurredOn < previousDate) add('HISTORY_ORDER_INVALID');
      previousDate = h.occurredOn;
      if (!amount(h.beforeAmount) || !amount(h.afterAmount)) continue;
      if (BigInt(h.beforeAmount) !== running) add('HISTORY_CHAIN_MISMATCH');
      running = BigInt(h.afterAmount);
    }
    if (running !== values.current) add('HISTORY_TOTAL_MISMATCH');
  }
  return result();
}

export function validateImport(batch) {
  try { return validateBatch(batch); }
  catch { return { valid: false, counts: emptyCounts(), errorCodes: ['INVALID_SHAPE'] }; }
}

export async function validateImportFile(file) {
  try {
    if ((await stat(file)).size > 5242880) return { valid: false, counts: emptyCounts(), errorCodes: ['INPUT_TOO_LARGE'] };
    return validateImport(JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')));
  } catch { return { valid: false, counts: emptyCounts(), errorCodes: ['INPUT_UNAVAILABLE_OR_INVALID'] }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv.length === 3
    ? await validateImportFile(process.argv[2])
    : { valid: false, counts: emptyCounts(), errorCodes: ['INPUT_FILE_REQUIRED'] };
  console.log(JSON.stringify(output));
  process.exitCode = output.valid ? 0 : 1;
}
