import { join } from 'node:path';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import { registerIdentity, type TokenVerifier } from './identity/auth.js';
import { registerStaffAccountRoutes } from './identity/accounts.js';
import { sessionVerifier } from './identity/sessions.js';
import { registerBranchRoutes } from './branches/routes.js';
import { registerCrmRoutes } from './crm/routes.js';
import { registerDashboardRoutes } from './dashboard/routes.js';
import { registerEvidenceFiles } from './evidence/files.js';
import { registerIntegrationRoutes } from './integration/routes.js';
import { registerInspectionRoutes } from './inspection/routes.js';
import { registerJobRoutes } from './jobs/routes.js';
import { registerPortalRoutes } from './portal/routes.js';
import { registerTransferRoutes } from './transfers/routes.js';
import { registerQuoteRoutes } from './quotes/routes.js';
import { registerTrackRoutes } from './track/routes.js';
import { toPublicError } from './errors.js';

export function createApp(
  config: Config,
  db: Pool,
  verifier: TokenVerifier = sessionVerifier(db),
): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  app.setErrorHandler((error, request, reply) => {
    const publicError = toPublicError(error);
    if (publicError.status >= 500 && publicError.code === 'INTERNAL_ERROR') {
      request.log.error(
        { errorName: error instanceof Error ? error.name : 'unknown' },
        'request failed',
      );
    }
    reply
      .status(publicError.status)
      .send({ error: { code: publicError.code, message: publicError.message } });
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await db.query('SELECT 1');
      return { status: 'ok', database: 'reachable' };
    } catch (error) {
      app.log.error({ err: error }, 'database health check failed');
      return reply.status(503).send({ status: 'unavailable', database: 'unreachable' });
    }
  });

  registerIdentity(app, db, verifier);
  registerStaffAccountRoutes(app, db);
  registerCrmRoutes(app, db);
  registerJobRoutes(app, db);
  registerBranchRoutes(app, db);
  registerInspectionRoutes(app, db);
  registerQuoteRoutes(app, db);
  registerTransferRoutes(app, db);
  registerPortalRoutes(app, db);
  registerEvidenceFiles(app, db, config.UPLOAD_DIR ?? join(process.cwd(), 'uploads'));
  registerTrackRoutes(app, db);
  registerDashboardRoutes(app, db);
  registerIntegrationRoutes(app, db);

  const webRoot = join(process.cwd(), '..', 'web', 'dist');
  if (existsSync(webRoot)) {
    void app.register(fastifyStatic, { root: webRoot, prefix: '/' });
    // Customer links are /track/<token>; the single-page app reads the token from the path.
    // The token must not leak through the Referer header or be cached.
    for (const route of ['/track/:token', '/p/:token']) {
      app.get(route, async (_request, reply) => {
        reply.header('referrer-policy', 'no-referrer').header('cache-control', 'no-store');
        return reply.sendFile('index.html');
      });
    }
    app.get('/portal', async (_request, reply) => reply.sendFile('index.html'));
  }
  return app;
}
