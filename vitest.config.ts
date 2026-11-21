import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // UDP tests are timing-sensitive: run files one by one
    fileParallelism: false,
  },
});
