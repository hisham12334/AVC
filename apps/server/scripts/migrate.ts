import { join } from 'node:path';
import { Pool } from 'pg';
import { loadConfig, loadLocalEnvFile } from '../src/config.js';
import { migrate, type MigrationMode } from '../src/migrations.js';

const command = process.argv[2];
if (!['up', 'status', 'validate'].includes(command ?? ''))
  throw new Error('Usage: migrate.ts <up|status|validate>');

async function run(): Promise<void> {
  loadLocalEnvFile();
  const pool = new Pool({ connectionString: loadConfig().DATABASE_URL, max: 1 });
  try {
    const lines = await migrate(
      pool,
      join(__dirname, '..', 'migrations'),
      command as MigrationMode,
    );
    lines.forEach((line) => console.log(line));
  } finally {
    await pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
