import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function loadLocalEnvFile(): void {
  const path = join(__dirname, '..', '..', '..', '.env');
  if (existsSync(path)) process.loadEnvFile(path);
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url().startsWith('postgres://').or(z.url().startsWith('postgresql://')),
  // 0 or unset leaves webhook delivery off; a worker or this timer may run it later.
  WEBHOOK_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(0).optional(),
  // Where uploaded photos are kept until object storage is chosen. Defaults to ./uploads.
  UPLOAD_DIR: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
