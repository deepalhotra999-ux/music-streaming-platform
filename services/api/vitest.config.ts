import { defineConfig } from 'vitest/config';

// DATABASE_URL is pointed at the TEST database for this package's suite.
// Never run these tests against the dev database.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://music:music-dev-only-change-me@localhost:5432/musicdb_test',
    },
    testTimeout: 30000,
  },
});
