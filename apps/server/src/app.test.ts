import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import type { Config } from './config.js';

const config: Config = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 3000,
  DATABASE_URL: 'postgres://localhost/test',
  LOG_LEVEL: 'silent',
};

describe('health checks', () => {
  it('reports liveness and database readiness', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const app = createApp(config, { query } as never);
    expect((await app.inject('/health/live')).statusCode).toBe(200);
    expect((await app.inject('/health/ready')).json()).toEqual({
      status: 'ok',
      database: 'reachable',
    });
    expect(query).toHaveBeenCalledWith('SELECT 1');
    await app.close();
  });

  it('does not claim readiness when the database is down', async () => {
    const app = createApp(config, {
      query: vi.fn().mockRejectedValue(new Error('offline')),
    } as never);
    const result = await app.inject('/health/ready');
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ status: 'unavailable', database: 'unreachable' });
    await app.close();
  });

  it('fails closed when no staff identity provider is configured', async () => {
    const app = createApp(config, { query: vi.fn() } as never);
    expect((await app.inject('/api/auth/status')).json()).toEqual({ configured: false });
    expect((await app.inject('/api/jobs')).statusCode).toBe(401);
    const claimedToken = await app.inject({
      url: '/api/jobs',
      headers: { authorization: 'Bearer unverified' },
    });
    expect(claimedToken.statusCode).toBe(503);
    expect(claimedToken.json().error.code).toBe('AUTH_NOT_CONFIGURED');
    await app.close();
  });
});
