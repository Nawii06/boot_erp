import 'server-only';
import { AppError } from '../lib/errors.ts';

// Only a verified provider subject may enter the identity lookup in stage 02.
// Request headers, cookies and posted roles are never a substitute for verification.
export interface AuthProvider {
  verifiedSubject(): Promise<string | null>;
}
const provider: AuthProvider = { async verifiedSubject() { return null; } };
export async function requireSubject(): Promise<string> {
  const subject = await provider.verifiedSubject();
  if (!subject) throw new AppError('UNAUTHENTICATED');
  return subject;
}
