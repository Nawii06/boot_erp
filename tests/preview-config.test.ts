import test from 'node:test';
import assert from 'node:assert/strict';
import { getPreviewConfig, previewRoles, type PreviewEnvironment } from '../src/lib/preview-config.ts';

const now = Date.parse('2026-11-06T00:00:00.000Z');
const schema = `boot_preview_${'a'.repeat(32)}`;
const users = Object.fromEntries(previewRoles.map((role,index) => [role,`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`]));
function fixture(): PreviewEnvironment {
  const url = new URL('postgresql://boot_erp_test_app:synthetic@127.0.0.1:55432/boot_erp_test');
  url.searchParams.set('options',`-c search_path=${schema}`);
  return {BOOT_ERP_PREVIEW_MODE:'1',APP_ORIGIN:'http://localhost:3000',DATABASE_URL:url.toString(),
    BOOT_ERP_PREVIEW_SCHEMA:schema,BOOT_ERP_PREVIEW_EXPIRES_AT:'2026-11-06T08:00:00.000Z',
    BOOT_ERP_PREVIEW_USERS:JSON.stringify(users)};
}

test('preview is opt-in, local, isolated, short-lived and role-bound', () => {
  for (const mode of [undefined,'','0']) assert.equal(getPreviewConfig({BOOT_ERP_PREVIEW_MODE:mode},now),null);
  const valid = fixture();
  assert.deepEqual(getPreviewConfig(valid,now),{schema,users,expiresAt:'2026-11-06T08:00:00.000Z',expiresAtMs:now+8*3600000});
  assert.ok(getPreviewConfig({...valid,BOOT_ERP_PREVIEW_EXPIRES_AT:'2026-11-06T01:00:00Z'},now));
  const invalid: PreviewEnvironment[] = [
    {...valid,BOOT_ERP_PREVIEW_MODE:'true'}, {...valid,APP_ORIGIN:'http://127.0.0.1:3000'},
    {...valid,APP_ORIGIN:'https://erp.example.invalid'}, {...valid,MIGRATION_DATABASE_URL:'not-allowed'},
    {...valid,BOOT_ERP_PREVIEW_SCHEMA:'public'}, {...valid,BOOT_ERP_PREVIEW_SCHEMA:schema+',public'},
    {...valid,BOOT_ERP_PREVIEW_SCHEMA:'boot_preview_'+ 'A'.repeat(32)},
    {...valid,BOOT_ERP_PREVIEW_EXPIRES_AT:'2026-11-06T00:00:00.000Z'},
    {...valid,BOOT_ERP_PREVIEW_EXPIRES_AT:'2026-11-06T08:00:00.001Z'},
    {...valid,BOOT_ERP_PREVIEW_EXPIRES_AT:'2026-11-06'},
    {...valid,BOOT_ERP_PREVIEW_EXPIRES_AT:'2026-02-30T01:00:00.000Z'},
    {...valid,BOOT_ERP_PREVIEW_USERS:JSON.stringify({...users,staff:users.admin})},
    {...valid,BOOT_ERP_PREVIEW_USERS:JSON.stringify({...users,staff:'arbitrary-user'})},
    {...valid,BOOT_ERP_PREVIEW_USERS:JSON.stringify({...users,owner:users.admin})},
    {...valid,BOOT_ERP_PREVIEW_USERS:JSON.stringify({staff:users.staff})},
    {...valid,BOOT_ERP_PREVIEW_USERS:'null'}, {...valid,BOOT_ERP_PREVIEW_USERS:'[]'},
  ];
  for (const change of [
    (url:URL) => {url.hostname='example.invalid';}, (url:URL) => {url.hostname='127.0.0.2';},
    (url:URL) => {url.port='5432';}, (url:URL) => {url.pathname='/boot_erp_dev';},
    (url:URL) => {url.username='boot_erp_test_owner';}, (url:URL) => {url.password='';},
    (url:URL) => {url.search='';},
    (url:URL) => {url.searchParams.set('options',`-c search_path=${schema},public`);},
    (url:URL) => {url.searchParams.set('options',`-c search_path=public,${schema}`);},
    (url:URL) => {url.searchParams.set('options',`-c search_path=${schema} -c role=other`);},
    (url:URL) => {url.searchParams.append('options',`-c search_path=${schema}`);},
    (url:URL) => {url.searchParams.set('application_name','preview');},
    (url:URL) => {url.hash='public';},
  ]) {const url=new URL(valid.DATABASE_URL!);change(url);invalid.push({...valid,DATABASE_URL:url.toString()});}
  for (const env of invalid) assert.throws(() => getPreviewConfig(env,now),{message:'Invalid preview configuration'});
  assert.throws(() => getPreviewConfig(valid,NaN));
  assert.throws(() => getPreviewConfig(valid,-1));
});
