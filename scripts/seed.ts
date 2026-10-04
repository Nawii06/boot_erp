import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { people, users, projects, projectMemberships, budgetLines } from '../src/server/schema.ts';
import { transaction } from '../src/server/transaction.ts';
import { assertRuntimeRole } from '../src/server/db.ts';
import { assertLocalDatabase, requiredUrl } from './db-config.mjs';

const pool = new Pool({ connectionString: assertLocalDatabase(requiredUrl('DATABASE_URL'), 'boot_erp_dev', 'app') });
try {
  await assertRuntimeRole(pool);
  await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('foundation.synthetic.seed',0))");
    const db = drizzle(client);
    const projectId = '10000000-0000-4000-8000-000000000001';
    const personId = '20000000-0000-4000-8000-000000000001';
    const userId = '30000000-0000-4000-8000-000000000001';
    await db.insert(people).values({ id: personId, displayName: '가상 참여자 01' }).onConflictDoNothing();
    await db.insert(users).values({ id: userId, personId, role: 'researcher', active: false }).onConflictDoNothing();
    await db.insert(projects).values({ id: projectId, code: 'SYNTHETIC-01', name: '가상 개발 검수 과제', kind: 'research' }).onConflictDoNothing();
    await db.insert(projectMemberships).values({ id: randomUUID(), projectId, userId, startsAt: new Date('2026-01-01T00:00:00Z') }).onConflictDoNothing();
    await db.insert(budgetLines).values({ id: '40000000-0000-4000-8000-000000000001', projectId, internalLabel: '가상 항목 (공식 분류 아님)', originalAmount: 10000000n }).onConflictDoNothing();
  });
  console.log('Synthetic seed ready; account remains inactive with no login subject.');
} catch { console.error('Seed failed. Only isolated development DB is supported; no credentials logged.'); process.exitCode = 1; }
finally { await pool.end(); }
