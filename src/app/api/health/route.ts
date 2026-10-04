import { assertRuntimeRole, runtimePool } from '../../../server/db.ts';
import { errorResponse } from '../../../lib/errors.ts';

export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    await assertRuntimeRole(runtimePool());
    await runtimePool().query('SELECT id FROM projects LIMIT 0');
    return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
