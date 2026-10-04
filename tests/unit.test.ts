import test from 'node:test';
import assert from 'node:assert/strict';
import { won, checkedWon, sumWon, jsonValue } from '../src/lib/money.ts';
import { uuid, textInput } from '../src/lib/validation.ts';
import { AppError, errorResponse } from '../src/lib/errors.ts';
import { mayAccess, roles } from '../src/server/access.ts';
import { requireSubject } from '../src/server/auth.ts';

test('won: safe integer boundary, exact arithmetic and JSON string contract', () => {
  assert.equal(sumWon([won('9007199254740993'), won('1')]), 9007199254740994n);
  assert.equal(jsonValue({ amount: won('9007199254740993') }), '{"amount":"9007199254740993"}');
  assert.equal(won('-9223372036854775808'), -9223372036854775808n);
  for (const invalid of [1, 0.1, NaN, Infinity, '', '01', '1.2', '1e3', ' 1', '+1', '9223372036854775808', '-9223372036854775809']) assert.throws(() => won(invalid), AppError);
  assert.throws(() => sumWon([9223372036854775807n, 1n]), AppError);
  assert.throws(() => checkedWon(-9223372036854775809n), AppError);
});
test('unverified login remains closed', async () => { await assert.rejects(requireSubject(), { code: 'UNAUTHENTICATED' }); });
test('role boundary: assignment, read only PI, staff vs system and unknown sensitive policy', () => {
  for (const role of roles) {
    assert.equal(mayAccess({ role, active: false, assigned: true }, 'project.read'), false);
    assert.equal(mayAccess({ role, active: true, assigned: true }, 'sensitive.read'), false);
    assert.equal(mayAccess({ role, active: true, assigned: true }, 'system.manage'), role === 'admin');
    assert.equal(mayAccess({ role, active: true, assigned: false }, 'project.read'), role === 'admin' || role === 'staff');
  }
  assert.equal(mayAccess({ role: 'principal_investigator', active: true, assigned: true }, 'project.read'), true);
  assert.equal(mayAccess({ role: 'principal_investigator', active: true, assigned: true }, 'project.write'), false);
});
test('input validation and error responses never serialize database details', async () => {
  assert.throws(() => uuid("' OR TRUE --"), AppError);
  assert.throws(() => textInput('  '), AppError);
  assert.throws(() => textInput('long', 2), AppError);
  const response = errorResponse(new Error('private SQL detail'));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: { code: 'UNAVAILABLE' } });
});
