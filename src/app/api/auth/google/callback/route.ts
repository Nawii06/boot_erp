import { runtimePool } from '../../../../../server/db.ts';
import { appOrigin, cookie, flowCookie, sessionCookie, readCookie } from '../../../../../server/security.ts';
import { finishGoogle } from '../../../../../server/google.ts';
export const dynamic='force-dynamic';
export async function GET(request: Request) {
  const headers=new Headers({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
  headers.append('Set-Cookie',cookie(flowCookie,'',true));
  try {
    const q=new URL(request.url).searchParams;
    if(q.getAll('state').length!==1||q.getAll('code').length!==1||q.has('error')) throw new Error();
    const token=await finishGoogle(runtimePool(),q.get('state')??'',readCookie(request,flowCookie),q.get('code')??'');
    headers.append('Set-Cookie',cookie(sessionCookie,token));headers.set('Location',appOrigin()+'/');
  } catch { headers.set('Location',appOrigin()+'/?login=failed'); }
  return new Response(null,{status:303,headers});
}
