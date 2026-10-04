import 'server-only';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';
import { AppError } from '../lib/errors.ts';

let pool: Pool | undefined;
export function runtimePool(): Pool {
  if (!process.env.DATABASE_URL || process.env.MIGRATION_DATABASE_URL) throw new AppError('UNAVAILABLE');
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
    pool.on('error', () => { /* Do not log SQL, connection strings or personal records. */ });
  }
  return pool;
}
export function database() { return drizzle(runtimePool(), { schema }); }

export async function assertRuntimeRole(client: Pick<Pool, 'query'>): Promise<void> {
  const { rows } = await client.query(`SELECT rolsuper, rolcreatedb, rolcreaterole,
    has_schema_privilege(current_user, 'public', 'CREATE') AS ddl
    FROM pg_roles WHERE rolname=current_user`);
  if (!rows[0] || rows[0].rolsuper || rows[0].rolcreatedb || rows[0].rolcreaterole || rows[0].ddl) throw new AppError('UNAVAILABLE');
}
