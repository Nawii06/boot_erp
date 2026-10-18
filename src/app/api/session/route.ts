import { runtimePool } from '../../../server/db.ts';
import { transaction } from '../../../server/transaction.ts';
import { authenticate,readCookie } from '../../../server/security.ts';
import { errorResponse } from '../../../lib/errors.ts';
export const dynamic='force-dynamic';
export async function GET(request: Request) {
  try { const result=await transaction(runtimePool(),async c=>{
    const a=await authenticate(c,readCookie(request));
    const otp=(await c.query('SELECT confirmed FROM otp_credentials WHERE user_id=$1',[a.id])).rows[0];
    return {id:a.id,email:a.email,role:a.role,expiresAt:a.expiresAt,idleExpiresAt:new Date(a.lastSeenAt.getTime()+900000),
      stepUpUntil:a.stepUpAt?new Date(a.stepUpAt.getTime()+300000):null,otpReady:otp?.confirmed??false,serverTime:new Date()};
  });return Response.json(result,{headers:{'Cache-Control':'no-store'}}); } catch(e){return errorResponse(e);}
}
