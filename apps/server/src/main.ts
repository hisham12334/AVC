import { Pool } from 'pg';
import { createApp } from './app.js';
import { loadConfig, loadLocalEnvFile } from './config.js';
import { dispatchWebhooks } from './integration/webhooks.js';

async function main(): Promise<void> {
  loadLocalEnvFile();
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
  const app = createApp(config, pool);
  const interval = config.WEBHOOK_DISPATCH_INTERVAL_MS;
  const timer = interval
    ? setInterval(() => {
        dispatchWebhooks(pool).catch((error: unknown) =>
          app.log.error({ err: error }, 'webhook dispatch failed'),
        );
      }, interval)
    : null;
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await pool.end();
  });
  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    app.log.error({ err: error }, 'startup failed');
    await app.close();
    process.exitCode = 1;
  }
}

void main();
