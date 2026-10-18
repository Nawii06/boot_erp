import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const localOrigin = 'http://localhost:3000';
export const googleRedirectUri = `${localOrigin}/api/auth/google/callback`;
const repository = fileURLToPath(new URL('..', import.meta.url));
const errorMessage = 'Google OAuth configuration unavailable or invalid; credential values are not logged.';

export function parseGoogleCredentials(raw) {
  try {
    const web = JSON.parse(raw.replace(/^\uFEFF/, '')).web;
    if (!web || typeof web.client_id !== 'string' || !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(web.client_id) ||
        typeof web.client_secret !== 'string' || web.client_secret.trim().length === 0 || web.client_secret.length > 4096 ||
        /[\s\x00-\x1f\x7f]/.test(web.client_secret)) throw new Error();
    // Fixed Google endpoints will be used by the future provider adapter. Never trust JSON URLs.
    return {
      clientId: web.client_id, clientSecret: web.client_secret, origin: localOrigin, redirectUri: googleRedirectUri,
      redirectListedInDownload: Array.isArray(web.redirect_uris) && web.redirect_uris.includes(googleRedirectUri),
    };
  } catch { throw new Error(errorMessage); }
}

export async function loadGoogleCredentials(filePath) {
  try {
    if (typeof filePath !== 'string' || !isAbsolute(filePath)) throw new Error();
    const [file, root] = await Promise.all([realpath(filePath), realpath(repository)]);
    const within = relative(root, file);
    if (!within || (!within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && within !== '..' && !isAbsolute(within))) throw new Error();
    const info = await stat(file);
    if (!info.isFile() || info.size > 65536) throw new Error();
    return parseGoogleCredentials(await readFile(file, 'utf8'));
  } catch { throw new Error(errorMessage); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = await loadGoogleCredentials(process.env.BOOT_ERP_GOOGLE_OAUTH_FILE);
    console.log(JSON.stringify({ readableWebCredentials: true, redirectListedInDownload: config.redirectListedInDownload,
      redirectUri: config.redirectUri, liveLoginVerified: false }));
  } catch { console.error(errorMessage); process.exitCode = 1; }
}
