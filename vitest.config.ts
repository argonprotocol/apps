import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    retry: 1,
    reporters: process.env.GITHUB_ACTIONS ? ['dot', 'github-actions'] : ['dot'],
    maxWorkers: 1,
    disableConsoleIntercept: true,
    projects: [
      {
        test: {
          testTimeout: 30_000,
          hookTimeout: 30_000,
          include: ['src-vue/__test__/**/*.test.ts'],
          setupFiles: './vitest.setup.ts',
          // silent: false
        },
      },
      {
        test: {
          testTimeout: 240_000,
          hookTimeout: 120_000,
          include: ['core/__test__/**/*.test.ts'],
        },
      },
      {
        test: {
          testTimeout: 240_000,
          hookTimeout: 120_000,
          include: ['indexer/__test__/**/*.test.ts'],
        },
      },
      {
        test: {
          testTimeout: 240_000,
          hookTimeout: 120_000,
          include: ['bot/__test__/**/*.test.ts'],
          env: {
            STATUS_URL: 'na',
          },
        },
      },
    ],
  },
});
