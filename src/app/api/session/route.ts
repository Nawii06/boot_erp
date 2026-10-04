import { requireSubject } from '../../../server/auth.ts';
import { AppError, errorResponse } from '../../../lib/errors.ts';

export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    await requireSubject();
    throw new AppError('UNAVAILABLE'); // Stage 02 must implement verified subject -> active DB account.
  } catch (error) { return errorResponse(error); }
}
