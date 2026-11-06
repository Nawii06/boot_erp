import { getPreviewConfig, previewRoles } from '../../../../lib/preview-config.ts';
import { AppError, errorResponse } from '../../../../lib/errors.ts';
import { runtimePool } from '../../../../server/db.ts';
import { issuePreviewSession } from '../../../../server/preview.ts';
import { body, cookie, readCookie, sessionCookie } from '../../../../server/security.ts';

export const dynamic = 'force-dynamic';
const headers = {'Cache-Control':'no-store','Referrer-Policy':'no-referrer'};
function localRequest(request: Request): void {
  const allowed = ['localhost:3000','127.0.0.1:3000'];
  const url = new URL(request.url);
  if (url.protocol !== 'http:' || !allowed.includes(url.host) || !allowed.includes(request.headers.get('host') ?? '')) {
    throw new AppError('FORBIDDEN');
  }
}
function unavailable(): Response { return Response.json({error:{code:'NOT_FOUND'}},{status:404,headers}); }

export async function GET(request: Request): Promise<Response> {
  try {
    const config = getPreviewConfig();
    if (!config) return unavailable();
    localRequest(request);
    return Response.json({enabled:true,expiresAt:config.expiresAt,roles:previewRoles},{headers});
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const config = getPreviewConfig();
    if (!config) return unavailable();
    localRequest(request);
    const input = await body(request,1024);
    if (Object.keys(input).length !== 1 || !Object.hasOwn(input,'role')) throw new AppError('INVALID_INPUT');
    const session = await issuePreviewSession(runtimePool(),config,input.role,readCookie(request));
    return Response.json({ok:true,role:session.role,expiresAt:config.expiresAt,authentication:'local-preview'},
      {headers:{...headers,'Set-Cookie':cookie(sessionCookie,session.token)}});
  } catch (error) { return errorResponse(error); }
}
