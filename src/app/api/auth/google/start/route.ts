import { errorResponse } from '../../../../../lib/errors.ts';
import { runtimePool } from '../../../../../server/db.ts';
import { sameOrigin, cookie, flowCookie, readCookie, hash } from '../../../../../server/security.ts';
import { beginGoogle } from '../../../../../server/google.ts';
export const dynamic='force-dynamic';
export async function POST(request: Request) {
  try {
    sameOrigin(request); const pool=runtimePool(),old=readCookie(request);
    if (old) await pool.query('UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE token_hash=$1 AND revoked_at IS NULL',[hash(old)]);
    const flow=await beginGoogle(pool);
    return Response.json({url:flow.url},{headers:{'Cache-Control':'no-store','Set-Cookie':cookie(flowCookie,flow.browser)}});
  } catch(e) { return errorResponse(e); }
}
