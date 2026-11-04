import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false, // all files share one real Postgres database
    testTimeout: 20000,
  },
});
