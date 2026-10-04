// Compile-time API compatibility probe only. No persistent ERP schema or migration.
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { bigint, pgTable } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';
import type { MigrationBuilder } from 'node-pg-migrate';

const probe = pgTable('toolchain_probe', {
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
});
export function buildProbe(pool: Pool) {
  const db = drizzle(pool);
  return db.select().from(probe).where(eq(probe.amount, 9007199254740993n)).for('update');
}

export function migrationApiProbe(pgm: MigrationBuilder) {
  pgm.sql('SELECT 1');
}
