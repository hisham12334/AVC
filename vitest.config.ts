import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
    // Integration tests share one disposable database and truncate it, so files run one at a time.
    fileParallelism: false,
  },
});
