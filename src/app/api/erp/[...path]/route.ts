import { AppError,errorResponse } from '../../../../lib/errors.ts';
import { runtimePool } from '../../../../server/db.ts';
import { transaction } from '../../../../server/transaction.ts';
import { authenticate,readCookie,body,logout,cookie,sessionCookie } from '../../../../server/security.ts';
import { accountList,accountDetail,manageAccount,beginOtp,verifyOtp } from '../../../../server/accounts.ts';
import { projectList,projectDetail,manageProject,workList,workDetail,manageWork } from '../../../../server/work.ts';
import { classificationList,manageClassification,allocateBudget,budgetList,changeList,changeDetail,manageBudgetChange,downloadBudgetFile } from '../../../../server/budgets.ts';
import { draftList,draftDetail,saveDraft,attachDraftFile,downloadDraftFile,policyList,policyHistory,savePolicy } from '../../../../server/expenses.ts';
export const dynamic='force-dynamic';
type Context={params:Promise<{path:string[]}>};
const json=(value:unknown)=>Response.json(value,{headers:{'Cache-Control':'no-store'}});
export async function GET(request:Request,context:Context) {
  try { const {path}=await context.params,pool=runtimePool(),token=readCookie(request),q=new URL(request.url).searchParams;
    if(path[0]==='expense-drafts'&&path.length<=2)return json(path[1]?await draftDetail(pool,token,path[1]):await draftList(pool,token,q.get('q')??''));
    if(path[0]==='expense-policies'&&path.length===1)return json(await policyList(pool,token));
    if(path[0]==='expense-policy-history'&&path.length===1)return json(await policyHistory(pool,token,q.get('type')??'',q.get('subtype')??''));
    if(path[0]==='expense-files'&&path.length===2){const f=await downloadDraftFile(pool,token,path[1]);return new Response(new Uint8Array(f.content),{headers:{
      'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="evidence"; filename*=UTF-8''${encodeURIComponent(f.filename).replace(/'/g,'%27')}`,
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"}});}
    if(path.length===1&&path[0]==='budget-codes')return json(await classificationList(pool,token));
    if(path.length===1&&path[0]==='budgets')return json(await budgetList(pool,token,q.get('project')??''));
    if(path[0]==='budget-changes'&&path.length<=2)return json(path[1]?await changeDetail(pool,token,q.get('project')??'',path[1]):await changeList(pool,token,q.get('project')??''));
    if(path[0]==='budget-files'&&path.length===2){const f=await downloadBudgetFile(pool,token,path[1]);return new Response(new Uint8Array(f.content),{headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="budget-document"; filename*=UTF-8''${encodeURIComponent(f.filename).replace(/'/g,'%27')}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"}});}
    if(path.length===1&&path[0]==='accounts') return json(await accountList(pool,token));
    if(path.length===2&&path[0]==='accounts') return json(await accountDetail(pool,token,path[1]));
    if(path[0]==='projects'&&path.length<=2) return json(path[1]?await projectDetail(pool,token,path[1]):await projectList(pool,token));
    if(path[0]==='work'&&path.length<=2) return json(path[1]?await workDetail(pool,token,path[1]):await workList(pool,token,q.get('q')??'',q.get('project')??undefined));
    if(path.length===1&&['export','stats'].includes(path[0])) {
      const rows=await workList(pool,token,q.get('q')??'',q.get('project')??undefined);
      if(path[0]==='stats')return json({visibleWorkCount:rows.length,limit:1000});
      return new Response(JSON.stringify(rows),{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="assigned-work.json"','Cache-Control':'no-store'}});
    }
    throw new AppError('FORBIDDEN');
  } catch(e){return errorResponse(e);}
}
export async function POST(request:Request,context:Context) {
  try { const {path}=await context.params,pool=runtimePool(),token=readCookie(request);
    // Authenticate before accepting the larger, bounded attachment body.
    const upload=path.length===1&&['budget-changes','expense-files'].includes(path[0]);
    if(upload)await transaction(pool,c=>authenticate(c,token));
    const input=await body(request,upload?7100000:32768);
    if(path.length!==1)throw new AppError('INVALID_INPUT');
    // No public activation switch: deferred submission/approval must not be reachable via the old API.
    if(path[0]==='budget-spend') {await transaction(pool,c=>authenticate(c,token));throw new AppError('PHASE_NOT_ENABLED');}
    if(path[0]==='expense-drafts')return json(await saveDraft(pool,token,input));
    if(path[0]==='expense-files')return json(await attachDraftFile(pool,token,input));
    if(path[0]==='expense-policies')return json(await savePolicy(pool,token,input));
    if(path[0]==='budget-codes')return json(await manageClassification(pool,token,input));
    if(path[0]==='budgets')return json(await allocateBudget(pool,token,input));
    if(path[0]==='budget-changes')return json(await manageBudgetChange(pool,token,input));
    if(path[0]==='accounts')return json(await manageAccount(pool,token,input));
    if(path[0]==='projects')return json(await manageProject(pool,token,input));
    if(path[0]==='work')return json(await manageWork(pool,token,input));
    if(path[0]==='otp-enroll')return json(await beginOtp(pool,token));
    if(path[0]==='otp-verify')return json(await verifyOtp(pool,token,input.code));
    if(path[0]==='activity'){ await transaction(pool,c=>authenticate(c,token,true));return json({ok:true}); }
    if(path[0]==='logout'){
      if(typeof input.all!=='boolean')throw new AppError('INVALID_INPUT');await logout(pool,token,input.all);
      return Response.json({ok:true},{headers:{'Cache-Control':'no-store','Set-Cookie':cookie(sessionCookie,'',true),'Clear-Site-Data':'"cache", "storage"'}});
    }
    throw new AppError('FORBIDDEN');
  }catch(e){return errorResponse(e);}
}
