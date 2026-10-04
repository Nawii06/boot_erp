import 'server-only';
import type { PoolClient } from 'pg';
import { AppError } from '../lib/errors.ts';

export const roles = ['researcher', 'principal_investigator', 'staff', 'admin'] as const;
export type Role = typeof roles[number];
export type Action = 'project.read' | 'project.write' | 'system.manage' | 'sensitive.read';
export interface AccessFacts { role: Role; active: boolean; assigned: boolean }

export function mayAccess(facts: AccessFacts, action: Action): boolean {
  if (!facts.active || !roles.includes(facts.role)) return false;
  if (action === 'system.manage') return facts.role === 'admin';
  if (action === 'sensitive.read') return false; // D-04: no sensitive data surface yet.
  if (action !== 'project.read' && action !== 'project.write') return false;
  if (facts.role === 'admin' || facts.role === 'staff') return true;
  // The write boundary is management only; researcher self-submission gets its own stage 04 action.
  return action === 'project.read' && facts.assigned;
}

export async function authorizeProject(client: PoolClient, actorId: string, projectId: string, action: Action): Promise<void> {
  // Read current DB facts every time. Never use a client-supplied role or membership cache.
  const result = await client.query(`SELECT u.role, u.active, EXISTS (
    SELECT 1 FROM project_memberships m WHERE m.user_id=u.id AND m.project_id=$2
    AND m.active AND m.starts_at<=CURRENT_TIMESTAMP AND (m.ends_at IS NULL OR m.ends_at>CURRENT_TIMESTAMP)
  ) AS assigned FROM users u JOIN projects p ON p.id=$2 WHERE u.id=$1 FOR SHARE OF u`, [actorId, projectId]);
  if (!result.rows[0] || !mayAccess(result.rows[0], action)) throw new AppError('FORBIDDEN');
}
