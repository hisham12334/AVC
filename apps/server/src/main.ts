import { Pool } from 'pg';
import { createApp } from './app.js';
import { loadConfig, loadLocalEnvFile } from './config.js';
import { dispatchWebhooks } from './integration/webhooks.js';
import { runCustomerMessages } from './engagement/worker.js';

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
  const customerTimer = setInterval(() => {
    runCustomerMessages(
      pool,
      config.CUSTOMER_MESSAGE_ENDPOINT,
      config.CUSTOMER_MESSAGE_API_KEY,
      config.CUSTOMER_PORTAL_URL,
    ).catch((error: unknown) => app.log.error({ err: error }, 'customer messaging failed'));
  }, 60_000);
  void runCustomerMessages(
    pool,
    config.CUSTOMER_MESSAGE_ENDPOINT,
    config.CUSTOMER_MESSAGE_API_KEY,
    config.CUSTOMER_PORTAL_URL,
  ).catch((error: unknown) => app.log.error({ err: error }, 'customer messaging failed'));
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    clearInterval(customerTimer);
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
