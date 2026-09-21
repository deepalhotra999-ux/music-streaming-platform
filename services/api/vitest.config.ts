import { defineConfig } from 'vitest/config';

// DATABASE_URL is pointed at the TEST database for this package's suite.
// Never run these tests against the dev database.
//
// Test files run SEQUENTIALLY in one worker (singleThread): several suites
// share the same test database, and concurrent global clean-ups would flake.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    poolOptions: {
      threads: { singleThread: true },
    },
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://music:music-dev-only-change-me@localhost:5432/musicdb_test',
      // Test-only secret. Production secrets come from real env / secret store.
      JWT_SECRET: 'test-only-secret-not-for-production-0123456789',
      NODE_ENV: 'test',
    },
    testTimeout: 30000,
  },
});
