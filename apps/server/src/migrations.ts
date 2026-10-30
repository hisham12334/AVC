import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

type Applied = { name: string; checksum: string };
export type MigrationMode = 'up' | 'status' | 'validate';

export async function migrate(
  pool: Pool,
  directory: string,
  mode: MigrationMode,
): Promise<string[]> {
  const client = await pool.connect();
  const result: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(2468001)');
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(directory))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort();
    const appliedResult = await client.query<Applied>(
      'SELECT name, checksum FROM public.schema_migrations',
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.name, row.checksum]));
    for (const name of files) {
      const sql = await readFile(join(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(name);
      if (previous && previous !== checksum) throw new Error(`Modified applied migration: ${name}`);
      if (previous) {
        result.push(`applied ${name}`);
        continue;
      }
      if (mode === 'up') {
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO public.schema_migrations(name, checksum) VALUES ($1, $2)',
            [name, checksum],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
        result.push(`applied ${name}`);
      } else {
        result.push(`pending ${name}`);
      }
    }
    for (const name of applied.keys()) {
      if (!files.includes(name)) throw new Error(`Applied migration file missing: ${name}`);
    }
    if (mode === 'validate' && result.some((line) => line.startsWith('pending '))) {
      throw new Error(
        `Pending migrations: ${result.filter((line) => line.startsWith('pending ')).join(', ')}`,
      );
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock(2468001)');
    client.release();
  }
}
