import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../lib/errors.ts';
import { jsonValue } from '../lib/money.ts';
import { uuid, textInput } from '../lib/validation.ts';
import { authorizeProject } from './access.ts';
import { assertRuntimeRole } from './db.ts';

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await assertRuntimeRole(client);
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
}

export interface Command {
  actorId: string; projectId: string; requestId: string; action: string; reason: string; input: unknown;
}
// Internal server primitive only. A stage service must supply a verified DB actor,
// validate business rules and lock/version the affected rows inside this callback.
// No HTTP mutation endpoint or reservation/payment rule is exposed in stage 01.
export async function auditedCommand(pool: Pool, command: Command,
  work: (client: PoolClient) => Promise<{ result: unknown; before: unknown; after: unknown }>,
): Promise<unknown> {
  const actor = uuid(command.actorId), project = uuid(command.projectId), request = uuid(command.requestId);
  const action = textInput(command.action), reason = textInput(command.reason, 1000);
  const fingerprint = createHash('sha256').update(jsonValue({ project, action, reason, input: command.input })).digest('hex');
  return transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${actor}:${request}`]);
    await authorizeProject(client, actor, project, 'project.write');
    const existing = await client.query('SELECT fingerprint,result FROM command_receipts WHERE actor_id=$1 AND request_id=$2', [actor, request]);
    if (existing.rows[0]) {
      if (existing.rows[0].fingerprint !== fingerprint) throw new AppError('CONFLICT');
      return existing.rows[0].result;
    }
    const output = await work(client);
    const result = jsonValue(output.result);
    await client.query('INSERT INTO command_receipts(actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4::jsonb)', [actor, request, fingerprint, result]);
    await client.query(`INSERT INTO audit_events(id,actor_id,project_id,request_id,action,reason,before_state,after_state)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`, [randomUUID(), actor, project, request, action, reason, jsonValue(output.before), jsonValue(output.after)]);
    return JSON.parse(result);
  });
}
