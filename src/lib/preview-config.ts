// Temporary access is restricted to one disposable local test schema.
export const previewRoles = ['staff', 'researcher', 'principal_investigator', 'admin'] as const;
export type PreviewRole = typeof previewRoles[number];
export interface PreviewConfig {
  schema: string;
  expiresAt: string;
  expiresAtMs: number;
  users: Record<PreviewRole, string>;
}
export type PreviewEnvironment = Record<string, string | undefined>;
const schemaPattern = /^boot_preview_[0-9a-f]{32}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getPreviewConfig(env: PreviewEnvironment = process.env, now = Date.now()): PreviewConfig | null {
  const mode = env.BOOT_ERP_PREVIEW_MODE;
  if (mode === undefined || mode === '' || mode === '0') return null;
  try {
    if (mode !== '1' || env.APP_ORIGIN !== 'http://localhost:3000' || env.MIGRATION_DATABASE_URL ||
        !Number.isSafeInteger(now) || now < 0) throw new Error();
    const schema = env.BOOT_ERP_PREVIEW_SCHEMA ?? '';
    if (!schemaPattern.test(schema)) throw new Error();
    const database = new URL(env.DATABASE_URL ?? '');
    if (database.protocol !== 'postgresql:' || !['localhost', '127.0.0.1'].includes(database.hostname) ||
        database.port !== '55432' || database.pathname !== '/boot_erp_test' ||
        decodeURIComponent(database.username) !== 'boot_erp_test_app' || !database.password || database.hash ||
        [...database.searchParams.keys()].length !== 1 ||
        database.searchParams.getAll('options').length !== 1 ||
        database.searchParams.get('options') !== `-c search_path=${schema}`) throw new Error();
    const expiry = env.BOOT_ERP_PREVIEW_EXPIRES_AT ?? '';
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiry)) throw new Error();
    const expiresAtMs = Date.parse(expiry);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now || expiresAtMs - now > 8 * 60 * 60 * 1000 ||
        new Date(expiresAtMs).toISOString() !== (expiry.includes('.') ? expiry : expiry.replace('Z','.000Z'))) throw new Error();
    const users: unknown = JSON.parse(env.BOOT_ERP_PREVIEW_USERS ?? '');
    if (!users || typeof users !== 'object' || Array.isArray(users) || Object.keys(users).length !== previewRoles.length ||
        !previewRoles.every(role => Object.hasOwn(users, role) &&
          typeof (users as Record<string, unknown>)[role] === 'string' &&
          uuidPattern.test((users as Record<string, string>)[role]))) throw new Error();
    const configured = users as Record<PreviewRole, string>;
    if (new Set(previewRoles.map(role => configured[role].toLowerCase())).size !== previewRoles.length) throw new Error();
    return {schema, expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs,
      users: Object.fromEntries(previewRoles.map(role => [role, configured[role].toLowerCase()])) as Record<PreviewRole, string>};
  } catch { throw new Error('Invalid preview configuration'); }
}
